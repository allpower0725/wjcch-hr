# 打卡收集器設計規格

- 日期：2026-10-19
- 狀態：待確認
- 依據：《人事系統 開發要點A（雲端版）》的「打卡收集」與「開發順序 1」，以及 2026-10-19 對話中確認的設計與預設值

## 1. 目標與範圍

收集器每 5 分鐘檢查院內兩台 GT100（192.168.230.190、192.168.230.191）有沒有新打卡，有就下載，並上傳到 Supabase。資料要完整、不重複，而且不能妨礙員工打卡和 ZKTime 運作。

**本階段包含**

- 收集器：Python，在主機B 以 Docker 常駐執行，排程內建。
- 雲端資料表 `punch_device`、`raw_punch`、`punch_device_user`，以及寫入用的資料庫函式。
- Edge Function `ingest-punches`。
- 部署與操作說明，以及和 ZKTime 報表比對用的 SQL。

**本階段不包含**

- 出勤判定、班別。
- 後台畫面、LINE。
- 收集器停擺通知：本階段只把狀態記在雲端，通知留到後續階段，由排程讀 `punch_device.last_seen_at` 判斷。

**完成標準**

1. 新打卡在 10 分鐘內出現在雲端（輪詢 5 分鐘加上上傳時間）。
2. 首次啟動後，雲端每台卡機的筆數等於卡機上的筆數。唯一鍵相同的紀錄只算一筆。
3. 斷網、停電、容器重啟或主機重開後，都能自動恢復，不掉資料、不重複寫入。
4. 和 ZKTime 並行 1 到 2 週，每天每人的打卡筆數與 ZKTime 報表一致。
5. 收集器不改卡機任何設定：不清紀錄、不校時、不改使用者，也不讀指紋。

## 2. 架構

```
GT100 .190 / .191
   │  TCP 4370：短連線、只讀，讀完就斷
   ▼
主機B：collector 容器（Python + pyzk + 本機 SQLite）
   │  HTTPS 443：只帶「上傳專用金鑰」，指定在東京執行（x-region: ap-northeast-1）
   ▼
Supabase Edge Function：ingest-punches（驗證金鑰與格式）
   │  以 secret key 呼叫資料庫函式 ingest_punch_batch（同一個交易）
   ▼
資料表：punch_device、raw_punch、punch_device_user
```

- 主機B 只需要對外連線，不開放任何對內連接埠，容器也不對外提供服務。
- 主機B 上只有一把「上傳專用金鑰」，它只能呼叫 `ingest-punches`。能完整存取資料庫的 secret key 只放在 Edge Function 的環境變數。

## 3. 收集流程

### 3.1 每輪輪詢（預設每 5 分鐘）

兩台卡機依序處理，一台失敗不影響另一台。

1. **連線並讀狀態**：連上卡機，讀序號、型號、韌體、紀錄筆數、使用者數、卡機時間，再算出時鐘誤差。
2. **判斷有沒有變動**：用序號找出本機記錄的上次筆數。
   - 筆數相同：斷線，跳到第 5 步。
   - 筆數不同，或本機沒有紀錄：下載全部打卡紀錄。
3. **斷線**：寫在 `finally`，一定會執行。
4. **比對新紀錄**：把下載到的紀錄寫進本機 SQLite（`INSERT OR IGNORE`），新寫入的就是「待上傳」。全部寫完後才更新本機的「上次筆數」，下載中途失敗則下一輪重來。筆數變少（ZKTime 清了舊資料）也照同樣方式處理。
5. **上傳**：
   - 把所有待上傳紀錄每批 500 筆送到 `ingest-punches`，成功才標成已上傳。
   - 遇到網路錯誤或 5xx：停止這輪上傳，下一輪再送。
   - 遇到 4xx：記錯誤 log，紀錄留在本機。
   - 這一輪有連上、但沒有紀錄要送的卡機，也送一次只含狀態的請求，作為心跳。
6. **寫健康檢查檔**：寫入 `/data/heartbeat`，供 Docker 健康檢查使用。

**不呼叫 `disable_device()`**：停用期間員工無法打卡，交班尖峰會卡住。下載時剛好有人打卡也沒關係，下一輪筆數變了就會補到。保留設定 `DISABLE_DEVICE_DURING_READ`：現場若發現不停用會讀到錯亂的資料，就改為停用，並在 `finally` 裡 `enable_device()`。

### 3.2 首次啟動

本機 SQLite 是空的，所以第一輪會下載兩台卡機上全部約半年的紀錄，並分批上傳。之後只傳新的紀錄。

### 3.3 每日對帳（台北時間 03:30）

分兩步，各自記錄完成日期。失敗時只重做沒完成的那一步，不會每 5 分鐘重複完整下載。

1. **強制完整下載**：不看筆數，把兩台卡機的紀錄完整下載一次並寫進本機。這一步能抓到「筆數剛好沒變、內容卻變了」的情況。
2. **重送近 7 天**：本機近 7 天的紀錄依卡機分批重送一次，雲端以唯一鍵去重。雲端回傳的新增筆數若大於 0，就以警告等級記 log：「對帳補傳 N 筆」。

錯過 03:30（例如當時停機）的話，恢復後第一輪就會補跑。開發要點原本寫的是「逐日比對筆數」，改用「重送去重」結果相同，但不必另寫查詢 API。這項記在 `docs/decisions.md`。

### 3.4 使用者名單同步

- 讀取卡機使用者時只保留編號和姓名。密碼、卡號、權限都在收集器裡就丟掉，指紋範本從頭到尾不讀。
- 以下兩種情況會把完整名單送上雲端：卡機使用者數和上次不同時，以及每日對帳時。
- 名單先存在本機，上傳成功才清掉「待同步」標記。

### 3.5 狀態回報

每次上傳都帶著卡機狀態：序號、IP、型號、韌體、最後連上時間、紀錄筆數、使用者數、時鐘誤差。雲端依「最後連上時間」只保留最新的狀態，所以補送舊資料不會把狀態倒回去。

時鐘誤差超過 120 秒時，在 log 記警告。收集器只記錄，不校時。

### 3.6 時間與時區

- 卡機時間是不帶時區的台北時間，收集器一律標上 `Asia/Taipei` 後，轉成 `+08:00` 格式的 ISO 字串。
- 排程的 03:30 和「近 7 天」也用 `Asia/Taipei` 計算，不受容器或主機的時區設定影響。
- 容器設定 `TZ=Asia/Taipei`，只是為了讓 log 好讀。

## 4. 本機 SQLite（`/data/collector.db`）

| 資料表 | 內容 |
| --- | --- |
| `punch` | 收過的每筆打卡。主鍵是（卡機序號、使用者編號、打卡時間）；`uploaded_at` 為空代表待上傳；另記 `first_seen_at` |
| `device_state` | 每台卡機（依序號）的 IP、型號、韌體、上次筆數、使用者數、時鐘誤差、最後連上時間、名單是否待同步 |
| `device_user` | 最近一次讀到的使用者名單（編號、姓名），上傳成功前保留 |
| `meta` | 鍵值設定，例如兩個對帳步驟各自的完成日期 |

- 使用 WAL 模式，並放在掛載的 `data/` 資料夾，容器重建後資料仍在。
- 本階段不清舊資料。一年約數十 MB，以後真有需要再加。

## 5. 雲端資料表（新 migration）

照現有慣例：
- 表名用單數；主鍵 `<表>_id`，是 `GENERATED ALWAYS AS IDENTITY`。
- `created_at` 和 `updated_at` 共用 `set_updated_at()` 觸發器。
- 每個欄位都寫中文 `COMMENT`。
- 全部開啟 RLS，本階段不設任何 policy，所以前端讀寫不到。後台的讀取權限在第二階段加。

### 5.1 `punch_device`（打卡機）

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `punch_device_id` | integer，自動編號 | 打卡機識別碼 |
| `serial_no` | varchar(30)，唯一，必填 | 卡機序號。兩台機器號都是 1，以序號區分 |
| `name` | varchar(50)，必填 | 顯示名稱。第一次建立時預設為「型號 IP」，之後可在後台改，收集器不會覆蓋 |
| `ip_address` | inet | 最近一次回報的 IP |
| `model` | varchar(30) | 型號 |
| `firmware_version` | varchar(50) | 韌體版本 |
| `last_seen_at` | timestamptz | 收集器最後一次成功連上的時間 |
| `record_count` | integer | 最後連上時卡機上的打卡紀錄筆數 |
| `user_count` | integer | 最後連上時卡機上的使用者數 |
| `clock_offset_seconds` | integer | 卡機時鐘減標準時間的秒數；只記錄，不校時 |
| `users_synced_at` | timestamptz | 最後一次完整同步使用者名單的時間 |
| `is_active` | boolean，預設 true | 使用中；卡機汰換時改為否 |
| `created_at`、`updated_at` | timestamptz | 建立、最後修改時間 |

收集器第一次送來某個序號時，自動建立這筆資料。

### 5.2 `raw_punch`（原始打卡紀錄，只增不改）

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `raw_punch_id` | bigint，自動編號 | 原始打卡識別碼 |
| `punch_device_id` | integer，必填，外鍵 | 哪一台卡機 |
| `device_user_no` | varchar(24)，必填 | 卡機上的使用者編號，對應 `employee.employee_no` |
| `punched_at` | timestamptz，必填 | 打卡時間（以 +08:00 寫入） |
| `verify_type` | smallint，必填 | 驗證方式原始代碼（pyzk 的 `status`，例如指紋、刷卡、密碼） |
| `punch_state` | smallint，必填 | 打卡狀態原始代碼（pyzk 的 `punch`，例如上班、下班） |
| `received_at` | timestamptz，預設 now() | 雲端收到的時間 |

- 唯一鍵 `uq_raw_punch`：(`punch_device_id`, `device_user_no`, `punched_at`)。
- 索引：`punched_at`；(`device_user_no`, `punched_at`)。
- 觸發器 `trg_raw_punch_immutable`：擋下 UPDATE、DELETE、TRUNCATE。要更正資料時必須另寫 migration 暫時停用它，所以一定會留下紀錄。
- 代碼的實際意義，在階段 0 用現場資料確認後補進欄位註解。

### 5.3 `punch_device_user`（卡機使用者名單）

| 欄位 | 型別 | 說明 |
| --- | --- | --- |
| `punch_device_user_id` | integer，自動編號 | 識別碼 |
| `punch_device_id` | integer，必填，外鍵 | 哪一台卡機 |
| `device_user_no` | varchar(24)，必填 | 卡機上的使用者編號 |
| `name` | varchar(50) | 卡機上登錄的姓名 |
| `last_synced_at` | timestamptz，必填 | 最後一次出現在同步名單裡的時間 |
| `created_at`、`updated_at` | timestamptz | 建立、最後修改時間 |

- 唯一鍵：(`punch_device_id`, `device_user_no`)。
- 判斷已從卡機刪除的使用者：`last_synced_at` 早於該卡機的 `users_synced_at`。
- 不另建員工對照表：員工對照直接用 `employee.employee_no`（註解寫明是「打卡機上的號碼」）。前導 0 這類格式差異在階段 0 確認。

### 5.4 資料庫函式 `ingest_punch_batch(p_payload jsonb) RETURNS jsonb`

在同一個交易裡完成：

1. 以序號 upsert `punch_device`。只有在 `seen_at` 比現有的 `last_seen_at` 新時才更新狀態欄位；`name` 只在新建時寫入。
2. 寫入 `raw_punch`，用 `ON CONFLICT DO NOTHING` 略過重複，並計算實際新增筆數。
3. 有 `users` 時 upsert `punch_device_user`，並更新 `users_synced_at`。
4. 回傳 `{punch_device_id, received, inserted, users_synced}`。

權限：`REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated`，只有 `service_role` 能執行。函式設定 `SET search_path = ''`，和 `set_updated_at()` 一致。

## 6. 上傳 API：`POST /functions/v1/ingest-punches`

**請求標頭**

- `Content-Type: application/json`
- `x-collector-key: <COLLECTOR_KEY>`
- `x-region: ap-northeast-1`

**請求內容**

```json
{
  "device": {
    "serial_no": "ABC1234567",
    "ip_address": "192.168.230.190",
    "model": "GT100",
    "firmware_version": "Ver 6.60 ...",
    "seen_at": "2026-10-19T14:05:03+08:00",
    "record_count": 41234,
    "user_count": 312,
    "clock_offset_seconds": -3
  },
  "punches": [
    { "device_user_no": "1023", "punched_at": "2026-10-19T07:58:12+08:00", "verify_type": 1, "punch_state": 0 }
  ],
  "users": [
    { "device_user_no": "1023", "name": "王小明" }
  ]
}
```

- `device.serial_no` 和 `device.seen_at` 必填，`device` 的其他欄位可省略。
- `punches` 可省略或給空陣列（只回報狀態），一次最多 1000 筆。
- `users` 只在同步名單時提供，而且必須是完整名單，一次最多 5000 筆。
- `punched_at` 和 `seen_at` 都必須帶時區。

**回應**

| 狀態碼 | 時機 | 內容 |
| --- | --- | --- |
| 200 | 成功 | `{"punch_device_id": 1, "received": 500, "inserted": 498, "users_synced": 0}` |
| 400 | 格式錯誤 | `{"error": "...", "details": [...]}` |
| 401 | 金鑰錯誤或沒帶 | `{"error": "unauthorized"}` |
| 405 | 不是 POST | — |
| 500 | 資料庫錯誤 | `{"error": "..."}`；收集器保留資料，下一輪重送 |

函式設定：`supabase/config.toml` 加 `[functions.ingest-punches] verify_jwt = false`，由程式自行比對金鑰，並採用固定時間比對（timing-safe）。

## 7. 金鑰與安全

- **`COLLECTOR_KEY`**：32 bytes 隨機值。
  - 存放位置：雲端 Edge Function secret（`npx supabase secrets set`）、主機B 的 `collector/.env`、本機測試用的 `supabase/functions/.env`。三處都不進 git。
  - 更換方式：同時更新雲端 secret 和 `.env`，再重啟容器。
- **Edge Function 寫資料庫用的金鑰**：用新的 secret key，讀 `SUPABASE_SECRET_KEYS` 的 `default`。舊的 `service_role` 金鑰會在 2026 年底停用。若專案還沒建立新金鑰，暫時退回 `SUPABASE_SERVICE_ROLE_KEY`，並提醒到後台建立。
- **為什麼不讓收集器直接拿 Supabase 的 secret key**：secret key 能繞過 RLS 讀寫整個資料庫；上傳專用金鑰只能呼叫這一個函式。
- **主機B 本機的個資**：SQLite 存有打卡紀錄，所以 `collector/data/` 要限制只有管理者能存取。

## 8. 設定（`collector/.env`，範本為 `.env.example`）

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `DEVICE_HOSTS` | `192.168.230.190,192.168.230.191` | 卡機 IP，逗號分隔 |
| `DEVICE_PORT` | `4370` | 連接埠 |
| `DEVICE_COMM_KEY` | `0` | 卡機通訊密碼，沒設定就是 0 |
| `DEVICE_TIMEOUT_SECONDS` | `10` | 單一指令逾時秒數 |
| `DEVICE_FORCE_UDP` | `false` | 階段 0 確認卡機要用 TCP 或 UDP |
| `DEVICE_ENCODING` | `UTF-8` | 卡機上姓名的文字編碼；階段 0 確認是 UTF-8 還是 Big5（cp950） |
| `DISABLE_DEVICE_DURING_READ` | `false` | 見 3.1 |
| `POLL_INTERVAL_SECONDS` | `300` | 輪詢間隔 |
| `RECONCILE_TIME` | `03:30` | 每日對帳時間（台北） |
| `RECONCILE_DAYS` | `7` | 對帳重送天數 |
| `INGEST_URL` | `https://zakixjdjnwetrvhsqsyg.supabase.co/functions/v1/ingest-punches` | 上傳網址 |
| `INGEST_REGION` | `ap-northeast-1` | 送出的 `x-region`；設成空值就不指定 |
| `COLLECTOR_KEY` | （必填） | 上傳專用金鑰 |
| `UPLOAD_BATCH_SIZE` | `500` | 每批筆數 |
| `CLOCK_DRIFT_WARN_SECONDS` | `120` | 時鐘誤差警告門檻 |
| `LOG_LEVEL` | `INFO` | log 等級 |

## 9. Docker 與部署

**映像**

- `python:3.12-slim`，以非 root 使用者執行。
- 套件：`pyzk`、`requests`、`tzdata`，版本固定。
- 不需要 `ping` 程式：pyzk 設定 `ommit_ping=True`。

**docker-compose.yml**

- `restart: unless-stopped`、`env_file: .env`、`TZ=Asia/Taipei`。
- 掛載 `./data:/data`。
- `extra_hosts: host.docker.internal:host-gateway`：本機測試時要連本機 Supabase，Linux 主機也適用。
- log 輪替：json-file，`max-size 10m`、`max-file 5`。
- 健康檢查：`/data/heartbeat` 超過 15 分鐘沒更新，就標成 unhealthy。
- `stop_grace_period: 30s`，收到 SIGTERM 後收尾再結束。

**指令**

- `python -m collector run`：常駐，這是預設。
- `python -m collector once`：只跑一輪就結束。
- `python -m collector probe`：只讀探測，印出卡機資訊和下載耗時，不寫 SQLite、不上傳。

**主機B：Windows 加 Docker Desktop（現況）**

- 安裝 Docker Desktop，勾選「登入時自動啟動」。
- 注意：Docker Desktop 要有人登入 Windows 才會啟動。可以設定自動登入，或接受「重開機後要有人登入」；停機期間的打卡會在恢復後從卡機補回。
- 在 `collector/` 放好 `.env` 後執行 `docker compose up -d --build`。

**主機B：日後改成 Linux**

- 安裝 Docker Engine 和 compose 外掛，用同一個資料夾和同一個指令啟動。開機自動執行由 systemd 負責。
- 要搬移時，把 `collector/data/` 一起帶過去，就不必重新全量上傳（不帶也只會重送一次，雲端會去重）。
- 程式不含 shell 腳本；另設 `.gitattributes` 固定換行字元為 LF，避免 Windows 和 Linux 間的換行差異。

## 10. 錯誤處理一覽

| 狀況 | 處理 |
| --- | --- |
| 卡機連不上、逾時、被 ZKTime 佔用 | 記 warning，下一輪再試；連續失敗超過 6 次（30 分鐘）改記 error |
| 下載到一半斷線 | `finally` 斷線；不更新上次筆數，下一輪重新下載 |
| 通訊密碼錯誤 | 記 error，並提示檢查 `DEVICE_COMM_KEY` |
| 對外網路中斷、雲端 5xx | 紀錄留在 SQLite，下一輪補送 |
| 雲端回 401 | 記 error「金鑰錯誤」；資料保留 |
| 雲端回 400 | 記 error 和回應內容；資料保留，等修正程式 |
| 程式例外 | 每輪各自 try/except，不讓常駐程式結束；萬一結束，由 Docker 自動重啟 |
| `docker stop`、主機關機 | 收到 SIGTERM 就停止排程；正在進行的卡機作業完成並斷線後結束 |
| 卡機時鐘誤差過大 | 記 warning，不校時 |

## 11. 測試策略

- **收集器單元測試**（pytest，在容器裡跑）：用假卡機和假上傳端，先寫測試再寫程式。測試案例：
  - 筆數不變時不下載；只上傳新紀錄；筆數變少照常比對。
  - 下載失敗時不更新上次筆數。
  - 斷網時暫存，恢復後補送；分批上傳；4xx 和 5xx 分開處理。
  - 時區轉換：`+08:00`，以及跨午夜的情況。
  - 每日對帳：準時執行、停機後補跑、兩步各自重試。
  - 使用者名單：只送編號與姓名，數量變動時才同步。
  - SIGTERM 能安全結束。
- **函式與資料表測試**（本機 `supabase start`）：
  - 金鑰錯回 401、格式錯回 400。
  - 正常寫入時，新增筆數正確；重送時新增 0 筆。
  - 舊的 `seen_at` 不會蓋掉新狀態。
  - `raw_punch` 無法 UPDATE 或 DELETE。
  - anon、authenticated 角色讀不到資料，也執行不了函式。
- **現場測試**：
  - 階段 0：用 `probe` 只讀探測。
  - 階段 4：這台電腦上的容器，連真卡機，送到本機 Supabase。

## 12. 開發階段

| 階段 | 內容 | 檢查點 |
| --- | --- | --- |
| 0 | `.gitattributes`（`.gitignore` 已在寫規格時建立）；把雲端的 `create_hr_schema` 抓回 `supabase/migrations/`；收集器骨架與 `probe` | 兩台卡機的序號、韌體、筆數、時鐘誤差、完整下載耗時、TCP 或 UDP、能否和 ZKTime 共存。**做完先停，你確認後再繼續** |
| 1 | migration、資料庫函式、`ingest-punches` 與測試 | 本機測試全部通過 |
| 2 | 收集器程式與單元測試 | 測試全部通過 |
| 3 | Dockerfile、compose、README | 本機 `docker compose up -d` 能常駐執行 |
| 4 | 本機整合測試（真卡機、只讀，送到本機 Supabase） | 首次回補、輪詢、斷網補送都正常 |
| 5 | 部署到雲端 `wjcch-hr`、設定金鑰、在主機B 啟動 | 雲端筆數和卡機一致，心跳持續更新 |
| 6 | 並行比對 1 到 2 週 | 結果記入 `docs/decisions.md` |

依開發要點，git 的 commit 和 push 由使用者執行。

## 13. 風險與待確認

- **完整下載耗時**：階段 0 量測。若超過數十秒，就放寬頻率，或只在離峰時段做完整下載。
- **與 ZKTime 共存**：如果 ZKTime 一直佔著連線，收集器會一直連不上。階段 0 確認；必要時調整 ZKTime 的連線方式。
- **通訊密碼**：卡機若有設定，探測時會連線失敗，到時再請使用者提供。
- **編號格式**：卡機使用者編號和 `employee.employee_no` 可能差在前導 0 這類格式，階段 0 用實際資料確認。
- **書面同意**：階段 5 會把真實打卡資料送上雲端，開發要點中「院方書面同意」尚未完成。
- **自動啟動**：主機B 是 Windows 加 Docker Desktop，重開機後要有人登入才會恢復收集；資料不會遺失，但會延遲。
