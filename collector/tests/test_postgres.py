"""真實 PostgreSQL 測試；只允許 wjcch_db_test，每個案例最後 rollback。"""
import os
from contextlib import contextmanager
from dataclasses import replace
from datetime import timedelta
from pathlib import Path

import psycopg
import pytest

from collector.config import Settings
from collector.uploader import Uploader, UploadError
from .test_uploader import STATE, PUNCH
from collector.models import DeviceUser

pytestmark = pytest.mark.skipif(os.environ.get("HR_INTEGRATION") != "1", reason="需明確啟用本機 PostgreSQL 整合測試")


@pytest.fixture
def database():
    root = Path(os.environ.get("HR_WORKSPACE", "/workspace"))
    settings = Settings(device_hosts=("fake-device",), db_host=os.environ.get("HR_LOCAL_HOST", "wjcch"),
        db_name="wjcch_db_test", db_password_file=root / "collector/.local/database/secrets/hr_collector_local_password")
    with psycopg.connect(host=settings.db_host, dbname=settings.db_name, user="hr_collector",
                         password=settings.db_password_file.read_text().strip()) as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == "wjcch_db_test"
        conn.rollback()
        # Uploader 的內層交易在此轉為 savepoint，整個案例都不留下模擬資料。
        @contextmanager
        def lease(**kwargs):
            with conn.transaction():
                yield conn
        with conn.transaction(force_rollback=True):
            uploader = Uploader(settings, connect=lease)
            uploader.prepare()
            yield conn, uploader


def test_insert_retry_and_taipei_time(database):
    conn, sender = database
    assert sender.send(STATE, [PUNCH]).inserted == 1
    assert sender.send(STATE, [PUNCH]).inserted == 0
    row = conn.execute("SELECT count(*), min(punched_at AT TIME ZONE 'Asia/Taipei')::text FROM hr.raw_punch").fetchone()
    assert row == (1, "2026-10-19 07:58:12")


def test_raw_conflict_rolls_back_entire_batch(database):
    conn, sender = database
    sender.send(STATE, [PUNCH])
    with pytest.raises(UploadError):
        sender.send(replace(STATE, seen_at=STATE.seen_at + timedelta(minutes=10)),
                    [replace(PUNCH, verify_type=2)])
    assert conn.execute("SELECT last_seen_at FROM hr.punch_device").fetchone()[0] == STATE.seen_at


def test_out_of_range_record_rolls_back_batch(database):
    conn, sender = database
    with pytest.raises(UploadError):
        sender.send(STATE, [PUNCH, replace(PUNCH, device_user_no="bad", verify_type=999)])
    assert conn.execute("SELECT count(*) FROM hr.raw_punch").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM hr.punch_device").fetchone()[0] == 0


def test_old_status_cannot_replace_new(database):
    conn, sender = database
    sender.send(STATE, [PUNCH])
    sender.send(replace(STATE, seen_at=STATE.seen_at - timedelta(hours=1), record_count=99))
    assert conn.execute("SELECT record_count FROM hr.punch_device").fetchone()[0] == STATE.record_count


def test_stale_user_snapshot_cannot_resurrect_removed_user(database):
    conn, sender = database
    sender.send(STATE, users=[DeviceUser("old", "Old")])
    newer = replace(STATE, seen_at=STATE.seen_at + timedelta(hours=1))
    sender.send(newer, users=[DeviceUser("new", "New")])
    # 舊快照中才出現的編號也不能補進較新的完整名單。
    sender.send(STATE, users=[DeviceUser("stale-only", "Stale")])
    assert conn.execute("SELECT count(*) FROM hr.punch_device_user WHERE device_user_no='stale-only'").fetchone()[0] == 0
    assert conn.execute("SELECT users_synced_at FROM hr.punch_device").fetchone()[0] == newer.seen_at


@pytest.mark.parametrize("query", ["SELECT * FROM heal_care.submissions", "SELECT * FROM hr.employee",
    "CREATE TABLE hr.forbidden(id integer)", "SET ROLE hr", "DELETE FROM hr.raw_punch",
    "TRUNCATE hr.raw_punch", "UPDATE hr.raw_punch SET punch_state=2"])
def test_collector_cannot_cross_privilege_boundary(database, query):
    conn, _ = database
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        with conn.transaction():
            conn.execute(query)


def test_runtime_has_no_privileged_role_attributes(database):
    conn, _ = database
    assert conn.execute("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname=current_user").fetchone() == (False,) * 5
