from datetime import datetime, timezone

import pytest

from collector.models import TAIPEI, iso, now_taipei, to_taipei


def test_to_taipei_attaches_zone():
    assert iso(to_taipei(datetime(2026, 10, 19, 7, 58, 12))) == "2026-10-19T07:58:12+08:00"


def test_iso_converts_utc_to_taipei():
    assert iso(datetime(2026, 10, 18, 23, 0, tzinfo=timezone.utc)) == "2026-10-19T07:00:00+08:00"


def test_iso_drops_microseconds():
    assert iso(to_taipei(datetime(2026, 10, 19, 7, 58, 12, 999999))) == "2026-10-19T07:58:12+08:00"


def test_to_taipei_rejects_aware():
    with pytest.raises(ValueError):
        to_taipei(datetime(2026, 10, 19, tzinfo=timezone.utc))


def test_now_taipei_is_aware_in_taipei():
    assert now_taipei().tzinfo is TAIPEI
