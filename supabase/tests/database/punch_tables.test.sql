-- 打卡資料表與 ingest_punch_batch 的資料庫測試（npx supabase test db）
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SELECT plan(26);

-- 測試用的請求內容
CREATE FUNCTION pg_temp.device(p_seen_at text, p_record_count integer DEFAULT 3) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object(
    'serial_no', 'TEST0001', 'ip_address', '192.168.230.190', 'model', 'GT100',
    'firmware_version', 'Ver 6.60 Jan 23 2015', 'seen_at', p_seen_at,
    'record_count', p_record_count, 'user_count', 2, 'clock_offset_seconds', -3)
$$;

CREATE FUNCTION pg_temp.three_punches() RETURNS jsonb
LANGUAGE sql AS $$
  SELECT '[
    {"device_user_no": "1023", "punched_at": "2026-10-19T07:58:12+08:00", "verify_type": 1, "punch_state": 0},
    {"device_user_no": "1023", "punched_at": "2026-10-19T17:02:00+08:00", "verify_type": 1, "punch_state": 1},
    {"device_user_no": "9021", "punched_at": "2026-10-19T08:01:30+08:00", "verify_type": 2, "punch_state": 0}
  ]'::jsonb
$$;

-- 測試卡機的識別碼；以下查詢一律限定這台，不受本機資料庫裡其他資料影響
CREATE FUNCTION pg_temp.dev() RETURNS integer
LANGUAGE sql AS $$
  SELECT punch_device_id FROM public.punch_device WHERE serial_no = 'TEST0001'
$$;

-- 結構
SELECT has_table('public', 'punch_device', '有 punch_device 表');
SELECT has_table('public', 'raw_punch', '有 raw_punch 表');
SELECT has_table('public', 'punch_device_user', '有 punch_device_user 表');
SELECT ok(
  (SELECT bool_and(relrowsecurity) FROM pg_class
    WHERE oid IN ('public.punch_device'::regclass, 'public.raw_punch'::regclass, 'public.punch_device_user'::regclass)),
  '三張表都開啟 RLS');
SELECT is(
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'
     AND tablename IN ('punch_device', 'raw_punch', 'punch_device_user')),
  0::bigint, '本階段不建任何 policy');

-- 權限：只有 service_role 能執行寫入函式
SELECT ok(NOT has_function_privilege('anon', 'public.ingest_punch_batch(jsonb)', 'EXECUTE'), 'anon 不能執行');
SELECT ok(NOT has_function_privilege('authenticated', 'public.ingest_punch_batch(jsonb)', 'EXECUTE'), 'authenticated 不能執行');
SELECT ok(has_function_privilege('service_role', 'public.ingest_punch_batch(jsonb)', 'EXECUTE'), 'service_role 可以執行');

-- 第一次寫入：新增 3 筆並自動建立卡機
CREATE TEMP TABLE r1 AS
  SELECT public.ingest_punch_batch(jsonb_build_object(
    'device', pg_temp.device('2026-10-19T16:00:00+08:00'), 'punches', pg_temp.three_punches())) AS r;
SELECT is((SELECT (r ->> 'received')::int FROM r1), 3, '第一次收到 3 筆');
SELECT is((SELECT (r ->> 'inserted')::int FROM r1), 3, '第一次新增 3 筆');
SELECT is((SELECT name::text FROM public.punch_device WHERE serial_no = 'TEST0001'),
          'GT100 192.168.230.190', '新卡機的名稱預設為「型號 IP」');
SELECT is((SELECT (r ->> 'punch_device_id')::int FROM r1),
          (SELECT punch_device_id FROM public.punch_device WHERE serial_no = 'TEST0001'), '回傳卡機識別碼');

-- 重送同樣內容：不重複寫入
SELECT is(
  (public.ingest_punch_batch(jsonb_build_object(
     'device', pg_temp.device('2026-10-19T16:05:00+08:00'), 'punches', pg_temp.three_punches())) ->> 'inserted')::int,
  0, '重送不會新增');
SELECT is((SELECT count(*) FROM public.raw_punch WHERE punch_device_id = pg_temp.dev()), 3::bigint,
          'raw_punch 仍是 3 筆');

-- 同一個鍵、不同代碼：保留第一筆
SELECT is(
  (public.ingest_punch_batch(jsonb_build_object(
     'device', pg_temp.device('2026-10-19T16:06:00+08:00'),
     'punches', '[{"device_user_no": "1023", "punched_at": "2026-10-19T07:58:12+08:00", "verify_type": 2, "punch_state": 5}]'::jsonb))
   ->> 'inserted')::int,
  0, '鍵相同時不新增');
SELECT is((SELECT verify_type FROM public.raw_punch
            WHERE punch_device_id = pg_temp.dev() AND device_user_no = '1023'
              AND punched_at = '2026-10-19T07:58:12+08:00'),
          1::smallint, '保留第一筆的代碼');

-- 異常日期照樣保存
SELECT is(
  (public.ingest_punch_batch(jsonb_build_object(
     'device', pg_temp.device('2026-10-19T16:07:00+08:00'),
     'punches', '[{"device_user_no": "1023", "punched_at": "2000-01-01T00:00:00+08:00", "verify_type": 1, "punch_state": 0}]'::jsonb))
   ->> 'inserted')::int,
  1, '時鐘被重設時的異常日期也會保存');

-- 時區：以台北時間寫入、讀回
SELECT is((SELECT (punched_at AT TIME ZONE 'Asia/Taipei')::text FROM public.raw_punch
            WHERE punch_device_id = pg_temp.dev() AND device_user_no = '9021'),
          '2026-10-19 08:01:30', '台北時間正確');

-- 狀態只接受較新的 seen_at
SELECT public.ingest_punch_batch(jsonb_build_object('device', pg_temp.device('2026-10-19T15:00:00+08:00', 99)));
SELECT is((SELECT record_count FROM public.punch_device WHERE serial_no = 'TEST0001'), 3, '較舊的狀態不會蓋掉新的');
SELECT public.ingest_punch_batch(jsonb_build_object('device', pg_temp.device('2026-10-19T16:10:00+08:00', 5)));
SELECT is((SELECT record_count FROM public.punch_device WHERE serial_no = 'TEST0001'), 5, '較新的狀態會更新');

-- 使用者名單
SELECT is(
  (public.ingest_punch_batch(jsonb_build_object(
     'device', pg_temp.device('2026-10-19T16:15:00+08:00', 5),
     'users', '[{"device_user_no": "1023", "name": "王小明"}, {"device_user_no": "9021", "name": ""}]'::jsonb))
   ->> 'users_synced')::int,
  2, '同步 2 位使用者');
SELECT is((SELECT users_synced_at FROM public.punch_device WHERE serial_no = 'TEST0001'),
          '2026-10-19T16:15:00+08:00'::timestamptz, '記錄名單同步時間');
SELECT is((SELECT name::text FROM public.punch_device_user
            WHERE punch_device_id = pg_temp.dev() AND device_user_no = '1023'),
          '王小明', '存入姓名');

-- 原始紀錄只增不改
SELECT throws_ok($$UPDATE public.raw_punch SET punch_state = 9 WHERE punch_device_id = pg_temp.dev()$$, 'P0001',
                 '原始打卡紀錄只能新增，不能修改或刪除', '不能 UPDATE');
SELECT throws_ok($$DELETE FROM public.raw_punch WHERE punch_device_id = pg_temp.dev()$$, 'P0001',
                 '原始打卡紀錄只能新增，不能修改或刪除', '不能 DELETE');
SELECT throws_ok($$TRUNCATE public.raw_punch$$, 'P0001',
                 '原始打卡紀錄只能新增，不能修改或刪除', '不能 TRUNCATE');

SELECT * FROM finish();
ROLLBACK;
