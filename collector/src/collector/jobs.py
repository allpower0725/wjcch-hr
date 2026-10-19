"""收集流程：輪詢卡機、上傳待送紀錄、回報狀態（心跳）。

流程與錯誤處理見 docs/specs/2026-10-19-punch-collector-design.md 第 3、10 節。
"""
import logging
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import datetime, time, timedelta

from .config import Settings
from .device import DeviceAuthError, DeviceClient, DeviceError
from .models import TAIPEI, now_taipei
from .store import Store
from .uploader import UploadError, Uploader

log = logging.getLogger(__name__)

# meta 的鍵：各步驟最後完成對帳的日期（台北）
_RECONCILE_DOWNLOAD = "reconcile_download"  # 實際鍵為 reconcile_download:<卡機 IP>
_RECONCILE_UPLOAD = "reconcile_upload"


@dataclass
class PollResult:
    host: str
    serial_no: str | None
    ok: bool
    downloaded: bool
    new_punches: int


class Collector:
    def __init__(self, settings: Settings, store: Store, uploader: Uploader,
                 device_factory: Callable[[str], DeviceClient],
                 clock: Callable[[], datetime] = now_taipei) -> None:
        self._settings = settings
        self._store = store
        self._uploader = uploader
        self._device_factory = device_factory
        self._clock = clock
        self._failures: dict[str, int] = {}
        self._upload_blocked = False  # 這一輪遇到可重試的上傳錯誤（例如斷網）

    # 輪詢

    def poll_device(self, host: str, *, force_download: bool = False) -> PollResult:
        try:
            with self._device_factory(host).session() as s:
                status = s.read_status()
                prev = self._store.get_device_state(status.serial_no)
                self._store.save_status(status)
                if abs(status.clock_offset_seconds) > self._settings.clock_drift_warn_seconds:
                    log.warning("%s 卡機時鐘誤差 %+d 秒，超過 %d 秒；校時由 ZKTime 負責，請檢查",
                                host, status.clock_offset_seconds, self._settings.clock_drift_warn_seconds)

                downloaded, new = False, 0
                if (force_download or prev is None or prev.record_count is None
                        or prev.record_count != status.record_count):
                    punches = s.read_punches()
                    new = self._store.add_punches(status.serial_no, punches)
                    self._store.set_record_count(status.serial_no, status.record_count)
                    downloaded = True

                if force_download or prev is None or prev.users_read_count != status.user_count:
                    self._store.replace_users(status.serial_no, s.read_users())
        except DeviceAuthError as exc:
            self._failures[host] = self._failures.get(host, 0) + 1
            log.error("%s", exc)
            return PollResult(host, None, False, False, 0)
        except DeviceError as exc:
            count = self._failures.get(host, 0) + 1
            self._failures[host] = count
            level = logging.ERROR if count >= self._settings.failure_error_threshold else logging.WARNING
            log.log(level, "連線卡機失敗（連續第 %d 次）：%s", count, exc)
            return PollResult(host, None, False, False, 0)

        self._failures[host] = 0
        if downloaded:
            log.info("%s（%s）紀錄 %d 筆，下載後新增 %d 筆", host, status.serial_no, status.record_count, new)
        else:
            log.info("%s（%s）紀錄 %d 筆，沒有變動", host, status.serial_no, status.record_count)
        return PollResult(host, status.serial_no, True, downloaded, new)

    # 上傳

    def upload_pending(self) -> set[str]:
        """送出所有待上傳的打卡與名單；回傳這輪有成功送出請求的序號。"""
        self._upload_blocked = False
        sent: set[str] = set()
        size = self._settings.upload_batch_size
        dirty_users = {s for s in self._store.known_serials() if self._store.users_to_sync(s) is not None}
        for serial in sorted(set(self._store.serials_with_pending()) | dirty_users):
            state = self._store.get_device_state(serial)
            if state is None:
                continue
            try:
                total = inserted = 0
                while batch := self._store.pending_punches(serial, size):
                    result = self._uploader.send(state, batch)
                    self._store.mark_uploaded(serial, batch)
                    sent.add(serial)
                    total += len(batch)
                    inserted += result.inserted
                    if len(batch) < size:
                        break
                if total:
                    log.info("%s 上傳 %d 筆，雲端新增 %d 筆", serial, total, inserted)

                users = self._store.users_to_sync(serial)
                if users is not None:
                    result = self._uploader.send(state, (), users)
                    self._store.clear_users_dirty(serial)
                    sent.add(serial)
                    log.info("%s 同步使用者名單 %d 位", serial, result.users_synced)
            except UploadError as exc:
                if exc.retryable:
                    log.warning("上傳暫時失敗，資料留在本機，下一輪再送：%s", exc)
                    self._upload_blocked = True
                    return sent
                log.error("%s 上傳被雲端拒收，資料保留在本機：%s", serial, exc)
        return sent

    def send_heartbeats(self, serials: Iterable[str]) -> None:
        for serial in serials:
            state = self._store.get_device_state(serial)
            if state is None:
                continue
            try:
                self._uploader.send(state)
            except UploadError as exc:
                log.warning("%s 狀態回報失敗：%s", serial, exc)

    # 每日對帳

    def _reconcile_due(self, now: datetime, key: str) -> bool:
        return now.time() >= self._settings.reconcile_time and self._store.get_meta(key) != now.date().isoformat()

    def reconcile_if_due(self, now: datetime) -> None:
        """對帳的重送步驟：近 N 天的紀錄全部重送一次，雲端以唯一鍵去重。

        對帳的強制下載步驟在 run_cycle 的輪詢裡完成，避免同一輪連線兩次。
        """
        now = now.astimezone(TAIPEI)
        if not self._reconcile_due(now, _RECONCILE_UPLOAD):
            return
        days = self._settings.reconcile_days
        since = datetime.combine(now.date() - timedelta(days=days), time(0), tzinfo=TAIPEI)
        size = self._settings.upload_batch_size
        received = inserted = 0
        try:
            for serial in self._store.known_serials():
                state = self._store.get_device_state(serial)
                punches = self._store.punches_since(serial, since)
                for i in range(0, len(punches), size):
                    batch = punches[i:i + size]
                    inserted += self._uploader.send(state, batch).inserted
                    received += len(batch)
        except UploadError as exc:
            log.warning("每日對帳重送失敗，下一輪再試：%s", exc)
            return
        self._store.set_meta(_RECONCILE_UPLOAD, now.date().isoformat())
        if inserted:
            log.warning("每日對帳：重送近 %d 天 %d 筆，對帳補傳 %d 筆", days, received, inserted)
        else:
            log.info("每日對帳：重送近 %d 天 %d 筆，雲端沒有缺漏", days, received)

    # 一輪

    def run_cycle(self) -> list[PollResult]:
        now = self._clock().astimezone(TAIPEI)
        results = []
        for host in self._settings.device_hosts:
            key = f"{_RECONCILE_DOWNLOAD}:{host}"
            force = self._reconcile_due(now, key)
            result = self.poll_device(host, force_download=force)
            if force and result.ok:
                self._store.set_meta(key, now.date().isoformat())
                log.info("%s 每日對帳：完整下載與名單同步完成", host)
            results.append(result)

        sent = self.upload_pending()
        if not self._upload_blocked:
            reached = {r.serial_no for r in results if r.ok and r.serial_no}
            self.send_heartbeats(sorted(reached - sent))
            self.reconcile_if_due(now)
        return results
