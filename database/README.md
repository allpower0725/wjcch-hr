# HR 資料庫與維護

## 目的地與帳號

| 環境 | 位置 | 實體資料庫 | 應用 schema |
|---|---|---|---|
| 本機主庫 | `localhost:5432`，容器 `wjcch` | `wjcch_db` | `hr` |
| 本機隔離測試 | 同一 PostgreSQL instance | `wjcch_db_test` | `hr` |
| 雲端 | Supabase `wjcch`，ref `tbulauezaixdjzdcqsem` | `postgres` | `hr` |

production 只使用雲端。只有開發／測試及人工維護本機資料庫時，才需要本機 PostgreSQL；正式機啟動 collector 不執行初始化或本機資料庫探測。

`hr` 擁有該 schema、表與 sequence；`hr_collector` 只取得收集所需權限。兩者都沒有 SUPERUSER、CREATEDB、CREATEROLE、REPLICATION 或 BYPASSRLS。

人事主檔包括部門、員工、職稱、職務、聘用類別、主管、學歷、證照與卡機身分對照。打卡資料另有三張業務表。`collector_target` 存放目的地 UUID，migration journal 為 `db_migrations.hr`。資料關係與證照效期見 [人事整合](personnel/README.md)。

所有業務表啟用 RLS。收集相關 policy 僅授予 hr_collector，人事表僅限維護角色存取。查詢 view 使用 SECURITY INVOKER，批次寫入函式的執行權限另行授予。

## 密碼與連線

Schema 管理密碼留在維護環境，執行密碼位於可獨立搬移的 collector 目錄內，全部不進 Git：

| 檔案（相對於專案根目錄） | 用途 |
|---|---|
| `.local/database/secrets/hr_local_password` | 本機 schema 維護角色 hr |
| `.local/database/secrets/hr_supabase_password` | 雲端 schema 維護角色 hr |
| `collector/.local/database/secrets/hr_collector_local_password` | test 執行帳號 |
| `collector/.local/database/secrets/hr_collector_supabase_password` | production 執行帳號 |

執行容器只掛載選定模式的執行密碼。兩種 compose 將它掛到共同路徑 `/run/secrets/collector_database_password`；production 另掛載公開 CA `collector/.local/database/certs/supabase-ca.crt`。正式機只需要完整 `collector/`，目錄內不包含 schema 管理密碼。

DBeaver：本機使用 Host `localhost`、Port `5432`、Database `wjcch_db`、User `hr`。雲端使用 Host `aws-0-ap-northeast-1.pooler.supabase.com`、Port `5432`、Database `postgres`、User `hr.tbulauezaixdjzdcqsem`，並啟用 CA 及 verify-full。

## 初始化與驗證

從原始專案根目錄操作。維護連線由參數指定私密檔案，不把密碼放在命令列。首次初始化才執行 configure，既有正式機只搬移現有執行密碼。

```powershell
# 建置執行映像與隔離測試工具
docker build --target runtime -t wjcch-collector:hr-modes collector
docker build --target test -t wjcch-collector-test:hr-modes collector
.\scripts\hr-db.ps1 configure
# 輸入 db_owner 密碼檔的本機路徑（不是密碼內容）
$adminPasswordFile = Read-Host '本機 db_owner 密碼檔路徑'
.\scripts\hr-db.ps1 migrate -Test -LocalAdminPasswordFile $adminPasswordFile
.\scripts\hr-db.ps1 verify
.\scripts\hr-db.ps1 migrate -LocalAdminPasswordFile $adminPasswordFile
.\scripts\hr-db.ps1 verify-runtime
```

`migrate` 核對初始化 baseline，再依檔名順序套用尚未記錄的 migration；每個已套用檔案必須與 journal checksum 一致，否則停止。SQL 以 `SET LOCAL ROLE hr` 建立應用物件，extension 等前置作業與管理紀錄由維護角色執行。已套用版本保留原文；詳見 [migration 規則](migrations/README.md)。

| 維護指令 | 行為 |
|---|---|
| `configure` | 準備本機私密檔與權限，已有密碼不重新產生 |
| `migrate` | 建立或核對 baseline，並套用缺少的後續 migration |
| `verify` | 只在 `wjcch_db_test` 執行合成資料測試。一般案例 rollback，跨連線的 LINE 綁定測試會提交合成資料並在結束時清除 |
| `verify-runtime` | 實際執行帳號的寫入／rollback 與越權拒絕檢查 |
| `fingerprint` | 唯讀計算 raw_punch 筆數與 SHA-256 |
| `backup-queue` | 以 SQLite backup API 備份本機佇列，不連卡機或 PostgreSQL |

雲端維護使用 `-Cloud -CloudAdminEnv <私密連線檔> -CloudCa <CA路徑>`。連線檔需有 `MIGRATION_DATABASE_URL`，使用 wjcch 的 db_owner 維護角色；工具拒絕其他專案。雲端更新前，須先通過相同全部 migration hashes 的本機隔離測試。只有 verify 需要測試映像，其餘維護指令使用執行映像。

## 初始系統管理者

套用系統管理者授權 migration 並確認本機驗收後，由具授權的資料庫維護人員執行。先確認目標資料庫、員編與員工的有效 LINE 綁定。以下為本機主庫指定 `P271` 的指令。

```powershell
Get-Content -Raw -Encoding UTF8 database/tools/initialize-system-admin.sql |
  docker exec -i wjcch psql -X -w -U db_owner -d wjcch_db -v employee_no=P271
```

授權記錄以 `employee_id` 關聯，包含授權來源、時間與資料庫維護身分。重跑會保留同一筆有效的初始授權。若初始授權已撤銷，交接或復原由受授權的維護人員在交易中記錄撤銷時間與維護身分，核對接任員工的有效 LINE 綁定，再以 `maintenance` 來源新增授權。保留原有記錄供查核。

### P271 角色切換

這是有資料庫維護權限的人員用來切換 P271 驗收權限的步驟。

1. 開啟 [Supabase `wjcch` 的 SQL Editor](https://supabase.com/dashboard/project/tbulauezaixdjzdcqsem/sql/new)，確認專案是 `wjcch`，目標是 `postgres.hr`。
2. 執行下方 SQL。將 `enable_admin` 設為 `false` 會撤銷 P271 目前的管理者授權，設為 `true` 則在有效 LINE 綁定下恢復授權。結果中的 `is_admin` 應等於所設定的值。
3. 用同一個 P271 LINE 帳號重新整理 [Vercel 班表](https://web-three-coral-4cwibhtp88.vercel.app/roster)。授權有效時可看全院排班單位。撤銷後，名冊依 P271 的員工身分與現有主管指派判定。原有 LINE 綁定可繼續使用。

```sql
BEGIN;
SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

DO $toggle$
DECLARE
  enable_admin constant boolean := false; -- 改為 true 後執行可恢復管理者授權
  pilot_id integer;
  pilot_status hr.employee.employment_status%TYPE;
BEGIN
  IF current_database() <> 'postgres' THEN
    RAISE EXCEPTION '資料庫名稱須為 postgres，請確認目前專案是 wjcch';
  END IF;

  LOCK TABLE hr.system_admin_grant IN SHARE ROW EXCLUSIVE MODE;
  SELECT e.employee_id, e.employment_status INTO STRICT pilot_id, pilot_status FROM hr.employee AS e
  WHERE e.employee_no = 'P271' FOR SHARE;

  IF NOT EXISTS (
    SELECT 1 FROM hr.system_admin_grant
    WHERE employee_id = pilot_id AND source = 'initial'
  ) THEN
    RAISE EXCEPTION 'P271 尚無初始管理者授權紀錄';
  END IF;

  IF enable_admin THEN
    PERFORM 1 FROM hr.employee_line_binding
    WHERE employee_id = pilot_id AND provider_id = '2005826039' AND revoked_at IS NULL
    FOR SHARE;
    IF NOT FOUND OR pilot_status NOT IN ('active', 'on_leave') THEN
      RAISE EXCEPTION 'P271 必須有有效 LINE 綁定及可登入的在職狀態';
    END IF;
    INSERT INTO hr.system_admin_grant(employee_id, source)
    VALUES (pilot_id, 'maintenance')
    ON CONFLICT (employee_id) WHERE revoked_at IS NULL DO NOTHING;
  ELSE
    UPDATE hr.system_admin_grant
    SET revoked_at = clock_timestamp(), revoked_by = session_user
    WHERE employee_id = pilot_id AND revoked_at IS NULL;
  END IF;
END;
$toggle$;

SELECT employee_no, hr.has_system_admin_grant(employee_id) AS is_admin
FROM hr.employee WHERE employee_no = 'P271';
COMMIT;
```

重複執行同一方向不會新增重複授權。恢復時新增一筆 `maintenance` 授權，原先撤銷的紀錄保留。

## 台北時區設定

本機主庫、測試庫與雲端資料庫的預設時區皆為 `Asia/Taipei`。兩份設定依序為：

1. `settings/20261117031328_use_taipei_for_hr_sessions.sql`：HR 帳號及雲端後台角色。
2. `settings/20261117031603_set_database_timezones_to_taipei.sql`：資料庫預設時區。

新環境建立 hr 後再套用設定。本機分別在主庫／測試庫以 db_owner 執行；雲端在 wjcch/postgres 以平台 postgres 執行。新連線的 `SHOW timezone` 應為 `Asia/Taipei`。

`timestamptz` 保存絕對時間，依連線時區顯示；`01:09+00` 與 `09:09+08` 是同一時間點。不要對原始打卡另加八小時。已開啟的工具可重新連線或執行 `SET TIME ZONE 'Asia/Taipei'`；客戶端若自行指定 UTC，仍須調整客戶端。

## 備份與還原

```powershell
.\scripts\hr-db.ps1 backup-queue
```

佇列副本與完整性檢查報告放在 `.local/database/backups/`。備份涵蓋原始紀錄與各目的地送達進度，可在 writer 運行時產生一致副本；實際替換佇列前必須先停止 collector。

PostgreSQL 使用標準 schema 備份／還原流程，由維護者以管理連線操作，涵蓋 hr、必要的 migration journal、角色授權及 sequence。先在隔離資料庫驗證，確認來源／目標與內容後再切換；不要把來源資料直接覆蓋正在收集的目的地。

私密備份、驗證報告與開發封存都保留在 `.local/`，留在維護環境，不作為日常操作入口。
