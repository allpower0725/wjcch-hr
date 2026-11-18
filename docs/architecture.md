# 現行架構

## 資料流

```text
GT100 卡機 → SQLite 原始暫存／待送佇列 → 選定 PostgreSQL 的 hr
                                      ├ test：本機 wjcch_db
                                      └ production：Supabase wjcch/postgres
```

同一程序只選一個目的地。SQLite 是收集器的持久暫存，PostgreSQL 是查詢與後續 HR 功能的資料來源。

production 與 test 共用同一份程式碼及 `.env` 範本，在 `collector/` 目錄直接使用對應的 Docker Compose 設定。production 的 `docker-compose.yml` 只掛載雲端密碼與 CA，沒有本機資料庫網路或本機密碼依賴；test 的 `docker-compose.test.yml` 只掛載本機密碼並加入本機資料庫網路。兩份設定各自獨立，不合併載入；設定檔與模式不一致時拒絕啟動。

完整 `collector/` 可獨立搬移：執行密碼與 CA 位於 `collector/.local/database/`，佇列位於 `collector/data/`，兩份 Compose 只掛載本目錄內的路徑。Schema 管理密碼與資料庫維護紀錄留在專案根目錄的 `.local/database/`。

## 收集與送達

1. 每 300 秒依序連線兩台卡機，只讀狀態、打卡及必要的使用者名單，讀完斷線。
2. 紀錄筆數改變或每日完整下載時，將卡機資料以唯一鍵寫入 SQLite，成功後才更新下載進度。
3. 以 `hr.collector_target` 的 UUID 識別目的地，查出該模式／目的地尚未送達的紀錄。
4. 每批預設 500 筆呼叫 `hr.ingest_punch_batch`；資料庫交易成功提交、回覆檢查通過後，才記錄 SQLite 送達。
5. 卡機連線成功但沒有待送資料時，仍更新目的地心跳。最近一輪的卡機及寫入結果用於健康檢查。

資料庫斷線時繼續保存 SQLite，下一輪重試。提交成功但回覆遺失時，重送由唯一鍵去重。相同鍵的原始內容不同時拒絕該批，保留原始資料供檢查。

## SQLite

| 資料表 | 用途 |
|---|---|
| `punch` | 原始打卡；鍵為卡機序號、使用者編號及打卡時間 |
| `device_state`／`device_user` | 最近卡機狀態與完整名單 |
| `delivery` | 各模式／資料庫目的地的打卡送達紀錄 |
| `user_snapshot`／`user_delivery` | 名單版本及各目的地送達版本 |
| `meta` | 下載及各目的地對帳進度 |

切換目的地不清除 SQLite。資料庫重建會產生新 UUID，觸發完整補送。整庫還原若保留 UUID，而希望視為新目的地，須由管理者重設該 UUID。

## PostgreSQL

`hr` 包含人事主檔、組織與主管、職稱與職務、學歷與證照、卡機身分對照、三張打卡業務表及 `collector_target`。`hr` 角色管理該 schema。`hr_collector` 具備收集所需的 DML、sequence、函式及 RLS 權限。

原始打卡以卡機、使用者編號、時間去重。卡機狀態與名單只接受足夠新的觀測時間。使用者從卡機移除時，保留歷史名單，以同步時間判斷當前有效名單。

人事編號與卡機帳號分開保存。`employee_device_mapping` 每台卡機的每個帳號只保留一筆對照。`v_punch_employee` 從 `confirmed_at` 起關聯正式員工，確認前的打卡保留目前候選與 `history_pending`。人事來源及日期規則見 [人事整合](../database/personnel/README.md)。

## 時間與對帳

卡機時間視為台北當地時間，輸入後標註 `Asia/Taipei`。SQLite 使用帶偏移的 ISO 字串，PostgreSQL 使用 `timestamptz`。本機主庫／測試庫及雲端資料庫預設時區皆為台北時間。

每天 03:30 完整下載，再重送近七天資料；下載與目的地重送分別記錄完成進度。這是日常補漏機制，首次還原資料仍需使用完整備份。

同一份 SQLite 使用 OS 檔案鎖防止重複執行。跨主機交接由操作人員先停止目前 writer，再啟動接手主機。
