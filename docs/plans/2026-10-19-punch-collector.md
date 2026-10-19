# 打卡收集器實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal：** 讓院內兩台 GT100 的打卡紀錄每 5 分鐘自動、完整、不重複地進入 Supabase `wjcch-hr`。

**Architecture：**
- 收集器是 Python 常駐程式，跑在 Docker 裡。
- 它用 pyzk 以短連線、只讀的方式讀卡機，用本機 SQLite 比對新紀錄並暫存，再分批 POST 到 Edge Function `ingest-punches`。
- Edge Function 驗證收集器金鑰和資料格式後，呼叫資料庫函式 `ingest_punch_batch`，在同一個交易裡寫入 `punch_device`、`raw_punch`、`punch_device_user`。

**Tech Stack：**
- 收集器：Python 3.12（`python:3.12-slim`）、pyzk 0.9、requests 2.34.2、tzdata 2026.5、pytest 9.1.1（只在測試映像）。
- 雲端：Supabase CLI 2.121.0（`npx supabase`）、Postgres 17、pgTAP、Edge Functions（Deno 2）、`@supabase/supabase-js@2`、zod 3。

**Spec：** [docs/specs/2026-10-19-punch-collector-design.md](../specs/2026-10-19-punch-collector-design.md)

## Global Constraints

- **只讀卡機**：不呼叫 `clear_attendance`、`set_time`、`set_user`、`delete_user`、`get_templates` 或任何寫入卡機的方法。`disable_device()` 只能在 `DISABLE_DEVICE_DURING_READ=true` 時呼叫，而且必須在 `finally` 裡 `enable_device()`。
- **一律斷線**：每次連卡機都在 `finally` 斷線。
- **pyzk 參數**：一律使用 `ommit_ping=True`，因為容器裡沒有 `ping`。
- **時區**：卡機時間一律以 `ZoneInfo("Asia/Taipei")` 標上時區，對外格式為 `YYYY-MM-DDTHH:MM:SS+08:00`。
- **唯一鍵**：本機和雲端都是（卡機序號或 `punch_device_id`、`device_user_no`、`punched_at`）。
- **金鑰**：主機B 只持有 `COLLECTOR_KEY`。Edge Function 優先用 `SUPABASE_SECRET_KEYS` 的 `default`，沒有時才退回 `SUPABASE_SERVICE_ROLE_KEY`。
- **SQL 風格**：照 `create_hr_schema` 的寫法，包括關鍵字大寫、欄位對齊、`set_updated_at()`、`trg_`／`ck_`／`uq_` 命名、每個欄位都有中文 `COMMENT`、全部開 RLS。
- **Log 與錯誤訊息**：用繁體中文。
- **不碰 git 歷史**：執行者不執行 `git commit` 和 `git push`；開發要點規定由使用者做。每個 Task 結束時列出變更檔案，供使用者 commit。
- **測試在容器裡跑**：本機沒有 Python，收集器測試一律在 `wjcch-collector-test` 映像中執行（Task 2 建立）。
- **預設值**（全部可用 `.env` 調整）：輪詢 300 秒、對帳 03:30（台北）、對帳 7 天、每批 500 筆、函式每次最多 1000 筆打卡與 5000 筆使用者、時鐘誤差警告 120 秒、連續失敗 6 次改記 error、健康檢查 15 分鐘。

**常用指令**（從專案根目錄 `C:\project\wjcch-hr` 執行）：

```powershell
# 建立測試映像（requirements 有變動才需要重建）
docker build --target test -t wjcch-collector-test collector
# 執行收集器測試（直接掛載原始碼，改程式不用重建）
docker run --rm -v "${PWD}/collector:/app" wjcch-collector-test python -m pytest -q
# 資料庫測試
npx supabase test db
```

## Review Focus

以下五種狀況沒有任何 Task 的主要測試直接涵蓋，但最可能在實際使用時出問題。每一項都已把測試補進負責的 Task：

1. **中文姓名編碼不對**：卡機若用 Big5 存姓名，用 UTF-8 解碼會變亂碼，而且 pyzk 遇到無法解碼的位元組會直接丟掉，事後救不回來。預期行為：依 `DEVICE_ENCODING` 正確解碼。
   → Task 3 加 `test_read_users_decodes_names_with_configured_encoding`。
2. **卡機時鐘曾被重設**：會出現異常日期（例如 2000-01-01）的紀錄。預期行為：照原始資料保存，不拒收，也不讓整批失敗。
   → Task 6 加 `accepts punches with unusual dates`。
3. **ZKTime 長時間佔用連線**：預期行為：每輪記 warning，連續 6 次後改記 error，另一台卡機照常處理。
   → Task 9 加 `test_consecutive_failures_escalate_to_error`。
4. **首次全量上傳中途斷網**：預期行為：已成功的批次不重送，其餘留在本機，下一輪從斷點繼續。
   → Task 9 加 `test_upload_stops_at_failed_batch_and_resumes`。
5. **同一人同一秒有兩筆，但代碼不同**：預期行為：保留第一筆，不報錯，也不算成新增。
   → Task 7 加 `test_add_punches_keeps_first_when_key_collides`。

---

## 階段 0：準備與現場探測

### Task 1：Repo 設定與同步雲端 migration

**Files:**
- Create: `.gitattributes`
- Create: `supabase/migrations/20261017014559_create_hr_schema.sql`

**Interfaces:**
- Produces：本機 migration 歷史和雲端一致，之後才能用 `npx supabase db push` 只推新的 migration。

- [ ] **Step 1：建立 `.gitattributes`**

  內容兩行：`* text=auto eol=lf`，以及 `*.ps1 text eol=crlf`。

- [ ] **Step 2：把雲端 migration 寫成本機檔案**

  用 Supabase MCP `execute_sql`（唯讀查詢）讀出 `supabase_migrations.schema_migrations` 中 version `20261017014559` 的 `statements[1]`，原封不動寫入上面的檔案。

- [ ] **Step 3：確認本機和雲端的 migration 歷史一致**

  執行：`npx supabase migration list`
  預期：`20261017014559` 在 Local 和 Remote 兩欄都有。

- [ ] **Step 4：確認本機資料庫沒有要保留的資料，再重設**

  1. 先檢查：`docker exec supabase_db_wjcch-hr psql -U postgres -tAc "select count(*) from information_schema.tables where table_schema='public'"`。
  2. 結果是 0，才執行 `npx supabase db reset`。不是 0 就停下來問使用者。
  3. 再查一次 public 的表。預期：5 張表（`job_title`、`employment_type`、`department`、`employee`、`department_manager`）。

- [ ] **Step 5：列出變更檔案，供使用者 commit**

### Task 2：收集器骨架、設定與資料型別

**Files:**
- Create: `collector/requirements.txt`，內容：`pyzk==0.9`、`requests==2.34.2`、`tzdata==2026.5`
- Create: `collector/requirements-dev.txt`，內容：`pytest==9.1.1`
- Create: `collector/Dockerfile`
- Create: `collector/.dockerignore`，排除 `data/`、`.env`、`__pycache__/`、`.pytest_cache/`
- Create: `collector/pyproject.toml`，只放 pytest 設定：`pythonpath = ["src"]`、`testpaths = ["tests"]`
- Create: `collector/src/collector/__init__.py`
- Create: `collector/src/collector/models.py`
- Create: `collector/src/collector/config.py`
- Test: `collector/tests/test_models.py`
- Test: `collector/tests/test_config.py`

**Dockerfile**

三個 stage：
- `base`：`python:3.12-slim`；設定 `PYTHONUNBUFFERED=1`、`PYTHONDONTWRITEBYTECODE=1`、`TZ=Asia/Taipei`、`PYTHONPATH=/app/src`；`WORKDIR /app`；安裝 `requirements.txt`；複製 `src/`。
- `test`：從 base 延伸，安裝 `requirements-dev.txt`，複製 `tests/` 和 `pyproject.toml`；CMD 為 `python -m pytest -q`。
- `runtime`：從 base 延伸，建立使用者 `collector`（uid 10001）與 `/data`，並交給該使用者擁有；`USER collector`；CMD 為 `["python", "-m", "collector", "run"]`。

**Interfaces（Produces）**

`collector.models`：

```python
TAIPEI: ZoneInfo  # ZoneInfo("Asia/Taipei")

def to_taipei(naive: datetime) -> datetime          # 標上台北時區；傳入已帶時區的值則拋 ValueError
def iso(dt: datetime) -> str                        # 先轉成台北時間 → "2026-10-19T07:58:12+08:00"（不含微秒）
def now_taipei() -> datetime                        # 帶時區的現在時間

@dataclass(frozen=True)
class Punch:
    device_user_no: str
    punched_at: datetime        # 帶台北時區
    verify_type: int
    punch_state: int

@dataclass(frozen=True)
class DeviceUser:
    device_user_no: str
    name: str

@dataclass(frozen=True)
class DeviceStatus:
    host: str
    serial_no: str
    model: str
    firmware_version: str
    record_count: int
    user_count: int
    seen_at: datetime           # 收集器讀取狀態的時間（帶時區）
    clock_offset_seconds: int   # round((卡機時間 - seen_at).total_seconds())
```

`collector.config`：

```python
class ConfigError(Exception): ...

@dataclass(frozen=True)
class Settings:
    device_hosts: tuple[str, ...]
    device_port: int = 4370
    device_comm_key: int = 0
    device_timeout_seconds: int = 10
    device_force_udp: bool = False
    device_encoding: str = "UTF-8"
    disable_device_during_read: bool = False
    poll_interval_seconds: int = 300
    reconcile_time: datetime.time = time(3, 30)
    reconcile_days: int = 7
    ingest_url: str = ""
    ingest_region: str = "ap-northeast-1"
    collector_key: str = ""
    upload_batch_size: int = 500
    clock_drift_warn_seconds: int = 120
    failure_error_threshold: int = 6
    data_dir: Path = Path("/data")
    log_level: str = "INFO"

def load_settings(env: Mapping[str, str], *, require_upload: bool = True) -> Settings
```

- 環境變數名稱照規格第 8 節，另加 `FAILURE_ERROR_THRESHOLD`、`DATA_DIR`。
- `require_upload=True` 時，`INGEST_URL` 和 `COLLECTOR_KEY` 必填。`probe` 指令用 `False`。

- [ ] **Step 1：寫失敗的測試**

  `test_models.py`：
  - `test_to_taipei_attaches_zone`：`iso(to_taipei(datetime(2026,10,19,7,58,12))) == "2026-10-19T07:58:12+08:00"`
  - `test_iso_converts_utc_to_taipei`：`iso(datetime(2026,10,18,23,0,tzinfo=timezone.utc)) == "2026-10-19T07:00:00+08:00"`
  - `test_to_taipei_rejects_aware`：傳入已帶時區的值要拋 `ValueError`

  `test_config.py`：
  - `test_defaults`：只給 `DEVICE_HOSTS`、`INGEST_URL`、`COLLECTOR_KEY` 時，`poll_interval_seconds == 300`、`reconcile_time == time(3,30)`、`upload_batch_size == 500`、`ingest_region == "ap-northeast-1"`
  - `test_hosts_are_split_and_trimmed`：`" 192.168.230.190 , 192.168.230.191 "` 解析成兩個 IP 的 tuple
  - `test_missing_key_raises_when_upload_required`：拋 `ConfigError`，訊息含 `COLLECTOR_KEY`
  - `test_probe_mode_does_not_need_upload_settings`：`require_upload=False` 時不拋錯
  - `test_invalid_reconcile_time_raises`：`"25:00"` 要拋 `ConfigError`
  - `test_bool_parsing`：`"true"`、`"1"`、`"yes"` 為真，`"false"`、`"0"` 為假

- [ ] **Step 2：建測試映像並確認測試失敗**

  1. 執行 `docker build --target test -t wjcch-collector-test collector`。
  2. 用「常用指令」跑 pytest。預期：FAIL，錯誤為 `ModuleNotFoundError: collector.models`。

- [ ] **Step 3：實作 `models.py`、`config.py`**

- [ ] **Step 4：再跑測試**

  預期：全部 PASS。

- [ ] **Step 5：列出變更檔案，供使用者 commit**

### Task 3：卡機存取 `device.py`

**Files:**
- Create: `collector/src/collector/device.py`
- Create: `collector/tests/fakes.py`
- Test: `collector/tests/test_device.py`

**Interfaces**

- Consumes：`Settings`、`Punch`、`DeviceUser`、`DeviceStatus`、`to_taipei`、`now_taipei`
- Produces：

```python
class DeviceError(Exception): ...            # 連不上、逾時、通訊錯誤
class DeviceAuthError(DeviceError): ...      # 通訊密碼錯誤（pyzk 回 "Unauthenticated"）

class DeviceSession:
    zk: Any                                  # 底層 pyzk 物件；只給 probe 讀額外資訊
    def read_status(self) -> DeviceStatus
    def read_punches(self) -> list[Punch]    # 依設定決定是否停用卡機；finally 裡一定恢復
    def read_users(self) -> list[DeviceUser] # 只回傳編號和姓名

class DeviceClient:
    def __init__(self, host: str, settings: Settings,
                 zk_factory: Callable[..., Any] = zk.ZK,
                 clock: Callable[[], datetime] = now_taipei) -> None
    @contextmanager
    def session(self) -> Iterator[DeviceSession]   # 連線；離開時在 finally 斷線，斷線失敗只記 log
```

**實作重點**

- 建立 pyzk 物件：`zk_factory(host, port=..., timeout=..., password=comm_key, force_udp=..., ommit_ping=True, encoding="latin-1")`。
- **姓名解碼**：pyzk 用 `encoding` 解碼時會丟掉無法解碼的位元組。所以固定用 latin-1 讀（任何位元組都能無損轉換），再 `name.encode("latin-1").decode(settings.device_encoding, errors="replace")`。
- **pyzk 自動補的名字**：pyzk 對沒有姓名的使用者會填 `"NN-<編號>"`，這種情況轉成空字串。
- **使用者數**：`read_status` 先呼叫 `read_sizes()`，再讀 `zk.users` 與 `zk.records`。
- **卡機型號**：`model` 用 `get_device_name()`，空字串時改用 `get_platform()`。
- **例外轉換**：pyzk 的例外（`ZKErrorConnection`、`ZKErrorResponse`、`ZKNetworkError`、`socket.timeout`、`OSError`）都轉成 `DeviceError`；訊息含 `"Unauthenticated"` 的轉成 `DeviceAuthError`。

**`tests/fakes.py`**

`FakeZK` 模擬 pyzk 的介面，記錄每次呼叫到 `calls: list[str]`：
- 可設定 `serial`、`device_name`、`firmware`、`device_time`、`users`（pyzk `User` 物件）、`attendances`（pyzk `Attendance` 物件）。
- 可設定故障：`fail_on: dict[str, Exception]`。
- 實作的方法：`connect`、`disconnect`、`read_sizes`、`get_serialnumber`、`get_device_name`、`get_platform`、`get_firmware_version`、`get_time`、`get_attendance`、`get_users`、`disable_device`、`enable_device`。

`fake_factory(fake)` 回傳一個 factory，供 `zk_factory` 注入。

- [ ] **Step 1：寫失敗的測試**

  `test_device.py`：
  - `test_read_status_fields`：
    - `serial_no`、`record_count`、`user_count` 等於 fake 的值。
    - 卡機時間比 clock 快 3 秒時，`clock_offset_seconds == 3`。
    - `seen_at` 等於注入的 clock 時間。
  - `test_read_punches_converts_to_taipei`：fake 的 `Attendance("1023", datetime(2026,10,19,7,58,12), 1, 0)` 轉成 `Punch("1023", <+08:00>, 1, 0)`。
  - `test_session_always_disconnects_on_error`：`get_attendance` 拋例外時，呼叫端收到 `DeviceError`，而且 `"disconnect"` 在 `calls` 裡。
  - `test_does_not_disable_device_by_default`：`"disable_device"` 不在 `calls` 裡。
  - `test_reenables_device_when_read_fails`：設定 `disable_device_during_read=True`，讓 `get_attendance` 失敗。`calls` 要依序含 `disable_device`、`enable_device`、`disconnect`。
  - `test_unauthenticated_maps_to_auth_error`：`connect` 拋 `ZKErrorResponse("Unauthenticated")` 時，收到 `DeviceAuthError`。
  - `test_connect_uses_safe_options`：factory 收到的參數含 `ommit_ping=True` 和 `encoding="latin-1"`。
  - `test_read_users_decodes_names_with_configured_encoding`（Review Focus 1）：
    - fake 使用者姓名是 `"王小明".encode("cp950").decode("latin-1")`。
    - 設定 `device_encoding="cp950"` 時，讀出 `"王小明"`。
  - `test_read_users_blanks_placeholder_names`：`"NN-1023"` 讀出空字串。
  - `test_read_users_returns_only_number_and_name`：回傳的是 `DeviceUser`，沒有密碼和卡號欄位。

- [ ] **Step 2：跑測試**

  預期：FAIL（`collector.device` 不存在）。

- [ ] **Step 3：實作 `device.py`、`fakes.py`**

- [ ] **Step 4：跑測試**

  預期：全部 PASS。

- [ ] **Step 5：列出變更檔案，供使用者 commit**

### Task 4：探測指令與現場探測

**Files:**
- Create: `collector/src/collector/probe.py`
- Create: `collector/src/collector/__main__.py`（這個 Task 只先放 `probe` 子指令；`run`、`once` 在 Task 10 加）
- Test: `collector/tests/test_probe.py`

**Interfaces**

- Consumes：`DeviceClient`、`load_settings(require_upload=False)`
- Produces：
  - `probe(settings: Settings, out: Callable[[str], None] = print, client_factory=DeviceClient) -> int`：全部卡機成功回傳 0，否則回傳 1。
  - `main(argv: list[str] | None = None) -> int`：`python -m collector probe`。

**每台卡機要輸出的內容**（都是只讀）

- 連線方式：看 `zk.tcp` 判斷是 TCP 還是 UDP；連線耗時。
- 卡機資訊：序號、`get_device_name`、`get_platform`、韌體；`read_sizes` 的 `users`、`records`、`rec_cap`。
- 時鐘：卡機時間和時鐘誤差。
- 完整下載：`read_punches()` 的耗時和筆數，以及最早、最晚的打卡時間。
- 代碼分布：`verify_type` 和 `punch_state` 各數值的筆數。
- 編號格式：`device_user_no` 長度的分布、有前導 0 的筆數，以及 5 個樣本。
- 姓名編碼：前 5 位使用者的姓名分別用 UTF-8、cp950 解碼的結果。從 `session.zk.get_users()` 取原始字串，再 `encode("latin-1")`。
- 總連線時間。

**輸出限制**：只在畫面顯示，不寫 SQLite、不上傳。姓名只顯示前 5 位，其他使用者只輸出筆數。

- [ ] **Step 1：寫失敗的測試**

  `test_probe.py`：
  - `test_probe_reports_serial_and_counts`：用 FakeZK 跑，輸出含序號和 `records` 數，回傳 0。
  - `test_probe_continues_after_one_device_fails`：第一台 `connect` 失敗時，第二台照樣輸出，回傳 1。
  - `test_probe_never_calls_write_methods`：`calls` 裡沒有 `disable_device`、`clear_attendance`、`set_time`。

- [ ] **Step 2：跑測試**

  預期：FAIL。

- [ ] **Step 3：實作 `probe.py`、`__main__.py`**

- [ ] **Step 4：跑測試**

  預期：全部 PASS。

- [ ] **Step 5：對真卡機執行探測**

  避開交班尖峰（07:30–08:30、15:30–16:30、23:30–00:30）。執行：

  ```powershell
  docker run --rm -e DEVICE_HOSTS=192.168.230.190,192.168.230.191 wjcch-collector-test python -m collector probe
  ```

  預期：兩台都輸出序號。如果出現 `DeviceAuthError`，停下來向使用者要通訊密碼；連不上就改用 `-e DEVICE_FORCE_UDP=true` 重試一次。

- [ ] **Step 6：記錄結果並停下**

  1. 把探測結果寫進 `docs/decisions.md`，內容包括：
     - 序號、型號、韌體、TCP 或 UDP、下載耗時、時鐘誤差。
     - 代碼分布、編號格式。
     - 姓名編碼的判斷，以及據此決定的 `DEVICE_ENCODING`。
  2. 下載耗時若超過 30 秒，提出頻率調整建議。
  3. **停下來等使用者確認後，再進入階段 1。**

---

## 階段 1：雲端資料表與上傳函式

### Task 5：資料表、資料庫函式與資料庫測試

**Files:**
- Create: `supabase/migrations/<執行當下時間>_create_punch_tables.sql`（用 `npx supabase migration new create_punch_tables` 產生）
- Create: `supabase/tests/database/punch_tables.test.sql`

**Interfaces**

- Produces：
  - 資料表 `punch_device`、`raw_punch`、`punch_device_user`，欄位、型別與註解完全照規格 5.1 到 5.3。
  - `public.ingest_punch_batch(p_payload jsonb) RETURNS jsonb`，回傳 `{"punch_device_id": int, "received": int, "inserted": int, "users_synced": int}`。
  - `p_payload` 的格式和規格第 6 節的請求內容相同（已由 Edge Function 驗證過）。

**SQL 重點**

- **`raw_punch` 只增不改**：
  - 唯一鍵 `uq_raw_punch (punch_device_id, device_user_no, punched_at)`。
  - 索引 `ix_raw_punch_punched_at`、`ix_raw_punch_user_time`。
  - 觸發器 `trg_raw_punch_immutable`：對 UPDATE、DELETE 是 `BEFORE ... FOR EACH ROW`，對 TRUNCATE 是 `FOR EACH STATEMENT`。都呼叫 `raw_punch_reject_change()`，拋出 `原始打卡紀錄只能新增，不能修改或刪除`。
- **`punch_device_user`**：唯一鍵 `uq_punch_device_user (punch_device_id, device_user_no)`。
- **`updated_at` 觸發器**：`punch_device` 和 `punch_device_user` 照慣例加 `trg_<表>_updated_at`。
- **`ingest_punch_batch` 的寫法**：
  - `LANGUAGE plpgsql`、`SET search_path = ''`，物件一律寫完整名稱（`public.`）。
  - 新建的卡機，`name` 為 `coalesce(model,'卡機') || ' ' || host(ip_address)`。
  - 狀態欄位只在 `seen_at > coalesce(last_seen_at, '-infinity')` 時更新。
  - 打卡用 `INSERT ... SELECT FROM jsonb_to_recordset(...) ON CONFLICT DO NOTHING`，以 `GET DIAGNOSTICS` 取得新增筆數。
  - 有 `users` 時，upsert 名單，`last_synced_at = seen_at`，並更新 `punch_device.users_synced_at`。
- **權限**：`REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role;`
- **RLS**：三張表都 `ENABLE ROW LEVEL SECURITY`，不建 policy。

- [ ] **Step 1：寫失敗的 pgTAP 測試**

  `punch_tables.test.sql`：

  ```sql
  BEGIN;
  SELECT plan(N);
  ...
  SELECT * FROM finish();
  ROLLBACK;
  ```

  斷言：
  - `has_table` 三張表；三張表的 `relrowsecurity` 都是 true。
  - 第一次以 3 筆打卡呼叫 `ingest_punch_batch`：`inserted = 3`，並建立 `punch_device`，`name = 'GT100 192.168.230.190'`。
  - 同樣內容再呼叫一次：`inserted = 0`，`raw_punch` 仍為 3 筆。
  - 用較舊的 `seen_at` 呼叫：`record_count` 不變；用較新的 `seen_at`：`record_count` 更新。
  - 帶 2 位使用者呼叫：`users_synced = 2`，`users_synced_at` 已設定。
  - `throws_ok`：對 `raw_punch` 做 UPDATE、DELETE、TRUNCATE 都要拋錯。
  - `SET LOCAL ROLE anon;` 後呼叫函式要拋 `permission denied`；`authenticated` 也一樣。
  - `punched_at` 寫入 `'2026-10-19T07:58:12+08:00'` 後，`punched_at AT TIME ZONE 'Asia/Taipei'` 等於 `'2026-10-19 07:58:12'`。

- [ ] **Step 2：確認測試失敗**

  執行：`npx supabase test db`
  預期：FAIL（表不存在）。

- [ ] **Step 3：寫 migration，並套用到本機**

  執行：`npx supabase migration up`。

- [ ] **Step 4：跑測試**

  執行：`npx supabase test db`
  預期：全部 PASS。

- [ ] **Step 5：確認 migration 能從頭套用**

  執行：`npx supabase db reset`，再跑一次 `npx supabase test db`。
  預期：PASS。

- [ ] **Step 6：列出變更檔案，供使用者 commit**

### Task 6：Edge Function `ingest-punches`

**Files:**
- Create: `supabase/functions/ingest-punches/handler.ts`（純邏輯；依賴由參數注入）
- Create: `supabase/functions/ingest-punches/index.ts`（接 `Deno.serve` 和 supabase-js）
- Create: `supabase/functions/ingest-punches/deno.json`（imports：`zod`、`@supabase/supabase-js`，固定版本）
- Modify: `supabase/config.toml`，加 `[functions.ingest-punches]` 與 `verify_jwt = false`
- Create: `supabase/functions/.env`（本機測試用的 `COLLECTOR_KEY`，已在 gitignore）
- Test: `supabase/functions/ingest-punches/handler.test.ts`

**Interfaces**

- Consumes：`public.ingest_punch_batch(p_payload jsonb)`
- Produces：
  - HTTP 介面完全照規格第 6 節。
  - `handleRequest(req: Request, deps: { collectorKey: string; ingest: (payload: IngestPayload) => Promise<IngestResult> }): Promise<Response>`
  - `IngestPayload`、`IngestResult` 的 TypeScript 型別，欄位名稱和規格第 6 節的 JSON 相同。

**實作重點**

- **金鑰比對**：兩邊各自做 SHA-256，再逐位元組 XOR 累加比較，避免逾時攻擊。`collectorKey` 為空時，所有請求一律回 401。
- **zod 驗證**：
  - `punched_at`、`seen_at` 用 `z.string().datetime({ offset: true })`。
  - `device_user_no`：1 到 24 個字元。
  - `verify_type`、`punch_state`：0 到 255 的整數。
  - `punches` 最多 1000 筆，`users` 最多 5000 筆，`name` 最多 50 個字元。
- **錯誤處理**：`ingest` 拋錯時回 500，並用 `console.error` 記錄錯誤，但不回傳資料庫細節。
- **`index.ts`**：
  - admin client 的金鑰：`JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}").default ?? Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`。
  - 呼叫 `.rpc("ingest_punch_batch", { p_payload })`。

- [ ] **Step 1：寫失敗的測試**

  `handler.test.ts`（用 `Deno.test`）：
  - `rejects missing key with 401`、`rejects wrong key with 401`
  - `rejects non-POST with 405`
  - `rejects punch without timezone with 400`：`"2026-10-19T07:58:12"`
  - `rejects more than 1000 punches with 400`
  - `passes valid payload to ingest and returns its result`：回 200，body 等於 fake ingest 的回傳值。
  - `accepts heartbeat without punches`：只有 `device` 時回 200。
  - `accepts punches with unusual dates`（Review Focus 2）：`"2000-01-01T00:00:00+08:00"` 回 200。
  - `returns 500 without leaking db error`：fake ingest 拋 `Error("relation ... secret")` 時，回應內容不含 `secret`。

- [ ] **Step 2：確認測試失敗**

  先查 `denoland/deno` 的 Docker 映像，固定一個 2.x 版本。執行：

  ```powershell
  docker run --rm -v "${PWD}/supabase/functions/ingest-punches:/w" -w /w denoland/deno:<版本> deno test
  ```

  預期：FAIL。

- [ ] **Step 3：實作 `handler.ts`、`index.ts`、`deno.json`、`config.toml`**

- [ ] **Step 4：跑測試**

  預期：全部 PASS。

- [ ] **Step 5：在本機做冒煙測試**

  1. 用 `python -c "import secrets;print(secrets.token_urlsafe(32))"`（在容器裡跑）產生金鑰，寫入 `supabase/functions/.env`。
  2. 執行 `npx supabase stop`，再 `npx supabase start`。
  3. 用 PowerShell 的 `Invoke-RestMethod` 對 `http://127.0.0.1:54321/functions/v1/ingest-punches` 送 2 筆打卡。預期：`inserted=2`。
  4. 再送一次。預期：`inserted=0`。
  5. 用錯的金鑰送。預期：401。

- [ ] **Step 6：列出變更檔案，供使用者 commit**

---

## 階段 2：收集器程式

### Task 7：本機儲存 `store.py`

**Files:**
- Create: `collector/src/collector/store.py`
- Test: `collector/tests/test_store.py`

**Interfaces**

- Consumes：`Punch`、`DeviceUser`、`DeviceStatus`、`iso`
- Produces：

```python
@dataclass(frozen=True)
class DeviceState:
    serial_no: str
    host: str
    model: str
    firmware_version: str
    record_count: int | None      # 上次完整下載成功時的筆數；從未下載過時為 None
    user_count: int
    clock_offset_seconds: int
    seen_at: datetime

class Store:
    def __init__(self, path: Path) -> None                      # 建立資料表、啟用 WAL
    def get_device_state(self, serial_no: str) -> DeviceState | None
    def save_status(self, status: DeviceStatus) -> None         # 更新所有狀態欄位，但不動 record_count
    def set_record_count(self, serial_no: str, count: int) -> None
    def add_punches(self, serial_no: str, punches: Iterable[Punch]) -> int   # 在單一交易裡 INSERT OR IGNORE，回傳新增筆數
    def pending_punches(self, serial_no: str, limit: int) -> list[Punch]     # 依 punched_at 排序
    def mark_uploaded(self, serial_no: str, punches: Sequence[Punch]) -> None
    def serials_with_pending(self) -> list[str]
    def punches_since(self, serial_no: str, since: datetime) -> list[Punch]
    def known_serials(self) -> list[str]
    def replace_users(self, serial_no: str, users: Sequence[DeviceUser]) -> None  # 並標成待同步
    def users_to_sync(self, serial_no: str) -> list[DeviceUser] | None          # 沒有待同步時回傳 None
    def clear_users_dirty(self, serial_no: str) -> None
    def get_meta(self, key: str) -> str | None
    def set_meta(self, key: str, value: str) -> None
```

- `punched_at` 以 `iso()` 字串存放，主鍵是 `(serial_no, device_user_no, punched_at)`。
- 讀回來時要還原成帶台北時區的 `datetime`。

- [ ] **Step 1：寫失敗的測試**

  `test_store.py`（用 `tmp_path`）：
  - `test_add_punches_returns_only_new_rows`：先加 3 筆；再加這 3 筆和 1 筆新的，回傳 1。
  - `test_add_punches_keeps_first_when_key_collides`（Review Focus 5）：同一個鍵、不同 `verify_type`，回傳 0，保留的是第一筆。
  - `test_pending_and_mark_uploaded`：pending 有 3 筆，mark 2 筆之後剩 1 筆。
  - `test_pending_respects_limit_and_order`
  - `test_save_status_does_not_touch_record_count`：`set_record_count(…, 10)` 後再 `save_status(record_count=12)`，`get_device_state().record_count == 10`。
  - `test_punches_since_uses_taipei_time`：`since` 是台北時間 00:00，前一天 23:59 的不包含、當天 00:00 的包含。
  - `test_users_dirty_cycle`：`replace_users` 後 `users_to_sync` 回傳名單，`clear_users_dirty` 之後回傳 None。
  - `test_data_survives_reopen`：關掉再用同一路徑開，資料都還在。
  - `test_meta_roundtrip`

- [ ] **Step 2：跑測試**

  預期：FAIL。

- [ ] **Step 3：實作 `store.py`**

- [ ] **Step 4：跑測試**

  預期：全部 PASS。

- [ ] **Step 5：列出變更檔案，供使用者 commit**

### Task 8：上傳 `uploader.py`

**Files:**
- Create: `collector/src/collector/uploader.py`
- Test: `collector/tests/test_uploader.py`

**Interfaces**

- Consumes：`DeviceState`、`Punch`、`DeviceUser`、`iso`
- Produces：

```python
class UploadError(Exception):
    retryable: bool        # 網路錯誤、逾時、5xx、429 為 True；其他 4xx 為 False
    status: int | None

@dataclass(frozen=True)
class IngestResult:
    punch_device_id: int
    received: int
    inserted: int
    users_synced: int

def build_payload(state: DeviceState, punches: Sequence[Punch],
                  users: Sequence[DeviceUser] | None) -> dict

class Uploader:
    def __init__(self, url: str, key: str, region: str,
                 session: requests.Session | None = None, timeout: float = 30) -> None
    def send(self, state: DeviceState, punches: Sequence[Punch] = (),
             users: Sequence[DeviceUser] | None = None) -> IngestResult
```

- **請求標頭**：`x-collector-key`；`region` 不是空字串時加 `x-region`；`Content-Type: application/json`。
- **請求內容**：
  - `device` 欄位對應：`ip_address` 取自 `state.host`，`seen_at` 取自 `iso(state.seen_at)`。
  - `users is None` 時，不放 `users` 這個鍵。

- [ ] **Step 1：寫失敗的測試**

  `test_uploader.py`，用假的 `requests.Session`，記錄收到的 url、headers、json：
  - `test_build_payload_matches_contract`：鍵名與規格第 6 節完全相同，`punched_at` 結尾是 `+08:00`。
  - `test_send_sets_headers`：含 `x-collector-key` 和 `x-region: ap-northeast-1`；`region=""` 時沒有 `x-region`。
  - `test_send_returns_result`
  - `test_5xx_and_network_errors_are_retryable`：500、503、`requests.ConnectionError`、`requests.Timeout` 都是 `retryable=True`。
  - `test_401_and_400_are_not_retryable`：`UploadError.status` 是對應的狀態碼。
  - `test_users_key_omitted_when_none`

- [ ] **Step 2：跑測試**

  預期：FAIL。

- [ ] **Step 3：實作 `uploader.py`**

- [ ] **Step 4：跑測試**

  預期：全部 PASS。

- [ ] **Step 5：列出變更檔案，供使用者 commit**

### Task 9：輪詢、上傳與心跳 `jobs.py`

**Files:**
- Create: `collector/src/collector/jobs.py`
- Test: `collector/tests/test_jobs.py`

**Interfaces**

- Consumes：`Settings`、`DeviceClient`（以 factory 注入）、`Store`、`Uploader`、`UploadError`、`DeviceError`、`DeviceAuthError`
- Produces：

```python
@dataclass
class PollResult:
    host: str
    serial_no: str | None
    ok: bool
    downloaded: bool
    new_punches: int

class Collector:
    def __init__(self, settings: Settings, store: Store, uploader: Uploader,
                 device_factory: Callable[[str], DeviceClient],
                 clock: Callable[[], datetime] = now_taipei) -> None
    def poll_device(self, host: str, *, force_download: bool = False) -> PollResult
    def upload_pending(self) -> set[str]          # 回傳這輪有成功送出請求的序號
    def send_heartbeats(self, serials: Iterable[str]) -> None
    def run_cycle(self) -> list[PollResult]       # 輪詢 → 上傳 → 心跳（對帳在 Task 10 加）
```

**`poll_device` 流程**（在一個 `session()` 裡完成）：

1. `read_status`，然後 `store.save_status`。
2. 時鐘誤差超過門檻就記 warning。
3. 需要下載時（`force_download`、`record_count is None`，或筆數不同），執行 `read_punches`、`add_punches`、`set_record_count`。
4. 需要同步名單時（`force_download`、從沒同步過，或 `user_count` 和上次不同），執行 `read_users`、`replace_users`。
5. 例外處理：
   - `DeviceAuthError`：記 error，訊息要提醒檢查 `DEVICE_COMM_KEY`。
   - `DeviceError`：累加這台卡機（依 host）的連續失敗次數。達到 `failure_error_threshold` 次才記 error，之前記 warning。
   - 成功後歸零失敗次數。

**`upload_pending` 流程**：

- 每個有待上傳資料或待同步名單的序號，依序處理：
  - 每次取 `upload_batch_size` 筆打卡送出，成功就 `mark_uploaded`，直到沒有待上傳的為止。
  - 待同步的名單和該序號的第一批一起送（沒有待上傳打卡時就單獨送），成功後 `clear_users_dirty`。
- 失敗時：
  - `UploadError.retryable`：停止全部上傳，等下一輪。
  - 不可重試的錯誤：記 error，跳過這個序號。

**心跳**：這輪有連上卡機、但沒送任何請求的序號，各送一次 `send(state)`。失敗只記 warning。

- [ ] **Step 1：寫失敗的測試**

  `test_jobs.py`（用 FakeZK、真 Store 加 `tmp_path`，以及假 Uploader 記錄每次 send）：
  - `test_first_poll_downloads_everything`：第一次輪詢 `downloaded=True`，`new_punches` 等於 fake 的筆數。
  - `test_unchanged_count_skips_download`：第二次輪詢時，FakeZK 的 `calls` 裡沒有 `get_attendance`。
  - `test_increased_count_uploads_only_new`：fake 多 2 筆後跑 `run_cycle`，上傳內容恰好是那 2 筆。
  - `test_decreased_count_still_diffs`：fake 刪掉最舊的 5 筆、新增 1 筆後，`new_punches == 1`。
  - `test_failed_download_keeps_old_count`：`get_attendance` 失敗時，`record_count` 維持舊值，下一輪還會下載。
  - `test_upload_stops_at_failed_batch_and_resumes`（Review Focus 4）：
    - 1200 筆，`batch=500`，第 2 批丟出 retryable 錯誤。
    - 結果：只有 500 筆標成已上傳。
    - 下一輪送出 700 筆（分 500、200 兩批）。
  - `test_non_retryable_error_skips_serial_but_keeps_data`
  - `test_offline_then_recover`：Uploader 連續兩輪都失敗，第三輪成功時，所有 pending 都送出，而且沒有重複。
  - `test_consecutive_failures_escalate_to_error`（Review Focus 3）：
    - 用 `caplog` 檢查。
    - 第 1 到 5 次失敗是 WARNING，第 6 次是 ERROR。
    - 另一台卡機照常輪詢。
  - `test_heartbeat_sent_when_nothing_to_upload`：無變動時，每台卡機各收到一次只含狀態的 send（`punches` 為空）。
  - `test_users_synced_when_user_count_changes`：`user_count` 改變後送出名單；名單沒變時不送。
  - `test_clock_drift_warning`：誤差 200 秒時有 WARNING，誤差 30 秒時沒有。

- [ ] **Step 2：跑測試**

  預期：FAIL。

- [ ] **Step 3：實作 `jobs.py`**

- [ ] **Step 4：跑測試**

  預期：全部 PASS。

- [ ] **Step 5：列出變更檔案，供使用者 commit**

### Task 10：每日對帳、常駐迴圈與指令

**Files:**
- Modify: `collector/src/collector/jobs.py`：加上 `reconcile_if_due`，並在 `run_cycle` 最後呼叫。
- Create: `collector/src/collector/runner.py`
- Modify: `collector/src/collector/__main__.py`：加 `run`、`once` 子指令。
- Test: `collector/tests/test_reconcile.py`
- Test: `collector/tests/test_runner.py`

**Interfaces**

- Produces：

```python
# jobs.Collector
def reconcile_if_due(self, now: datetime) -> None

# runner.py
def run_forever(collector: Collector, settings: Settings, stop: threading.Event,
                clock: Callable[[], datetime] = now_taipei,
                heartbeat_path: Path | None = None) -> None
def install_signal_handlers(stop: threading.Event) -> None    # SIGTERM、SIGINT → stop.set()
def write_heartbeat(path: Path, now: datetime) -> None        # 寫入 iso(now)
```

**對帳規則**（meta 的鍵）

- **到期判斷**：`now`（台北時間）的時間 ≥ `reconcile_time`，而且該步驟記錄的日期 ≠ 今天。
- **下載步驟**：
  - 每台卡機用各自的鍵 `reconcile_download:<host>`。
  - 執行 `poll_device(host, force_download=True)`；成功才寫入今天的日期。
- **重送步驟**：
  - 鍵為 `reconcile_upload`。
  - 對 `known_serials()` 的每個序號，從 `punches_since(serial, 台北今天 00:00 減 reconcile_days 天)` 取資料，每批 `upload_batch_size` 筆送出，加總 `inserted`。
  - 全部成功才寫入日期。
  - `inserted > 0` 時記 WARNING：`對帳補傳 N 筆`；否則記 INFO。

**`run_forever`**

- 每輪先 `run_cycle()`，再寫健康檢查檔；`run_cycle` 的任何例外都記 `logger.exception`，不中斷迴圈。
- 下一輪的開始時間 = 本輪開始時間 + `poll_interval_seconds`，用 `stop.wait(剩餘秒數)` 等待，所以收到 SIGTERM 會立刻醒來結束。

**`__main__`**

- `run`：設定 logging（格式 `%(asctime)s %(levelname)s %(name)s %(message)s`），建立 Store（`data_dir/collector.db`）、Uploader、Collector，然後進入 `run_forever`。
- `once`：只跑一輪 `run_cycle()` 就結束。
- 設定錯誤（`ConfigError`）時，印出中文訊息並以代碼 2 結束。

- [ ] **Step 1：寫失敗的測試**

  `test_reconcile.py`：
  - `test_not_due_before_time`：03:29 不執行。
  - `test_runs_once_per_day`：03:30 執行；同一天 03:35 再呼叫時，不再強制下載。
  - `test_catches_up_after_downtime`：當天第一次呼叫在 09:00，仍會執行。
  - `test_download_retried_per_host`：A 成功、B 失敗；下一次只對 B 強制下載。
  - `test_upload_step_retried_without_redownload`：重送失敗時，下一輪只重送，不再完整下載。
  - `test_resend_window_is_seven_taipei_days`：今天是 10/19，重送範圍從 10/12 00:00（台北）開始。
  - `test_logs_warning_when_backfill_inserted`：假 Uploader 回 `inserted=3` 時，log 有 `對帳補傳 3 筆`。

  `test_runner.py`：
  - `test_stop_event_ends_loop_quickly`：在背景執行緒啟動 `run_forever`，`stop.set()` 之後 2 秒內結束。
  - `test_cycle_exception_does_not_stop_loop`：`run_cycle` 第一次拋例外、第二次正常時，總共被呼叫 2 次。
  - `test_heartbeat_file_written_each_cycle`
  - `test_main_once_exits_zero_with_fake_collector`、`test_main_config_error_exits_2`

- [ ] **Step 2：跑測試**

  預期：FAIL。

- [ ] **Step 3：實作**

- [ ] **Step 4：跑全部收集器測試**

  預期：全部 PASS。

- [ ] **Step 5：列出變更檔案，供使用者 commit**

---

## 階段 3：Docker 化

### Task 11：compose、設定範本與 README

**Files:**
- Create: `collector/docker-compose.yml`
- Create: `collector/.env.example`
- Create: `collector/README.md`

**compose 規格**（照規格第 9 節）

- service 名稱 `collector`：`build: { context: ., target: runtime }`，`image: wjcch-collector:latest`。
- 執行設定：`restart: unless-stopped`、`env_file: .env`、`environment: TZ=Asia/Taipei`。
- 掛載與網路：`volumes: ./data:/data`；`extra_hosts: host.docker.internal:host-gateway`。
- 收尾：`stop_grace_period: 30s`。
- log 輪替：`logging: json-file`，`max-size 10m`、`max-file 5`。
- 健康檢查：`interval 1m`、`start_period 2m`，以 python 一行程式檢查 `/data/heartbeat` 距今是否小於 900 秒。

**`.env.example`**：規格第 8 節的所有變數和預設值，每個變數上一行加中文註解，`COLLECTOR_KEY` 留空。

**README（繁體中文）**

1. 這是什麼。
2. 第一次部署：Windows 加 Docker Desktop（勾選登入時自動啟動、自動登入的注意事項），以及 Linux。
3. 日常操作：`docker compose logs -f`、`ps`（健康狀態）、`restart`。
4. 更新程式：`docker compose up -d --build`。
5. 更換金鑰。
6. 搬移主機時帶走 `data/`。
7. 常見問題：連不上卡機、金鑰錯誤、時鐘誤差。
8. 和 ZKTime 比對的 SQL：
   - 每天每人筆數：`(punched_at AT TIME ZONE 'Asia/Taipei')::date` 加上 `device_user_no`。
   - 每台卡機的總筆數和 `record_count` 對照。

- [ ] **Step 1：寫好三個檔案**

- [ ] **Step 2：確認 compose 設定能正確解析**

  執行：`docker compose -f collector/docker-compose.yml config`，並先暫時複製 `.env.example` 成 `.env`。
  預期：沒有錯誤，而且 `restart: unless-stopped`、`healthcheck` 都出現在輸出裡。

- [ ] **Step 3：建立 runtime 映像**

  執行：`docker compose -f collector/docker-compose.yml build`
  預期：成功。

- [ ] **Step 4：列出變更檔案，供使用者 commit**

---

## 階段 4：本機整合測試

### Task 12：真卡機加本機 Supabase

- [ ] **Step 1：設定 `collector/.env`**

  - `INGEST_URL=http://host.docker.internal:54321/functions/v1/ingest-punches`
  - `INGEST_REGION=`（空值）
  - `COLLECTOR_KEY` 和 `supabase/functions/.env` 相同。
  - `DEVICE_ENCODING`、`DEVICE_FORCE_UDP` 依階段 0 的結果設定。

- [ ] **Step 2：首次全量上傳**

  執行 `docker compose -f collector/docker-compose.yml run --rm collector python -m collector once`。

  預期：本機資料庫每台卡機的 `count(*)` 等於探測時的 `records`，扣除鍵重複的筆數。用 `docker exec supabase_db_wjcch-hr psql ...` 查。

- [ ] **Step 3：常駐執行**

  執行 `docker compose -f collector/docker-compose.yml up -d`。觀察 10 分鐘。

  預期：log 每 5 分鐘一輪；`punch_device.last_seen_at` 持續更新；`docker ps` 顯示 healthy。

- [ ] **Step 4：模擬斷線**

  1. `npx supabase stop`，等一輪。預期：log 出現上傳失敗。
  2. `npx supabase start`，下一輪。預期：補送成功，沒有重複。

- [ ] **Step 5：手動觸發對帳**

  1. 暫時設 `RECONCILE_TIME` 為現在時間的前一分鐘，重啟容器。
  2. 預期：log 出現對帳完成，補傳 0 筆。
  3. 把設定改回 03:30。

- [ ] **Step 6：收尾並回報**

  執行 `docker compose down`，向使用者回報結果。

---

## 階段 5：上線

### Task 13：部署到 `wjcch-hr` 與主機B

上線前先向使用者確認兩件事：「院方書面同意」的現況，以及部署時間。

- [ ] **Step 1：推送 migration 並確認歷史一致**

  執行：`npx supabase db push`
  預期：只套用 `create_punch_tables`。`npx supabase migration list` 兩邊一致。

- [ ] **Step 2：確認雲端已有新版 secret key**

  用 Supabase 後台確認 API Keys 頁有 secret key（`default`）。沒有的話，請使用者建立。

- [ ] **Step 3：部署函式並設定金鑰**

  1. 產生正式用的 `COLLECTOR_KEY`（和本機不同）。
  2. 執行 `npx supabase secrets set COLLECTOR_KEY=...`。
  3. 執行 `npx supabase functions deploy ingest-punches`。

- [ ] **Step 4：雲端冒煙測試**

  用錯的金鑰呼叫正式網址，預期回 401。不送假資料到正式資料庫，所以只測金鑰。

- [ ] **Step 5：主機B 部署**

  1. 照 README 放好程式，在 `.env` 填正式網址、`INGEST_REGION=ap-northeast-1`、正式金鑰。
  2. 執行 `docker compose up -d --build`。

- [ ] **Step 6：驗證**

  第一輪完成後，用 Supabase MCP 唯讀查詢確認：
  - 每台卡機的 `count(*)` 和 `punch_device.record_count` 一致（扣除鍵重複）。
  - `last_seen_at` 在 5 分鐘內有更新。

- [ ] **Step 7：寫入決策紀錄**

  把上線日期與結果寫入 `docs/decisions.md`，並列出變更檔案，供使用者 commit。

---

## 階段 6：並行比對（使用者主導）

用 README 第 8 節的 SQL，連續 1 到 2 週，每天和 ZKTime 報表對照，差異與處理方式記入 `docs/decisions.md`。這個階段不需要寫程式。
