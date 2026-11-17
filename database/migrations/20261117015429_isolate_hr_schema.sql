-- 員工與部門資料表（Supabase 版）

CREATE FUNCTION hr.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

CREATE TABLE hr.job_title (
  job_title_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          varchar(30)  NOT NULL UNIQUE,
  sort_order    smallint     NOT NULL DEFAULT 0,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE hr.employment_type (
  employment_type_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                varchar(20)  NOT NULL UNIQUE,
  sort_order          smallint     NOT NULL DEFAULT 0,
  is_active           boolean      NOT NULL DEFAULT true,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE hr.department (
  department_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           varchar(50)  NOT NULL,
  parent_id      integer      REFERENCES hr.department (department_id) ON DELETE RESTRICT,
  sort_order     smallint     NOT NULL DEFAULT 0,
  phone_ext      varchar(10),
  is_active      boolean      NOT NULL DEFAULT true,
  disabled_on    date,
  created_at     timestamptz  NOT NULL DEFAULT now(),
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_department_not_own_parent CHECK (parent_id <> department_id),
  CONSTRAINT ck_department_disabled_on CHECK (is_active = (disabled_on IS NULL))
);

CREATE UNIQUE INDEX uq_department_active_name
  ON hr.department (parent_id, name) NULLS NOT DISTINCT
  WHERE is_active;

CREATE TABLE hr.employee (
  employee_id         integer       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_no         varchar(10)   NOT NULL UNIQUE,
  name                varchar(50)   NOT NULL,
  gender              char(1)       CHECK (gender IN ('M', 'F')),
  birth_date          date,
  national_id         varchar(10)   UNIQUE
                                    CHECK (national_id ~ '^[A-Z][A-Z0-9][0-9]{8}$'),
  mobile_phone        varchar(20),
  email               varchar(100)  UNIQUE,
  department_id       integer       NOT NULL REFERENCES hr.department (department_id) ON DELETE RESTRICT,
  job_title_id        integer       REFERENCES hr.job_title (job_title_id) ON DELETE RESTRICT,
  employment_type_id  integer       REFERENCES hr.employment_type (employment_type_id) ON DELETE RESTRICT,
  employment_status   varchar(10)   NOT NULL DEFAULT 'active'
                                    CHECK (employment_status IN ('active', 'on_leave', 'resigned')),
  hire_date           date          NOT NULL,
  resign_date         date,
  card_no             varchar(20)   UNIQUE,
  zk_user_id          integer       UNIQUE,
  staff_code          varchar(10)   UNIQUE,
  note                text,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT ck_employee_resign_after_hire CHECK (resign_date >= hire_date),
  CONSTRAINT ck_employee_resigned_needs_date CHECK (employment_status <> 'resigned' OR resign_date IS NOT NULL)
);

CREATE TABLE hr.department_manager (
  department_manager_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id          integer      NOT NULL REFERENCES hr.department (department_id) ON DELETE RESTRICT,
  employee_id            integer      NOT NULL REFERENCES hr.employee (employee_id) ON DELETE RESTRICT,
  role                   varchar(10)  NOT NULL CHECK (role IN ('head', 'deputy', 'acting')),
  start_date             date         NOT NULL,
  end_date               date,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_department_manager_end_after_start CHECK (end_date >= start_date)
);

CREATE UNIQUE INDEX uq_department_manager_current_head
  ON hr.department_manager (department_id)
  WHERE role IN ('head', 'acting') AND end_date IS NULL;

CREATE TRIGGER trg_job_title_updated_at          BEFORE UPDATE ON hr.job_title          FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();
CREATE TRIGGER trg_employment_type_updated_at    BEFORE UPDATE ON hr.employment_type    FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();
CREATE TRIGGER trg_department_updated_at         BEFORE UPDATE ON hr.department         FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();
CREATE TRIGGER trg_employee_updated_at           BEFORE UPDATE ON hr.employee           FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();
CREATE TRIGGER trg_department_manager_updated_at BEFORE UPDATE ON hr.department_manager FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();

COMMENT ON TABLE  hr.job_title                 IS '職稱';
COMMENT ON COLUMN hr.job_title.job_title_id    IS '職稱識別碼（系統自動編號）';
COMMENT ON COLUMN hr.job_title.name            IS '職稱名稱，例：護理師';
COMMENT ON COLUMN hr.job_title.sort_order      IS '顯示順序';
COMMENT ON COLUMN hr.job_title.is_active       IS '使用中；停用時改為否';
COMMENT ON COLUMN hr.job_title.created_at      IS '建立時間';
COMMENT ON COLUMN hr.job_title.updated_at      IS '最後修改時間';

COMMENT ON TABLE  hr.employment_type                    IS '聘用類別';
COMMENT ON COLUMN hr.employment_type.employment_type_id IS '聘用類別識別碼（系統自動編號）';
COMMENT ON COLUMN hr.employment_type.name               IS '類別名稱，例：正職';
COMMENT ON COLUMN hr.employment_type.sort_order         IS '顯示順序';
COMMENT ON COLUMN hr.employment_type.is_active          IS '使用中；停用時改為否';
COMMENT ON COLUMN hr.employment_type.created_at         IS '建立時間';
COMMENT ON COLUMN hr.employment_type.updated_at         IS '最後修改時間';

COMMENT ON TABLE  hr.department               IS '部門';
COMMENT ON COLUMN hr.department.department_id IS '部門識別碼（系統自動編號）';
COMMENT ON COLUMN hr.department.name          IS '部門名稱';
COMMENT ON COLUMN hr.department.parent_id     IS '上層部門；最上層留空';
COMMENT ON COLUMN hr.department.sort_order    IS '顯示順序';
COMMENT ON COLUMN hr.department.phone_ext     IS '單位分機';
COMMENT ON COLUMN hr.department.is_active     IS '使用中；裁撤時改為否';
COMMENT ON COLUMN hr.department.disabled_on   IS '停用日期';
COMMENT ON COLUMN hr.department.created_at    IS '建立時間';
COMMENT ON COLUMN hr.department.updated_at    IS '最後修改時間';

COMMENT ON TABLE  hr.employee                    IS '員工';
COMMENT ON COLUMN hr.employee.employee_id        IS '員工識別碼（系統自動編號）';
COMMENT ON COLUMN hr.employee.employee_no        IS '員工編號（打卡機上的號碼）';
COMMENT ON COLUMN hr.employee.name               IS '姓名';
COMMENT ON COLUMN hr.employee.gender             IS '性別：M 男、F 女';
COMMENT ON COLUMN hr.employee.birth_date         IS '出生日期';
COMMENT ON COLUMN hr.employee.national_id        IS '身分證字號（外籍同仁填居留證號）';
COMMENT ON COLUMN hr.employee.mobile_phone       IS '手機';
COMMENT ON COLUMN hr.employee.email              IS '電子郵件';
COMMENT ON COLUMN hr.employee.department_id      IS '所屬部門';
COMMENT ON COLUMN hr.employee.job_title_id       IS '職稱';
COMMENT ON COLUMN hr.employee.employment_type_id IS '聘用類別';
COMMENT ON COLUMN hr.employee.employment_status  IS '在職狀態：active 在職、on_leave 留職停薪、resigned 離職';
COMMENT ON COLUMN hr.employee.hire_date          IS '到職日';
COMMENT ON COLUMN hr.employee.resign_date        IS '離職日';
COMMENT ON COLUMN hr.employee.card_no            IS '識別證卡號（刷卡打卡用）';
COMMENT ON COLUMN hr.employee.zk_user_id         IS '打卡系統編號（舊打卡軟體 ZKTime 的人員編號）';
COMMENT ON COLUMN hr.employee.staff_code         IS '人事代碼（P／H 開頭，用途待確認）';
COMMENT ON COLUMN hr.employee.note               IS '備註';
COMMENT ON COLUMN hr.employee.created_at         IS '建立時間';
COMMENT ON COLUMN hr.employee.updated_at         IS '最後修改時間';

COMMENT ON TABLE  hr.department_manager                       IS '部門主管';
COMMENT ON COLUMN hr.department_manager.department_manager_id IS '主管紀錄編號（系統自動編號）';
COMMENT ON COLUMN hr.department_manager.department_id         IS '部門';
COMMENT ON COLUMN hr.department_manager.employee_id           IS '主管人員；可兼任多個部門';
COMMENT ON COLUMN hr.department_manager.role                  IS '主管類別：head 主管、deputy 副主管、acting 代理主管';
COMMENT ON COLUMN hr.department_manager.start_date            IS '任期開始';
COMMENT ON COLUMN hr.department_manager.end_date              IS '任期結束；空白代表現任';
COMMENT ON COLUMN hr.department_manager.created_at            IS '建立時間';
COMMENT ON COLUMN hr.department_manager.updated_at            IS '最後修改時間';

ALTER TABLE hr.job_title          ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employment_type    ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.department         ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employee           ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.department_manager ENABLE ROW LEVEL SECURITY;;

-- 打卡收集：卡機、原始打卡紀錄、卡機使用者名單，以及收集器上傳用的寫入函式
-- 設計見 docs/specs/2026-10-19-punch-collector-design.md 第 5 節

CREATE TABLE hr.punch_device (
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

CREATE TABLE hr.raw_punch (
  raw_punch_id     bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  punch_device_id  integer      NOT NULL REFERENCES hr.punch_device (punch_device_id) ON DELETE RESTRICT,
  device_user_no   varchar(24)  NOT NULL,
  punched_at       timestamptz  NOT NULL,
  verify_type      smallint     NOT NULL,
  punch_state      smallint     NOT NULL,
  received_at      timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_raw_punch UNIQUE (punch_device_id, device_user_no, punched_at)
);

CREATE INDEX ix_raw_punch_punched_at ON hr.raw_punch (punched_at);
CREATE INDEX ix_raw_punch_user_time  ON hr.raw_punch (device_user_no, punched_at);

CREATE TABLE hr.punch_device_user (
  punch_device_user_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  punch_device_id       integer      NOT NULL REFERENCES hr.punch_device (punch_device_id) ON DELETE RESTRICT,
  device_user_no        varchar(24)  NOT NULL,
  name                  varchar(50),
  last_synced_at        timestamptz  NOT NULL,
  created_at            timestamptz  NOT NULL DEFAULT now(),
  updated_at            timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT uq_punch_device_user UNIQUE (punch_device_id, device_user_no)
);

CREATE TRIGGER trg_punch_device_updated_at      BEFORE UPDATE ON hr.punch_device      FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();
CREATE TRIGGER trg_punch_device_user_updated_at BEFORE UPDATE ON hr.punch_device_user FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();

-- 原始打卡紀錄只增不改：要更正資料時，必須另寫 migration 暫時停用觸發器
CREATE FUNCTION hr.raw_punch_reject_change() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '原始打卡紀錄只能新增，不能修改或刪除';
END;
$$;

CREATE TRIGGER trg_raw_punch_immutable   BEFORE UPDATE OR DELETE ON hr.raw_punch FOR EACH ROW       EXECUTE FUNCTION hr.raw_punch_reject_change();
CREATE TRIGGER trg_raw_punch_no_truncate BEFORE TRUNCATE         ON hr.raw_punch FOR EACH STATEMENT EXECUTE FUNCTION hr.raw_punch_reject_change();

-- 收集器上傳：在同一個交易裡更新卡機狀態、寫入打卡、同步使用者名單
-- p_payload 的格式見設計規格第 6 節，由 Edge Function ingest-punches 驗證後傳入
CREATE FUNCTION hr.ingest_punch_batch(p_payload jsonb) RETURNS jsonb
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
  v_users_seen_at timestamptz := coalesce((p_payload ->> 'users_seen_at')::timestamptz, v_seen_at);
BEGIN
  IF v_serial_no IS NULL OR btrim(v_serial_no) = '' OR v_seen_at IS NULL
     OR coalesce(jsonb_array_length(p_payload -> 'punches'), 0) > 1000
     OR coalesce(jsonb_array_length(p_payload -> 'users'), 0) > 5000 THEN
    RAISE EXCEPTION 'invalid collector payload' USING ERRCODE = '22023';
  END IF;
  INSERT INTO hr.punch_device AS d
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
    FROM hr.punch_device
   WHERE serial_no = v_serial_no;

  IF v_received > 0 THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_to_recordset(p_payload -> 'punches') AS p
        (device_user_no varchar, punched_at timestamptz, verify_type smallint, punch_state smallint)
      JOIN hr.raw_punch r ON r.punch_device_id = v_device_id
        AND r.device_user_no = p.device_user_no AND r.punched_at = p.punched_at
      WHERE r.verify_type <> p.verify_type OR r.punch_state <> p.punch_state
    ) THEN
      RAISE EXCEPTION 'raw punch conflicts with preserved data' USING ERRCODE = '23514';
    END IF;
    INSERT INTO hr.raw_punch (punch_device_id, device_user_no, punched_at, verify_type, punch_state)
    SELECT v_device_id, p.device_user_no, p.punched_at, p.verify_type, p.punch_state
      FROM jsonb_to_recordset(p_payload -> 'punches')
           AS p(device_user_no varchar, punched_at timestamptz, verify_type smallint, punch_state smallint)
    ON CONFLICT ON CONSTRAINT uq_raw_punch DO NOTHING;
    GET DIAGNOSTICS v_inserted = ROW_COUNT;
  END IF;

  IF p_payload ? 'users' AND v_users_seen_at >= coalesce(
       (SELECT users_synced_at FROM hr.punch_device WHERE punch_device_id = v_device_id), '-infinity') THEN
    INSERT INTO hr.punch_device_user AS u (punch_device_id, device_user_no, name, last_synced_at)
    SELECT DISTINCT ON (x.device_user_no) v_device_id, x.device_user_no, x.name, v_users_seen_at
      FROM jsonb_to_recordset(p_payload -> 'users') AS x(device_user_no varchar, name varchar)
    ON CONFLICT ON CONSTRAINT uq_punch_device_user DO UPDATE
       SET name           = EXCLUDED.name,
           last_synced_at = EXCLUDED.last_synced_at
     WHERE EXCLUDED.last_synced_at >= u.last_synced_at;
    GET DIAGNOSTICS v_users = ROW_COUNT;

    UPDATE hr.punch_device
       SET users_synced_at = v_users_seen_at
     WHERE punch_device_id = v_device_id
       AND (users_synced_at IS NULL OR users_synced_at < v_users_seen_at);
  END IF;

  RETURN jsonb_build_object(
    'punch_device_id', v_device_id,
    'received',        v_received,
    'inserted',        v_inserted,
    'users_synced',    v_users);
END;
$$;


COMMENT ON TABLE  hr.punch_device                      IS '打卡機';
COMMENT ON COLUMN hr.punch_device.punch_device_id      IS '打卡機識別碼（系統自動編號）';
COMMENT ON COLUMN hr.punch_device.serial_no            IS '卡機序號；兩台機器號都是 1，以序號區分';
COMMENT ON COLUMN hr.punch_device.name                 IS '顯示名稱；第一次建立時預設為「型號 IP」，之後可在後台修改，收集器不會覆蓋';
COMMENT ON COLUMN hr.punch_device.ip_address           IS '最近一次回報的 IP';
COMMENT ON COLUMN hr.punch_device.model                IS '型號';
COMMENT ON COLUMN hr.punch_device.firmware_version     IS '韌體版本';
COMMENT ON COLUMN hr.punch_device.last_seen_at         IS '收集器最後一次成功連上的時間';
COMMENT ON COLUMN hr.punch_device.record_count         IS '最後連上時卡機上的打卡紀錄筆數';
COMMENT ON COLUMN hr.punch_device.user_count           IS '最後連上時卡機上的使用者數';
COMMENT ON COLUMN hr.punch_device.clock_offset_seconds IS '卡機時鐘減標準時間的秒數；只記錄，不校時';
COMMENT ON COLUMN hr.punch_device.users_synced_at      IS '最後一次完整同步使用者名單的時間';
COMMENT ON COLUMN hr.punch_device.is_active            IS '使用中；卡機汰換時改為否';
COMMENT ON COLUMN hr.punch_device.created_at           IS '建立時間';
COMMENT ON COLUMN hr.punch_device.updated_at           IS '最後修改時間';

COMMENT ON TABLE  hr.raw_punch                 IS '原始打卡紀錄（卡機下載的原貌，只增不改）';
COMMENT ON COLUMN hr.raw_punch.raw_punch_id    IS '原始打卡識別碼（系統自動編號）';
COMMENT ON COLUMN hr.raw_punch.punch_device_id IS '哪一台卡機';
COMMENT ON COLUMN hr.raw_punch.device_user_no  IS '卡機上的使用者編號，對應 employee.employee_no';
COMMENT ON COLUMN hr.raw_punch.punched_at      IS '打卡時間（卡機的台北當地時間，以 +08:00 寫入）';
COMMENT ON COLUMN hr.raw_punch.verify_type     IS '驗證方式原始代碼；現場只見 1、2，推測 1 指紋、2 刷卡（待確認）';
COMMENT ON COLUMN hr.raw_punch.punch_state     IS '打卡狀態原始代碼；.190 幾乎都是 0、.191 幾乎都是 1，意義待人事確認';
COMMENT ON COLUMN hr.raw_punch.received_at     IS '雲端收到的時間';

COMMENT ON TABLE  hr.punch_device_user                      IS '卡機使用者名單（只存編號與姓名，不讀密碼、卡號、指紋）';
COMMENT ON COLUMN hr.punch_device_user.punch_device_user_id IS '卡機使用者識別碼（系統自動編號）';
COMMENT ON COLUMN hr.punch_device_user.punch_device_id      IS '哪一台卡機';
COMMENT ON COLUMN hr.punch_device_user.device_user_no       IS '卡機上的使用者編號';
COMMENT ON COLUMN hr.punch_device_user.name                 IS '卡機上登錄的姓名';
COMMENT ON COLUMN hr.punch_device_user.last_synced_at       IS '最後一次出現在同步名單裡的時間；早於該卡機的 users_synced_at 代表已從卡機刪除';
COMMENT ON COLUMN hr.punch_device_user.created_at           IS '建立時間';
COMMENT ON COLUMN hr.punch_device_user.updated_at           IS '最後修改時間';

COMMENT ON FUNCTION hr.ingest_punch_batch(jsonb) IS '收集器批次寫入；SECURITY INVOKER，以 hr_collector 權限及 RLS 執行';

ALTER TABLE hr.punch_device      ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.raw_punch         ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.punch_device_user ENABLE ROW LEVEL SECURITY;

-- 目的地識別不依賴密碼或 hostname；重建資料庫就會得到新的識別碼。
CREATE TABLE hr.collector_target (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  instance_id uuid NOT NULL DEFAULT gen_random_uuid(),
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1)
);
INSERT INTO hr.collector_target DEFAULT VALUES;
COMMENT ON TABLE hr.collector_target IS 'collector 目的地識別；備份還原後如需視為新目的地，管理者須重設 instance_id';
ALTER TABLE hr.collector_target ENABLE ROW LEVEL SECURITY;

ALTER TABLE hr.raw_punch ADD CONSTRAINT ck_raw_punch_codes CHECK
  (verify_type BETWEEN 0 AND 255 AND punch_state BETWEEN 0 AND 255 AND btrim(device_user_no) <> '');
ALTER TABLE hr.punch_device ADD CONSTRAINT ck_punch_device_counts CHECK
  (record_count >= 0 AND user_count >= 0 AND btrim(serial_no) <> '');

CREATE INDEX ix_department_parent ON hr.department(parent_id);
CREATE INDEX ix_employee_department ON hr.employee(department_id);
CREATE INDEX ix_employee_job_title ON hr.employee(job_title_id);
CREATE INDEX ix_employee_employment_type ON hr.employee(employment_type_id);
CREATE INDEX ix_department_manager_department ON hr.department_manager(department_id);
CREATE INDEX ix_department_manager_employee ON hr.department_manager(employee_id);

REVOKE ALL ON ALL TABLES IN SCHEMA hr FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA hr FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hr FROM PUBLIC;
GRANT USAGE ON SCHEMA hr TO hr_collector;
GRANT SELECT ON hr.collector_target, hr.punch_device, hr.raw_punch, hr.punch_device_user TO hr_collector;
GRANT INSERT ON hr.punch_device, hr.raw_punch, hr.punch_device_user TO hr_collector;
GRANT UPDATE (ip_address, model, firmware_version, last_seen_at, record_count,
  user_count, clock_offset_seconds, users_synced_at) ON hr.punch_device TO hr_collector;
GRANT UPDATE (name, last_synced_at) ON hr.punch_device_user TO hr_collector;
GRANT USAGE ON SEQUENCE hr.punch_device_punch_device_id_seq,
  hr.raw_punch_raw_punch_id_seq, hr.punch_device_user_punch_device_user_id_seq TO hr_collector;
GRANT EXECUTE ON FUNCTION hr.ingest_punch_batch(jsonb) TO hr_collector;
CREATE POLICY collector_target_read ON hr.collector_target FOR SELECT TO hr_collector USING (true);
CREATE POLICY collector_device_read ON hr.punch_device FOR SELECT TO hr_collector USING (true);
CREATE POLICY collector_device_insert ON hr.punch_device FOR INSERT TO hr_collector WITH CHECK (true);
CREATE POLICY collector_device_update ON hr.punch_device FOR UPDATE TO hr_collector USING (true) WITH CHECK (true);
CREATE POLICY collector_punch_read ON hr.raw_punch FOR SELECT TO hr_collector USING (true);
CREATE POLICY collector_punch_insert ON hr.raw_punch FOR INSERT TO hr_collector WITH CHECK (true);
CREATE POLICY collector_users_read ON hr.punch_device_user FOR SELECT TO hr_collector USING (true);
CREATE POLICY collector_users_insert ON hr.punch_device_user FOR INSERT TO hr_collector WITH CHECK (true);
CREATE POLICY collector_users_update ON hr.punch_device_user FOR UPDATE TO hr_collector USING (true) WITH CHECK (true);
