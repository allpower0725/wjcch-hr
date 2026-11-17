# 已套用的資料庫版本

此處 SQL 是 hr 的初始化 baseline，檔名、內容與 SHA-256 共同對應 `db_migrations.hr`。已套用版本保持原文，不能為整理註解、重排版或改名而修改，否則初始化工具會拒絕將它視為相同版本。

檔內註解反映該版本建立時的背景；現行架構以 [docs/architecture.md](../../docs/architecture.md) 為準，操作以 [database/README.md](../README.md) 為準。

後續結構異動新增版本，保留必要的測試、驗證與回復方式。角色／資料庫時區等設定位於 `database/settings/`，不改寫 baseline。
