"""Read-only HR reports and database verification."""
import argparse
import hashlib
import json
import os
from pathlib import Path

import psycopg

ROOT = Path(os.environ.get("HR_WORKSPACE", "/workspace"))
PRIVATE = ROOT / ".local/database/personnel"


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_private(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value, encoding="utf-8")
    path.chmod(0o600)


def connection(target):
    if target not in ("test", "local", "cloud"):
        raise ValueError("Unknown target")
    cloud = target == "cloud"
    options = dict(host="aws-0-ap-northeast-1.pooler.supabase.com" if cloud else "wjcch", port=5432,
                   dbname="postgres" if cloud else "wjcch_db_test" if target == "test" else "wjcch_db",
                   user="hr.tbulauezaixdjzdcqsem" if cloud else "hr",
                   password=(ROOT / f".local/database/secrets/hr_{'supabase' if cloud else 'local'}_password").read_text().strip(),
                   connect_timeout=20, prepare_threshold=None,
                   options="-c timezone=Asia/Taipei")
    if cloud:
        options.update(sslmode="verify-full", sslrootcert=str(ROOT / "collector/.local/database/certs/supabase-ca.crt"))
    conn = psycopg.connect(**options)
    if conn.info.dbname != options["dbname"]:
        conn.close()
        raise RuntimeError("Wrong target database")
    return conn


def report(conn):
    return conn.execute((ROOT / "database/personnel/report.sql").read_text()).fetchone()[0]


def punch_fingerprint(conn, maximum=None):
    rows = conn.execute("""SELECT raw_punch_id, punch_device_id, device_user_no,
        extract(epoch FROM punched_at)::text, verify_type, punch_state,
        extract(epoch FROM received_at)::text FROM hr.raw_punch
        WHERE %s::bigint IS NULL OR raw_punch_id <= %s ORDER BY raw_punch_id""", (maximum, maximum))
    sha = hashlib.sha256()
    count, last = 0, 0
    for row in rows:
        sha.update((canonical(row) + "\n").encode())
        count += 1
        last = row[0]
    return {"count": count, "max_id": last, "sha256": sha.hexdigest()}


def audit(conn):
    shape = {}
    shape["relations"] = conn.execute("""SELECT c.relname,c.relkind,c.relrowsecurity,c.reloptions,
        c.relowner::regrole::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='hr' AND c.relkind IN ('r','v') ORDER BY c.relname""").fetchall()
    shape["columns"] = conn.execute("""SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod),
        a.attnotnull,a.attidentity,pg_get_expr(d.adbin,d.adrelid) FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
        LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
        WHERE n.nspname='hr' AND c.relkind IN ('r','v') AND a.attnum>0 AND NOT a.attisdropped
        ORDER BY c.relname,a.attnum""").fetchall()
    shape["constraints"] = conn.execute("""SELECT c.relname,con.conname,pg_get_constraintdef(con.oid)
        FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
        JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='hr'
        ORDER BY c.relname,con.conname""").fetchall()
    shape["views"] = conn.execute("""SELECT c.relname,pg_get_viewdef(c.oid)
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='hr' AND c.relkind='v' ORDER BY c.relname""").fetchall()
    if any(row[4] != "hr" or (row[1] == 'r' and not row[2]) or
           (row[1] == 'v' and 'security_invoker=true' not in (row[3] or [])) for row in shape["relations"]):
        raise RuntimeError("Unexpected schema ownership, RLS or view security")
    protected = ('employee','department','department_manager','job_title','employment_type','job_duty',
                 'employee_education','license_type','employee_license','employee_device_mapping',
                 'v_punch_employee','v_employee_license')
    violations = conn.execute("""SELECT c.relname,r.rolname FROM pg_class c
        JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN pg_roles r
        WHERE n.nspname='hr' AND c.relname=ANY(%s)
        AND r.rolname IN ('hr_collector','anon','authenticated')
        AND has_table_privilege(r.oid,c.oid,'SELECT')""", (list(protected),)).fetchall()
    if violations:
        raise RuntimeError("Personnel data is exposed to an unintended role")
    return {"passed": True, "relations": len(shape["relations"]),
            "schema_sha256": digest(canonical(shape).encode()), "protected_relations": len(protected)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["report", "pgpass", "snapshot", "verify-preserved", "audit"])
    parser.add_argument("--target", choices=["test", "local", "cloud"], default="test")
    args = parser.parse_args()
    if args.command == "report":
        with connection(args.target) as conn:
            data = report(conn)
        write_private(PRIVATE / f"{args.target}-report.json", json.dumps(data, ensure_ascii=False, indent=2))
        print(json.dumps(data, ensure_ascii=False))
    elif args.command == "audit":
        with connection(args.target) as conn:
            data = audit(conn)
        write_private(PRIVATE / f"{args.target}-schema-audit.json", json.dumps(data, indent=2))
        print(json.dumps(data))
    elif args.command in ("snapshot", "verify-preserved"):
        path = PRIVATE / f"{args.target}-before-punch.json"
        with connection(args.target) as conn:
            if args.command == "snapshot":
                result = punch_fingerprint(conn)
                write_private(path, json.dumps(result, indent=2))
            else:
                before = json.loads(path.read_text())
                result = punch_fingerprint(conn, before["max_id"])
                if before != result:
                    raise RuntimeError("Preserved raw punches differ from saved fingerprint")
                result = {"preserved": True, **result}
                write_private(PRIVATE / f"{args.target}-preservation-report.json", json.dumps(result, indent=2))
        print(json.dumps(result))
    else:
        entries = []
        for host, db, user, suffix in (("wjcch", "*", "hr", "local"),
              ("aws-0-ap-northeast-1.pooler.supabase.com", "postgres", "hr.tbulauezaixdjzdcqsem", "supabase")):
            password = (ROOT / f".local/database/secrets/hr_{suffix}_password").read_text().strip()
            escape = lambda value: value.replace("\\", "\\\\").replace(":", "\\:")
            entries.append(":".join((host, "5432", db, user, escape(password))))
        write_private(PRIVATE / "pgpass", "\n".join(entries) + "\n")
        print("Private pgpass prepared")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        # Server diagnostics may contain personal data; retain details only locally.
        write_private(PRIVATE / "last-error.txt", repr(exc))
        print(f"Personnel operation failed: {type(exc).__name__}; inspect private last-error.txt")
        raise SystemExit(1)
