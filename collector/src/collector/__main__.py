"""指令入口：python -m collector <指令>"""
import argparse
import logging
import os
import sys

from .config import ConfigError, load_settings
from .probe import probe


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="collector", description="打卡收集器")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("probe", help="只讀探測各台卡機，不寫入、不上傳")
    args = parser.parse_args(argv)

    try:
        settings = load_settings(os.environ, require_upload=args.command != "probe")
    except ConfigError as exc:
        print(f"設定錯誤：{exc}", file=sys.stderr)
        return 2

    logging.basicConfig(level=settings.log_level,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if args.command == "probe":
        return probe(settings)
    return 2


if __name__ == "__main__":
    sys.exit(main())
