# 決策紀錄

重要決策依日期記在這裡。新的對話讀過就能接上。每則寫明：決定了什麼、為什麼、影響範圍。

## 2026-10-19　打卡收集器

詳細設計見 [specs/2026-10-19-punch-collector-design.md](specs/2026-10-19-punch-collector-design.md)。

| 決策 | 理由 |
| --- | --- |
| 輪詢間隔改為 5 分鐘（開發要點原寫 1 到 2 分鐘），寫在 `.env` 可調 | 使用者指示。卡機保留半年紀錄，間隔長短不影響資料完整，只影響延遲 |
| 排程內建在收集器常駐程式，Docker 設 `restart: unless-stopped` | 不依賴主機的排程設定，Windows 和 Linux 主機都一樣運作 |
| 下載時不呼叫 `disable_device()`（保留設定可改） | 停用期間員工無法打卡，交班尖峰會卡住；下載中新打的卡，下一輪就會補到 |
| 每日對帳改為「強制完整下載，再重送近 7 天，由雲端去重」，取代逐日比對筆數 | 結果相同，不必另寫查詢 API；雲端回傳的新增筆數就是補到的缺漏 |
| 員工對照直接用 `employee.employee_no`，不另建對照表 | 現有 schema 已註明 `employee_no` 是「打卡機上的號碼」 |
| 同步卡機使用者名單時只存編號與姓名 | 方便和 ZKTime 報表比對、找出對不上的編號；密碼、卡號、指紋都不讀 |
| `raw_punch` 用觸發器擋下 UPDATE、DELETE、TRUNCATE | 開發要點規定原始紀錄只增不改；出勤紀錄要保存五年 |
| 收集器使用專用的 `COLLECTOR_KEY`，Edge Function 設 `verify_jwt = false` 並自行驗證 | 主機B 不放能繞過 RLS 的金鑰；新版 secret key 不是 JWT，平台的 JWT 驗證用不上 |
| Edge Function 改用新版 secret key（`SUPABASE_SECRET_KEYS`） | 舊的 `service_role` 金鑰在 2026 年底停用 |
| 上傳時指定在東京執行（`x-region: ap-northeast-1`） | 和資料庫同區，批次寫入較快 |
| 主機B 目前是 Windows 加 Docker Desktop，日後可能換 Linux | 容器內容相同；換主機時帶走 `collector/data/`，就不必重新全量上傳 |
| 本階段不另開測試用 Supabase 專案：本機用 `supabase start` 測試，通過後部署到 `wjcch-hr` | 本機環境已足以測試；和 ZKTime 比對需要真實資料 |
