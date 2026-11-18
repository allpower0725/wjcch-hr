# 人事資料與維護

## 資料關係

| 資料表 | 用途與關係 |
|---|---|
| department | `parent_id` 建立組織樹，員工指向所屬的最末層單位。醫院為根節點，`source_level` 記錄 Lv1–Lv3 層級 |
| job_title / job_duty / employment_type | 職稱、職務、正兼職三個不同字典，各與 employee 一對多 |
| department_manager | 員工可管理多個部門；院長及副院長管理醫院根節點，管理部課長管理管理部 |
| employee_education | 員工一對多學歷，`is_highest` 標示最高學歷 |
| license_type / employee_license | 員工一對多證照，同類證照每次續期可另建有效期間 |
| punch_device / punch_device_user | 卡機及其同步名單，繼續由 collector 管理 |
| employee_device_mapping | 以卡機與帳號連到目前對應的員工；同機同號只保留一筆 |
| raw_punch | 原始打卡只增不改；無對照時仍可正常收集 |

P/H 人事編號存於 `employee_no`，卡機帳號另存於 `employee_device_mapping`。`zk_user_id` 保留舊軟體 USERID。市話、手機與卡機帳號均以字串保留前導零。

## 日期與狀態

- 到職日與主管任期開始日可留空；主管 `recorded_on` 是現況登錄日，不代替任期開始日。
- 證照 `valid_from`、`valid_to` 均為日期，包含起迄當日。`valid_to >= valid_from`。
- 空白效期不是永久有效；只有確認無期限時才設定 `has_no_expiry=true`，且迄日須為空。
- `v_employee_license.validity_status` 為 `valid`、`expired`、`not_yet_valid` 或 `validity_unknown`，依台北日期計算。
- `confirmed_at` 記錄目前帳號歸屬的確認時間。`v_punch_employee` 對確認前的打卡顯示 `history_pending`，正式 `employee_id` 留空，`candidate_*` 顯示目前候選。帳號日後轉給別人時，更新員工與確認時間，對照表只保存目前歸屬。
- 特例使用 `employee.attendance_required=false` 並記錄原因；沒有打卡不等於離職。

## 查詢與核對

從專案根目錄執行以下指令查詢人事資料及核對打卡紀錄。

```powershell
.\scripts\hr-personnel.ps1 report -Target local
.\scripts\hr-personnel.ps1 audit -Target local
.\scripts\hr-personnel.ps1 snapshot -Target local
.\scripts\hr-personnel.ps1 verify-preserved -Target local
```

`report` 顯示人事筆數和關聯狀態，`audit` 核對資料結構與權限。`snapshot` 記錄當時的原始打卡校驗值，供 `verify-preserved` 日後核對。雲端使用 `-Target cloud`，連至固定的 wjcch 專案並驗證 TLS 憑證。

人事表與兩個查詢 View 僅限維護角色存取。人事表的 RLS 採預設拒絕。

## 回復

結構更新以交易執行，失敗時回滾。已提交的資料如需回復，先用備份在隔離資料庫核對。

需要整體還原時，先將更新前 `.dump` 還原到隔離資料庫驗證，再規劃切換。備份後可能持續有新打卡，切換前需保留及補回新增資料；不可直接用舊備份覆蓋收集中的目的地。migration journal 依實際還原版本核對，baseline 檔與 checksum 不改寫。
