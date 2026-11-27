# 專案開發規範

- 修改 `web/` 的介面、樣式或瀏覽器行為前，先使用 Modern Web Guidance 搜尋並讀取適用指引。交付前依指引核對實作與瀏覽器支援，並在驗收結果記錄使用的指引。
- `web/` 的所有介面開發都使用 UI SDK，涵蓋一般瀏覽器與 LINE 共用的頁面及元件。
- 新增或調整 `web/` 介面時，依[行動優先與共用介面](docs/development-requirements.md#24-行動優先與共用介面)統一頁首、字級、觸控選單及響應式驗收。
- 使用 ui-sdk 前，若已安裝 `ui-sdk` 技能，先遵循其指引，並閱讀 `web/node_modules/@ui-sdk/react/docs/llms.txt`。建立新的 ui-sdk 元件時，另依標題搜尋同目錄的 `core.md`，並閱讀 `rendering.md`。
- 介面動效依 `.agents/skills/` 內的 GSAP 官方技能實作。React 動效讀取 `gsap-core` 和 `gsap-react`，多階段動效讀取 `gsap-timeline`，效能檢查參照 `gsap-performance`。簡單的焦點及狀態回饋可用 CSS。支援 `prefers-reduced-motion`，並在 React 元件卸載時清理動畫。
- 每個開發步驟完成後交由使用者驗收。下一步開工前先說明詳細做法，取得使用者確認。
- 開發涉及資料庫異動時，須在開工前的開發討論中，和程式邏輯一起列出資料庫異動清單。涵蓋資料表、欄位、索引、限制條件、檢視表、函式、觸發器、權限與設定，以及開發或維護所做的資料新增、回填、修正或刪除。逐項說明目標環境與 schema、變更原因、影響範圍、驗證方式及回復方式，取得使用者確認後才開始實作與套用。驗收時回報實際套用的環境、異動及結果。
