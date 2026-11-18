"""Meaningful personnel constraints and temporal joins, only in wjcch_db_test."""
import os
from pathlib import Path
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import psycopg
import pytest

ROOT = Path(os.environ.get("HR_WORKSPACE", "/workspace"))
sys.path.insert(0, str(ROOT / "database/tools"))
from personnel import connection


@pytest.fixture
def db():
    if os.environ.get("HR_INTEGRATION") != "1":
        pytest.skip("Explicit isolated PostgreSQL opt-in required")
    with connection("test") as conn:
        assert conn.info.dbname == "wjcch_db_test"
        with conn.transaction(force_rollback=True):
            department = conn.execute("INSERT INTO hr.department(name) VALUES ('Synthetic department') RETURNING department_id").fetchone()[0]
            employee = conn.execute("INSERT INTO hr.employee(employee_no,name,department_id) VALUES ('T-SYNTH','Synthetic',%s) RETURNING employee_id", (department,)).fetchone()[0]
            yield conn, employee


def test_licenses_have_unknown_expired_future_and_inclusive_validity(db):
    conn, employee = db
    kind = conn.execute("INSERT INTO hr.license_type(name) VALUES ('Synthetic license') RETURNING license_type_id").fetchone()[0]
    today = datetime.now(ZoneInfo("Asia/Taipei")).date()
    cases = [(None, None, False, 'validity_unknown'),
             (today-timedelta(days=10), today-timedelta(days=1), False, 'expired'),
             (today+timedelta(days=1), today+timedelta(days=10), False, 'not_yet_valid'),
             (today, today, False, 'valid'),
             (today-timedelta(days=1), None, True, 'valid'),
             (today-timedelta(days=2), None, False, 'validity_unknown')]
    for start, end, no_expiry, status in cases:
        record = conn.execute("INSERT INTO hr.employee_license(employee_id,license_type_id,valid_from,valid_to,has_no_expiry) VALUES (%s,%s,%s,%s,%s) RETURNING employee_license_id",
                              (employee, kind, start, end, no_expiry)).fetchone()[0]
        assert conn.execute("SELECT validity_status FROM hr.v_employee_license WHERE employee_license_id=%s", (record,)).fetchone()[0] == status
    for values in [(today, today-timedelta(days=1), False), (today, today, True)]:
        with pytest.raises(psycopg.errors.CheckViolation):
            with conn.transaction():
                conn.execute("INSERT INTO hr.employee_license(employee_id,license_type_id,valid_from,valid_to,has_no_expiry) VALUES (%s,%s,%s,%s,%s)", (employee, kind, *values))


def test_mapping_is_unique_per_machine_and_uses_confirmation_time(db):
    conn, employee = db
    device = conn.execute("INSERT INTO hr.punch_device(serial_no,name) VALUES ('SYNTHETIC-MAP','Synthetic') RETURNING punch_device_id").fetchone()[0]
    confirmed = datetime(2026, 11, 17, 12, tzinfo=ZoneInfo("Asia/Taipei"))
    conn.execute("INSERT INTO hr.employee_device_mapping(employee_id,punch_device_id,device_user_no,confirmed_at) VALUES (%s,%s,'0007',%s)", (employee, device, confirmed))
    with pytest.raises(psycopg.errors.UniqueViolation):
        with conn.transaction():
            conn.execute("INSERT INTO hr.employee_device_mapping(employee_id,punch_device_id,device_user_no) VALUES (%s,%s,'0007')", (employee, device))
    for stamp in (confirmed-timedelta(days=1), confirmed, confirmed+timedelta(days=1)):
        conn.execute("INSERT INTO hr.raw_punch(punch_device_id,device_user_no,punched_at,verify_type,punch_state) VALUES (%s,'0007',%s,1,0)", (device, stamp))
    actual = conn.execute("SELECT employee_id,candidate_employee_no,association_status FROM hr.v_punch_employee WHERE punch_device_id=%s ORDER BY punched_at", (device,)).fetchall()
    assert actual == [(None,'T-SYNTH','history_pending'), (employee,'T-SYNTH','matched'), (employee,'T-SYNTH','matched')]


def test_same_account_number_on_different_machines_resolves_by_machine(db):
    conn, employee = db
    devices = conn.execute("""INSERT INTO hr.punch_device(serial_no,name)
        VALUES ('SYNTHETIC-A','Synthetic'), ('SYNTHETIC-B','Synthetic') RETURNING punch_device_id""").fetchall()
    confirmed = datetime(2026, 11, 1, tzinfo=ZoneInfo("Asia/Taipei"))
    second = conn.execute("INSERT INTO hr.employee(employee_no,name,department_id) SELECT 'T-SECOND','Second',department_id FROM hr.employee WHERE employee_id=%s RETURNING employee_id", (employee,)).fetchone()[0]
    for (device,), person in zip(devices, (employee, second)):
        conn.execute("INSERT INTO hr.employee_device_mapping(employee_id,punch_device_id,device_user_no,confirmed_at) VALUES (%s,%s,'007',%s)", (person,device,confirmed))
        conn.execute("INSERT INTO hr.raw_punch(punch_device_id,device_user_no,punched_at,verify_type,punch_state) VALUES (%s,'007',%s,1,0)", (device,confirmed))
        assert conn.execute("SELECT employee_id,association_status FROM hr.v_punch_employee WHERE punch_device_id=%s", (device,)).fetchall() == [(person,'matched')]


def test_collector_cannot_read_personnel_extensions_or_views(db):
    conn, _ = db
    protected = ('job_duty','employee_education','license_type','employee_license',
                 'employee_device_mapping',
                 'v_punch_employee','v_employee_license')
    for table in protected:
        assert not conn.execute("SELECT has_table_privilege('hr_collector',%s,'SELECT')", (f"hr.{table}",)).fetchone()[0]
    assert conn.execute("SELECT bool_and(relrowsecurity) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hr' AND c.relkind='r'").fetchone()[0]
