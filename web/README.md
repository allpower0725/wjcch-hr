# 人資工作台本機原型

由專案根目錄啟動。使用 Node.js 20.9 以上版本。

```powershell
cd web
npm ci
npm run dev
```

若 Windows PowerShell 限制執行 `npm.ps1`，請使用 `npm.cmd`。

## LIFF 串接隔離測試庫

套用 LINE 綁定與系統管理者授權 migration 後，可在專案根目錄使用 PowerShell 7 啟用本機串接。設定指令只對 `wjcch_db_test` 安裝測試函式與兩筆合成員工，並準備僅能執行測試函式的 Web 角色。PostgreSQL 容器需將連接埠提供至 `127.0.0.1:5432`。

```powershell
.\scripts\hr-line-web-test.ps1
$env:HR_LINE_TEST = '1'
Set-Location web
npm.cmd run dev
```

- [首次綁定](http://127.0.0.1:3100/liff) 使用 `Z000000001` 和 `1992-06-15`；[留職停薪情境](http://127.0.0.1:3100/liff?demo=leave) 使用 `Z000000005` 和 `1990-10-25`。畫面亦會提示合成資料。
- [從我的打卡紀錄進入](http://127.0.0.1:3100/liff?returnTo=%2Fattendance) 可驗證確認綁定後回到原功能。功能頁仍為入口預覽。
- 登出會撤銷目前登入，下一次以相同模擬 LINE 身分開啟 `/liff` 會直接進入工作台。綁定與比對次數保存在 PostgreSQL，重啟網頁伺服器仍保留。
- 本機驗收使用合成 LINE 憑證，`HR_LINE_TEST` 僅在非 Vercel 的 loopback 網址生效。移除該環境變數後重啟，即回到原型／HTTPS 憑證驗證模式。

## 驗收

- [桌機入口](http://127.0.0.1:3100/) 提供 LINE 模擬入口，並可展開「預覽已綁定的角色」。
- [首次 LIFF 進入](http://127.0.0.1:3100/?entry=line) 會直接開啟員工身分驗證。使用證件號碼 `TEST000001` 和西元生日 `1992-06-15` 進行測試。資料比對通過後，畫面會列出員工帳號 `DEMO-1001` 供確認。確認綁定後顯示個人服務選單。
- [留職停薪員工](http://127.0.0.1:3100/?entry=line&demo=leave) 可照常綁定與登入。使用合成證件號碼 `TEST000005` 和生日 `1990-10-25`。
- 首次綁定自確認 LINE 身分起限時 15 分鐘。每個 LINE 身分在該時段內最多比對失敗 5 次，重新整理、取消後再開啟和換瀏覽器都共用次數與原期限。達上限後，等該時段結束即可重新驗證。
- [已綁定的部級主管](http://127.0.0.1:3100/?entry=line&demo=department) 直接進入功能選單，可查看授權範圍。[院級主管](http://127.0.0.1:3100/?entry=line&demo=executive)與[系統管理者](http://127.0.0.1:3100/?entry=line&demo=admin)也可用同樣方式驗收。
- 登出後從同一個 LINE 測試身分進入，可略過比對。重啟本機 Node.js 程序可清空本次測試的綁定並重做首次驗證。手機畫面可在瀏覽器裝置模擬模式檢視。

原型僅接受合成資料。員工帳號使用對應的 `employee_no`，綁定與授權使用員工內部 ID。功能頁為入口預覽，由後端檢查角色。

## 共用讀取提示與動效

頁面載入使用 App Router 的共用 `loading.tsx`，站內導覽使用 `PortalLink`。新增需要等待的操作時，可在操作期間以 `LoadingFeedback` 傳入狀態文字。重疊的等待共用一個齒輪提示，快速完成時會略過提示。使用者啟用減少動態效果時，齒輪保持靜止，頁面與步驟直接切換。

## 使用 ngrok 驗收本機 LIFF

在專案根目錄的 PowerShell 執行以下指令。把網域與 LINE 識別碼填成開發頻道的設定。隧道模式使用 `wjcch_db_test` 的獨立 Web 角色，綁定與已驗證的登入保存在本機測試庫。

```powershell
.\scripts\hr-line-web-test.ps1 -Tunnel
$env:HR_LINE_TUNNEL_ORIGIN = 'https://pleasantly-flying-falcon.ngrok-free.app'
$env:LINE_LIFF_ID = '2012756681-yI3hpTek'
$env:LINE_LOGIN_CHANNEL_ID = '2012756681'
Set-Location web
npm.cmd run build
node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 3101
```

在另一個 PowerShell 開啟 HTTPS 隧道。

```powershell
ngrok http http://127.0.0.1:3101 --url https://pleasantly-flying-falcon.ngrok-free.app --inspect=false
```

[開發用 LIFF](https://liff.line.me/2012756681-yI3hpTek) 的 Endpoint 指向 [本機 HTTPS 入口](https://pleasantly-flying-falcon.ngrok-free.app/liff)。在合成資料模式中，首次驗收使用 `Z000000011`、`1992-06-15`，預期顯示 `LTEST2001`。留職停薪驗收用 `Z000000015`、`1990-10-25`，預期顯示 `LTEST2005`。兩個程序須運行才能從手機開啟。

### 手動停止 ngrok 隧道

如果 ngrok 是在 PowerShell 視窗中啟動的，回到該視窗按 `Ctrl+C`。如果 ngrok 是由專案在背景啟動，請在專案根目錄執行下列指令。指令會讀取啟動時記錄的 PID，確認程序名稱和轉發目標後才停止。

```powershell
$agentPidFile = '.local/verification/ngrok-liff-agent.pid'
if (-not (Test-Path -LiteralPath $agentPidFile)) {
    throw '找不到背景 ngrok 的 PID 記錄。'
}

$ngrokProcessId = [int](Get-Content -LiteralPath $agentPidFile -Raw)
$tunnel = Get-CimInstance Win32_Process -Filter "ProcessId=$ngrokProcessId" -ErrorAction Stop
if ($tunnel.Name -eq 'ngrok.exe' -and $tunnel.CommandLine -match '127\.0\.0\.1:3101(?=\s|"|$)') {
    Stop-Process -Id $ngrokProcessId
} else {
    Write-Host '找不到原本轉發到 3101 的 ngrok 程序。'
}
```

停止後，外部 LIFF 入口會暫時無法連線。要恢復入口，可重新執行上方的 ngrok 啟動指令。

### 以 P271 驗收正式員工綁定

在上述本機 Web 的建置與啟動指令前設定 `HR_LINE_PILOT=1`。此模式透過 `hr` 連線到本機 `wjcch_db`，只接受獲准的 LINE 帳號，且只和 `P271` 的員工主檔比對。伺服器從忽略版本控制的 `.local/database/secrets/` 讀取 `hr_local_password` 和 `hr_line_pilot_subject`。ngrok 使用 `--inspect=false`。

1. 以獲准的 LINE 帳號開啟開發用 LIFF，由本人在頁面輸入證件號碼及西元出生日期，核對員編、姓名和單位後確認綁定。
2. 在手機登出，再從桌機的本機 HTTPS 入口使用同一個 LINE 帳號登入。兩端應顯示相同員編，登入時會略過首次比對。
3. 結束驗收後，可停止 3101 服務。若要回到合成資料模式，先移除 `HR_LINE_PILOT`，再啟動原先的隧道版本。

## Vercel 正式名冊驗收

Vercel 專案 `web` 以 `web/` 為建置目錄。[開發用 LIFF Endpoint](https://web-three-coral-4cwibhtp88.vercel.app/liff) 與 [班表入口](https://web-three-coral-4cwibhtp88.vercel.app/roster) 共用既有 LINE 驗證。啟用後，獲准的 LINE 帳號首次登入須重新比對正式員工資料並確認 P271 綁定。完成後，由維護端核對有效綁定並新增初始管理者授權。

驗收不同角色時，依 [P271 角色切換](../database/README.md#p271-角色切換) 撤銷或恢復管理者授權，再重新整理班表。

Vercel 專案的 Production 環境設定 `HR_LINE_PILOT_HOST`、`LINE_LIFF_ID` 和 `LINE_LOGIN_CHANNEL_ID`，並將 `HR_LINE_PILOT_SUBJECT_SHA256`、`HR_LINE_PILOT_DATABASE_URL` 和 `HR_LINE_PILOT_DATABASE_CA` 設為伺服器端設定。其中資料庫 URL 使用正式 Supabase 的交易連線池以及專用角色 `hr_web_pilot`，憑證驗證保持啟用。網頁與 LINE 都使用相同域名和短效登入 Cookie。Preview 部署與其他主機名稱不會啟用正式名冊。

正式庫已套用 LINE 綁定、管理者授權及班表草稿 migration，逐支核對並登錄 `db_migrations.hr`。`database/tools/render-line-web-pilot.cjs` 使用 Node.js 24 提供 `lineWebPilotFunctions` 與 `rosterWebPilotDraftFunctions`，分別產生限定帳號的登入及名冊 SQL，以及草稿讀取與儲存 SQL。Vercel 專用角色 `hr_web_pilot` 僅可執行獲授權的函式。

Vercel Production 設定 `HR_ROSTER_CLOUD_DRAFTS=1` 後可從班表頁儲存草稿。要回復名冊唯讀，移除該設定並重新部署，或切回先前的唯讀部署，再撤銷 `hr_web_pilot` 對 `hr.roster_web_pilot_draft_read`、`hr.roster_web_pilot_draft_save` 的執行權。已儲存的草稿保留於正式庫。

班表送出期限使用 `HR_ROSTER_SUBMISSION_DAY`。本機可在 `web/.env.local` 依 `.env.example` 設定，Vercel 使用同名的伺服器環境變數。預設為前月 25 日 24:00，採台北時間。逾期送出會在送出紀錄標記。

部署班表簽核時，先驗證和套用 `add_roster_approvals` migration，再更新 Vercel 既有草稿函式，以及 `database/tools/roster-web-pilot-approval.sql` 的簽核入口。若要回復，先暫停草稿與簽核寫入，再切到前版部署並保留版本、案件與操作紀錄。

若須停止驗收，撤銷專用資料庫角色的登入與函式權限，撤除 Vercel 的正式名冊設定並回復部署。撤銷 P271 的驗收授權時保留授權歷史。

## 先前的雲端 LIFF 合成資料測試

Vercel 的 `wjcch-hr-liff-test` 是前期使用的獨立測試專案，以下保留歷史驗收方式。當開發用 LIFF 的 Endpoint 設為 [Vercel HTTPS 入口](https://wjcch-hr-liff-test.vercel.app/liff) 時，使用 LINE 開發頻道的管理員或測試者帳號驗收。兩端使用同一 LINE 帳號時，完成一次綁定後都應顯示相同的合成員工帳號。

- 首次綁定使用畫面提示的合成證件 `Z000000001` 和生日 `1992-06-15`，核對 `LTEST1001` 後按「確認並綁定」。
- 以另一個尚未綁定的測試 LINE 帳號驗收留職停薪，使用合成證件 `Z000000005` 和生日 `1990-10-25`，核對 `LTEST1005`。
- [從我的打卡紀錄進入](https://wjcch-hr-liff-test.vercel.app/liff?returnTo=%2Fattendance) 時，登入後應直接載入該功能入口。

Vercel 測試專案使用 `LINE_LIFF_ID` 與 `LINE_LOGIN_CHANNEL_ID`。兩項皆為識別碼，由測試專案的環境設定提供。伺服器以 LINE 的驗證 API 檢查憑證及其適用頻道，回傳驗證結果。

雲端合成資料驗收使用獨立的 Supabase `wjcch-hr` 專案。資料庫依序載入 `database/tools/setup-line-web-cloud-fixtures.sql`、既有 LINE 綁定 migration，以及 `database/tools/line-web-test-functions.sql`。Vercel 以伺服器端敏感環境變數 `HR_LINE_CLOUD_TEST_DATABASE_URL` 提供測試角色的交易連線池網址，並以 `HR_LINE_CLOUD_TEST_CA` 提供驗證 TLS 連線的 Supabase 憑證。只有既有的 LIFF 測試網域啟用此流程。後端驗證真實 LINE 憑證後，首次登入進入合成員工比對，已綁定時直接進入工作台。

- 官方帳號聊天室的 Rich Menu 與員工群組內的 LIFF 連結可以指向同一入口。桌機瀏覽器的 LINE 授權方式以院方確認的流程為準。 [圖文選單說明](https://developers.line.biz/en/docs/messaging-api/rich-menus-overview/) · [開啟 LIFF](https://developers.line.biz/en/docs/liff/opening-liff-app/)
- 後端驗證 LINE ID token，使用驗證結果中的 LINE 使用者 ID 查詢綁定。首次綁定採證件號碼與出生日期比對，在職及留職停薪員工皆可登入。正式串接前需確認員工資料缺漏的處理與個資告知。 [LINE 後端驗證](https://developers.line.biz/en/docs/liff/using-user-profile/) · [個人資料保護法](https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=I0050021)
- 正式綁定與人資授權依後續確認接入。隔離測試已驗證資料庫綁定、離職撤權及重綁，管理清單和主管及簽核權限另行驗收。
