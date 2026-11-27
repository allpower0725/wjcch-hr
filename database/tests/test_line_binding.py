"""Exercise employee LINE binding with synthetic identities in wjcch_db_test."""

from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from hashlib import sha256
import os
from pathlib import Path
import sys
from threading import Barrier
from uuid import uuid4

import pytest

ROOT = Path(os.environ.get("HR_WORKSPACE", "/workspace"))
sys.path.insert(0, str(ROOT / "database/tools"))
from personnel import connection


BIRTH_DATE = date(1990, 1, 2)


def token_hash():
    return sha256(uuid4().bytes).digest()


@pytest.fixture
def isolated_db():
    if os.environ.get("HR_INTEGRATION") != "1":
        pytest.skip("Explicit isolated PostgreSQL opt-in required")
    with connection("test") as conn:
        assert conn.execute("SELECT current_database()").fetchone()[0] == "wjcch_db_test"
        yield conn
        conn.rollback()


def synthetic_employee(conn):
    fixture_id = uuid4()
    suffix = fixture_id.hex[:8].upper()
    department = conn.execute(
        "INSERT INTO hr.department(name) VALUES (%s) RETURNING department_id", (f"Synthetic LINE {suffix}",),
    ).fetchone()[0]
    # Z0 matches the column format while staying outside real ID category codes.
    number, national_id = f"LT{suffix}", f"Z0{fixture_id.int % 100_000_000:08d}"
    employee = conn.execute("""
        INSERT INTO hr.employee(employee_no, name, national_id, birth_date, department_id)
        VALUES (%s, 'Synthetic LINE employee', %s, %s, %s) RETURNING employee_id
    """, (number, national_id, BIRTH_DATE, department)).fetchone()[0]
    return employee, number, national_id, department


def start(conn, provider, subject, token):
    return conn.execute("SELECT * FROM hr.begin_line_login(%s, %s, %s)", (provider, subject, token)).fetchone()


def verify(conn, token, national_id, birthday=BIRTH_DATE):
    return conn.execute("SELECT * FROM hr.verify_line_employee(%s, %s, %s)", (token, national_id, birthday)).fetchone()


def confirm(conn, pending, login):
    return conn.execute("SELECT hr.confirm_line_binding(%s, %s)", (pending, login)).fetchone()[0]


def logged_in(conn, token):
    return conn.execute("SELECT * FROM hr.line_login_identity(%s)", (token,)).fetchone()


def expire_window(conn, provider):
    conn.execute("""
        WITH test_time AS (SELECT clock_timestamp() - interval '16 minutes' AS started_at)
        UPDATE hr.line_binding_window
        SET started_at = test_time.started_at, expires_at = test_time.started_at + interval '15 minutes'
        FROM test_time
        WHERE provider_id = %s
    """, (provider,))


def test_shared_window_blocks_fifth_failure_and_reopens_after_deadline(isolated_db):
    conn = isolated_db
    _, _, national_id, _ = synthetic_employee(conn)
    provider = f"synthetic-{uuid4()}"
    first, second, third, fresh = (token_hash() for _ in range(4))
    status, deadline, remaining = start(conn, provider, "line", first)
    assert (status, remaining) == ("binding_required", 5)
    assert conn.execute(
        "SELECT expires_at - started_at FROM hr.line_binding_window WHERE provider_id = %s", (provider,),
    ).fetchone()[0] == timedelta(minutes=15)
    assert verify(conn, first, national_id, date(1990, 1, 3)) == ("mismatch", deadline, 4)
    assert start(conn, provider, "line", second) == ("binding_required", deadline, 4)
    assert verify(conn, second, national_id) == ("matched", deadline, 4)
    for remaining in (3, 2, 1):
        assert verify(conn, first, "synthetic-no-match") == ("mismatch", deadline, remaining)
    assert verify(conn, first, "synthetic-no-match") == ("locked", deadline, 0)
    assert start(conn, provider, "line", third) == ("locked", deadline, 0)
    assert verify(conn, second, national_id) == ("locked", deadline, 0)
    assert confirm(conn, second, token_hash()) == "locked"

    expire_window(conn, provider)
    assert confirm(conn, second, token_hash()) == "expired"
    status, new_deadline, remaining = start(conn, provider, "line", fresh)
    assert (status, remaining) == ("binding_required", 5)
    assert new_deadline > deadline
    assert verify(conn, first, national_id)[0] == "expired"
    assert verify(conn, fresh, national_id) == ("matched", new_deadline, 5)


def test_confirmation_requires_current_match_and_unexpired_window(isolated_db):
    conn = isolated_db
    employee, _, national_id, _ = synthetic_employee(conn)
    provider = f"synthetic-{uuid4()}"
    pending = token_hash()
    start(conn, provider, "line", pending)
    assert confirm(conn, pending, token_hash()) == "match_required"
    assert verify(conn, pending, national_id)[0] == "matched"
    assert verify(conn, pending, "synthetic-no-match")[0] == "mismatch"
    assert confirm(conn, pending, token_hash()) == "match_required"
    assert verify(conn, pending, national_id)[0] == "matched"
    conn.execute("UPDATE hr.employee SET employment_status = 'resigned', resign_date = CURRENT_DATE WHERE employee_id = %s", (employee,))
    assert confirm(conn, pending, token_hash()) == "ineligible"
    assert verify(conn, pending, national_id)[0] == "mismatch"
    conn.execute("UPDATE hr.employee SET employment_status = 'active', resign_date = NULL WHERE employee_id = %s", (employee,))
    assert verify(conn, pending, national_id)[0] == "matched"
    expire_window(conn, provider)
    assert confirm(conn, pending, token_hash()) == "expired"
    assert conn.execute("SELECT count(*) FROM hr.employee_line_binding WHERE provider_id = %s", (provider,)).fetchone()[0] == 0


def test_leave_revoke_rebind_and_resignation(isolated_db):
    conn = isolated_db
    employee, number, national_id, _ = synthetic_employee(conn)
    admin, *_ = synthetic_employee(conn)
    provider = f"synthetic-{uuid4()}"
    pending, login, another_device, new_pending, new_login = (token_hash() for _ in range(5))
    conn.execute("UPDATE hr.employee SET employment_status = 'on_leave' WHERE employee_id = %s", (employee,))
    start(conn, provider, "old", pending)
    assert verify(conn, pending, national_id.lower())[0] == "matched"
    assert logged_in(conn, pending) is None
    assert confirm(conn, pending, login) == "authenticated"
    assert confirm(conn, pending, token_hash()) == "expired"
    assert start(conn, provider, "old", another_device)[0] == "authenticated"
    assert logged_in(conn, login) == logged_in(conn, another_device) == (employee, number)

    # Only a fixture write. The administrator's revoke action is a later phase.
    conn.execute("""
        UPDATE hr.employee_line_binding SET revoked_at = clock_timestamp(), revoked_by_employee_id = %s
        WHERE provider_id = %s AND line_user_id = 'old'
    """, (admin, provider))
    assert logged_in(conn, login) is None
    assert logged_in(conn, another_device) is None
    assert start(conn, provider, "old", token_hash())[0] == "binding_required"
    start(conn, provider, "new", new_pending)
    assert verify(conn, new_pending, national_id)[0] == "matched"
    assert confirm(conn, new_pending, new_login) == "authenticated"
    assert logged_in(conn, new_login) == (employee, number)
    assert logged_in(conn, login) is None
    assert conn.execute("""
        SELECT count(*), count(DISTINCT employee_id), count(revoked_at)
        FROM hr.employee_line_binding WHERE provider_id = %s
    """, (provider,)).fetchone() == (2, 1, 1)

    conn.execute("UPDATE hr.employee SET employment_status = 'resigned', resign_date = CURRENT_DATE WHERE employee_id = %s", (employee,))
    assert logged_in(conn, new_login) is None
    assert start(conn, provider, "new", token_hash())[0] == "ineligible"


def test_concurrent_failures_and_conflicting_employee_bindings(isolated_db):
    conn = isolated_db
    employee, _, national_id, department = synthetic_employee(conn)
    provider = f"synthetic-{uuid4()}"
    attempt_tokens = [token_hash() for _ in range(7)]
    for token in attempt_tokens:
        start(conn, provider, "shared-attempts", token)
    first, second, first_login, second_login = (token_hash() for _ in range(4))
    for subject, pending in (("one", first), ("two", second)):
        start(conn, provider, subject, pending)
        assert verify(conn, pending, national_id)[0] == "matched"
    # Independent PostgreSQL connections need to see the same synthetic fixtures.
    conn.commit()

    def concurrent(operation, inputs):
        barrier = Barrier(len(inputs), timeout=10)

        def run(args):
            with connection("test") as worker:
                worker.execute("SET LOCAL statement_timeout = '10s'")
                barrier.wait()
                return operation(worker, *args)

        with ThreadPoolExecutor(max_workers=len(inputs)) as pool:
            return list(pool.map(run, inputs))

    try:
        attempts = concurrent(verify, [(token, "synthetic-no-match") for token in attempt_tokens])
        assert sorted((status, remaining) for status, _, remaining in attempts) == (
            [("locked", 0)] * 3 + [("mismatch", remaining) for remaining in range(1, 5)]
        )
        assert conn.execute("""
            SELECT failure_count FROM hr.line_binding_window WHERE provider_id = %s AND line_user_id = 'shared-attempts'
        """, (provider,)).fetchone() == (5,)
        outcomes = concurrent(confirm, [(first, first_login), (second, second_login)])
        assert sorted(outcomes) == ["authenticated", "binding_conflict"]
        assert conn.execute("""
            SELECT count(*) FROM hr.employee_line_binding WHERE employee_id = %s AND revoked_at IS NULL
        """, (employee,)).fetchone() == (1,)
    finally:
        conn.rollback()
        with conn.transaction():
            conn.execute("""
                DELETE FROM hr.line_login_session
                WHERE pending_provider_id = %s OR binding_id IN (
                    SELECT binding_id FROM hr.employee_line_binding WHERE provider_id = %s
                )
            """, (provider, provider))
            conn.execute("DELETE FROM hr.employee_line_binding WHERE provider_id = %s", (provider,))
            conn.execute("DELETE FROM hr.line_binding_window WHERE provider_id = %s", (provider,))
            conn.execute("DELETE FROM hr.employee WHERE employee_id = %s", (employee,))
            conn.execute("DELETE FROM hr.department WHERE department_id = %s", (department,))


def test_one_active_employee_per_line_and_expired_login(isolated_db):
    conn = isolated_db
    first, _, first_national_id, _ = synthetic_employee(conn)
    second, second_number, second_national_id, _ = synthetic_employee(conn)
    provider, other_provider = (f"synthetic-{uuid4()}" for _ in range(2))
    pending, competing, first_login, second_login, other_pending = (token_hash() for _ in range(5))
    for token, national_id in ((pending, first_national_id), (competing, second_national_id)):
        assert start(conn, provider, "same-subject", token)[0] == "binding_required"
        assert verify(conn, token, national_id)[0] == "matched"
    assert confirm(conn, pending, first_login) == "authenticated"
    assert confirm(conn, competing, token_hash()) == "binding_conflict"
    assert start(conn, other_provider, "same-subject", other_pending)[0] == "binding_required"
    assert verify(conn, other_pending, second_national_id)[0] == "matched"
    assert confirm(conn, other_pending, second_login) == "authenticated"
    assert logged_in(conn, first_login)[0] == first
    assert logged_in(conn, second_login) == (second, second_number)
    conn.execute("""
        UPDATE hr.line_login_session
        SET created_at = now() - interval '5 hours', expires_at = now() - interval '1 hour'
        WHERE token_hash = %s
    """, (first_login,))
    assert logged_in(conn, first_login) is None
    assert logged_in(conn, second_login) == (second, second_number)


def test_binding_storage_and_functions_are_private(isolated_db):
    conn = isolated_db
    tables = ('employee_line_binding', 'line_binding_window', 'line_login_session')
    assert conn.execute("""
        SELECT count(*), bool_and(c.relrowsecurity AND pg_get_userbyid(c.relowner) = 'hr')
        FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'hr' AND c.relname = ANY(%s)
    """, (list(tables),)).fetchone() == (3, True)
    assert conn.execute("""
        SELECT bool_and(NOT has_table_privilege(r.rolname, c.oid, 'SELECT,INSERT,UPDATE,DELETE'))
        FROM pg_roles AS r CROSS JOIN pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE r.rolname IN ('hr_collector', 'anon', 'authenticated', 'service_role')
          AND n.nspname = 'hr' AND c.relname = ANY(%s)
    """, (list(tables),)).fetchone() == (True,)
    assert conn.execute("""
        SELECT count(DISTINCT p.oid), bool_and(NOT p.prosecdef AND NOT has_function_privilege(r.rolname, p.oid, 'EXECUTE'))
        FROM pg_roles AS r CROSS JOIN pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
        WHERE r.rolname IN ('hr_collector', 'anon', 'authenticated', 'service_role') AND n.nspname = 'hr'
          AND p.proname IN ('begin_line_login', 'verify_line_employee', 'confirm_line_binding', 'line_login_identity')
    """).fetchone() == (4, True)
