from datetime import datetime
import errno
from pathlib import Path

import pytest
import psycopg
from collector.config import Settings

from collector.models import DeviceUser, Punch, to_taipei
from collector.store import DeviceState
from collector.uploader import UploadError, Uploader, build_payload

STATE = DeviceState(
    serial_no="3088152000240", host="192.168.230.190", model="GT100", firmware_version="Ver 6.60",
    record_count=6354, user_count=88, clock_offset_seconds=-109,
    seen_at=to_taipei(datetime(2026, 10, 19, 16, 10, 57)),
)
PUNCH = Punch("9021", to_taipei(datetime(2026, 10, 19, 7, 58, 12)), 1, 0)


def test_build_payload_matches_contract():
    payload = build_payload(STATE, [PUNCH], [DeviceUser("9021", "王小明")])
    assert payload == {
        "device": {
            "serial_no": "3088152000240", "ip_address": "192.168.230.190", "model": "GT100",
            "firmware_version": "Ver 6.60", "seen_at": "2026-10-19T16:10:57+08:00",
            "record_count": 6354, "user_count": 88, "clock_offset_seconds": -109,
        },
        "punches": [{"device_user_no": "9021", "punched_at": "2026-10-19T07:58:12+08:00",
                     "verify_type": 1, "punch_state": 0}],
        "users": [{"device_user_no": "9021", "name": "王小明"}],
    }


def test_users_key_omitted_when_none():
    assert "users" not in build_payload(STATE, [PUNCH], None)


def test_record_count_omitted_before_first_download():
    from dataclasses import replace
    assert "record_count" not in build_payload(replace(STATE, record_count=None), [], None)["device"]


def test_hostname_is_not_sent_as_ip_address():
    from dataclasses import replace
    assert "ip_address" not in build_payload(replace(STATE, host="gt100-a.local"), [], None)["device"]


class Cursor:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


class Connection:
    def __init__(self, result=None, instance="instance-a", fail_commit=False):
        self.result = result or {"punch_device_id": 1, "received": 1, "inserted": 1, "users_synced": 0}
        self.instance = instance
        self.fail_commit = fail_commit
        self.commits = 0
        self.rollbacks = 0

    def __enter__(self):
        return self

    def __exit__(self, kind, value, tb):
        if kind:
            self.rollbacks += 1
        elif self.fail_commit:
            raise psycopg.OperationalError("secret connection detail")
        else:
            self.commits += 1

    def execute(self, query, args=None):
        if "collector_target" in query:
            return Cursor((self.instance, "wjcch_db", "hr_collector"))
        return Cursor((self.result,))


def sender(tmp_path, conn):
    secret = tmp_path / "password"
    secret.write_text("private-password")
    settings = Settings(device_hosts=("device",), db_password_file=secret)
    return Uploader(settings, connect=lambda **kwargs: conn)


@pytest.mark.parametrize("error,reason", [
    (FileNotFoundError(errno.ENOENT, "private filesystem detail"), "檔案不存在"),
    (PermissionError(errno.EACCES, "private filesystem detail"), "權限不足"),
    (IsADirectoryError(errno.EISDIR, "private filesystem detail"), "路徑是目錄"),
    (OSError(errno.EIO, "private filesystem detail"), "讀取失敗"),
])
def test_password_read_failure_identifies_cause_without_connecting(tmp_path, monkeypatch, error, reason):
    def unreadable(*args, **kwargs):
        raise error
    def unexpected_connect(**kwargs):
        pytest.fail("無法讀取密碼時不應連線資料庫")
    path = tmp_path / "password"
    monkeypatch.setattr(Path, "read_text", unreadable)
    upload = Uploader(Settings(device_hosts=("device",), db_password_file=path), connect=unexpected_connect)
    with pytest.raises(UploadError) as caught:
        upload.prepare()
    assert reason in str(caught.value) and str(path) in str(caught.value)
    assert "private filesystem detail" not in str(caught.value)
    assert not caught.value.retryable


@pytest.mark.parametrize("content,reason", [(b"\xef\xbb\xbf \r\n", "內容為空白"),
                                           (b"\xff\xfe", "UTF-8")])
def test_invalid_password_file_is_reported_without_its_contents(tmp_path, content, reason):
    path = tmp_path / "password"
    path.write_bytes(content)
    upload = Uploader(Settings(device_hosts=("device",), db_password_file=path))
    with pytest.raises(UploadError, match=reason):
        upload.prepare()


def test_password_file_accepts_windows_utf8_bom_and_crlf(tmp_path):
    path = tmp_path / "password"
    path.write_bytes(b"\xef\xbb\xbfprivate-password\r\n")
    actual = {}
    def connect(**kwargs):
        actual.update(kwargs)
        return Connection()
    upload = Uploader(Settings(device_hosts=("device",), db_password_file=path), connect=connect)
    upload.prepare()
    assert actual["password"] == "private-password"


def test_ack_returned_after_commit(tmp_path):
    conn = Connection()
    upload = sender(tmp_path, conn)
    assert upload.prepare() == "test:instance-a"
    assert upload.send(STATE, [PUNCH]).received == 1
    assert conn.commits == 2


def test_failed_commit_keeps_pending_and_redacts_error(tmp_path):
    conn = Connection()
    upload = sender(tmp_path, conn)
    upload.prepare()
    conn.fail_commit = True
    with pytest.raises(UploadError) as err:
        upload.send(STATE, [PUNCH])
    assert err.value.retryable and "secret" not in str(err.value)


@pytest.mark.parametrize("field,value", [("received", 0), ("inserted", 2),
    ("punch_device_id", 0), ("users_synced", 1), ("received", True)])
def test_bad_ack_rolls_back(tmp_path, field, value):
    conn = Connection()
    conn.result[field] = value
    upload = sender(tmp_path, conn)
    upload.prepare()
    with pytest.raises(UploadError):
        upload.send(STATE, [PUNCH])
    assert conn.rollbacks == 1


def test_database_replaced_between_prepare_and_send(tmp_path):
    conn = Connection()
    upload = sender(tmp_path, conn)
    upload.prepare()
    conn.instance = "instance-b"
    with pytest.raises(UploadError, match="目的地已改變"):
        upload.send(STATE, [PUNCH])
    assert upload.prepare() == "test:instance-b"
