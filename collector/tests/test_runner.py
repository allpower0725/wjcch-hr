import threading
import time
import json
from dataclasses import replace
from datetime import datetime

from collector.__main__ import main
from collector.config import Settings
from collector.models import iso, to_taipei
from collector.runner import run_forever

NOW = to_taipei(datetime(2026, 10, 19, 16, 0))
FAST = Settings(device_hosts=("192.168.230.190",), poll_interval_seconds=0)
ENV = {"DEVICE_HOSTS": "192.168.230.190", "LOCAL_DB_PASSWORD_FILE": "/secret"}


class FakeCollector:
    def __init__(self, stop=None, errors=(), stop_after=None):
        self.stop = stop
        self.errors = list(errors)
        self.stop_after = stop_after
        self.calls = 0

    def run_cycle(self):
        self.calls += 1
        if self.stop_after and self.calls >= self.stop_after:
            self.stop.set()
        if self.calls <= len(self.errors) and self.errors[self.calls - 1]:
            raise self.errors[self.calls - 1]


class FakeStore:
    closed = False

    def close(self):
        self.closed = True


def test_stop_event_ends_loop_quickly():
    stop = threading.Event()
    collector = FakeCollector()
    thread = threading.Thread(target=run_forever,
                              args=(collector, replace(FAST, poll_interval_seconds=300), stop))
    thread.start()
    deadline = time.monotonic() + 2
    while collector.calls == 0 and time.monotonic() < deadline:
        time.sleep(0.01)
    stop.set()
    thread.join(2)
    assert not thread.is_alive()
    assert collector.calls == 1


def test_cycle_exception_does_not_stop_loop():
    stop = threading.Event()
    collector = FakeCollector(stop, errors=[RuntimeError("boom")], stop_after=2)
    run_forever(collector, FAST, stop)
    assert collector.calls == 2


def test_heartbeat_file_written_each_cycle(tmp_path):
    stop = threading.Event()
    path = tmp_path / "heartbeat"
    run_forever(FakeCollector(stop, stop_after=1), FAST, stop, clock=lambda: NOW, heartbeat_path=path)
    assert path.read_text() == iso(NOW)


def test_no_heartbeat_when_cycle_fails(tmp_path):
    stop = threading.Event()
    path = tmp_path / "heartbeat"
    run_forever(FakeCollector(stop, errors=[RuntimeError("boom")], stop_after=1), FAST, stop,
                clock=lambda: NOW, heartbeat_path=path)
    assert not path.exists()


def test_main_once_exits_zero_with_fake_collector(tmp_path):
    collector, store = FakeCollector(), FakeStore()
    assert main(["once"], env={**ENV, "DATA_DIR": str(tmp_path)}, build=lambda settings: (collector, store)) == 0
    assert collector.calls == 1
    assert store.closed


def test_main_config_error_exits_2():
    assert main(["once"], env={}) == 2


def test_health_rejects_another_mode_and_failed_cycle(tmp_path):
    path = tmp_path / "status.json"
    env = {"DEVICE_HOSTS": "device", "DATA_DIR": str(tmp_path)}
    from datetime import timezone
    state = {"mode": "test", "healthy": True, "checked_at": datetime.now(timezone.utc).isoformat()}
    path.write_text(json.dumps(state))
    assert main(["health"], env=env) == 0
    assert main(["health"], env={**env, "COLLECTOR_MODE": "production"}) == 1
    state["healthy"] = False
    path.write_text(json.dumps(state))
    assert main(["health"], env=env) == 1
