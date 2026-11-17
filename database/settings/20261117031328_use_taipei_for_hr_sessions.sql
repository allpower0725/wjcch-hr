-- 只調整連線的顯示／預設解讀時區，不變更任何 timestamptz 資料。
-- 本機：分別在 wjcch_db、wjcch_db_test 以 db_owner 執行。
-- Supabase：在 wjcch 專案 postgres 資料庫以平台 postgres 角色執行。
-- 不修改 database 全域時區或 healthcare／authenticator 等服務角色。
DO $$
BEGIN
  EXECUTE format('ALTER ROLE hr IN DATABASE %I SET timezone TO %L', current_database(), 'Asia/Taipei');
  EXECUTE format('ALTER ROLE hr_collector IN DATABASE %I SET timezone TO %L', current_database(), 'Asia/Taipei');
  IF current_database() = 'postgres' THEN
    ALTER ROLE postgres IN DATABASE postgres SET timezone TO 'Asia/Taipei';
  END IF;
END;
$$;

-- 新連線生效；已開啟的 SQL Editor／DBeaver 請重新連線或先 SET TIME ZONE 'Asia/Taipei'。
-- 若客戶端自行指定 UTC 或格式化顯示，仍以客戶端設定為準。
-- 還原：ALTER ROLE <role> IN DATABASE <database> RESET timezone;
