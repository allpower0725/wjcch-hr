import logging
from dataclasses import replace
from datetime import datetime

import pytest
from zk.exception import ZKNetworkError

from .env import A, B, SETTINGS, SN_A, Env, retryable
from .fakes import make_attendance


@pytest.fixture
def env(tmp_path):
    e = Env(tmp_path)
    e.fakes[A].attendance_list.append(make_attendance("2000", datetime(2026, 10, 18, 8, 0)))
    e.fakes[B].attendance_list.append(make_attendance("2001", datetime(2026, 10, 17, 17, 0)))
    e.at(2026, 10, 19, 2, 0).collector.run_cycle()  # 凌晨 2 點先跑一輪，紀錄都已上傳
    e.uploader.sent.clear()
    for fake in e.fakes.values():
        fake.calls.clear()
    yield e
    e.store.close()


def resent(env):
    """對帳重送的請求：帶打卡、不帶名單。"""
    return [(serial, punches) for serial, punches, users in env.uploader.sent if users is None and punches]


def test_not_due_before_time(env):
    env.at(2026, 10, 19, 3, 29).collector.run_cycle()
    assert "get_attendance" not in env.calls(A)
    assert resent(env) == []


def test_runs_once_per_day(env):
    env.at(2026, 10, 19, 3, 30).collector.run_cycle()
    assert "get_attendance" in env.calls(A) and "get_attendance" in env.calls(B)
    assert len(resent(env)) == 2

    env.uploader.sent.clear()
    for fake in env.fakes.values():
        fake.calls.clear()
    env.at(2026, 10, 19, 3, 35).collector.run_cycle()
    assert "get_attendance" not in env.calls(A) and "get_attendance" not in env.calls(B)
    assert resent(env) == []


def test_catches_up_after_downtime(env):
    env.at(2026, 10, 19, 9, 0).collector.run_cycle()
    assert "get_attendance" in env.calls(A)
    assert len(resent(env)) == 2


def test_runs_again_next_day(env):
    env.at(2026, 10, 19, 3, 30).collector.run_cycle()
    for fake in env.fakes.values():
        fake.calls.clear()
    env.at(2026, 10, 20, 3, 30).collector.run_cycle()
    assert "get_attendance" in env.calls(A)


def test_download_retried_per_host(env):
    env.fakes[B].fail_on["connect"] = ZKNetworkError("down")
    env.at(2026, 10, 19, 3, 30).collector.run_cycle()
    assert "get_attendance" in env.calls(A)

    del env.fakes[B].fail_on["connect"]
    for fake in env.fakes.values():
        fake.calls.clear()
    env.at(2026, 10, 19, 3, 35).collector.run_cycle()
    assert "get_attendance" not in env.calls(A)
    assert "get_attendance" in env.calls(B)


def test_upload_step_retried_without_redownload(env):
    env.uploader.fail_when = lambda serial, punches, users: retryable() if punches else None
    env.at(2026, 10, 19, 3, 30).collector.run_cycle()
    assert resent(env) == []

    env.uploader.fail_when = None
    for fake in env.fakes.values():
        fake.calls.clear()
    env.at(2026, 10, 19, 3, 35).collector.run_cycle()
    assert "get_attendance" not in env.calls(A) and "get_attendance" not in env.calls(B)
    assert len(resent(env)) == 2


def test_reconcile_also_resyncs_users(env):
    env.at(2026, 10, 19, 3, 30).collector.run_cycle()
    assert sum(1 for _, _, users in env.uploader.sent if users is not None) == 2


def test_resend_window_is_seven_taipei_days(tmp_path):
    e = Env(tmp_path, replace(SETTINGS, device_hosts=(A,)))
    e.fakes[A].attendance_list = [
        make_attendance("1", datetime(2026, 10, 11, 23, 59)),
        make_attendance("1", datetime(2026, 10, 12, 0, 0)),
        make_attendance("1", datetime(2026, 10, 19, 1, 0)),
    ]
    e.at(2026, 10, 19, 3, 30).collector.run_cycle()
    serial, punches = resent(e)[-1]
    assert serial == SN_A
    assert [p.punched_at.isoformat() for p in punches] == ["2026-10-12T00:00:00+08:00", "2026-10-19T01:00:00+08:00"]
    e.store.close()


def test_logs_warning_when_backfill_inserted(env, caplog):
    env.uploader.inserted_override = 3
    with caplog.at_level(logging.INFO):
        env.at(2026, 10, 19, 3, 30).collector.run_cycle()
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING and "對帳補傳 6 筆" in r.getMessage()]
    assert len(warnings) == 1


def test_logs_info_when_nothing_missing(env, caplog):
    env.uploader.inserted_override = 0
    with caplog.at_level(logging.INFO):
        env.at(2026, 10, 19, 3, 30).collector.run_cycle()
    assert any("沒有缺漏" in r.getMessage() for r in caplog.records)
    assert not any("對帳補傳" in r.getMessage() for r in caplog.records)
