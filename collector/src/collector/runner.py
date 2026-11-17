"""常駐迴圈：每隔 POLL_INTERVAL_SECONDS 跑一輪，收到 SIGTERM／SIGINT 時收尾結束。"""
import logging
import signal
import threading
import json
from collections.abc import Callable
from datetime import datetime
from pathlib import Path
from time import monotonic

from .config import Settings
from .models import iso, now_taipei

log = logging.getLogger(__name__)


def write_heartbeat(path: Path, now: datetime) -> None:
    """寫入健康檢查檔，Docker healthcheck 用它判斷收集器是否還在正常運作。"""
    path.write_text(iso(now))


def install_signal_handlers(stop: threading.Event) -> None:
    def handle(signum, _frame):
        log.info("收到 %s，這一輪結束後停止", signal.Signals(signum).name)
        stop.set()

    signal.signal(signal.SIGTERM, handle)
    signal.signal(signal.SIGINT, handle)


def run_forever(collector, settings: Settings, stop: threading.Event,
                clock: Callable[[], datetime] = now_taipei,
                heartbeat_path: Path | None = None) -> None:
    interval = settings.poll_interval_seconds
    while not stop.is_set():
        started = monotonic()
        try:
            collector.run_cycle()
        except Exception:
            log.exception("這一輪發生未預期的錯誤，下一輪繼續")
        else:
            if heartbeat_path is not None and getattr(collector, "healthy", True):
                write_heartbeat(heartbeat_path, clock())
        if heartbeat_path is not None:
            state = {"mode": settings.mode, "checked_at": clock().isoformat(),
                     "healthy": getattr(collector, "healthy", False)}
            temp = heartbeat_path.with_name("status.json.tmp")
            temp.write_text(json.dumps(state), encoding="utf-8")
            temp.replace(heartbeat_path.with_name("status.json"))
        remaining = interval - (monotonic() - started)
        if remaining > 0:
            stop.wait(remaining)
