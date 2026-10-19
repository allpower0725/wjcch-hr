"""測試共用的收集器環境：兩台假卡機、真 Store、假上傳端、可調整的時鐘。"""
from datetime import datetime, timedelta

from collector.config import Settings
from collector.device import DeviceClient
from collector.jobs import Collector
from collector.models import to_taipei
from collector.store import Store
from collector.uploader import UploadError

from .fakes import FakeUploader, FakeZK, fake_factory, make_attendance, make_user

A, B = "192.168.230.190", "192.168.230.191"
SN_A, SN_B = "3088152000240", "3088152000161"
NOW = to_taipei(datetime(2026, 10, 19, 16, 0))
SETTINGS = Settings(device_hosts=(A, B), ingest_url="http://x", collector_key="k")


def atts(n, start=datetime(2026, 10, 1, 8, 0)):
    return [make_attendance(str(1000 + i), start + timedelta(minutes=i)) for i in range(n)]


def retryable():
    return UploadError("network down", retryable=True)


class Clock:
    def __init__(self, now=NOW):
        self.now = now

    def __call__(self):
        return self.now


class Env:
    def __init__(self, tmp_path, settings=SETTINGS, failures=None):
        self.settings = settings
        self.clock = Clock()
        self.sync_device_clock = True  # 卡機時鐘跟著測試時鐘走，避免多餘的誤差警告
        self.fakes = {
            A: FakeZK(serial=SN_A, attendances=atts(3), users=[make_user("1000", "Amy")]),
            B: FakeZK(serial=SN_B, attendances=atts(2), users=[make_user("1000", "Amy")]),
        }
        self.store = Store(tmp_path / "c.db", clock=self.clock)
        self.uploader = FakeUploader(failures)
        self.collector = Collector(settings, self.store, self.uploader,
                                   device_factory=self._device, clock=self.clock)

    def _device(self, host):
        fake = self.fakes[host]
        if self.sync_device_clock:
            fake.device_time = self.clock().replace(tzinfo=None)
        return DeviceClient(host, self.settings, zk_factory=fake_factory(fake), clock=self.clock)

    def at(self, *args):
        """把時鐘撥到指定的台北時間。"""
        self.clock.now = to_taipei(datetime(*args))
        return self

    def calls(self, host):
        return self.fakes[host].calls
