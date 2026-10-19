-- 打卡收集：卡機、原始打卡紀錄、卡機使用者名單，以及收集器上傳用的寫入函式
-- 設計見 docs/specs/2026-10-19-punch-collector-design.md 第 5 節

CREATE TABLE punch_device (
  punch_device_id       integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  serial_no             varchar(30)  NOT NULL UNIQUE,
  name                  varchar(50)  NOT NULL,
  ip_address            inet,
  model                 varchar(30),
  firmware_version      varchar(50),
  last_seen_at          timestamptz,
  record_count          integer,
  user_count            integer,
  clock_offset_seconds  integer,
  users_synced_at       timestamptz,
  is_active             boolean      NOT NULL DEFAULT true,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE raw_punch (
  raw_punch_id     bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  punch_device_id  integer      NOT NULL REFERENCES punch_device (punch_device_id) ON DELETE RESTRICT,
  device_user_no   varchar(24)  NOT NULL,
  punched_at       timestamptz  NOT NULL,
  verify_type      smallint     NOT NULL,
  punch_state      smallint     NOT NULL,
  received_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_raw_punch UNIQUE (punch_device_id, device_user_no, punched_at)
);

CREATE INDEX ix_raw_punch_punched_at ON raw_punch (punched_at);
CREATE INDEX ix_raw_punch_user_time  ON raw_punch (device_user_no, punched_at);

CREATE TABLE punch_device_user (
  punch_device_user_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  punch_device_id       integer      NOT NULL REFERENCES punch_device (punch_device_id) ON DELETE RESTRICT,
  device_user_no        varchar(24)  NOT NULL,
  name                  varchar(50),
  last_synced_at        timestamptz  NOT NULL,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_punch_device_user UNIQUE (punch_device_id, device_user_no)
);

CREATE TRIGGER trg_punch_device_updated_at      BEFORE UPDATE ON punch_device      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_punch_device_user_updated_at BEFORE UPDATE ON punch_device_user FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 原始打卡紀錄只增不改：要更正資料時，必須另寫 migration 暫時停用觸發器
CREATE FUNCTION public.raw_punch_reject_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '原始打卡紀錄只能新增，不能修改或刪除';
END;
$$;

CREATE TRIGGER trg_raw_punch_immutable   BEFORE UPDATE OR DELETE ON raw_punch FOR EACH ROW       EXECUTE FUNCTION raw_punch_reject_change();
CREATE TRIGGER trg_raw_punch_no_truncate BEFORE TRUNCATE         ON raw_punch FOR EACH STATEMENT EXECUTE FUNCTION raw_punch_reject_change();

-- 收集器上傳：在同一個交易裡更新卡機狀態、寫入打卡、同步使用者名單
-- p_payload 的格式見設計規格第 6 節，由 Edge Function ingest-punches 驗證後傳入
CREATE FUNCTION public.ingest_punch_batch(p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_device     jsonb       := p_payload -> 'device';
  v_serial_no  varchar     := v_device ->> 'serial_no';
  v_seen_at    timestamptz := (v_device ->> 'seen_at')::timestamptz;
  v_ip         inet        := (v_device ->> 'ip_address')::inet;
  v_device_id  integer;
  v_received   integer     := coalesce(jsonb_array_length(p_payload -> 'punches'), 0);
  v_inserted   integer     := 0;
  v_users      integer     := 0;
BEGIN
  INSERT INTO public.punch_device AS d
         (serial_no, name, ip_address, model, firmware_version,
          last_seen_at, record_count, user_count, clock_offset_seconds)
  VALUES (v_serial_no,
          coalesce(nullif(v_device ->> 'model', ''), '卡機') || coalesce(' ' || host(v_ip), ''),
          v_ip, v_device ->> 'model', v_device ->> 'firmware_version',
          v_seen_at, (v_device ->> 'record_count')::integer, (v_device ->> 'user_count')::integer,
          (v_device ->> 'clock_offset_seconds')::integer)
  ON CONFLICT (serial_no) DO UPDATE
     SET ip_address           = coalesce(EXCLUDED.ip_address, d.ip_address),
         model                = coalesce(EXCLUDED.model, d.model),
         firmware_version     = coalesce(EXCLUDED.firmware_version, d.firmware_version),
         last_seen_at         = EXCLUDED.last_seen_at,
         record_count         = coalesce(EXCLUDED.record_count, d.record_count),
         user_count           = coalesce(EXCLUDED.user_count, d.user_count),
         clock_offset_seconds = coalesce(EXCLUDED.clock_offset_seconds, d.clock_offset_seconds)
   WHERE EXCLUDED.last_seen_at > coalesce(d.last_seen_at, '-infinity');

  SELECT punch_device_id INTO v_device_id
    FROM public.punch_device
   WHERE serial_no = v_serial_no;

  IF v_received > 0 THEN
    INSERT INTO public.raw_punch (punch_device_id, device_user_no, punched_at, verify_type, punch_state)
    SELECT v_device_id, p.device_user_no, p.punched_at, p.verify_type, p.punch_state
      FROM jsonb_to_recordset(p_payload -> 'punches')
           AS p(device_user_no varchar, punched_at timestamptz, verify_type smallint, punch_state smallint)
    ON CONFLICT ON CONSTRAINT uq_raw_punch DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  IF p_payload ? 'users' THEN
    INSERT INTO public.punch_device_user AS u (punch_device_id, device_user_no, name, last_synced_at)
    SELECT DISTINCT ON (x.device_user_no) v_device_id, x.device_user_no, x.name, v_seen_at
      FROM jsonb_to_recordset(p_payload -> 'users') AS x(device_user_no varchar, name varchar)
    ON CONFLICT ON CONSTRAINT uq_punch_device_user DO UPDATE
       SET name           = EXCLUDED.name,
           last_synced_at = EXCLUDED.last_synced_at
     WHERE EXCLUDED.last_synced_at >= u.last_synced_at;
    GET DIAGNOSTICS v_users = ROW_COUNT;

    UPDATE public.punch_device
       SET users_synced_at = v_seen_at
     WHERE punch_device_id = v_device_id
       AND (users_synced_at IS NULL OR users_synced_at < v_seen_at);
  END IF;

  RETURN jsonb_build_object(
    'punch_device_id', v_device_id,
    'received',        v_received,
    'inserted',        v_inserted,
    'users_synced',    v_users);
END;
$$;

REVOKE ALL ON FUNCTION public.ingest_punch_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ingest_punch_batch(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.raw_punch_reject_change() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE  punch_device                      IS '打卡機';
COMMENT ON COLUMN punch_device.punch_device_id      IS '打卡機識別碼（系統自動編號）';
COMMENT ON COLUMN punch_device.serial_no            IS '卡機序號；兩台機器號都是 1，以序號區分';
COMMENT ON COLUMN punch_device.name                 IS '顯示名稱；第一次建立時預設為「型號 IP」，之後可在後台修改，收集器不會覆蓋';
COMMENT ON COLUMN punch_device.ip_address           IS '最近一次回報的 IP';
COMMENT ON COLUMN punch_device.model                IS '型號';
COMMENT ON COLUMN punch_device.firmware_version     IS '韌體版本';
COMMENT ON COLUMN punch_device.last_seen_at         IS '收集器最後一次成功連上的時間';
COMMENT ON COLUMN punch_device.record_count         IS '最後連上時卡機上的打卡紀錄筆數';
COMMENT ON COLUMN punch_device.user_count           IS '最後連上時卡機上的使用者數';
COMMENT ON COLUMN punch_device.clock_offset_seconds IS '卡機時鐘減標準時間的秒數；只記錄，不校時';
COMMENT ON COLUMN punch_device.users_synced_at      IS '最後一次完整同步使用者名單的時間';
COMMENT ON COLUMN punch_device.is_active            IS '使用中；卡機汰換時改為否';
COMMENT ON COLUMN punch_device.created_at           IS '建立時間';
COMMENT ON COLUMN punch_device.updated_at           IS '最後修改時間';

COMMENT ON TABLE  raw_punch                 IS '原始打卡紀錄（卡機下載的原貌，只增不改）';
COMMENT ON COLUMN raw_punch.raw_punch_id    IS '原始打卡識別碼（系統自動編號）';
COMMENT ON COLUMN raw_punch.punch_device_id IS '哪一台卡機';
COMMENT ON COLUMN raw_punch.device_user_no  IS '卡機上的使用者編號，對應 employee.employee_no';
COMMENT ON COLUMN raw_punch.punched_at      IS '打卡時間（卡機的台北當地時間，以 +08:00 寫入）';
COMMENT ON COLUMN raw_punch.verify_type     IS '驗證方式原始代碼；現場只見 1、2，推測 1 指紋、2 刷卡（待確認）';
COMMENT ON COLUMN raw_punch.punch_state     IS '打卡狀態原始代碼；.190 幾乎都是 0、.191 幾乎都是 1，意義待人事確認';
COMMENT ON COLUMN raw_punch.received_at     IS '雲端收到的時間';

COMMENT ON TABLE  punch_device_user                      IS '卡機使用者名單（只存編號與姓名，不讀密碼、卡號、指紋）';
COMMENT ON COLUMN punch_device_user.punch_device_user_id IS '卡機使用者識別碼（系統自動編號）';
COMMENT ON COLUMN punch_device_user.punch_device_id      IS '哪一台卡機';
COMMENT ON COLUMN punch_device_user.device_user_no       IS '卡機上的使用者編號';
COMMENT ON COLUMN punch_device_user.name                 IS '卡機上登錄的姓名';
COMMENT ON COLUMN punch_device_user.last_synced_at       IS '最後一次出現在同步名單裡的時間；早於該卡機的 users_synced_at 代表已從卡機刪除';
COMMENT ON COLUMN punch_device_user.created_at           IS '建立時間';
COMMENT ON COLUMN punch_device_user.updated_at           IS '最後修改時間';

COMMENT ON FUNCTION public.ingest_punch_batch(jsonb) IS '收集器上傳：更新卡機狀態、寫入打卡（重複略過）、同步使用者名單；只給 service_role 呼叫';

ALTER TABLE punch_device      ENABLE ROW LEVEL SECURITY;
ALTER TABLE raw_punch         ENABLE ROW LEVEL SECURITY;
ALTER TABLE punch_device_user ENABLE ROW LEVEL SECURITY;
