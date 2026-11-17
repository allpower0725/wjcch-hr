import logging
from dataclasses import replace
from datetime import datetime

import pytest
from zk.exception import ZKNetworkError

from collector.uploader import UploadError

from .env import SETTINGS, SN_A, SN_B, A, B, Env, atts, retryable
from .fakes import make_attendance, make_user


@pytest.fixture
def env(tmp_path):
    e = Env(tmp_path)
    yield e
    e.store.close()


def test_first_poll_downloads_everything(env):
    result = env.collector.poll_device(A)
    assert result.ok and result.downloaded
    assert result.serial_no == SN_A
    assert result.new_punches == 3
    assert env.store.get_device_state(SN_A).record_count == 3


def test_unchanged_count_skips_download(env):
    env.collector.poll_device(A)
    env.fakes[A].calls.clear()
    result = env.collector.poll_device(A)
    assert result.ok and not result.downloaded
    assert "get_attendance" not in env.fakes[A].calls
    assert env.fakes[A].calls[-1] == "disconnect"


def test_increased_count_uploads_only_new(env):
    env.collector.run_cycle()
    env.uploader.sent.clear()
    new = [make_attendance("2000", datetime(2026, 10, 19, 15, 0)), make_attendance("2001", datetime(2026, 10, 19, 15, 1))]
    env.fakes[A].attendance_list += new
    env.collector.run_cycle()
    assert [p.device_user_no for p in env.uploader.punches_sent(SN_A)] == ["2000", "2001"]
    assert env.uploader.punches_sent(SN_B) == []


def test_decreased_count_still_diffs(env):
    env.fakes[A].attendance_list = atts(10)
    env.collector.poll_device(A)
    env.fakes[A].attendance_list = env.fakes[A].attendance_list[5:] + [make_attendance("3000", datetime(2026, 10, 19, 9, 0))]
    result = env.collector.poll_device(A)
    assert result.downloaded
    assert result.new_punches == 1


def test_failed_download_keeps_old_count(env):
    env.collector.poll_device(A)
    env.fakes[A].attendance_list += atts(1, start=datetime(2026, 10, 19, 9, 0))
    env.fakes[A].fail_on["get_attendance"] = ZKNetworkError("timed out")
    assert env.collector.poll_device(A).ok is False
    assert env.store.get_device_state(SN_A).record_count == 3
    del env.fakes[A].fail_on["get_attendance"]
    result = env.collector.poll_device(A)
    assert result.downloaded and result.new_punches == 1


def test_upload_stops_at_failed_batch_and_resumes(tmp_path):
    settings = replace(SETTINGS, device_hosts=(A,), upload_batch_size=500)
    e = Env(tmp_path, settings, failures=[None, retryable()])
    e.fakes[A].attendance_list = atts(1200)
    e.collector.run_cycle()
    assert len(e.store.pending_punches(SN_A, 5000)) == 700
    assert len(e.uploader.punches_sent(SN_A)) == 500
    e.collector.run_cycle()
    assert e.store.pending_punches(SN_A, 5000) == []
    sizes = [len(ps) for s, ps, users in e.uploader.sent if users is None and ps]
    assert sizes == [500, 500, 200]
    assert len({p for p in e.uploader.punches_sent(SN_A)}) == 1200
    e.store.close()


def test_retryable_error_stops_all_uploads_this_cycle(tmp_path):
    e = Env(tmp_path, failures=[retryable()])
    e.collector.run_cycle()
    assert e.uploader.attempts == 1  # 第一次失敗後不再嘗試其他卡機或心跳
    assert e.store.serials_with_pending() == sorted([SN_A, SN_B])
    e.store.close()


def test_non_retryable_error_skips_serial_but_keeps_data(tmp_path, caplog):
    e = Env(tmp_path, failures=[UploadError("constraint rejected", retryable=False)])
    with caplog.at_level(logging.ERROR):
        e.collector.run_cycle()
    # 序號排序後 .191（SN_B）先送；它被拒收，資料保留在本機
    assert e.store.serials_with_pending() == [SN_B]
    assert len(e.uploader.punches_sent(SN_A)) == 3   # 另一台照常上傳
    assert any("拒" in r.getMessage() for r in caplog.records)
    e.store.close()


def test_offline_then_recover(tmp_path):
    e = Env(tmp_path, failures=[retryable(), retryable()])
    e.collector.run_cycle()
    e.collector.run_cycle()
    assert e.uploader.sent == []
    e.collector.run_cycle()
    assert e.store.serials_with_pending() == []
    sent = e.uploader.punches_sent()
    assert len(sent) == 5 and len(set((p.device_user_no, p.punched_at) for p in sent)) == 3
    e.store.close()


def _failure_level(env, caplog):
    caplog.clear()
    with caplog.at_level(logging.WARNING):
        results = env.collector.run_cycle()
    assert results[1].ok  # 另一台照常輪詢
    return max(r.levelno for r in caplog.records if A in r.getMessage())


def test_consecutive_failures_escalate_to_error(env, caplog):
    env.fakes[A].fail_on["connect"] = ZKNetworkError("can't reach device")
    levels = [_failure_level(env, caplog) for _ in range(6)]
    assert levels == [logging.WARNING] * 5 + [logging.ERROR]

    del env.fakes[A].fail_on["connect"]
    assert env.collector.poll_device(A).ok
    env.fakes[A].fail_on["connect"] = ZKNetworkError("can't reach device")
    assert _failure_level(env, caplog) == logging.WARNING  # 恢復後重新計算


def test_heartbeat_sent_when_nothing_to_upload(env):
    env.collector.run_cycle()
    env.uploader.sent.clear()
    env.collector.run_cycle()
    assert sorted(env.uploader.sent) == sorted([(SN_A, [], None), (SN_B, [], None)])


def test_no_heartbeat_for_unreachable_device(env):
    env.collector.run_cycle()
    env.uploader.sent.clear()
    env.fakes[A].fail_on["connect"] = ZKNetworkError("down")
    env.collector.run_cycle()
    assert [s for s, _, _ in env.uploader.sent] == [SN_B]


def test_users_sent_separately_from_punches(env):
    env.collector.run_cycle()
    user_requests = [(s, ps, u) for s, ps, u in env.uploader.sent if u is not None]
    assert sorted(s for s, _, _ in user_requests) == sorted([SN_A, SN_B])
    assert all(ps == [] for _, ps, _ in user_requests)
    assert env.store.users_to_sync(SN_A) is None


def test_users_synced_when_user_count_changes(env):
    env.collector.run_cycle()
    env.uploader.sent.clear()
    env.collector.run_cycle()
    assert all(u is None for _, _, u in env.uploader.sent)  # 名單沒變不重送
    env.fakes[A].user_list.append(make_user("1001", "Bob", uid=2))
    env.collector.run_cycle()
    users = [u for s, _, u in env.uploader.sent if u is not None]
    assert len(users) == 1 and [x.device_user_no for x in users[0]] == ["1000", "1001"]


def test_clock_drift_warning(env, caplog):
    env.sync_device_clock = False
    env.fakes[A].device_time = datetime(2026, 10, 19, 15, 56, 40)  # 慢 200 秒
    env.fakes[B].device_time = datetime(2026, 10, 19, 16, 0, 30)   # 快 30 秒
    with caplog.at_level(logging.WARNING):
        env.collector.run_cycle()
    drift = [r for r in caplog.records if "時鐘" in r.getMessage()]
    assert len(drift) == 1 and A in drift[0].getMessage()
