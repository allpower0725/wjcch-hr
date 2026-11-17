from datetime import time
from pathlib import Path

import pytest

from collector.config import ConfigError, load_settings

BASE_ENV = {
    "DEVICE_HOSTS": "192.168.230.190,192.168.230.191",
    "LOCAL_DB_PASSWORD_FILE": "/run/secrets/test-password",
}


def test_defaults():
    s = load_settings(BASE_ENV)
    assert s.device_port == 4370
    assert s.device_comm_key == 0
    assert s.device_encoding == "UTF-8"
    assert s.disable_device_during_read is False
    assert s.poll_interval_seconds == 300
    assert s.reconcile_time == time(3, 30)
    assert s.reconcile_days == 7
    assert s.upload_batch_size == 500
    assert s.mode == "test"
    assert s.db_name == "wjcch_db"
    assert s.clock_drift_warn_seconds == 120
    assert s.failure_error_threshold == 6
    assert s.data_dir == Path("/data")


def test_hosts_are_split_and_trimmed():
    s = load_settings({**BASE_ENV, "DEVICE_HOSTS": " 192.168.230.190 , 192.168.230.191 "})
    assert s.device_hosts == ("192.168.230.190", "192.168.230.191")


def test_missing_hosts_raises():
    env = {k: v for k, v in BASE_ENV.items() if k != "DEVICE_HOSTS"}
    with pytest.raises(ConfigError, match="DEVICE_HOSTS"):
        load_settings(env)


def test_missing_password_file_raises_when_database_required():
    env = {k: v for k, v in BASE_ENV.items() if k != "LOCAL_DB_PASSWORD_FILE"}
    with pytest.raises(ConfigError, match="PASSWORD_FILE"):
        load_settings(env)


def test_probe_mode_does_not_need_database_settings():
    s = load_settings({"DEVICE_HOSTS": "192.168.230.190"}, require_database=False)
    assert s.device_hosts == ("192.168.230.190",)


def test_invalid_reconcile_time_raises():
    with pytest.raises(ConfigError, match="RECONCILE_TIME"):
        load_settings({**BASE_ENV, "RECONCILE_TIME": "25:00"})


def test_invalid_integer_raises():
    with pytest.raises(ConfigError, match="POLL_INTERVAL_SECONDS"):
        load_settings({**BASE_ENV, "POLL_INTERVAL_SECONDS": "five"})


def test_test_mode_rejects_cloud():
    with pytest.raises(ConfigError, match="test"):
        load_settings({**BASE_ENV, "LOCAL_DB_HOST": "db.example.com"})


@pytest.mark.parametrize("name,value", [("UPLOAD_BATCH_SIZE", "0"), ("UPLOAD_BATCH_SIZE", "-1"),
    ("UPLOAD_BATCH_SIZE", "1001"), ("POLL_INTERVAL_SECONDS", "0"), ("LOCAL_DB_PORT", "65536"),
    ("RECONCILE_TIME", "03:30+08:00"), ("COLLECTOR_MODE", "prod")])
def test_invalid_ranges(name, value):
    with pytest.raises(ConfigError):
        load_settings({**BASE_ENV, name: value})


def test_production_only_uses_cloud_settings():
    env = {**BASE_ENV, "COLLECTOR_MODE": "production", "LOCAL_DB_PASSWORD_FILE": "broken",
           "LOCAL_DB_HOST": "does-not-exist", "LOCAL_DB_PORT": "not-an-integer",
           "CLOUD_DB_HOST": "db.example.com", "CLOUD_DB_PASSWORD_FILE": "/run/secrets/cloud",
           "CLOUD_DB_SSLROOTCERT": "/run/certs/ca.crt"}
    settings = load_settings(env)
    assert settings.db_host == "db.example.com" and settings.db_name == "postgres"
    assert str(settings.db_password_file) == "/run/secrets/cloud"
    with pytest.raises(ConfigError, match="verify-full"):
        load_settings({**env, "CLOUD_DB_SSLMODE": "require"})


def test_production_can_omit_all_local_database_settings():
    env = {"DEVICE_HOSTS": "unused-device", "COLLECTOR_MODE": "production",
           "COLLECTOR_PROFILE": "production", "CLOUD_DB_HOST": "cloud.example.com",
           "CLOUD_DB_PASSWORD_FILE": "/run/secrets/cloud", "CLOUD_DB_SSLROOTCERT": "/run/certs/ca.crt"}
    assert load_settings(env).db_host == "cloud.example.com"


@pytest.mark.parametrize("mode,profile", [("production", "test"), ("test", "production")])
def test_wrong_compose_profile_is_rejected_before_database_use(mode, profile):
    with pytest.raises(ConfigError, match="部署設定不一致"):
        load_settings({"DEVICE_HOSTS": "unused-device", "COLLECTOR_MODE": mode, "COLLECTOR_PROFILE": profile})


@pytest.mark.parametrize("raw,expected", [
    ("true", True), ("1", True), ("yes", True), ("TRUE", True),
    ("false", False), ("0", False), ("no", False),
])
def test_bool_parsing(raw, expected):
    assert load_settings({**BASE_ENV, "DEVICE_FORCE_UDP": raw}).device_force_udp is expected


def test_invalid_bool_raises():
    with pytest.raises(ConfigError, match="DEVICE_FORCE_UDP"):
        load_settings({**BASE_ENV, "DEVICE_FORCE_UDP": "maybe"})
