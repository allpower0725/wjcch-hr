"""維護工具的資料安全與目的地保護。"""
import json
import sqlite3

import pytest

from collector import admin
from collector.store import Store
from .test_store import p


def test_configure_keeps_existing_passwords_and_separates_runtime_from_owner(tmp_path, monkeypatch):
    private = tmp_path / ".local/database"
    runtime = tmp_path / "collector/.local/database"
    monkeypatch.setattr(admin, "ROOT", tmp_path)
    monkeypatch.setattr(admin, "PRIVATE", private)
    monkeypatch.setattr(admin, "RUNTIME_PRIVATE", runtime)
    passwords = {
        private / "secrets/hr_local_password": "existing-local-owner\n",
        private / "secrets/hr_supabase_password": "existing-cloud-owner\n",
        runtime / "secrets/hr_collector_local_password": "existing-local-collector\n",
        runtime / "secrets/hr_collector_supabase_password": "existing-cloud-collector\n",
    }
    for path, value in passwords.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    admin.configure()
    for path, value in passwords.items():
        assert path.read_text() == value
    assert {p.name for p in runtime.rglob("*_password")} == {
        "hr_collector_local_password", "hr_collector_supabase_password"}
    assert (runtime / "certs").is_dir()


def test_configure_rejects_directory_in_place_of_password(tmp_path, monkeypatch):
    monkeypatch.setattr(admin, "ROOT", tmp_path)
    monkeypatch.setattr(admin, "PRIVATE", tmp_path / ".local/database")
    monkeypatch.setattr(admin, "RUNTIME_PRIVATE", tmp_path / "collector/.local/database")
    wrong_path = admin.PRIVATE / "secrets/hr_local_password"
    wrong_path.mkdir(parents=True)
    with pytest.raises(RuntimeError, match="密碼路徑必須是檔案"):
        admin.configure()
    assert wrong_path.is_dir()


def test_queue_backup_includes_committed_wal_without_changing_source(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(admin, "ROOT", tmp_path)
    monkeypatch.setattr(admin, "PRIVATE", tmp_path / ".local/database")
    source = tmp_path / "collector/data/collector.db"
    source.parent.mkdir(parents=True)
    store = Store(source)
    punch = p("0001", 2026, 11, 17, 8, 0)
    store.add_punches("device", [punch])
    store.select_destination("production:destination")
    store.mark_uploaded("device", [punch])
    assert source.with_name("collector.db-wal").exists()

    admin.backup_queue()
    report = json.loads(capsys.readouterr().out)
    backup = tmp_path / report["backup"]
    with sqlite3.connect(backup) as conn:
        assert conn.execute("PRAGMA quick_check").fetchone()[0] == "ok"
        assert conn.execute("SELECT device_user_no FROM punch").fetchone()[0] == "0001"
        assert conn.execute("SELECT destination FROM delivery").fetchone()[0] == "production:destination"
    assert store.pending_punches("device", 10) == []
    assert report["created_at"].endswith("+08:00")
    store.close()


@pytest.mark.parametrize("url", [
    "postgresql://db_owner.other-project:synthetic@aws-0-ap-northeast-1.pooler.supabase.com/postgres",
    "postgresql://db_owner:synthetic@localhost/postgres",
    "postgresql://db_owner.tbulauezaixdjzdcqsem:synthetic@aws-0-ap-northeast-1.pooler.supabase.com/wrong_database",
])
def test_cloud_maintenance_rejects_wrong_target_before_connect(tmp_path, monkeypatch, url):
    env_file = tmp_path / "admin.env"
    env_file.write_text("MIGRATION_DATABASE_URL=" + url)
    monkeypatch.setenv("HR_CLOUD_ADMIN_ENV", str(env_file))
    with pytest.raises(RuntimeError, match="wjcch"):
        admin.connect_admin(cloud=True)


def test_cloud_maintenance_always_verifies_tls(tmp_path, monkeypatch):
    env_file = tmp_path / "admin.env"
    env_file.write_text("MIGRATION_DATABASE_URL=postgresql://db_owner.tbulauezaixdjzdcqsem:synthetic@aws-0-ap-northeast-1.pooler.supabase.com/postgres?sslmode=disable")
    monkeypatch.setenv("HR_CLOUD_ADMIN_ENV", str(env_file))
    monkeypatch.setenv("HR_CLOUD_CA", "/private/ca.crt")
    monkeypatch.setattr(admin.psycopg, "connect", lambda **kwargs: kwargs)
    actual = admin.connect_admin(cloud=True)
    assert actual["sslmode"] == "verify-full"
    assert actual["sslrootcert"] == "/private/ca.crt"
