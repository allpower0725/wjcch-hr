from datetime import time
from pathlib import Path

import pytest

from collector.config import ConfigError, load_settings

BASE_ENV = {
    "DEVICE_HOSTS": "192.168.230.190,192.168.230.191",
    "INGEST_URL": "https://example.supabase.co/functions/v1/ingest-punches",
    "COLLECTOR_KEY": "test-key",
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
    assert s.ingest_region == "ap-northeast-1"
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


def test_missing_key_raises_when_upload_required():
    env = {k: v for k, v in BASE_ENV.items() if k != "COLLECTOR_KEY"}
    with pytest.raises(ConfigError, match="COLLECTOR_KEY"):
        load_settings(env)


def test_probe_mode_does_not_need_upload_settings():
    s = load_settings({"DEVICE_HOSTS": "192.168.230.190"}, require_upload=False)
    assert s.device_hosts == ("192.168.230.190",)


def test_invalid_reconcile_time_raises():
    with pytest.raises(ConfigError, match="RECONCILE_TIME"):
        load_settings({**BASE_ENV, "RECONCILE_TIME": "25:00"})


def test_invalid_integer_raises():
    with pytest.raises(ConfigError, match="POLL_INTERVAL_SECONDS"):
        load_settings({**BASE_ENV, "POLL_INTERVAL_SECONDS": "five"})


def test_empty_region_means_no_region():
    assert load_settings({**BASE_ENV, "INGEST_REGION": ""}).ingest_region == ""


@pytest.mark.parametrize("raw,expected", [
    ("true", True), ("1", True), ("yes", True), ("TRUE", True),
    ("false", False), ("0", False), ("no", False),
])
def test_bool_parsing(raw, expected):
    assert load_settings({**BASE_ENV, "DEVICE_FORCE_UDP": raw}).device_force_udp is expected


def test_invalid_bool_raises():
    with pytest.raises(ConfigError, match="DEVICE_FORCE_UDP"):
        load_settings({**BASE_ENV, "DEVICE_FORCE_UDP": "maybe"})
