# WJCCH 人力資源管理系統

本專案包含獨立的打卡收集器與 `hr` 資料庫結構。collector 以 Python／Docker 運行，透過專用 PostgreSQL 帳號寫入資料。

| 模式 | 資料流 |
|---|---|
| `test` | 卡機 → SQLite 暫存／待送佇列 → 本機 PostgreSQL `wjcch_db.hr` |
| `production` | 卡機 → SQLite 暫存／待送佇列 → Supabase `wjcch` 的 `postgres.hr` |

每次只寫入選定目的地，兩種模式的送達進度分開。時間一律採 `Asia/Taipei`。

## 文件與目錄

| 位置 | 用途 |
|---|---|
| [collector/README.md](collector/README.md) | 設定、執行、模式切換與健康檢查 |
| [collector/INSTALL.md](collector/INSTALL.md) | 安裝與主機搬移 |
| [database/README.md](database/README.md) | 資料庫、帳號、初始化、時區及備份 |
| [docs/architecture.md](docs/architecture.md) | 收集、待送、去重與對帳流程 |
| [docs/decisions.md](docs/decisions.md) | 現行資料與操作規則 |
| [docs/development-requirements.md](docs/development-requirements.md) | LINE 與瀏覽器共用、人事功能、權限及驗收需求 |
| [docs/approval-workflow.md](docs/approval-workflow.md) | 人事簽核路徑、院級設定與驗收案例 |
| `scripts/hr-db.ps1` | 資料庫維護與 SQLite 備份入口 |
| `collector/.local/` | 隨 collector 搬移的執行密碼與 CA，不進 Git |
| `.local/` | Schema 管理密碼、備份、驗證報告及封存，不進 Git |

## 日常操作

安裝、啟停與模式切換，一律在 `collector/` 目錄直接使用 Docker Compose，指令見 [collector/INSTALL.md](collector/INSTALL.md)。開發機與正式機使用同一份原始碼，不另產生部署程式副本。

實際模式以 `collector/.env` 為準，運行狀態以 Docker 查詢為準。

只複製完整 `collector/` 目錄即可部署正式機。執行密碼位於 `collector/.local/database/secrets/`，CA 位於 `collector/.local/database/certs/`，打卡暫存位於 `collector/data/`。更新時保留正式機原有 `.env`、`data/` 與私密設定，詳細範圍見安裝說明。
