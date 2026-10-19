"""本機 SQLite：已收過的打卡、待上傳佇列、各卡機狀態與使用者名單。

打卡時間以 iso()（+08:00）字串存放，格式固定，所以字串排序就是時間排序。
"""
import sqlite3
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from .models import DeviceStatus, DeviceUser, Punch, iso, now_taipei

_SCHEMA = """
CREATE TABLE IF NOT EXISTS punch (
  serial_no       TEXT    NOT NULL,
  device_user_no  TEXT    NOT NULL,
  punched_at      TEXT    NOT NULL,
  verify_type     INTEGER NOT NULL,
  punch_state     INTEGER NOT NULL,
  first_seen_at   TEXT    NOT NULL,
  uploaded_at     TEXT,
  PRIMARY KEY (serial_no, device_user_no, punched_at)
);
CREATE INDEX IF NOT EXISTS ix_punch_pending ON punch (serial_no, punched_at) WHERE uploaded_at IS NULL;
CREATE TABLE IF NOT EXISTS device_state (
  serial_no             TEXT PRIMARY KEY,
  host                  TEXT    NOT NULL,
  model                 TEXT    NOT NULL,
  firmware_version      TEXT    NOT NULL,
  record_count          INTEGER,
  user_count            INTEGER NOT NULL,
  clock_offset_seconds  INTEGER NOT NULL,
  seen_at               TEXT    NOT NULL,
  users_read_count      INTEGER,
  users_dirty           INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS device_user (
  serial_no       TEXT NOT NULL,
  device_user_no  TEXT NOT NULL,
  name            TEXT NOT NULL,
  PRIMARY KEY (serial_no, device_user_no)
);
CREATE TABLE IF NOT EXISTS meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
"""


@dataclass(frozen=True)
class DeviceState:
    serial_no: str
    host: str
    model: str
    firmware_version: str
    record_count: int | None  # 上次完整下載成功時的筆數；從未下載過為 None
    user_count: int
    clock_offset_seconds: int
    seen_at: datetime
    users_read_count: int | None = None  # 上次讀使用者名單時的人數；從未讀過為 None


def _punch(row: sqlite3.Row) -> Punch:
    return Punch(row["device_user_no"], datetime.fromisoformat(row["punched_at"]),
                 row["verify_type"], row["punch_state"])


class Store:
    def __init__(self, path: Path, clock: Callable[[], datetime] = now_taipei) -> None:
        self._clock = clock
        self._conn = sqlite3.connect(path)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(_SCHEMA)

    def close(self) -> None:
        self._conn.close()

    # 卡機狀態

    def get_device_state(self, serial_no: str) -> DeviceState | None:
        row = self._conn.execute("SELECT * FROM device_state WHERE serial_no = ?", (serial_no,)).fetchone()
        if row is None:
            return None
        return DeviceState(
            serial_no=row["serial_no"], host=row["host"], model=row["model"],
            firmware_version=row["firmware_version"], record_count=row["record_count"],
            user_count=row["user_count"], clock_offset_seconds=row["clock_offset_seconds"],
            seen_at=datetime.fromisoformat(row["seen_at"]), users_read_count=row["users_read_count"],
        )

    def save_status(self, status: DeviceStatus) -> None:
        """更新狀態欄位；record_count 只在完整下載成功後由 set_record_count 更新。"""
        with self._conn:
            self._conn.execute(
                """INSERT INTO device_state
                     (serial_no, host, model, firmware_version, user_count, clock_offset_seconds, seen_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (serial_no) DO UPDATE SET
                     host = excluded.host, model = excluded.model,
                     firmware_version = excluded.firmware_version, user_count = excluded.user_count,
                     clock_offset_seconds = excluded.clock_offset_seconds, seen_at = excluded.seen_at""",
                (status.serial_no, status.host, status.model, status.firmware_version,
                 status.user_count, status.clock_offset_seconds, iso(status.seen_at)),
            )

    def set_record_count(self, serial_no: str, count: int) -> None:
        with self._conn:
            self._conn.execute("UPDATE device_state SET record_count = ? WHERE serial_no = ?", (count, serial_no))

    def known_serials(self) -> list[str]:
        return [r[0] for r in self._conn.execute("SELECT serial_no FROM device_state ORDER BY serial_no")]

    # 打卡紀錄

    def add_punches(self, serial_no: str, punches: Iterable[Punch]) -> int:
        """寫入新紀錄（已存在的略過），回傳新增筆數。"""
        now = iso(self._clock())
        with self._conn:
            cur = self._conn.executemany(
                """INSERT OR IGNORE INTO punch
                     (serial_no, device_user_no, punched_at, verify_type, punch_state, first_seen_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                ((serial_no, x.device_user_no, iso(x.punched_at), x.verify_type, x.punch_state, now)
                 for x in punches),
            )
        return max(cur.rowcount, 0)

    def pending_punches(self, serial_no: str, limit: int) -> list[Punch]:
        rows = self._conn.execute(
            """SELECT * FROM punch WHERE serial_no = ? AND uploaded_at IS NULL
               ORDER BY punched_at, device_user_no LIMIT ?""",
            (serial_no, limit),
        )
        return [_punch(r) for r in rows]

    def mark_uploaded(self, serial_no: str, punches: Sequence[Punch]) -> None:
        now = iso(self._clock())
        with self._conn:
            self._conn.executemany(
                """UPDATE punch SET uploaded_at = ?
                   WHERE serial_no = ? AND device_user_no = ? AND punched_at = ?""",
                ((now, serial_no, x.device_user_no, iso(x.punched_at)) for x in punches),
            )

    def serials_with_pending(self) -> list[str]:
        rows = self._conn.execute(
            "SELECT DISTINCT serial_no FROM punch WHERE uploaded_at IS NULL ORDER BY serial_no")
        return [r[0] for r in rows]

    def punches_since(self, serial_no: str, since: datetime) -> list[Punch]:
        rows = self._conn.execute(
            """SELECT * FROM punch WHERE serial_no = ? AND punched_at >= ?
               ORDER BY punched_at, device_user_no""",
            (serial_no, iso(since)),
        )
        return [_punch(r) for r in rows]

    # 使用者名單

    def replace_users(self, serial_no: str, users: Sequence[DeviceUser]) -> None:
        """存下最新名單並標成待同步。"""
        with self._conn:
            self._conn.execute("DELETE FROM device_user WHERE serial_no = ?", (serial_no,))
            self._conn.executemany(
                "INSERT OR REPLACE INTO device_user (serial_no, device_user_no, name) VALUES (?, ?, ?)",
                ((serial_no, u.device_user_no, u.name) for u in users),
            )
            self._conn.execute(
                "UPDATE device_state SET users_dirty = 1, users_read_count = ? WHERE serial_no = ?",
                (len(users), serial_no),
            )

    def users_to_sync(self, serial_no: str) -> list[DeviceUser] | None:
        row = self._conn.execute("SELECT users_dirty FROM device_state WHERE serial_no = ?", (serial_no,)).fetchone()
        if row is None or not row[0]:
            return None
        rows = self._conn.execute(
            "SELECT device_user_no, name FROM device_user WHERE serial_no = ? ORDER BY device_user_no",
            (serial_no,),
        )
        return [DeviceUser(r[0], r[1]) for r in rows]

    def clear_users_dirty(self, serial_no: str) -> None:
        with self._conn:
            self._conn.execute("UPDATE device_state SET users_dirty = 0 WHERE serial_no = ?", (serial_no,))

    # 其他設定

    def get_meta(self, key: str) -> str | None:
        row = self._conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
        return row[0] if row else None

    def set_meta(self, key: str, value: str) -> None:
        with self._conn:
            self._conn.execute(
                "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                (key, value),
            )
