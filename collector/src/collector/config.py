"""從環境變數（.env）讀取收集器設定。"""
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import time
from pathlib import Path


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    device_hosts: tuple[str, ...]
    device_port: int = 4370
    device_comm_key: int = 0
    device_timeout_seconds: int = 10
    device_force_udp: bool = False
    device_encoding: str = "UTF-8"
    disable_device_during_read: bool = False
    poll_interval_seconds: int = 300
    reconcile_time: time = time(3, 30)
    reconcile_days: int = 7
    ingest_url: str = ""
    ingest_region: str = "ap-northeast-1"
    collector_key: str = ""
    upload_batch_size: int = 500
    clock_drift_warn_seconds: int = 120
    failure_error_threshold: int = 6
    data_dir: Path = Path("/data")
    log_level: str = "INFO"


_TRUE = {"true", "1", "yes", "on"}
_FALSE = {"false", "0", "no", "off"}


def _int(env: Mapping[str, str], name: str, default: int) -> int:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        raise ConfigError(f"{name} 必須是整數，目前是 {raw!r}") from None


def _bool(env: Mapping[str, str], name: str, default: bool) -> bool:
    raw = env.get(name, "").strip().lower()
    if not raw:
        return default
    if raw in _TRUE:
        return True
    if raw in _FALSE:
        return False
    raise ConfigError(f"{name} 必須是 true 或 false，目前是 {raw!r}")


def _time(env: Mapping[str, str], name: str, default: time) -> time:
    raw = env.get(name, "").strip()
    if not raw:
        return default
    try:
        return time.fromisoformat(raw)
    except ValueError:
        raise ConfigError(f"{name} 必須是 HH:MM 格式的時間，目前是 {raw!r}") from None


def load_settings(env: Mapping[str, str], *, require_upload: bool = True) -> Settings:
    hosts = tuple(h.strip() for h in env.get("DEVICE_HOSTS", "").split(",") if h.strip())
    if not hosts:
        raise ConfigError("DEVICE_HOSTS 未設定，請填卡機 IP，多台以逗號分隔")

    ingest_url = env.get("INGEST_URL", "").strip()
    collector_key = env.get("COLLECTOR_KEY", "").strip()
    if require_upload:
        if not ingest_url:
            raise ConfigError("INGEST_URL 未設定")
        if not collector_key:
            raise ConfigError("COLLECTOR_KEY 未設定")

    d = Settings(device_hosts=hosts)
    return Settings(
        device_hosts=hosts,
        device_port=_int(env, "DEVICE_PORT", d.device_port),
        device_comm_key=_int(env, "DEVICE_COMM_KEY", d.device_comm_key),
        device_timeout_seconds=_int(env, "DEVICE_TIMEOUT_SECONDS", d.device_timeout_seconds),
        device_force_udp=_bool(env, "DEVICE_FORCE_UDP", d.device_force_udp),
        device_encoding=env.get("DEVICE_ENCODING", "").strip() or d.device_encoding,
        disable_device_during_read=_bool(env, "DISABLE_DEVICE_DURING_READ", d.disable_device_during_read),
        poll_interval_seconds=_int(env, "POLL_INTERVAL_SECONDS", d.poll_interval_seconds),
        reconcile_time=_time(env, "RECONCILE_TIME", d.reconcile_time),
        reconcile_days=_int(env, "RECONCILE_DAYS", d.reconcile_days),
        ingest_url=ingest_url,
        ingest_region=env.get("INGEST_REGION", d.ingest_region).strip(),
        collector_key=collector_key,
        upload_batch_size=_int(env, "UPLOAD_BATCH_SIZE", d.upload_batch_size),
        clock_drift_warn_seconds=_int(env, "CLOCK_DRIFT_WARN_SECONDS", d.clock_drift_warn_seconds),
        failure_error_threshold=_int(env, "FAILURE_ERROR_THRESHOLD", d.failure_error_threshold),
        data_dir=Path(env.get("DATA_DIR", "").strip() or d.data_dir),
        log_level=env.get("LOG_LEVEL", "").strip().upper() or d.log_level,
    )
