from datetime import datetime

from zk.exception import ZKNetworkError

from collector.config import Settings
from collector.device import DeviceClient
from collector.models import to_taipei
from collector.probe import probe

from .fakes import FakeZK, fake_factory, make_attendance, make_user

HOSTS = ("192.168.230.190", "192.168.230.191")
SETTINGS = Settings(device_hosts=HOSTS)
NOW = to_taipei(datetime(2026, 10, 19, 10, 0, 0))


def run_probe(fakes):
    lines = []

    def client_factory(host, settings):
        return DeviceClient(host, settings, zk_factory=fake_factory(fakes[host]), clock=lambda: NOW)

    rc = probe(SETTINGS, out=lines.append, client_factory=client_factory)
    return rc, "\n".join(lines)


def sample_fake(serial):
    return FakeZK(
        serial=serial,
        users=[make_user("1023", "Amy"), make_user("0042", "Bob")],
        attendances=[
            make_attendance("1023", datetime(2026, 5, 1, 7, 58), status=1, punch=0),
            make_attendance("0042", datetime(2026, 10, 19, 17, 2), status=15, punch=1),
        ],
    )


def test_probe_reports_serial_and_counts():
    rc, text = run_probe({HOSTS[0]: sample_fake("SN-A"), HOSTS[1]: sample_fake("SN-B")})
    assert rc == 0
    assert "SN-A" in text and "SN-B" in text
    assert "2 筆" in text  # 兩台各下載 2 筆


def test_probe_continues_after_one_device_fails():
    bad = FakeZK(fail_on={"connect": ZKNetworkError("can't reach device")})
    rc, text = run_probe({HOSTS[0]: bad, HOSTS[1]: sample_fake("SN-B")})
    assert rc == 1
    assert "SN-B" in text


def test_probe_never_calls_write_methods():
    fakes = {HOSTS[0]: sample_fake("SN-A"), HOSTS[1]: sample_fake("SN-B")}
    run_probe(fakes)
    for fake in fakes.values():
        assert not {"disable_device", "enable_device", "clear_attendance", "set_time"} & set(fake.calls)
        assert fake.calls[-1] == "disconnect"
