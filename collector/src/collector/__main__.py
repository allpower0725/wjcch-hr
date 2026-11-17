"""指令入口：python -m collector <指令>

  run    常駐執行（Docker 預設）：每 POLL_INTERVAL_SECONDS 輪詢一次，含每日對帳
  once   只跑一輪就結束（測試或手動補傳用）
  probe  只讀探測各台卡機，不寫入、不上傳
  sync   只補送 SQLite，不連線卡機
  health 檢查最近一輪的收集與寫入狀態
"""
import argparse
import logging
import os
import sys
import threading
import json
from datetime import datetime
from collections.abc import Callable, Mapping

from .config import ConfigError, Settings, load_settings
from .device import DeviceClient
from .jobs import Collector
from .probe import probe
from .runner import install_signal_handlers, run_forever
from .store import Store
from .uploader import Uploader
from .lock import InstanceLock

log = logging.getLogger("collector")


def build_collector(settings: Settings) -> tuple[Collector, Store]:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(settings.data_dir / "collector.db")
    uploader = Uploader(settings)
    collector = Collector(settings, store, uploader, device_factory=lambda host: DeviceClient(host, settings))
    return collector, store


def main(argv: list[str] | None = None, env: Mapping[str, str] | None = None,
         build: Callable[[Settings], tuple] = build_collector) -> int:
    parser = argparse.ArgumentParser(prog="collector", description="打卡收集器")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run", help="常駐執行")
    sub.add_parser("once", help="只跑一輪")
    sub.add_parser("probe", help="只讀探測各台卡機，不寫入、不上傳")
    sub.add_parser("sync", help="只補送 SQLite，不連線卡機")
    sub.add_parser("health", help="檢查收集與目的地寫入狀態")
    args = parser.parse_args(argv)

    try:
        settings = load_settings(os.environ if env is None else env,
                                 require_database=args.command not in {"probe", "health"})
    except ConfigError as exc:
        print(f"設定錯誤：{exc}", file=sys.stderr)
        return 2

    logging.basicConfig(level=settings.log_level,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if args.command == "probe":
        return probe(settings)
    if args.command == "health":
        try:
            state = json.loads((settings.data_dir / "status.json").read_text(encoding="utf-8"))
            age = (datetime.now().astimezone() - datetime.fromisoformat(state["checked_at"])).total_seconds()
            return 0 if (state["healthy"] and state["mode"] == settings.mode
                         and 0 <= age < max(900, settings.poll_interval_seconds * 3)) else 1
        except (OSError, ValueError, KeyError, TypeError):
            return 1

    settings.data_dir.mkdir(parents=True, exist_ok=True)
    try:
        instance_lock = InstanceLock(settings.data_dir / "collector.lock")
    except RuntimeError as exc:
        log.error("%s", exc)
        return 2
    try:
        collector, store = build(settings)
    except Exception:
        instance_lock.close()
        raise
    try:
        log.info("模式 %s；目的地 %s:%d/%s.hr；登入角色 %s", settings.mode,
                 settings.db_host, settings.db_port, settings.db_name, settings.db_user)
        if args.command == "sync":
            return 0 if collector.sync_only() else 1
        if args.command == "once":
            collector.run_cycle()
            return 0 if getattr(collector, "healthy", True) else 1
        log.info("收集器啟動：卡機 %s，每 %d 秒輪詢，每日 %s 對帳（近 %d 天）",
                 "、".join(settings.device_hosts), settings.poll_interval_seconds,
                 settings.reconcile_time.strftime("%H:%M"), settings.reconcile_days)
        stop = threading.Event()
        install_signal_handlers(stop)
        run_forever(collector, settings, stop, heartbeat_path=settings.data_dir / "heartbeat")
        log.info("收集器已停止")
        return 0
    finally:
        store.close()
        instance_lock.close()


if __name__ == "__main__":
    sys.exit(main())
