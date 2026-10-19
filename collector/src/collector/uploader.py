"""把打卡紀錄與卡機狀態送到 Edge Function ingest-punches。

介面規格見 docs/specs/2026-10-19-punch-collector-design.md 第 6 節。
"""
import ipaddress
from collections.abc import Sequence
from dataclasses import dataclass

import requests

from .models import DeviceUser, Punch, iso
from .store import DeviceState


class UploadError(Exception):
    def __init__(self, message: str, *, retryable: bool, status: int | None = None) -> None:
        super().__init__(message)
        self.retryable = retryable  # 網路錯誤、逾時、5xx、429：下一輪再送就好
        self.status = status


@dataclass(frozen=True)
class IngestResult:
    punch_device_id: int
    received: int
    inserted: int
    users_synced: int


def _is_ip(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def build_payload(state: DeviceState, punches: Sequence[Punch], users: Sequence[DeviceUser] | None) -> dict:
    device = {"serial_no": state.serial_no}
    if _is_ip(state.host):
        device["ip_address"] = state.host
    device.update(model=state.model, firmware_version=state.firmware_version, seen_at=iso(state.seen_at))
    if state.record_count is not None:
        device["record_count"] = state.record_count
    device.update(user_count=state.user_count, clock_offset_seconds=state.clock_offset_seconds)

    payload = {
        "device": device,
        "punches": [
            {"device_user_no": x.device_user_no, "punched_at": iso(x.punched_at),
             "verify_type": x.verify_type, "punch_state": x.punch_state}
            for x in punches
        ],
    }
    if users is not None:
        payload["users"] = [{"device_user_no": u.device_user_no, "name": u.name} for u in users]
    return payload


class Uploader:
    def __init__(self, url: str, key: str, region: str,
                 session: requests.Session | None = None, timeout: float = 30) -> None:
        self._url = url
        self._headers = {"x-collector-key": key}
        if region:
            self._headers["x-region"] = region
        self._session = session or requests.Session()
        self._timeout = timeout

    def send(self, state: DeviceState, punches: Sequence[Punch] = (),
             users: Sequence[DeviceUser] | None = None) -> IngestResult:
        payload = build_payload(state, punches, users)
        try:
            resp = self._session.post(self._url, json=payload, headers=self._headers, timeout=self._timeout)
        except requests.RequestException as exc:
            raise UploadError(f"連不上上傳端：{exc}", retryable=True) from exc

        if resp.status_code != 200:
            retryable = resp.status_code >= 500 or resp.status_code == 429
            hint = "（請檢查 COLLECTOR_KEY）" if resp.status_code == 401 else ""
            raise UploadError(f"上傳失敗 HTTP {resp.status_code}{hint}：{resp.text[:300]}",
                              retryable=retryable, status=resp.status_code)

        data = resp.json()
        return IngestResult(int(data["punch_device_id"]), int(data["received"]),
                            int(data["inserted"]), int(data["users_synced"]))
