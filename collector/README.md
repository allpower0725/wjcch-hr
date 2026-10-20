# 打卡收集器

收集器每 5 分鐘檢查院內兩台 GT100（192.168.230.190、.191）的打卡紀錄，有新紀錄就上傳到 Supabase `wjcch-hr`。

- **只讀卡機**：不清紀錄、不校時、不改使用者，也不讀指紋。下載時不停用卡機，員工照常打卡。
- **斷線也不掉資料**：網路斷線時紀錄先存在本機 `data/collector.db`，恢復後自動補送。
- **每日對帳**：每天台北時間 03:30 完整下載一次，並把近 7 天的紀錄重送一次。雲端會去掉重複的，所以有缺漏會自動補上。

設計細節見 [docs/specs/2026-10-19-punch-collector-design.md](../docs/specs/2026-10-19-punch-collector-design.md)。

## 目前在哪裡執行

從 2026-10-19 起，正式收集暫時由開發電腦（192.168.230.74）負責，資料夾是 `C:\project\wjcch-hr\collector`。主機B 決定之後，照 [INSTALL.md](INSTALL.md) 安裝並搬過去。

開發電腦下班關機時，收集會跟著暫停，打卡則留在卡機上。隔天開機、Docker Desktop 啟動後，第一輪就會自動補上，不會掉資料，只是雲端會晚幾個小時才有夜間的紀錄。例如 2026-10-19 17:07 關機，隔天 07:44 開機後補上 56 筆。

## 安裝與搬移

在乾淨的主機上安裝（Windows 或 Linux），以及從開發電腦搬到主機B 的完整步驟，見 [INSTALL.md](INSTALL.md)。

## 本機測試（開發用）

開發電腦連本機 Supabase 測試時，用的是 `.env.local`（`INGEST_URL` 指向 `host.docker.internal:54321`、`INGEST_REGION` 留空）。

- **開發電腦還在跑正式收集時**：不要用 `.env.local` 啟動常駐容器，否則會停掉正式收集。要測試請用另一個資料夾和另一份 compose 專案。
- **搬到主機B 之後**：照 INSTALL.md 第 5 節，把 `.env.local` 改回 `.env`。

## 日常操作

在 `collector/` 資料夾執行：

| 要做的事 | 指令 |
| --- | --- |
| 看即時 log | `docker compose logs -f` |
| 看最近 200 行 log | `docker compose logs --tail 200` |
| 看狀態（應為 `healthy`） | `docker compose ps` |
| 重新啟動 | `docker compose restart` |
| 停止 | `docker compose down` |
| 手動跑一輪 | `docker compose run --rm collector python -m collector once` |
| 探測卡機（只讀，不上傳） | `docker compose run --rm collector python -m collector probe` |

正常的 log 長這樣，每 5 分鐘一輪：

```
INFO collector.jobs 192.168.230.190（3088152000240）紀錄 6354 筆，沒有變動
INFO collector.jobs 3088152000240 上傳 3 筆，雲端新增 3 筆
```

## 人工檢查

建議每天看一次，或懷疑有問題時檢查。

> **時區**：從 2026-10-20 起，Supabase 後台的 Table Editor 和 SQL Editor 都以台灣時間顯示（結尾是 `+08`），和卡機上的時間一致。如果看到結尾是 `+00` 的時間（例如其他工具或 API 回傳的資料），那是 UTC，要加 8 小時才是台灣時間；兩者其實是同一個時間點。下面的 SQL 也已經轉成台灣時間。

### 1. 從雲端看狀態

在 Supabase 後台的 SQL Editor 執行：

```sql
SELECT d.name AS 卡機,
       to_char(d.last_seen_at AT TIME ZONE 'Asia/Taipei', 'MM-DD HH24:MI') AS 最後連線,
       round(extract(epoch FROM now() - d.last_seen_at) / 60) AS 距今分鐘,
       d.record_count AS 卡機筆數,
       count(p.*) AS 雲端筆數,
       to_char(max(p.punched_at) AT TIME ZONE 'Asia/Taipei', 'MM-DD HH24:MI') AS 最新打卡,
       d.clock_offset_seconds AS 時鐘誤差秒
  FROM punch_device d
  LEFT JOIN raw_punch p USING (punch_device_id)
 GROUP BY d.punch_device_id
 ORDER BY d.name;
```

| 欄位 | 正常 | 不正常時怎麼辦 |
| --- | --- | --- |
| 距今分鐘 | 10 以內。即使沒有新打卡，收集器每 5 分鐘也會回報一次狀態 | 主機關機或睡眠、Docker 沒啟動，或卡機、網路不通。接著做第 2 步 |
| 卡機筆數、雲端筆數 | 兩者相同。ZKTime 清掉卡機舊紀錄後，雲端會比較多，這是正常的 | 雲端比較少，而且下一輪仍沒補上：看 log 是否上傳失敗 |
| 最新打卡 | 上班時段應接近現在 | 夜間沒人打卡時，停在最後一筆是正常的。只有 .190 的時間會比較新也是正常的，.191 多半是下班打卡 |
| 時鐘誤差秒 | 正負 120 以內 | 請 ZKTime 對卡機校時 |

### 2. 在執行收集器的主機上看

在 `collector/` 資料夾執行：

```powershell
docker compose ps
```
```powershell
docker compose logs --since 1h
```

- 狀態要是 `Up … (healthy)`。如果是 `unhealthy` 或根本沒有這個容器，執行 `docker compose up -d`。
- log 裡出現 `WARNING`、`ERROR` 時，對照下面的「常見問題」。只有 `INFO` 就是正常。
- 主機剛開機時，第一輪會出現 `下載後新增 N 筆`，那是關機期間的打卡被補上，是正常的。

### 3. 和 ZKTime 報表比對

見本文最後一節「和 ZKTime 報表比對」。

## 更新程式

更新 `collector/` 裡的程式檔後，執行 `docker compose up -d --build`。`data/` 和 `.env` 都會保留。

## 更換上傳金鑰

1. 產生新金鑰：`docker compose run --rm collector python -c "import secrets; print(secrets.token_urlsafe(32))"`。
2. 在開發電腦專案根目錄更新雲端的 secret：`npx supabase secrets set COLLECTOR_KEY=新金鑰`。
3. 修改主機B 的 `.env`，再執行 `docker compose up -d`。

在步驟 2 和步驟 3 之間，上傳會失敗（log 會出現 401），但資料會留在本機，換好之後自動補送。

## 搬到另一台主機

把整個 `collector/` 資料夾（含 `data/` 和 `.env`）搬過去，再執行 `docker compose up -d --build`。

沒帶 `data/` 也可以：收集器會把卡機上的紀錄全部重送一次，雲端會自動去重。

## 常見問題

| log 訊息 | 原因與處理 |
| --- | --- |
| `連線卡機失敗（連續第 N 次）` | 卡機斷電、網路不通，或 ZKTime 正佔用連線。偶爾一次沒關係，下一輪會再試。連續 6 次（30 分鐘）以上會改記 ERROR，請檢查卡機與網路 |
| `通訊密碼錯誤，請檢查 DEVICE_COMM_KEY` | 卡機設了通訊密碼，把它填進 `.env` |
| `上傳暫時失敗，資料留在本機` | 對外網路或 Supabase 暫時不通；恢復後會自動補送 |
| `上傳失敗 HTTP 401（請檢查 COLLECTOR_KEY）` | `.env` 的金鑰和雲端的不一致 |
| `上傳被雲端拒收` | 資料格式被拒（HTTP 400）。資料保留在本機，請把 log 交給開發者 |
| `卡機時鐘誤差 ... 超過 120 秒` | 卡機時鐘偏差太大。校時由 ZKTime 負責，請檢查它的自動校時 |
| `每日對帳：...對帳補傳 N 筆` | 雲端原本缺了 N 筆，已經自動補上。偶爾出現沒關係；常出現請告知開發者 |

## 和 ZKTime 報表比對

在 Supabase 後台的 SQL Editor 執行。

**某一天每人的打卡**（把日期換成要比對的那天）：

```sql
SELECT (p.punched_at AT TIME ZONE 'Asia/Taipei')::date AS 日期,
       p.device_user_no AS 編號,
       max(u.name) AS 姓名,
       count(*) AS 筆數,
       string_agg(to_char(p.punched_at AT TIME ZONE 'Asia/Taipei', 'HH24:MI') || '(' || d.name || ')',
                  '、' ORDER BY p.punched_at) AS 打卡時間
  FROM raw_punch p
  JOIN punch_device d USING (punch_device_id)
  LEFT JOIN punch_device_user u
         ON u.punch_device_id = p.punch_device_id AND u.device_user_no = p.device_user_no
 WHERE p.punched_at >= '2026-10-20 00:00+08' AND p.punched_at < '2026-10-21 00:00+08'
 GROUP BY 1, 2
 ORDER BY 2;
```

**每台卡機的總筆數**：

```sql
SELECT d.name AS 卡機, d.serial_no AS 序號,
       d.record_count AS 卡機上的筆數, count(p.*) AS 雲端筆數,
       d.last_seen_at AT TIME ZONE 'Asia/Taipei' AS 最後連線,
       d.clock_offset_seconds AS 時鐘誤差秒數
  FROM punch_device d
  LEFT JOIN raw_punch p USING (punch_device_id)
 GROUP BY d.punch_device_id
 ORDER BY d.name;
```

ZKTime 清掉卡機上的舊紀錄之後，雲端筆數會比卡機多，這是正常的，雲端會保留全部紀錄。如果最後連線時間超過 15 分鐘沒有更新，代表收集器或卡機停了。
