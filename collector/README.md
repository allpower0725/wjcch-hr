# 打卡收集器

collector 每 5 分鐘只讀院內兩台 GT100。資料先保存於 SQLite，再批次寫入選定的 PostgreSQL 目的地。執行角色為 `hr_collector`。

完整複製本目錄即可獨立部署，包含 `.env`、`.local/` 與 `data/`。安裝、啟停、更新、模式切換及搬移，統一依 [INSTALL.md](INSTALL.md)，所有操作都在本目錄直接使用 Docker Compose。

## 模式與設定

| COLLECTOR_MODE | Compose 設定 | 目的地 |
|---|---|---|
| `test`（範本預設） | `docker-compose.test.yml` | 本機 `5432/wjcch_db.hr` |
| `production` | `docker-compose.yml` | Supabase `wjcch` 專案的 `postgres.hr` |

兩種模式使用同一份程式碼與 `.env.example`。複製範本為同目錄的 `.env`，核對模式、卡機 IP、文字編碼及所選目的地的連線設定。現場卡機為 Big5，範本使用 `DEVICE_ENCODING=cp950`。`.env` 不納入 Git。

每次只連所選目的地。正式模式可省略全部 `LOCAL_DB_*` 設定、本機密碼及本機資料庫網路；測試模式可省略全部 `CLOUD_DB_*` 設定、雲端密碼及 CA。production 強制 TLS `verify-full`。

執行密碼放在本目錄內的 `.local/database/secrets/`：test 掛載 `hr_collector_local_password`，production 掛載 `hr_collector_supabase_password` 與本目錄內的 `.local/database/certs/supabase-ca.crt`。Schema 管理角色 `hr` 的密碼留在維護環境。

兩種模式的送達進度以模式及資料庫 UUID 分開記錄。切回 test 時，會補送 SQLite 中尚未送達本機的紀錄。資料庫維護工具由人工執行，collector 啟動只使用所選目的地。

## 健康狀態與資料核對

Docker healthcheck 檢查 `data/status.json` 的模式、新鮮度及最近一輪結果。卡機失聯或目的地寫入失敗會顯示 unhealthy；待送資料仍保存在 SQLite。`once`／`sync` 是一次性操作，使用退出碼與日誌判斷，不產生常駐健康狀態。

在選定目的地以維護帳號執行：

```sql
SELECT d.serial_no, d.last_seen_at AS 最後連線,
       d.record_count AS 卡機筆數, count(p.raw_punch_id) AS 保存筆數,
       max(p.punched_at) AS 最新打卡
FROM hr.punch_device d
LEFT JOIN hr.raw_punch p USING (punch_device_id)
GROUP BY d.punch_device_id ORDER BY d.serial_no;
```

連線預設時區為 `Asia/Taipei`，時間顯示 `+08`。ZKTime 清除卡機舊紀錄後，保存筆數大於卡機筆數屬正常。時鐘誤差只記錄，校時仍由 ZKTime 負責。
