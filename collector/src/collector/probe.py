"""現場探測：只讀連線各台卡機，印出設定收集器需要的資訊。

不寫 SQLite、不上傳；姓名只顯示前 5 位，用來判斷卡機的文字編碼。
"""
from collections import Counter
from collections.abc import Callable
from datetime import timedelta
from time import monotonic

from .config import Settings
from .device import DeviceClient
from .models import iso

_SAMPLE = 5


def _distribution(counter: Counter) -> str:
    return "、".join(f"{k}：{v} 筆" for k, v in sorted(counter.items()))


def _decode_candidates(raw: str) -> str:
    data = raw.encode("latin-1")
    return " ｜ ".join(f"{enc}={data.decode(enc, errors='replace')}" for enc in ("utf-8", "cp950"))


def _probe_one(host: str, settings: Settings, out: Callable[[str], None],
               client_factory: Callable[[str, Settings], DeviceClient]) -> None:
    started = monotonic()
    with client_factory(host, settings).session() as s:
        out(f"連線方式：{'TCP' if getattr(s.zk, 'tcp', False) else 'UDP'}，"
            f"連線耗時 {monotonic() - started:.2f} 秒")

        status = s.read_status()
        try:
            platform = s.zk.get_platform()
        except Exception:
            platform = "（讀不到）"
        device_time = status.seen_at + timedelta(seconds=status.clock_offset_seconds)
        out(f"序號：{status.serial_no}")
        out(f"型號：{status.model}　平台：{platform}　韌體：{status.firmware_version}")
        out(f"使用者：{status.user_count} 位　打卡紀錄：{status.record_count} 筆"
            f"（容量 {getattr(s.zk, 'rec_cap', '?')}）")
        out(f"卡機時間：{iso(device_time)}　時鐘誤差：{status.clock_offset_seconds:+d} 秒")

        t0 = monotonic()
        punches = s.read_punches()
        out(f"完整下載：{len(punches)} 筆，耗時 {monotonic() - t0:.2f} 秒")
        if punches:
            times = sorted(p.punched_at for p in punches)
            out(f"最早：{iso(times[0])}　最晚：{iso(times[-1])}")
            out(f"verify_type 分布：{_distribution(Counter(p.verify_type for p in punches))}")
            out(f"punch_state 分布：{_distribution(Counter(p.punch_state for p in punches))}")
            numbers = sorted({p.device_user_no for p in punches})
            out(f"打卡的編號：{len(numbers)} 個，長度分布："
                f"{_distribution(Counter(len(n) for n in numbers))}，"
                f"有前導 0 的：{sum(1 for n in numbers if len(n) > 1 and n.startswith('0'))} 個，"
                f"樣本：{', '.join(numbers[:_SAMPLE])}")

        raw_users = s.zk.get_users()
        out(f"使用者名單：{len(raw_users)} 位；前 {_SAMPLE} 位姓名的解碼結果：")
        for u in raw_users[:_SAMPLE]:
            out(f"  {u.user_id}：{_decode_candidates(u.name)}")
    out(f"總連線時間：{monotonic() - started:.2f} 秒")


def probe(settings: Settings, out: Callable[[str], None] = print,
          client_factory: Callable[[str, Settings], DeviceClient] = DeviceClient) -> int:
    rc = 0
    for host in settings.device_hosts:
        out(f"=== {host} ===")
        try:
            _probe_one(host, settings, out, client_factory)
        except Exception as exc:
            out(f"失敗：{type(exc).__name__}: {exc}")
            rc = 1
    return rc
