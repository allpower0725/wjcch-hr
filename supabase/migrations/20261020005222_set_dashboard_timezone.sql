-- 後台（Table Editor、SQL Editor）以台灣時間顯示時間欄位
--
-- 只設定 postgres 角色（Supabase 後台與外部工具使用）的預設時區，新連線才會生效。
-- 資料本身不變：timestamptz 存的是絕對時間點，這裡只改顯示方式，以及沒有指定時區時的預設換算。
-- 上傳 API（authenticator）、登入驗證、Edge Functions 維持 UTC，符合 Supabase 建議。
-- 程式裡判斷「哪一天」仍一律明確寫 AT TIME ZONE 'Asia/Taipei'，不依賴這個預設值。
-- 還原：ALTER ROLE postgres RESET timezone;

ALTER ROLE postgres SET timezone TO 'Asia/Taipei';
