"""從環境變數（.env）讀取收集器設定。"""
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import time
from pathlib import Path
import codecs


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
    mode: str = "test"
    db_host: str = "localhost"
    db_port: int = 5432
    db_name: str = "wjcch_db"
    db_user: str = "hr_collector"
    db_password_file: Path = Path("/run/secrets/hr_collector_password")
    db_sslmode: str = "disable"
    db_sslrootcert: str = ""
    db_timeout_seconds: int = 15
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
        value = int(raw)
    except ValueError:
        raise ConfigError(f"{name} 必須是整數，目前是 {raw!r}") from None
    minimum = 0 if name in {"DEVICE_COMM_KEY", "CLOCK_DRIFT_WARN_SECONDS"} else 1
    maximum = 65535 if name.endswith("PORT") else 1000 if name == "UPLOAD_BATCH_SIZE" else 2147483647
    if not minimum <= value <= maximum:
        raise ConfigError(f"{name} 必須介於 {minimum} 與 {maximum}")
    return value


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
        value = time.fromisoformat(raw)
        if value.tzinfo is not None or len(raw) != 5:
            raise ValueError
        return value
    except ValueError:
        raise ConfigError(f"{name} 必須是 HH:MM 格式的時間，目前是 {raw!r}") from None


def load_settings(env: Mapping[str, str], *, require_database: bool = True) -> Settings:
    hosts = tuple(h.strip() for h in env.get("DEVICE_HOSTS", "").split(",") if h.strip())
    if not hosts:
        raise ConfigError("DEVICE_HOSTS 未設定，請填卡機 IP，多台以逗號分隔")

    mode = env.get("COLLECTOR_MODE", "test").strip()
    if mode not in {"test", "production"}:
        raise ConfigError("COLLECTOR_MODE 必須是 test 或 production")
    profile = env.get("COLLECTOR_PROFILE", "").strip()
    if profile and profile != mode:
        raise ConfigError("COLLECTOR_MODE 與部署設定不一致：production 請使用 docker-compose.yml，test 請使用 docker-compose.test.yml")
    prefix = "LOCAL_DB_" if mode == "test" else "CLOUD_DB_"
    host = env.get(prefix + "HOST", "localhost" if mode == "test" else "").strip()
    name = env.get(prefix + "NAME", "wjcch_db" if mode == "test" else "postgres").strip()
    sslmode = env.get(prefix + "SSLMODE", "disable" if mode == "test" else "verify-full").strip()
    ca = env.get(prefix + "SSLROOTCERT", "").strip()
    password_file = env.get(prefix + "PASSWORD_FILE", "").strip()
    user = env.get(prefix + "USER", "hr_collector").strip()
    if require_database:
        if not host or not password_file:
            raise ConfigError(f"{prefix}HOST 與 {prefix}PASSWORD_FILE 必填")
        local_hosts = {"localhost", "127.0.0.1", "::1", "wjcch", "host.docker.internal"}
        if mode == "test" and (host not in local_hosts or name not in {"wjcch_db", "wjcch_db_test"}):
            raise ConfigError("test 只允許指定的本機 PostgreSQL 主庫或測試庫")
        if mode == "production" and (host in local_hosts or sslmode != "verify-full" or not ca):
            raise ConfigError("production 必須使用雲端主機、verify-full 與 SSLROOTCERT")
        if user.split(".")[0] != "hr_collector":
            raise ConfigError("collector 必須使用專用 hr_collector 帳號")
    encoding = env.get("DEVICE_ENCODING", "UTF-8").strip() or "UTF-8"
    try:
        codecs.lookup(encoding)
    except LookupError:
        raise ConfigError("DEVICE_ENCODING 不是支援的編碼") from None
    level = env.get("LOG_LEVEL", "INFO").strip().upper() or "INFO"
    if level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        raise ConfigError("LOG_LEVEL 無效")

    d = Settings(device_hosts=hosts)
    return Settings(
        device_hosts=hosts,
        device_port=_int(env, "DEVICE_PORT", d.device_port),
        device_comm_key=_int(env, "DEVICE_COMM_KEY", d.device_comm_key),
        device_timeout_seconds=_int(env, "DEVICE_TIMEOUT_SECONDS", d.device_timeout_seconds),
        device_force_udp=_bool(env, "DEVICE_FORCE_UDP", d.device_force_udp),
        device_encoding=encoding,
        disable_device_during_read=_bool(env, "DISABLE_DEVICE_DURING_READ", d.disable_device_during_read),
        poll_interval_seconds=_int(env, "POLL_INTERVAL_SECONDS", d.poll_interval_seconds),
        reconcile_time=_time(env, "RECONCILE_TIME", d.reconcile_time),
        reconcile_days=_int(env, "RECONCILE_DAYS", d.reconcile_days),
        mode=mode, db_host=host, db_port=_int(env, prefix + "PORT", 5432),
        db_name=name, db_user=user,
        db_password_file=Path(password_file or d.db_password_file),
        db_sslmode=sslmode, db_sslrootcert=ca,
        db_timeout_seconds=_int(env, "DB_TIMEOUT_SECONDS", d.db_timeout_seconds),
        upload_batch_size=_int(env, "UPLOAD_BATCH_SIZE", d.upload_batch_size),
        clock_drift_warn_seconds=_int(env, "CLOCK_DRIFT_WARN_SECONDS", d.clock_drift_warn_seconds),
        failure_error_threshold=_int(env, "FAILURE_ERROR_THRESHOLD", d.failure_error_threshold),
        data_dir=Path(env.get("DATA_DIR", "").strip() or d.data_dir),
        log_level=level,
    )
