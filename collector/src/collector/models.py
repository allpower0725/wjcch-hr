"""收集器共用的資料型別與時間工具。

卡機時間是不帶時區的台北當地時間；進入收集器後一律標上 Asia/Taipei，
對外一律輸出成 +08:00 格式的 ISO 字串。
"""
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

TAIPEI = ZoneInfo("Asia/Taipei")


def to_taipei(naive: datetime) -> datetime:
    """把卡機讀到的當地時間標上台北時區。"""
    if naive.tzinfo is not None:
        raise ValueError(f"預期不帶時區的時間，卻收到 {naive!r}")
    return naive.replace(tzinfo=TAIPEI)


def iso(dt: datetime) -> str:
    """轉成台北時間的 ISO 字串，例如 2026-10-19T07:58:12+08:00（不含微秒）。"""
    return dt.astimezone(TAIPEI).replace(microsecond=0).isoformat()


def now_taipei() -> datetime:
    return datetime.now(TAIPEI)


@dataclass(frozen=True)
class Punch:
    device_user_no: str
    punched_at: datetime  # 帶台北時區
    verify_type: int
    punch_state: int


@dataclass(frozen=True)
class DeviceUser:
    device_user_no: str
    name: str


@dataclass(frozen=True)
class DeviceStatus:
    host: str
    serial_no: str
    model: str
    firmware_version: str
    record_count: int
    user_count: int
    seen_at: datetime  # 收集器讀取狀態的時間（帶時區）
    clock_offset_seconds: int  # 卡機時間減 seen_at 的秒數
