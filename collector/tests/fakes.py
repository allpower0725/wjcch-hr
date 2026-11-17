"""測試用的假卡機：模擬 pyzk ZK 物件的介面，並記錄每次呼叫。"""
from datetime import datetime

from zk.attendance import Attendance
from zk.user import User


def make_user(user_id: str, name: str, uid: int = 1) -> User:
    return User(uid, name, 0, password="1234", group_id="", user_id=user_id, card=123456)


def make_attendance(user_id: str, ts: datetime, status: int = 1, punch: int = 0) -> Attendance:
    return Attendance(user_id, ts, status, punch)


class FakeZK:
    def __init__(self, *, serial="SN0001", device_name="GT100", platform="ZEM560",
                 firmware="Ver 6.60 Apr 1 2015", device_time=datetime(2026, 10, 19, 10, 0, 0),
                 users=(), attendances=(), fail_on=None, tcp=True):
        self.serial = serial
        self.device_name = device_name
        self.platform = platform
        self.firmware = firmware
        self.device_time = device_time
        self.user_list = list(users)
        self.attendance_list = list(attendances)
        self.fail_on = dict(fail_on or {})
        self.tcp = tcp
        self.calls: list[str] = []
        # pyzk 在 read_sizes() 後才有這些計數
        self.users = 0
        self.records = 0
        self.rec_cap = 100000

    def _call(self, name):
        self.calls.append(name)
        if name in self.fail_on:
            raise self.fail_on[name]

    def connect(self):
        self._call("connect")
        return self

    def disconnect(self):
        self._call("disconnect")
        return True

    def read_sizes(self):
        self._call("read_sizes")
        self.users = len(self.user_list)
        self.records = len(self.attendance_list)
        return True

    def get_serialnumber(self):
        self._call("get_serialnumber")
        return self.serial

    def get_device_name(self):
        self._call("get_device_name")
        return self.device_name

    def get_platform(self):
        self._call("get_platform")
        return self.platform

    def get_firmware_version(self):
        self._call("get_firmware_version")
        return self.firmware

    def get_time(self):
        self._call("get_time")
        return self.device_time

    def get_attendance(self):
        self._call("get_attendance")
        return list(self.attendance_list)

    def get_users(self):
        self._call("get_users")
        return list(self.user_list)

    def disable_device(self):
        self._call("disable_device")
        return True

    def enable_device(self):
        self._call("enable_device")
        return True


class FakeUploader:
    """假的上傳端：記錄每次 send，可依呼叫順序設定要丟出的例外。"""

    def __init__(self, failures=None):
        self.attempts = 0
        self.sent = []  # 成功送出的 (serial_no, punches, users)
        self.failures = list(failures or [])  # 第 N 次呼叫要丟的例外；None 代表成功
        self.fail_when = None  # (serial_no, punches, users) -> 例外或 None
        self.inserted_override = None

    def send(self, state, punches=(), users=None):
        from collector.uploader import IngestResult
        index = self.attempts
        self.attempts += 1
        if index < len(self.failures) and self.failures[index] is not None:
            raise self.failures[index]
        if self.fail_when and (exc := self.fail_when(state.serial_no, list(punches), users)):
            raise exc
        self.sent.append((state.serial_no, list(punches), None if users is None else list(users)))
        inserted = len(punches) if self.inserted_override is None else self.inserted_override
        return IngestResult(1, len(punches), inserted, 0 if users is None else len(users))

    def prepare(self):
        return getattr(self, "destination", "unit-test")

    def punches_sent(self, serial_no=None):
        return [p for s, ps, _ in self.sent if serial_no in (None, s) for p in ps]


def fake_factory(fake: FakeZK):
    """回傳可注入 DeviceClient(zk_factory=...) 的 factory，並記下建立參數。"""
    def factory(ip, **kwargs):
        factory.ip = ip
        factory.kwargs = kwargs
        return fake
    return factory
