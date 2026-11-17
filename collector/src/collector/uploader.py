"""專用 PostgreSQL 帳號批次寫入；交易提交成功後才回報送達。"""
import errno
import ipaddress
from collections.abc import Sequence
from dataclasses import dataclass

import psycopg
from psycopg.types.json import Jsonb

from .config import Settings
from .models import DeviceUser, Punch, iso
from .store import DeviceState


class UploadError(Exception):
    def __init__(self, message: str, *, retryable: bool) -> None:
        super().__init__(message)
        self.retryable = retryable  # 連線、交易衝突與資源不足：下一輪再送。


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
        if state.users_seen_at is not None:
            payload["users_seen_at"] = state.users_seen_at.isoformat()
    return payload


class Uploader:
    def __init__(self, settings: Settings, connect=psycopg.connect) -> None:
        self._settings = settings
        self._connect = connect
        self._instance: str | None = None

    def _connection(self):
        s = self._settings
        try:
            password = s.db_password_file.read_text(encoding="utf-8-sig").strip()
        except OSError as exc:
            reason = {
                errno.ENOENT: "檔案不存在，請核對 Compose 掛載與 PASSWORD_FILE",
                errno.EACCES: "權限不足，請讓容器的 UID/GID 10001 可讀取此檔案",
                errno.EPERM: "權限不足，請讓容器的 UID/GID 10001 可讀取此檔案",
                errno.EISDIR: "路徑是目錄，請掛載實際的密碼檔案",
            }.get(exc.errno, f"讀取失敗（{type(exc).__name__}）")
            raise UploadError(f"無法讀取資料庫密碼檔 {str(s.db_password_file)!r}：{reason}",
                              retryable=False) from None
        except UnicodeError:
            raise UploadError(f"資料庫密碼檔 {str(s.db_password_file)!r} 必須使用 UTF-8 編碼",
                              retryable=False) from None
        if not password:
            raise UploadError(f"資料庫密碼檔 {str(s.db_password_file)!r} 內容為空白",
                              retryable=False)
        return self._connect(host=s.db_host, port=s.db_port, dbname=s.db_name, user=s.db_user,
            password=password, sslmode=s.db_sslmode, sslrootcert=s.db_sslrootcert,
            connect_timeout=s.db_timeout_seconds, prepare_threshold=None,
            application_name=f"wjcch-collector-{s.mode}")

    def _identity(self, conn) -> str:
        row = conn.execute("SELECT instance_id::text, current_database(), current_user FROM hr.collector_target WHERE singleton AND schema_version = 1").fetchone()
        if not row or row[1] != self._settings.db_name or row[2] != "hr_collector":
            raise UploadError("資料庫識別或登入角色不符合設定", retryable=False)
        return row[0]

    @staticmethod
    def _error(exc: psycopg.Error) -> UploadError:
        # 資料庫錯誤可能含整筆個資；日誌只記錄類型與 SQLSTATE。
        state = exc.sqlstate or "connection"
        retryable = isinstance(exc, (psycopg.OperationalError, psycopg.InterfaceError)) or state[:2] in {"08", "40", "53", "57"}
        return UploadError(f"資料庫寫入失敗：{type(exc).__name__}（{state}）", retryable=retryable)

    def prepare(self) -> str:
        try:
            with self._connection() as conn:
                self._instance = self._identity(conn)
        except psycopg.Error as exc:
            raise self._error(exc) from None
        # 同一主機重建資料庫時 UUID 會改變，會自動建立新的送達進度。
        return f"{self._settings.mode}:{self._instance}"

    def send(self, state: DeviceState, punches: Sequence[Punch] = (),
             users: Sequence[DeviceUser] | None = None) -> IngestResult:
        payload = build_payload(state, punches, users)
        try:
            with self._connection() as conn:
                conn.execute("SET LOCAL statement_timeout = '30s'")
                conn.execute("SET LOCAL lock_timeout = '5s'")
                if self._instance is None or self._identity(conn) != self._instance:
                    raise UploadError("資料庫目的地已改變，下一輪重新識別", retryable=True)
                data = conn.execute("SELECT hr.ingest_punch_batch(%s)", (Jsonb(payload),)).fetchone()[0]
                keys = ("punch_device_id", "received", "inserted", "users_synced")
                if (not isinstance(data, dict) or any(type(data.get(k)) is not int for k in keys)
                    or data["punch_device_id"] <= 0 or data["received"] != len(punches)
                    or not 0 <= data["inserted"] <= len(punches)
                    or not 0 <= data["users_synced"] <= len(users or ())):
                    raise UploadError("資料庫送達回覆不符合批次內容，保留待送資料", retryable=False)
                result = IngestResult(*(data[k] for k in keys))
            return result  # 離開 connection context，確認 COMMIT 成功後才回傳。
        except psycopg.Error as exc:
            raise self._error(exc) from None
