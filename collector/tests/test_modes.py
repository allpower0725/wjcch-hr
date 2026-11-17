import sqlite3
import threading

from collector.runner import run_forever
from collector.store import Store
from collector.lock import InstanceLock
from .env import Env, SN_A, retryable
from .test_store import p


def test_switching_destination_replays_all_history_and_users(tmp_path):
    env = Env(tmp_path)
    env.at(2026, 10, 19, 2, 0).collector.run_cycle()
    assert not env.store.serials_with_pending()
    env.uploader.sent.clear()
    env.uploader.destination = "production:cloud"
    env.collector.run_cycle()
    assert len(env.uploader.punches_sent()) == 5
    assert sum(users is not None for _, _, users in env.uploader.sent) == 2
    env.uploader.sent.clear()
    env.uploader.destination = "unit-test"
    env.collector.run_cycle()
    assert env.uploader.punches_sent() == []
    env.store.close()


def test_old_uploaded_flag_is_not_new_destination_receipt(tmp_path):
    path = tmp_path / "queue.db"
    store = Store(path)
    punch = p("0001", 2026, 1, 1, 8, 0)
    store.add_punches(SN_A, [punch])
    store._conn.execute("ALTER TABLE punch ADD COLUMN uploaded_at TEXT")
    store._conn.execute("UPDATE punch SET uploaded_at = 'old-cloud'")
    store._conn.commit()
    store.close()
    with sqlite3.connect(path) as db:
        db.execute("DROP TABLE delivery")
    store = Store(path, destination="production:new-cloud")
    assert store.pending_punches(SN_A, 10) == [punch]
    store.close()


def test_failed_upload_does_not_report_healthy(tmp_path):
    env = Env(tmp_path, failures=[retryable()])
    stop = threading.Event()
    original = env.collector.run_cycle
    def once():
        original()
        stop.set()
    env.collector.run_cycle = once
    heartbeat = tmp_path / "heartbeat"
    run_forever(env.collector, env.settings, stop, clock=env.clock, heartbeat_path=heartbeat)
    assert not heartbeat.exists()
    assert '"healthy": false' in (tmp_path / "status.json").read_text()
    env.store.close()


def test_same_queue_cannot_run_twice(tmp_path):
    import pytest
    lock = InstanceLock(tmp_path / "lock")
    with pytest.raises(RuntimeError):
        InstanceLock(tmp_path / "lock")
    lock.close()
    InstanceLock(tmp_path / "lock").close()
