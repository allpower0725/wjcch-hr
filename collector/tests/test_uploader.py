from datetime import datetime

import pytest
import requests

from collector.models import DeviceUser, Punch, to_taipei
from collector.store import DeviceState
from collector.uploader import IngestResult, UploadError, Uploader, build_payload

URL = "https://example.supabase.co/functions/v1/ingest-punches"
STATE = DeviceState(
    serial_no="3088152000240", host="192.168.230.190", model="GT100", firmware_version="Ver 6.60",
    record_count=6354, user_count=88, clock_offset_seconds=-109,
    seen_at=to_taipei(datetime(2026, 10, 19, 16, 10, 57)),
)
PUNCH = Punch("9021", to_taipei(datetime(2026, 10, 19, 7, 58, 12)), 1, 0)


class FakeResponse:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body


class FakeSession:
    def __init__(self, response=None, exc=None):
        self.response = response or FakeResponse(
            200, {"punch_device_id": 1, "received": 1, "inserted": 1, "users_synced": 0})
        self.exc = exc
        self.requests = []

    def post(self, url, json=None, headers=None, timeout=None):
        self.requests.append({"url": url, "json": json, "headers": headers, "timeout": timeout})
        if self.exc:
            raise self.exc
        return self.response


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


def test_send_sets_headers():
    session = FakeSession()
    Uploader(URL, "secret-key", "ap-northeast-1", session=session).send(STATE, [PUNCH])
    req = session.requests[0]
    assert req["url"] == URL
    assert req["headers"]["x-collector-key"] == "secret-key"
    assert req["headers"]["x-region"] == "ap-northeast-1"
    assert req["timeout"] == 30


def test_no_region_header_when_empty():
    session = FakeSession()
    Uploader(URL, "k", "", session=session).send(STATE)
    assert "x-region" not in session.requests[0]["headers"]


def test_send_returns_result():
    session = FakeSession(FakeResponse(200, {"punch_device_id": 3, "received": 2, "inserted": 1, "users_synced": 88}))
    assert Uploader(URL, "k", "", session=session).send(STATE, [PUNCH]) == IngestResult(3, 2, 1, 88)


@pytest.mark.parametrize("status", [500, 502, 503, 429])
def test_5xx_and_429_are_retryable(status):
    session = FakeSession(FakeResponse(status, {"error": "x"}))
    with pytest.raises(UploadError) as err:
        Uploader(URL, "k", "", session=session).send(STATE, [PUNCH])
    assert err.value.retryable is True
    assert err.value.status == status


@pytest.mark.parametrize("exc", [requests.ConnectionError("down"), requests.Timeout("slow")])
def test_network_errors_are_retryable(exc):
    with pytest.raises(UploadError) as err:
        Uploader(URL, "k", "", session=FakeSession(exc=exc)).send(STATE, [PUNCH])
    assert err.value.retryable is True
    assert err.value.status is None


@pytest.mark.parametrize("status", [400, 401])
def test_401_and_400_are_not_retryable(status):
    session = FakeSession(FakeResponse(status, {"error": "bad"}))
    with pytest.raises(UploadError) as err:
        Uploader(URL, "k", "", session=session).send(STATE, [PUNCH])
    assert err.value.retryable is False
    assert err.value.status == status
