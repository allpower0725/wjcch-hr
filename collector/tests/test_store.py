from datetime import datetime

import pytest

from collector.models import DeviceStatus, DeviceUser, Punch, to_taipei
from collector.store import Store

SN = "3088152000240"


def t(*args):
    return to_taipei(datetime(*args))


def p(user, *ts, verify=1, state=0):
    return Punch(user, t(*ts), verify, state)


def status(record_count=10, user_count=88, seen=(2026, 10, 19, 16, 0)):
    return DeviceStatus("192.168.230.190", SN, "GT100", "Ver 6.60", record_count, user_count, t(*seen), -109)


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "collector.db", clock=lambda: t(2026, 10, 19, 16, 0))
    yield s
    s.close()


def test_add_punches_returns_only_new_rows(store):
    first = [p("9021", 2026, 10, 19, 8, 0), p("9021", 2026, 10, 19, 17, 0), p("9247", 2026, 10, 19, 8, 1)]
    assert store.add_punches(SN, first) == 3
    assert store.add_punches(SN, first + [p("9247", 2026, 10, 19, 17, 5)]) == 1


def test_add_punches_keeps_first_when_key_collides(store):
    store.add_punches(SN, [p("9021", 2026, 10, 19, 8, 0, verify=1)])
    assert store.add_punches(SN, [p("9021", 2026, 10, 19, 8, 0, verify=2, state=5)]) == 0
    assert store.pending_punches(SN, 10) == [p("9021", 2026, 10, 19, 8, 0, verify=1)]


def test_same_punch_on_other_device_is_separate(store):
    store.add_punches(SN, [p("9021", 2026, 10, 19, 8, 0)])
    assert store.add_punches("3088152000161", [p("9021", 2026, 10, 19, 8, 0)]) == 1


def test_pending_and_mark_uploaded(store):
    punches = [p("9021", 2026, 10, 19, 8, 0), p("9021", 2026, 10, 19, 17, 0), p("9247", 2026, 10, 19, 8, 1)]
    store.add_punches(SN, punches)
    assert len(store.pending_punches(SN, 10)) == 3
    store.mark_uploaded(SN, punches[:2])
    assert store.pending_punches(SN, 10) == [punches[2]]


def test_pending_respects_limit_and_order(store):
    store.add_punches(SN, [p("1", 2026, 10, 19, 9, 0), p("2", 2026, 10, 19, 7, 0), p("3", 2026, 10, 19, 8, 0)])
    assert [x.device_user_no for x in store.pending_punches(SN, 2)] == ["2", "3"]


def test_pending_round_trips_timezone(store):
    store.add_punches(SN, [p("9021", 2026, 10, 19, 7, 58, 12)])
    got = store.pending_punches(SN, 1)[0].punched_at
    assert got == t(2026, 10, 19, 7, 58, 12)
    assert got.isoformat() == "2026-10-19T07:58:12+08:00"


def test_serials_with_pending(store):
    store.add_punches(SN, [p("1", 2026, 10, 19, 9, 0)])
    store.add_punches("OTHER", [p("1", 2026, 10, 19, 9, 0)])
    store.mark_uploaded("OTHER", [p("1", 2026, 10, 19, 9, 0)])
    assert store.serials_with_pending() == [SN]


def test_save_status_does_not_touch_record_count(store):
    store.save_status(status(record_count=5))
    assert store.get_device_state(SN).record_count is None
    store.set_record_count(SN, 10)
    store.save_status(status(record_count=12, seen=(2026, 10, 19, 16, 5)))
    state = store.get_device_state(SN)
    assert state.record_count == 10
    assert state.seen_at == t(2026, 10, 19, 16, 5)
    assert state.clock_offset_seconds == -109
    assert state.host == "192.168.230.190"


def test_unknown_device_state_is_none(store):
    assert store.get_device_state("NOPE") is None


def test_known_serials(store):
    store.save_status(status())
    assert store.known_serials() == [SN]


def test_punches_since_uses_taipei_time(store):
    store.add_punches(SN, [p("1", 2026, 10, 11, 23, 59), p("1", 2026, 10, 12, 0, 0), p("1", 2026, 10, 19, 8, 0)])
    got = store.punches_since(SN, t(2026, 10, 12, 0, 0))
    assert [x.punched_at for x in got] == [t(2026, 10, 12, 0, 0), t(2026, 10, 19, 8, 0)]


def test_users_dirty_cycle(store):
    store.save_status(status())
    users = [DeviceUser("9021", "王小明"), DeviceUser("9247", "")]
    store.replace_users(SN, users)
    assert store.users_to_sync(SN) == users
    assert store.get_device_state(SN).users_read_count == 2
    store.clear_users_dirty(SN)
    assert store.users_to_sync(SN) is None


def test_replace_users_drops_old_list(store):
    store.save_status(status())
    store.replace_users(SN, [DeviceUser("1", "a"), DeviceUser("2", "b")])
    store.replace_users(SN, [DeviceUser("2", "b2")])
    assert store.users_to_sync(SN) == [DeviceUser("2", "b2")]


def test_data_survives_reopen(tmp_path):
    path = tmp_path / "collector.db"
    s = Store(path)
    s.add_punches(SN, [p("1", 2026, 10, 19, 9, 0)])
    s.save_status(status())
    s.set_record_count(SN, 1)
    s.set_meta("reconcile_upload", "2026-10-19")
    s.close()
    s2 = Store(path)
    assert len(s2.pending_punches(SN, 10)) == 1
    assert s2.get_device_state(SN).record_count == 1
    assert s2.get_meta("reconcile_upload") == "2026-10-19"
    s2.close()


def test_meta_roundtrip(store):
    assert store.get_meta("x") is None
    store.set_meta("x", "1")
    store.set_meta("x", "2")
    assert store.get_meta("x") == "2"
