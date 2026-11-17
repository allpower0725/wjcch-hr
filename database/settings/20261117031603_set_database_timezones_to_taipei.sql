-- 使用者確認：本機主庫／測試庫及 Supabase wjcch 資料庫皆採台北時間。
-- 在各目標資料庫以其 owner 執行，只設定預設時區，不 UPDATE 任何打卡資料。
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Taipei');
END;
$$;

-- 新連線生效。既有連線請重新連線，或於該連線 SET TIME ZONE 'Asia/Taipei'。
-- 時間戳仍使用 timestamptz；客戶端若自行指定 UTC，顯示仍由客戶端決定。
-- 還原：ALTER DATABASE <database> RESET timezone;
