"""卡機存取：短連線、只讀。

這裡只會呼叫讀取類的 pyzk 方法；不清紀錄、不校時、不改使用者、不讀指紋。
disable_device() 只在設定 DISABLE_DEVICE_DURING_READ=true 時使用，且一定在 finally 恢復。
"""
import logging
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import datetime
from functools import wraps
from typing import Any

from zk import ZK
from zk.exception import ZKError

from .config import Settings
from .models import DeviceStatus, DeviceUser, Punch, now_taipei, to_taipei

log = logging.getLogger(__name__)

# pyzk 以 latin-1 解碼姓名時可逐位元組還原，再用設定的編碼重新解碼，不會遺失資料
_RAW_ENCODING = "latin-1"


class DeviceError(Exception):
    """連不上、逾時或通訊錯誤。"""


class DeviceAuthError(DeviceError):
    """卡機通訊密碼錯誤。"""


def _wrap(host: str, exc: Exception) -> DeviceError:
    if "Unauthenticated" in str(exc):
        return DeviceAuthError(f"{host} 通訊密碼錯誤，請檢查 DEVICE_COMM_KEY")
    return DeviceError(f"{host}: {type(exc).__name__}: {exc}")


def _guarded(method):
    @wraps(method)
    def wrapper(self, *args, **kwargs):
        try:
            return method(self, *args, **kwargs)
        except (ZKError, OSError) as exc:
            raise _wrap(self.host, exc) from exc
    return wrapper


class DeviceSession:
    def __init__(self, host: str, zk: Any, settings: Settings, clock: Callable[[], datetime]):
        self.host = host
        self.zk = zk
        self._settings = settings
        self._clock = clock

    @_guarded
    def read_status(self) -> DeviceStatus:
        self.zk.read_sizes()
        serial_no = self.zk.get_serialnumber()
        model = self.zk.get_device_name() or self._platform()
        firmware = self.zk.get_firmware_version()
        device_time = self.zk.get_time()
        seen_at = self._clock()
        return DeviceStatus(
            host=self.host,
            serial_no=serial_no,
            model=model,
            firmware_version=firmware,
            record_count=self.zk.records,
            user_count=self.zk.users,
            seen_at=seen_at,
            clock_offset_seconds=round((to_taipei(device_time) - seen_at).total_seconds()),
        )

    def _platform(self) -> str:
        try:
            return self.zk.get_platform()
        except ZKError:
            return ""

    @_guarded
    def read_punches(self) -> list[Punch]:
        if self._settings.disable_device_during_read:
            self.zk.disable_device()
            try:
                records = self.zk.get_attendance()
            finally:
                self.zk.enable_device()
        else:
            records = self.zk.get_attendance()
        # 沒有使用者編號的紀錄無法歸屬，而且雲端會拒收整批，所以略過並記警告
        punches = [
            Punch(str(r.user_id).strip(), to_taipei(r.timestamp), int(r.status), int(r.punch))
            for r in records
        ]
        valid = [p for p in punches if p.device_user_no]
        if len(valid) < len(punches):
            log.warning("%s 有 %d 筆打卡沒有使用者編號，已略過", self.host, len(punches) - len(valid))
        return valid

    @_guarded
    def read_users(self) -> list[DeviceUser]:
        users = []
        for u in self.zk.get_users():
            if not str(u.user_id).strip():
                continue
            name = u.name
            if name == f"NN-{u.user_id}":  # pyzk 對沒有姓名的使用者自動填的名字
                name = ""
            else:
                name = name.encode(_RAW_ENCODING).decode(self._settings.device_encoding, errors="replace")
            users.append(DeviceUser(str(u.user_id), name))
        return users


class DeviceClient:
    def __init__(self, host: str, settings: Settings,
                 zk_factory: Callable[..., Any] = ZK,
                 clock: Callable[[], datetime] = now_taipei) -> None:
        self.host = host
        self._settings = settings
        self._zk_factory = zk_factory
        self._clock = clock

    @contextmanager
    def session(self) -> Iterator[DeviceSession]:
        s = self._settings
        zk = self._zk_factory(
            self.host,
            port=s.device_port,
            timeout=s.device_timeout_seconds,
            password=s.device_comm_key,
            force_udp=s.device_force_udp,
            ommit_ping=True,
            encoding=_RAW_ENCODING,
        )
        try:
            conn = zk.connect()
        except (ZKError, OSError) as exc:
            raise _wrap(self.host, exc) from exc
        try:
            yield DeviceSession(self.host, conn, s, self._clock)
        finally:
            try:
                conn.disconnect()
            except Exception as exc:  # 斷線失敗不影響已讀到的資料
                log.warning("%s 斷線時發生錯誤：%s", self.host, exc)
