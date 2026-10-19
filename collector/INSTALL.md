# 主機B 安裝步驟（從乾淨的主機開始）

這份文件說明怎麼在一台全新的主機上裝好打卡收集器，並把目前在開發電腦上執行的收集器搬過去。Windows 和 Linux 都適用；主機確定後，照對應的章節做即可。

- **目前狀態**：收集器暫時在開發電腦（192.168.230.74）上執行，資料夾是 `C:\project\wjcch-hr\collector`。
- **搬移期間不會掉資料**：卡機會保留約半年的紀錄，收集器停機期間的打卡，在新主機啟動後的第一輪就會補上。

## 1. 事前確認

| 項目 | 需求 |
| --- | --- |
| 網路（院內） | 主機B 要能連到兩台卡機的 TCP 4370：192.168.230.190、192.168.230.191 |
| 網路（對外） | 能用 HTTPS（443）連到 `zakixjdjnwetrvhsqsyg.supabase.co`；不需要開放任何對內的連接埠 |
| 開機 | 24 小時開機，不睡眠 |
| 時鐘 | 系統時間要自動校時；收集器用它計算卡機的時鐘誤差 |
| 硬體 | 需求很低：記憶體約 100 MB；磁碟約 1 GB（大部分是 Docker 映像），資料每年約數十 MB |
| 作業系統 | Windows 10／11 專業版以上，或 Linux（建議 Ubuntu 24.04 LTS） |

**Windows 要注意 Docker Desktop 的授權**：機構員工 250 人以上，或年營收 1,000 萬美元以上，就必須購買付費授權。如果醫院符合其中一項，建議改用 Linux，Linux 的 Docker Engine 免費。

## 2. Windows（Docker Desktop）

### 2-1 安裝 WSL 2 與 Docker Desktop

1. 用「以系統管理員身分執行」開啟 PowerShell，輸入下面的指令，完成後重新開機：
   ```powershell
   wsl --install
   ```
2. 從 <https://www.docker.com/products/docker-desktop/> 下載 Docker Desktop。安裝時選擇 WSL 2。
3. 開啟 Docker Desktop，進入 Settings → General，確認勾選：
   - **Use the WSL 2 based engine**
   - **Start Docker Desktop when you sign in to your computer**
4. 開啟 PowerShell 執行下面的指令，能看到版本號就表示安裝完成：
   ```powershell
   docker compose version
   ```

### 2-2 Windows 設定

1. **不睡眠**：用系統管理員 PowerShell 執行下面兩個指令：
   ```powershell
   powercfg /change standby-timeout-ac 0
   ```
   ```powershell
   powercfg /change hibernate-timeout-ac 0
   ```
2. **自動校時**：設定 → 時間與語言 → 日期和時間，開啟「自動設定時間」。
3. **重開機後自動恢復**（擇一）：
   - 設定 Windows 自動登入（例如用微軟的 Sysinternals Autologon 工具）。主機重開後，Docker Desktop 就會自己啟動。主機應放在上鎖的機房。
   - 不設自動登入：重開機後要有人登入，收集器才會恢復，期間的打卡會在恢復後補上。
4. **Windows Update**：設定「使用時段」，避免在上班時間自動重開機。

### 2-3 檢查網路

在主機B 的 PowerShell 執行下面三個指令，每一個都應該顯示 `TcpTestSucceeded : True`：
```powershell
Test-NetConnection 192.168.230.190 -Port 4370
```
```powershell
Test-NetConnection 192.168.230.191 -Port 4370
```
```powershell
Test-NetConnection zakixjdjnwetrvhsqsyg.supabase.co -Port 443
```

### 2-4 從開發電腦搬過來

1. **在開發電腦停止收集器**，避免兩台同時連卡機：
   ```powershell
   cd C:\project\wjcch-hr\collector
   ```
   ```powershell
   docker compose down
   ```
2. **把整個 `collector` 資料夾複製到主機B**，例如放在 `D:\wjcch-collector\`。資料夾裡一定要有：
   - `Dockerfile`、`docker-compose.yml`、`requirements.txt`、`requirements-dev.txt`、`pyproject.toml`
   - `src\`、`tests\`
   - `.env`：正式設定，內含上傳金鑰
   - `data\`：已上傳紀錄；帶過去就不必重新全量上傳
   - 不需要 `.env.local`：那是開發電腦做本機測試用的設定

   `.env` 內含金鑰。如果用隨身碟搬，複製完要把隨身碟上的副本刪掉。
3. **在主機B 啟動**：
   ```powershell
   cd D:\wjcch-collector
   ```
   ```powershell
   docker compose up -d --build
   ```
   第一次會下載 Python 映像和套件，大約需要幾分鐘。
4. 照第 4 節驗證。

## 3. Linux（Ubuntu 24.04 LTS）

### 3-1 安裝 Docker Engine

照 Docker 官方文件 <https://docs.docker.com/engine/install/ubuntu/> 的「Install using the apt repository」安裝 `docker-ce` 和 `docker-compose-plugin`。裝好之後設定開機自動啟動：
```bash
sudo systemctl enable --now docker
```
確認安裝成功：
```bash
docker compose version
```

### 3-2 系統設定

- 自動校時：執行 `timedatectl`，確認 `System clock synchronized: yes`。
- 伺服器版的 Ubuntu 預設不會睡眠，不需要另外設定。

### 3-3 檢查網路

```bash
nc -zv 192.168.230.190 4370
```
```bash
nc -zv 192.168.230.191 4370
```
```bash
nc -zv zakixjdjnwetrvhsqsyg.supabase.co 443
```
三個都應該顯示 `succeeded`。

### 3-4 從開發電腦搬過來

1. 在開發電腦停止收集器（同 2-4 第 1 步）。
2. 把 `collector` 資料夾（內容同 2-4 第 2 步）複製到主機B，例如 `/opt/wjcch-collector`。
3. 設定權限：容器以 uid 10001 執行，`data` 要交給它；`.env` 只讓管理者讀。
   ```bash
   cd /opt/wjcch-collector
   ```
   ```bash
   sudo chown -R 10001:10001 data && sudo chmod 600 .env
   ```
4. 啟動：
   ```bash
   sudo docker compose up -d --build
   ```
5. 照第 4 節驗證。

## 4. 驗證

1. **看第一輪的 log**（Linux 的指令前面要加 `sudo`）：
   ```
   docker compose logs -f
   ```
   - 有帶 `data` 過來：會看到兩台都是 `紀錄 … 筆，沒有變動`。停機期間有新打卡的話，是 `下載後新增 N 筆`，接著是 `上傳 N 筆`。
   - 沒帶 `data`：會看到全部紀錄重新上傳，`雲端新增 0 筆`（雲端已經有了，會自動去重）。

   確認後按 Ctrl+C 離開，收集器會繼續在背景執行。
2. **看健康狀態**：約 2 分鐘後執行 `docker compose ps`，狀態應為 `healthy`。
3. **從雲端確認**：在 Supabase 後台的 SQL Editor 執行下面的查詢，`最後連線` 應該在 5 分鐘以內，`卡機上的筆數` 和 `雲端筆數` 應該一致：
   ```sql
   SELECT d.name AS 卡機, d.record_count AS 卡機上的筆數, count(p.*) AS 雲端筆數,
          d.last_seen_at AT TIME ZONE 'Asia/Taipei' AS 最後連線
     FROM punch_device d LEFT JOIN raw_punch p USING (punch_device_id)
    GROUP BY d.punch_device_id ORDER BY d.name;
   ```
   ZKTime 清掉卡機上的舊紀錄之後，雲端筆數會比卡機多，這是正常的。
4. **重開機測試**：重新開機一次。開機後（Windows 是登入後）約 5 分鐘內，`最後連線` 應該再次更新。

## 5. 開發電腦的收尾

確認主機B 正常運作後，把開發電腦改回本機測試的設定。這樣正式金鑰只會留在主機B，開發電腦也不會誤連正式環境。

```powershell
cd C:\project\wjcch-hr\collector
```
```powershell
Remove-Item .env; Rename-Item .env.local .env; Remove-Item -Recurse data
```

## 6. 特殊情況

- **`data` 遺失或沒帶**：直接啟動即可。收集器會把卡機上的紀錄全部重送一次，雲端會自動去重，不會產生重複資料。
- **`.env` 遺失**：從 `.env.example` 複製一份成 `.env`，再產生新的上傳金鑰，照 [README](README.md) 的「更換上傳金鑰」設定雲端與 `.env`。
- **之後主機B 的 IP 改變**：不影響。收集器只會主動對外連線，雲端只認上傳金鑰，不看來源 IP。
- **卡機的 IP 改變**：修改 `.env` 的 `DEVICE_HOSTS`，再執行 `docker compose up -d`。卡機是用序號識別，所以雲端資料會接續原本的紀錄。

日常操作、更換金鑰、常見問題，請見 [README](README.md)。
