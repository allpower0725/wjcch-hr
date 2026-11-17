# 安裝與操作

collector 可整個目錄獨立搬移，程式、執行設定、帳密、CA 與 SQLite 佇列都在此目錄內。以下所有指令都在本檔案所在的 `collector/` 目錄執行，直接使用專案原始碼建置。

## 安裝準備

主機須持續開機、時鐘同步，能連線兩台卡機 TCP 4370，並安裝 Docker 與 Docker Compose。Windows 上 Docker Desktop 必須保持運行。

完整複製 `collector/`，包含 `.env`、`.local/` 與 `data/`，保留以下目錄結構：

```text
collector/
  Dockerfile、docker-compose.yml、docker-compose.test.yml、requirements.txt、src/
  .env.example
  .env
  data/
  .local/database/
    secrets/hr_collector_supabase_password   production 使用的檔案
    secrets/hr_collector_local_password      test 使用的檔案
    certs/supabase-ca.crt                    production 使用的檔案
```

production 只需雲端執行密碼及 CA，可省略本機密碼檔；主機能連線 Supabase 的 PostgreSQL session pooler 5432 即可。test 才需要本機 PostgreSQL 容器 `wjcch`、`wjcch_default` 網路及本機執行密碼，可省略雲端密碼與 CA。

`hr_collector_supabase_password` 是內含既有執行密碼的文字檔，檔名沒有副檔名；`supabase-ca.crt` 也是檔案。它們隨 `collector/.local/` 一起搬移，不包含在 Git 或 Docker 映像中。例如正式機在 `C:\project\collector` 執行，密碼檔就位於 `C:\project\collector\.local\database\secrets\hr_collector_supabase_password`。

沿用已建立的資料庫帳密，不重新產生密碼。執行容器以 uid/gid 10001 運行；Linux 上 `data/` 必須可寫，執行密碼檔由 root 持有、群組 10001 唯讀（0440）。Windows 應限制私密檔案的 NTFS 存取權限。資料庫結構由維護環境事先建立，正式機只需這個 collector 目錄。

## 正式模式安裝與啟動

1. 首次安裝時將同目錄的 `.env.example` 複製為 `.env`；已有 `.env` 就保留原檔。
2. 設定 `COLLECTOR_MODE=production`，核對 `CLOUD_DB_*` 與卡機 IP。`LOCAL_DB_*` 不會在此模式使用，也可刪除。
3. Windows 在本目錄確認密碼與 CA 均為檔案，以下兩行都應回傳 `True`：

```powershell
Test-Path -LiteralPath .\.local\database\secrets\hr_collector_supabase_password -PathType Leaf
Test-Path -LiteralPath .\.local\database\certs\supabase-ca.crt -PathType Leaf
```

4. 確認其他主機的 collector 已停止，再執行：

```powershell
docker compose -f docker-compose.yml up -d --build
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml logs --tail 100
```

第一行會直接以目前目錄的程式碼建置並啟動，後兩行用來確認運行狀態與日誌。完成首輪收集後，狀態應顯示 healthy。

更新程式時先停止正式機 collector，保留正式機原有 `.env`、`data/` 及正確的執行密碼與 CA，再覆蓋程式檔案並使用同一條 `up -d --build` 指令。不要用開發機的 `data/` 覆蓋正式機佇列。

## 日常操作

| 操作 | production 指令 |
|---|---|
| 啟動／更新 | `docker compose -f docker-compose.yml up -d --build` |
| 停止 | `docker compose -f docker-compose.yml down` |
| 查看狀態 | `docker compose -f docker-compose.yml ps -a` |
| 查看日誌 | `docker compose -f docker-compose.yml logs --tail 100` |

需單次補送或讀卡驗證時，先停止常駐 collector，再執行：

```powershell
# 只補送 SQLite，不連卡機
docker compose -f docker-compose.yml run --rm --no-deps collector python -m collector sync
# 讀卡並送出一輪
docker compose -f docker-compose.yml run --rm --no-deps collector python -m collector once
```

一次性操作以退出碼與日誌判斷結果；完成後用 `up -d --build` 恢復常駐。`down` 不刪除 `data/`。

## 測試模式與切換

兩種模式共用同一份程式碼，僅連線與掛載設定不同：

| `.env` 的 COLLECTOR_MODE | 使用的設定檔 | 寫入目的地 |
|---|---|---|
| `production` | `docker-compose.yml` | Supabase wjcch.hr |
| `test` | `docker-compose.test.yml` | 本機 PostgreSQL hr |

切換時先用目前模式的設定檔執行 `down`，再修改 `.env` 的 `COLLECTOR_MODE`。例如切換到 test 後：

```powershell
docker compose -f docker-compose.test.yml up -d --build
docker compose -f docker-compose.test.yml ps
docker compose -f docker-compose.test.yml logs --tail 100
```

test 的其他操作也使用相同指令，只將 `-f` 後的檔名改為 `docker-compose.test.yml`。每次只載入一份設定檔，模式與設定檔不一致時程式會拒絕啟動。

切換模式保留同一份 `data/`；各目的地送達進度分開，尚未送達的紀錄會補送。

## 密碼檔讀取錯誤

密碼檔錯誤會顯示容器內路徑及原因。`檔案不存在` 應核對掛載與所選模式的 `PASSWORD_FILE`；`路徑是目錄` 表示掛載來源成了同名資料夾，應先停止容器、將錯誤資料夾改名保留，再放入正確的密碼檔；`權限不足` 應確認搬移後的檔案可由容器 UID/GID 10001 讀取；`內容為空白` 應補回既有執行帳號的密碼。密碼檔支援 UTF-8（含 Windows BOM）及 CRLF 換行。

production 可在本目錄執行以下指令，檢查身分、設定路徑與掛載權限，輸出不含密碼內容：

```powershell
docker compose -f docker-compose.yml exec collector sh -c 'id; printenv COLLECTOR_MODE CLOUD_DB_PASSWORD_FILE; ls -ldn /run/secrets /run/secrets/*'
```

修復掛載或權限後重新執行 `up -d --build`。尚未送達的紀錄保留在 `data/`，不要刪除佇列。

## 搬到另一台主機

1. 在原主機的 `collector/` 目錄使用目前模式的 `down` 指令，確認 collector 已停止。
2. 停止後備份並搬移完整 `data/`（包含 SQLite 及可能存在的 WAL 檔）、`.env`、所選模式的執行密碼與必要 CA。
3. 只將整個 `collector/` 目錄搬到新主機，包含 `.env`、`.local/`、`data/`，核對檔案權限。Schema 管理帳密、資料庫維護腳本與開發備份留在維護環境。
4. 在新主機的 `collector/` 目錄，執行對應模式的 `up -d --build`，檢查狀態與日誌。

兩台主機只能由一台負責收卡。需要回復時，先停止新主機，再恢復原主機；不要清除 SQLite 佇列。
