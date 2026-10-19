from dataclasses import replace
from datetime import datetime

import pytest
from zk.exception import ZKErrorResponse, ZKNetworkError

from collector.config import Settings
from collector.device import DeviceAuthError, DeviceClient, DeviceError
from collector.models import DeviceUser, Punch, to_taipei

from .fakes import FakeZK, fake_factory, make_attendance, make_user

SETTINGS = Settings(device_hosts=("192.168.230.190",))
NOW = to_taipei(datetime(2026, 10, 19, 10, 0, 0))


def client(fake, settings=SETTINGS):
    return DeviceClient("192.168.230.190", settings, zk_factory=fake_factory(fake), clock=lambda: NOW)


def test_read_status_fields():
    fake = FakeZK(serial="ABC123", device_time=datetime(2026, 10, 19, 10, 0, 3),
                  users=[make_user("1", "a"), make_user("2", "b")],
                  attendances=[make_attendance("1", datetime(2026, 10, 19, 8, 0))])
    with client(fake).session() as s:
        status = s.read_status()
    assert status.host == "192.168.230.190"
    assert status.serial_no == "ABC123"
    assert status.model == "GT100"
    assert status.firmware_version == "Ver 6.60 Apr 1 2015"
    assert status.record_count == 1
    assert status.user_count == 2
    assert status.seen_at == NOW
    assert status.clock_offset_seconds == 3


def test_model_falls_back_to_platform():
    fake = FakeZK(device_name="")
    with client(fake).session() as s:
        assert s.read_status().model == "ZEM560"


def test_read_punches_converts_to_taipei():
    fake = FakeZK(attendances=[make_attendance("1023", datetime(2026, 10, 19, 7, 58, 12), status=1, punch=0)])
    with client(fake).session() as s:
        punches = s.read_punches()
    assert punches == [Punch("1023", to_taipei(datetime(2026, 10, 19, 7, 58, 12)), 1, 0)]
    assert punches[0].punched_at.isoformat() == "2026-10-19T07:58:12+08:00"


def test_session_always_disconnects_on_error():
    fake = FakeZK(fail_on={"get_attendance": ZKNetworkError("timed out")})
    with pytest.raises(DeviceError):
        with client(fake).session() as s:
            s.read_punches()
    assert "disconnect" in fake.calls


def test_socket_timeout_maps_to_device_error():
    fake = FakeZK(fail_on={"get_time": TimeoutError("timed out")})
    with pytest.raises(DeviceError):
        with client(fake).session() as s:
            s.read_status()
    assert fake.calls[-1] == "disconnect"


def test_connect_failure_maps_to_device_error():
    fake = FakeZK(fail_on={"connect": ZKNetworkError("can't reach device")})
    with pytest.raises(DeviceError, match="192.168.230.190"):
        with client(fake).session():
            pass


def test_does_not_disable_device_by_default():
    fake = FakeZK(attendances=[make_attendance("1", datetime(2026, 10, 19, 8, 0))])
    with client(fake).session() as s:
        s.read_punches()
    assert "disable_device" not in fake.calls
    assert "enable_device" not in fake.calls


def test_reenables_device_when_read_fails():
    fake = FakeZK(fail_on={"get_attendance": ZKNetworkError("boom")})
    settings = replace(SETTINGS, disable_device_during_read=True)
    with pytest.raises(DeviceError):
        with client(fake, settings).session() as s:
            s.read_punches()
    tail = [c for c in fake.calls if c in ("disable_device", "get_attendance", "enable_device", "disconnect")]
    assert tail == ["disable_device", "get_attendance", "enable_device", "disconnect"]


def test_unauthenticated_maps_to_auth_error():
    fake = FakeZK(fail_on={"connect": ZKErrorResponse("Unauthenticated")})
    with pytest.raises(DeviceAuthError, match="DEVICE_COMM_KEY"):
        with client(fake).session():
            pass


def test_connect_uses_safe_options():
    fake = FakeZK()
    factory = fake_factory(fake)
    settings = replace(SETTINGS, device_comm_key=1234, device_force_udp=True, device_timeout_seconds=7)
    with DeviceClient("192.168.230.190", settings, zk_factory=factory, clock=lambda: NOW).session():
        pass
    assert factory.ip == "192.168.230.190"
    assert factory.kwargs == {
        "port": 4370, "timeout": 7, "password": 1234, "force_udp": True,
        "ommit_ping": True, "encoding": "latin-1",
    }


def test_read_users_decodes_names_with_configured_encoding():
    raw = "王小明".encode("cp950").decode("latin-1")  # pyzk 以 latin-1 讀出的樣子
    fake = FakeZK(users=[make_user("1023", raw)])
    settings = replace(SETTINGS, device_encoding="cp950")
    with client(fake, settings).session() as s:
        assert s.read_users() == [DeviceUser("1023", "王小明")]


def test_read_users_decodes_utf8_by_default():
    raw = "陳大文".encode("utf-8").decode("latin-1")
    fake = FakeZK(users=[make_user("7", raw)])
    with client(fake).session() as s:
        assert s.read_users() == [DeviceUser("7", "陳大文")]


def test_read_users_blanks_placeholder_names():
    fake = FakeZK(users=[make_user("1023", "NN-1023")])
    with client(fake).session() as s:
        assert s.read_users() == [DeviceUser("1023", "")]


def test_read_users_returns_only_number_and_name():
    fake = FakeZK(users=[make_user("1023", "Amy")])
    with client(fake).session() as s:
        user = s.read_users()[0]
    assert set(vars(user)) == {"device_user_no", "name"}
