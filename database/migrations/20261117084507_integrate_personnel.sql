-- HR 人事整合；由維護角色執行，應用物件仍由 hr 擁有。
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO hr;
SET LOCAL ROLE hr;

CREATE TABLE hr.personnel_import_batch (
  import_batch_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_key text NOT NULL UNIQUE,
  sources jsonb NOT NULL,
  decisions jsonb NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hr.personnel_import_row (
  import_row_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  import_batch_id uuid NOT NULL REFERENCES hr.personnel_import_batch ON DELETE RESTRICT,
  source_kind text NOT NULL CHECK (source_kind IN ('roster', 'device_export')),
  source_row integer NOT NULL CHECK (source_row > 0),
  employee_id integer REFERENCES hr.employee ON DELETE RESTRICT,
  original_data jsonb NOT NULL,
  applied_corrections jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (import_batch_id, source_kind, source_row)
);
CREATE INDEX ix_personnel_import_row_employee ON hr.personnel_import_row(employee_id);

CREATE TABLE hr.job_duty (
  job_duty_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(80) NOT NULL UNIQUE,
  sort_order smallint NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE hr.employee
  ALTER COLUMN hire_date DROP NOT NULL,
  ADD COLUMN job_duty_id integer REFERENCES hr.job_duty ON DELETE RESTRICT,
  ADD COLUMN address_city varchar(30),
  ADD COLUMN address_district varchar(30),
  ADD COLUMN address_detail text,
  ADD COLUMN phone_area varchar(10),
  ADD COLUMN phone_number varchar(30),
  ADD COLUMN attendance_required boolean NOT NULL DEFAULT true,
  ADD COLUMN attendance_exception_reason text,
  ADD CONSTRAINT ck_employee_attendance_exception CHECK
    (attendance_required OR nullif(btrim(attendance_exception_reason), '') IS NOT NULL);
CREATE INDEX ix_employee_job_duty ON hr.employee(job_duty_id);
ALTER TABLE hr.department ADD COLUMN source_level smallint CHECK (source_level BETWEEN 1 AND 3);
ALTER TABLE hr.department_manager
  ALTER COLUMN start_date DROP NOT NULL,
  ADD COLUMN recorded_on date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Taipei')::date,
  ADD COLUMN source_import_row_id bigint REFERENCES hr.personnel_import_row ON DELETE RESTRICT;
CREATE INDEX ix_department_manager_source ON hr.department_manager(source_import_row_id);

CREATE TABLE hr.employee_education (
  employee_education_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES hr.employee ON DELETE RESTRICT,
  school_name varchar(100) NOT NULL,
  major_name varchar(100),
  is_highest boolean NOT NULL DEFAULT false,
  source_import_row_id bigint REFERENCES hr.personnel_import_row ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (employee_id, school_name, major_name)
);
CREATE UNIQUE INDEX uq_employee_highest_education ON hr.employee_education(employee_id) WHERE is_highest;
CREATE INDEX ix_employee_education_source ON hr.employee_education(source_import_row_id);

CREATE TABLE hr.license_type (
  license_type_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name varchar(100) NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE hr.employee_license (
  employee_license_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES hr.employee ON DELETE RESTRICT,
  license_type_id integer NOT NULL REFERENCES hr.license_type ON DELETE RESTRICT,
  certificate_no varchar(100),
  valid_from date,
  valid_to date,
  has_no_expiry boolean NOT NULL DEFAULT false,
  source_import_row_id bigint REFERENCES hr.personnel_import_row ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_employee_license_dates CHECK (valid_to >= valid_from),
  CONSTRAINT ck_employee_license_no_expiry CHECK (NOT has_no_expiry OR valid_to IS NULL),
  UNIQUE NULLS NOT DISTINCT (employee_id, license_type_id, valid_from, valid_to)
);
CREATE INDEX ix_employee_license_type ON hr.employee_license(license_type_id);
CREATE INDEX ix_employee_license_source ON hr.employee_license(source_import_row_id);
CREATE INDEX ix_employee_license_expiry ON hr.employee_license(valid_to) WHERE valid_to IS NOT NULL;

CREATE TABLE hr.employee_device_mapping (
  employee_device_mapping_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES hr.employee ON DELETE RESTRICT,
  punch_device_id integer NOT NULL REFERENCES hr.punch_device ON DELETE RESTRICT,
  device_user_no varchar(24) NOT NULL CHECK (btrim(device_user_no) <> ''),
  valid_from timestamptz,
  valid_to timestamptz,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  match_basis text NOT NULL CHECK (btrim(match_basis) <> ''),
  source_import_row_id bigint REFERENCES hr.personnel_import_row ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ck_employee_device_mapping_dates CHECK (valid_to > valid_from),
  CONSTRAINT ex_employee_device_mapping_period EXCLUDE USING gist
    (punch_device_id extensions.gist_int4_ops WITH =,
     device_user_no extensions.gist_text_ops WITH =,
     tstzrange(valid_from, valid_to, '[)') WITH &&)
);
CREATE INDEX ix_employee_device_mapping_employee ON hr.employee_device_mapping(employee_id);
CREATE INDEX ix_employee_device_mapping_source ON hr.employee_device_mapping(source_import_row_id);

CREATE VIEW hr.v_employee_license WITH (security_invoker = true) AS
SELECT l.*, t.name AS license_name,
  CASE
    WHEN l.valid_from > (now() AT TIME ZONE 'Asia/Taipei')::date THEN 'not_yet_valid'
    WHEN l.valid_to < (now() AT TIME ZONE 'Asia/Taipei')::date THEN 'expired'
    WHEN l.valid_from IS NULL OR (l.valid_to IS NULL AND NOT l.has_no_expiry) THEN 'validity_unknown'
    ELSE 'valid'
  END AS validity_status
FROM hr.employee_license l JOIN hr.license_type t USING (license_type_id);

-- 日期未知的對照只能確認現況；過去打卡顯示候選人，不冒充已確認歷史。
CREATE VIEW hr.v_punch_employee WITH (security_invoker = true) AS
SELECT r.*,
  CASE WHEN r.punched_at >= coalesce(m.valid_from, m.confirmed_at) THEN e.employee_id END AS employee_id,
  CASE WHEN r.punched_at >= coalesce(m.valid_from, m.confirmed_at) THEN e.employee_no END AS employee_no,
  CASE WHEN r.punched_at >= coalesce(m.valid_from, m.confirmed_at) THEN e.name END AS employee_name,
  e.employee_no AS candidate_employee_no, e.name AS candidate_employee_name,
  m.employee_device_mapping_id,
  CASE WHEN m.employee_device_mapping_id IS NULL THEN 'unmatched'
       WHEN r.punched_at < coalesce(m.valid_from, m.confirmed_at) THEN 'history_pending'
       ELSE 'matched' END AS association_status
FROM hr.raw_punch r
LEFT JOIN hr.employee_device_mapping m ON m.punch_device_id = r.punch_device_id
  AND m.device_user_no = r.device_user_no
  AND (m.valid_from IS NULL OR r.punched_at >= m.valid_from)
  AND (m.valid_to IS NULL OR r.punched_at < m.valid_to)
LEFT JOIN hr.employee e USING (employee_id);

CREATE TRIGGER trg_job_duty_updated_at BEFORE UPDATE ON hr.job_duty FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();
CREATE TRIGGER trg_license_type_updated_at BEFORE UPDATE ON hr.license_type FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();
CREATE TRIGGER trg_employee_education_updated_at BEFORE UPDATE ON hr.employee_education FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();
CREATE TRIGGER trg_employee_license_updated_at BEFORE UPDATE ON hr.employee_license FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();
CREATE TRIGGER trg_employee_device_mapping_updated_at BEFORE UPDATE ON hr.employee_device_mapping FOR EACH ROW EXECUTE FUNCTION hr.set_updated_at();

ALTER TABLE hr.personnel_import_batch ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.personnel_import_row ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.job_duty ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employee_education ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.license_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employee_license ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employee_device_mapping ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hr.personnel_import_batch, hr.personnel_import_row, hr.job_duty,
  hr.employee_education, hr.license_type, hr.employee_license, hr.employee_device_mapping,
  hr.v_employee_license, hr.v_punch_employee FROM PUBLIC, hr_collector;
DO $revoke_api_roles$
DECLARE api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON hr.personnel_import_batch, hr.personnel_import_row, hr.job_duty, '
      'hr.employee_education, hr.license_type, hr.employee_license, hr.employee_device_mapping, '
      'hr.v_employee_license, hr.v_punch_employee FROM %I', api_role);
  END LOOP;
END;
$revoke_api_roles$;

COMMENT ON TABLE hr.job_duty IS '職務；與職稱分開，例如職員的職務可為護理師';
COMMENT ON TABLE hr.employee_education IS '員工學歷；附件僅提供最高學歷，不推定學位或畢業日期';
COMMENT ON TABLE hr.license_type IS '專業證照類別；保留來源名稱，不自動合併近似名稱';
COMMENT ON TABLE hr.employee_license IS '員工證照及每次有效期間；續期另建一筆';
COMMENT ON COLUMN hr.employee_license.valid_from IS '有效起日，含當日；未知留空';
COMMENT ON COLUMN hr.employee_license.valid_to IS '有效迄日，含當日；未知或無期限留空，依 has_no_expiry 區分';
COMMENT ON COLUMN hr.employee_license.has_no_expiry IS '僅在確認證照無期限時設為 true；空白日期不代表永久有效';
COMMENT ON TABLE hr.employee_device_mapping IS '員工與各卡機帳號的時間對照；同機同號期間不得重疊';
COMMENT ON COLUMN hr.employee_device_mapping.valid_from IS '有效起時，含；未知留空，歷史打卡另列待確認';
COMMENT ON COLUMN hr.employee_device_mapping.valid_to IS '有效迄時，不含；空白表示尚未結束';
COMMENT ON COLUMN hr.employee_device_mapping.confirmed_at IS '本次身分對照確認時間；不是任職日或帳號啟用日';
COMMENT ON TABLE hr.personnel_import_batch IS '人事匯入批次、來源雜湊及使用者確認規則；僅限人事維護';
COMMENT ON TABLE hr.personnel_import_row IS '來源欄位原值及更正紀錄；不收錄卡機密碼、指紋或安全設定';
COMMENT ON COLUMN hr.employee.employee_no IS '人事員工編號；對應員工一覽表，與卡機帳號分開';
COMMENT ON COLUMN hr.employee.hire_date IS '到職日；選填，未知留空';
COMMENT ON COLUMN hr.employee.job_duty_id IS '職務，與 job_title_id 職稱分開';
COMMENT ON COLUMN hr.employee.address_city IS '通訊地址縣市';
COMMENT ON COLUMN hr.employee.address_district IS '通訊地址鄉鎮區';
COMMENT ON COLUMN hr.employee.address_detail IS '通訊地址村里鄰巷弄號';
COMMENT ON COLUMN hr.employee.phone_area IS '聯絡市話區碼，保留前導零';
COMMENT ON COLUMN hr.employee.phone_number IS '聯絡市話號碼';
COMMENT ON COLUMN hr.employee.attendance_required IS '是否需要打卡；特例為 false 並附原因';
COMMENT ON COLUMN hr.employee.attendance_exception_reason IS '人事確認的免打卡原因';
COMMENT ON COLUMN hr.employee.staff_code IS '保留舊欄位；P/H 人事編號統一使用 employee_no，不重複填入';
COMMENT ON COLUMN hr.department.source_level IS '附件中的 Lv1/Lv2/Lv3；醫院根節點留空';
COMMENT ON COLUMN hr.department_manager.start_date IS '任期開始日；未知留空，不以到職日代替';
COMMENT ON COLUMN hr.department_manager.recorded_on IS '主管現況登錄日，不代表任期開始日';
COMMENT ON COLUMN hr.raw_punch.device_user_no IS '卡機帳號；透過 employee_device_mapping 按卡機及時間對照員工';
COMMENT ON VIEW hr.v_punch_employee IS '打卡與員工對照；歷史期間未知時 employee_id 留空，candidate_* 僅為現況候選';
COMMENT ON VIEW hr.v_employee_license IS '證照有效狀態；日期未知不判定為有效';
RESET ROLE;
