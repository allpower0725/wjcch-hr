"""HR schema 維護工具。管理連線由本機私密檔提供，禁止輸出連線與資料值。"""
import argparse
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import sys

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict
from .models import now_taipei

ROOT = Path(os.environ.get("HR_WORKSPACE", "/workspace"))
PRIVATE = ROOT / ".local/database"
RUNTIME_PRIVATE = ROOT / "collector/.local/database"
CLOUD_PROJECT_REF = "tbulauezaixdjzdcqsem"


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)


def configure():
    for folder, names in (
        (PRIVATE, ("hr_local_password", "hr_supabase_password")),
        (RUNTIME_PRIVATE, ("hr_collector_local_password", "hr_collector_supabase_password")),
    ):
        for name in names:
            path = folder / "secrets" / name
            if path.exists() and not path.is_file():
                raise RuntimeError(f"密碼路徑必須是檔案：{path.relative_to(ROOT)}")
            if not path.exists():
                write_private(path, secrets.token_urlsafe(32) + "\n")
            if folder == RUNTIME_PRIVATE:
                # runtime 是 uid/gid 10001；只開放此群組讀取執行帳號密碼。
                os.chown(path, 0, 10001)
                path.chmod(0o440)
        folder.chmod(0o700)
        (folder / "secrets").chmod(0o700)
    (RUNTIME_PRIVATE / "certs").mkdir(exist_ok=True)
    print("私密目錄與執行帳密權限已準備，既有密碼保持不變")


def backup_queue():
    """以 SQLite backup API 產生一致副本，不連卡機或 PostgreSQL。"""
    source = ROOT / "collector/data/collector.db"
    if not source.is_file():
        raise RuntimeError("找不到 collector/data/collector.db")
    captured_at = now_taipei()
    folder = PRIVATE / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    folder.chmod(0o700)
    backup = folder / f"collector-{captured_at:%Y%m%d-%H%M%S}-{secrets.token_hex(3)}.db"
    with sqlite3.connect(source.resolve().as_uri() + "?mode=ro", uri=True) as src:
        with sqlite3.connect(backup) as dest:
            src.backup(dest)
            if dest.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise RuntimeError("SQLite 備份完整性檢查未通過")
            count = dest.execute("SELECT count(*) FROM punch").fetchone()[0]
    backup.chmod(0o600)
    report = {"backup": backup.relative_to(ROOT).as_posix(), "punch_rows": count,
              "created_at": captured_at.isoformat()}
    write_private(backup.with_suffix(".json"), json.dumps(report, indent=2))
    print(json.dumps(report))


def cloud_admin_settings():
    env_file = Path(os.environ["HR_CLOUD_ADMIN_ENV"])
    values = dict(line.split("=", 1) for line in env_file.read_text().splitlines()
                  if "=" in line and not line.startswith("#"))
    info = conninfo_to_dict(values["MIGRATION_DATABASE_URL"].strip().strip('"').strip("'"))
    pooler = info.get("host", "").endswith(".pooler.supabase.com")
    valid = (pooler and info.get("user") == f"db_owner.{CLOUD_PROJECT_REF}") or (
        info.get("host") == f"db.{CLOUD_PROJECT_REF}.supabase.co" and info.get("user") == "db_owner")
    if info.get("dbname") != "postgres" or not valid:
        raise RuntimeError("維護工具只接受 wjcch 專案的 db_owner 連線")
    return info


def connect_admin(cloud=False, test=False):
    if cloud:
        info = cloud_admin_settings()
        info.update(sslmode="verify-full", sslrootcert=os.environ["HR_CLOUD_CA"], connect_timeout=15)
        return psycopg.connect(**info, prepare_threshold=None)
    return psycopg.connect(host=os.environ.get("HR_LOCAL_HOST", "wjcch"), port=5432,
        dbname="wjcch_db_test" if test else "wjcch_db", user="db_owner",
        password=Path(os.environ["HR_LOCAL_ADMIN_PASSWORD_FILE"]).read_text().strip(),
        connect_timeout=15)


def verifier(password):
    salt = secrets.token_bytes(16)
    salted = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 4096)
    client = hmac.digest(salted, b"Client Key", "sha256")
    stored = hashlib.sha256(client).digest()
    server = hmac.digest(salted, b"Server Key", "sha256")
    enc = lambda data: base64.b64encode(data).decode()
    return f"SCRAM-SHA-256$4096:{enc(salt)}${enc(stored)}:{enc(server)}"


def migrate(cloud=False, test=False):
    baseline = next((ROOT / "database/migrations").glob("*_isolate_hr_schema.sql"))
    content = baseline.read_text(encoding="utf-8")
    checksum = hashlib.sha256(content.encode()).hexdigest()
    if cloud:
        report = json.loads((PRIVATE / "test-verification.json").read_text())
        if not report.get("passed") or report.get("migration_sha256") != checksum:
            raise RuntimeError("須先通過相同 baseline 的本機整合驗證")
    suffix = "supabase" if cloud else "local"
    with connect_admin(cloud, test) as conn:
        database = conn.execute("SELECT current_database()").fetchone()[0]
        if database != ("postgres" if cloud else "wjcch_db_test" if test else "wjcch_db"):
            raise RuntimeError("管理連線目的地不符")
        exists = conn.execute("SELECT to_regnamespace('hr') IS NOT NULL").fetchone()[0]
        if exists:
            row = conn.execute("SELECT checksum FROM db_migrations.hr WHERE version=%s", (baseline.stem,)).fetchone()
            if not row or row[0] != checksum:
                raise RuntimeError("hr schema 已存在但 migration 不一致，停止操作")
            print(f"{database}.hr migration 已一致，無需重做")
            return
        for role, file_name in (("hr", f"hr_{suffix}_password"),
                                ("hr_collector", f"hr_collector_{suffix}_password")):
            row = conn.execute("SELECT rolname FROM pg_roles WHERE rolname=%s", (role,)).fetchone()
            if not row:
                folder = RUNTIME_PRIVATE if role == "hr_collector" else PRIVATE
                password = (folder / "secrets" / file_name).read_text(encoding="utf-8-sig").strip()
                conn.execute(sql.SQL("CREATE ROLE {} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD {}")
                             .format(sql.Identifier(role), sql.Literal(verifier(password))))
        if cloud:
            # db_owner 是本專案維護角色；不授權給 healthcare 或 collector。
            conn.execute("GRANT hr TO db_owner WITH INHERIT FALSE, SET TRUE")
        conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO hr, hr_collector").format(sql.Identifier(database)))
        conn.execute("CREATE SCHEMA hr AUTHORIZATION hr")
        conn.execute("CREATE SCHEMA IF NOT EXISTS db_migrations")
        conn.execute("CREATE TABLE IF NOT EXISTS db_migrations.hr (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())")
        conn.execute("REVOKE ALL ON TABLE db_migrations.hr FROM PUBLIC")
        conn.execute("SET LOCAL ROLE hr")
        conn.execute("REVOKE ALL ON SCHEMA hr FROM PUBLIC")
        conn.execute("ALTER DEFAULT PRIVILEGES IN SCHEMA hr REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC")
        conn.execute(content, prepare=False)
        conn.execute("RESET ROLE")
        conn.execute("INSERT INTO db_migrations.hr(version,checksum) VALUES (%s,%s)", (baseline.stem, checksum))
        for role in ("hr", "hr_collector"):
            conn.execute(sql.SQL("ALTER ROLE {} IN DATABASE {} SET search_path TO pg_catalog, hr")
                         .format(sql.Identifier(role), sql.Identifier(database)))
        if cloud:
            conn.execute("SET LOCAL ROLE hr")
            conn.execute("GRANT USAGE ON SCHEMA hr TO postgres")
            conn.execute("GRANT ALL ON ALL TABLES IN SCHEMA hr TO postgres")
            conn.execute("GRANT ALL ON ALL SEQUENCES IN SCHEMA hr TO postgres")
            conn.execute("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hr TO postgres")
            conn.execute("RESET ROLE")
    print(f"{database}.hr schema 與專用角色已建立")


def verify_runtime(cloud=False, test=False):
    from contextlib import contextmanager
    from .config import Settings
    from .models import DeviceUser
    from .store import DeviceState
    from .uploader import Uploader
    if cloud:
        info = cloud_admin_settings()
        user = f"hr_collector.{CLOUD_PROJECT_REF}" if info["host"].endswith(".pooler.supabase.com") else "hr_collector"
        settings = Settings(device_hosts=("verification-only",), mode="production",
            db_host=info["host"], db_port=int(info.get("port", 5432)), db_name="postgres",
            db_user=user, db_password_file=RUNTIME_PRIVATE / "secrets/hr_collector_supabase_password",
            db_sslmode="verify-full", db_sslrootcert=os.environ["HR_CLOUD_CA"])
    else:
        settings = Settings(device_hosts=("verification-only",), db_host=os.environ.get("HR_LOCAL_HOST", "wjcch"),
            db_name="wjcch_db_test" if test else "wjcch_db",
            db_password_file=RUNTIME_PRIVATE / "secrets/hr_collector_local_password")
    uploader = Uploader(settings)
    destination = uploader.prepare()
    state = DeviceState("127.0.0.1", "HR-RUNTIME-VERIFY", "Verification", "Verification", 0, 1, 0,
                        now_taipei())
    with uploader._connection() as conn:
        conn.rollback()
        before = conn.execute("SELECT count(*) FROM hr.raw_punch").fetchone()[0]
        conn.rollback()
        @contextmanager
        def lease(**kwargs):
            with conn.transaction():
                yield conn
        with conn.transaction(force_rollback=True):
            probe = Uploader(settings, connect=lease)
            probe.prepare()
            probe.send(state, users=[DeviceUser("verification", "Verification")])
            for query in ("SELECT * FROM heal_care.submissions", "SELECT * FROM hr.employee",
                          "CREATE TABLE hr.forbidden(id integer)", "SET ROLE hr",
                          "DELETE FROM hr.raw_punch", "TRUNCATE hr.raw_punch"):
                try:
                    with conn.transaction():
                        conn.execute(query)
                except psycopg.errors.InsufficientPrivilege:
                    pass
                else:
                    raise RuntimeError("權限拒絕測試未通過")
        assert conn.execute("SELECT count(*) FROM hr.punch_device WHERE serial_no='HR-RUNTIME-VERIFY'").fetchone()[0] == 0
        assert conn.execute("SELECT count(*) FROM hr.raw_punch").fetchone()[0] == before
    report = {"mode": settings.mode, "destination": destination, "login": "hr_collector",
              "tls_verify_full": cloud, "write_and_rollback_verified": True,
              "privilege_boundaries_verified": True, "raw_punch_count": before,
              "verified_at": now_taipei().isoformat()}
    write_private(PRIVATE / f"runtime-{'cloud' if cloud else 'test' if test else 'local'}.json", json.dumps(report, indent=2))
    print(json.dumps(report))


def fingerprint(cloud=False, test=False):
    with connect_admin(cloud, test) as conn:
        conn.execute("SET LOCAL ROLE hr")
        count, digest = conn.execute("""SELECT count(*), encode(sha256(convert_to(coalesce(
            string_agg(jsonb_build_array(raw_punch_id,punch_device_id,device_user_no,
            extract(epoch FROM punched_at),verify_type,punch_state,extract(epoch FROM received_at))::text,
            E'\\n' ORDER BY raw_punch_id),''),'UTF8')),'hex') FROM hr.raw_punch""").fetchone()
    print(json.dumps({"count": count, "sha256": digest}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["configure", "migrate", "verify", "backup-queue", "verify-runtime", "fingerprint"])
    parser.add_argument("--cloud", action="store_true")
    parser.add_argument("--test", action="store_true")
    args = parser.parse_args()
    if args.cloud and args.test:
        parser.error("--cloud 與 --test 不能並用")
    if args.command in {"configure", "backup-queue"} and (args.cloud or args.test):
        parser.error("configure／backup-queue 只操作本機私密檔，不接受 --cloud 或 --test")
    try:
        if args.command == "configure":
            configure()
        elif args.command == "backup-queue":
            backup_queue()
        elif args.command == "verify-runtime":
            verify_runtime(args.cloud, args.test)
        elif args.command == "fingerprint":
            fingerprint(args.cloud, args.test)
        elif args.command == "verify":
            if args.cloud:
                raise RuntimeError("verify 僅執行本機隔離測試")
            result = subprocess.run([sys.executable, "-B", "-m", "pytest", "-q", "-p", "no:cacheprovider",
                                     "tests/test_postgres.py"], cwd=ROOT / "collector",
                                    env={**os.environ, "HR_INTEGRATION": "1"})
            if result.returncode:
                return result.returncode
            baseline = next((ROOT / "database/migrations").glob("*_isolate_hr_schema.sql"))
            write_private(PRIVATE / "test-verification.json", json.dumps({"passed": True,
                "migration_sha256": hashlib.sha256(baseline.read_bytes()).hexdigest(),
                "verified_at": now_taipei().isoformat()}, indent=2))
        else:
            migrate(args.cloud, args.test)
    except Exception as exc:
        # 不顯示可能含連線字串、密碼或個資的例外內容。
        print(f"維護未完成：{type(exc).__name__}；請在本機私密環境檢查")
        if isinstance(exc, psycopg.errors.InsufficientPrivilege):
            print(exc.diag.message_primary)
        elif isinstance(exc, RuntimeError):
            print(str(exc))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
