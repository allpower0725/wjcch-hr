"""指令入口：python -m collector <指令>

  run    常駐執行（Docker 預設）：每 POLL_INTERVAL_SECONDS 輪詢一次，含每日對帳
  once   只跑一輪就結束（測試或手動補傳用）
  probe  只讀探測各台卡機，不寫入、不上傳
"""
import argparse
import logging
import os
import sys
import threading
from collections.abc import Callable, Mapping

from .config import ConfigError, Settings, load_settings
from .device import DeviceClient
from .jobs import Collector
from .probe import probe
from .runner import install_signal_handlers, run_forever
from .store import Store
from .uploader import Uploader

log = logging.getLogger("collector")


def build_collector(settings: Settings) -> tuple[Collector, Store]:
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    store = Store(settings.data_dir / "collector.db")
    uploader = Uploader(settings.ingest_url, settings.collector_key, settings.ingest_region)
    collector = Collector(settings, store, uploader, device_factory=lambda host: DeviceClient(host, settings))
    return collector, store


def main(argv: list[str] | None = None, env: Mapping[str, str] | None = None,
         build: Callable[[Settings], tuple] = build_collector) -> int:
    parser = argparse.ArgumentParser(prog="collector", description="打卡收集器")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("run", help="常駐執行")
    sub.add_parser("once", help="只跑一輪")
    sub.add_parser("probe", help="只讀探測各台卡機，不寫入、不上傳")
    args = parser.parse_args(argv)

    try:
        settings = load_settings(os.environ if env is None else env,
                                 require_upload=args.command != "probe")
    except ConfigError as exc:
        print(f"設定錯誤：{exc}", file=sys.stderr)
        return 2

    logging.basicConfig(level=settings.log_level,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if args.command == "probe":
        return probe(settings)

    collector, store = build(settings)
    try:
        if args.command == "once":
            collector.run_cycle()
            return 0
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


if __name__ == "__main__":
    sys.exit(main())
