-- 員工與部門資料表（Supabase 版）

CREATE FUNCTION public.set_updated_at() RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.updated_at := pg_catalog.now();
  RETURN NEW;
END;
$$;

CREATE TABLE job_title (
  job_title_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          varchar(30)  NOT NULL UNIQUE,
  sort_order    smallint     NOT NULL DEFAULT 0,
  is_active     boolean      NOT NULL DEFAULT true,
  created_at    timestamptz  NOT NULL DEFAULT now(),
  updated_at    timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE employment_type (
  employment_type_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name                varchar(20)  NOT NULL UNIQUE,
  sort_order          smallint     NOT NULL DEFAULT 0,
  is_active           boolean      NOT NULL DEFAULT true,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now()
);

CREATE TABLE department (
  department_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           varchar(50)  NOT NULL,
  parent_id      integer      REFERENCES department (department_id) ON DELETE RESTRICT,
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
  ON department (parent_id, name) NULLS NOT DISTINCT
  WHERE is_active;

CREATE TABLE employee (
  employee_id         integer       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_no         varchar(10)   NOT NULL UNIQUE,
  name                varchar(50)   NOT NULL,
  gender              char(1)       CHECK (gender IN ('M', 'F')),
  birth_date          date,
  national_id         varchar(10)   UNIQUE
                                    CHECK (national_id ~ '^[A-Z][A-Z0-9][0-9]{8}$'),
  mobile_phone        varchar(20),
  email               varchar(100)  UNIQUE,
  department_id       integer       NOT NULL REFERENCES department (department_id) ON DELETE RESTRICT,
  job_title_id        integer       REFERENCES job_title (job_title_id) ON DELETE RESTRICT,
  employment_type_id  integer       REFERENCES employment_type (employment_type_id) ON DELETE RESTRICT,
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

CREATE TABLE department_manager (
  department_manager_id  integer      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id          integer      NOT NULL REFERENCES department (department_id) ON DELETE RESTRICT,
  employee_id            integer      NOT NULL REFERENCES employee (employee_id) ON DELETE RESTRICT,
  role                   varchar(10)  NOT NULL CHECK (role IN ('head', 'deputy', 'acting')),
  start_date             date         NOT NULL,
  end_date               date,
  created_at             timestamptz  NOT NULL DEFAULT now(),
  updated_at             timestamptz  NOT NULL DEFAULT now(),
  CONSTRAINT ck_department_manager_end_after_start CHECK (end_date >= start_date)
);

CREATE UNIQUE INDEX uq_department_manager_current_head
  ON department_manager (department_id)
  WHERE role IN ('head', 'acting') AND end_date IS NULL;

CREATE TRIGGER trg_job_title_updated_at          BEFORE UPDATE ON job_title          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employment_type_updated_at    BEFORE UPDATE ON employment_type    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_department_updated_at         BEFORE UPDATE ON department         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_employee_updated_at           BEFORE UPDATE ON employee           FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_department_manager_updated_at BEFORE UPDATE ON department_manager FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE  job_title                 IS '職稱';
COMMENT ON COLUMN job_title.job_title_id    IS '職稱識別碼（系統自動編號）';
COMMENT ON COLUMN job_title.name            IS '職稱名稱，例：護理師';
COMMENT ON COLUMN job_title.sort_order      IS '顯示順序';
COMMENT ON COLUMN job_title.is_active       IS '使用中；停用時改為否';
COMMENT ON COLUMN job_title.created_at      IS '建立時間';
COMMENT ON COLUMN job_title.updated_at      IS '最後修改時間';

COMMENT ON TABLE  employment_type                    IS '聘用類別';
COMMENT ON COLUMN employment_type.employment_type_id IS '聘用類別識別碼（系統自動編號）';
COMMENT ON COLUMN employment_type.name               IS '類別名稱，例：正職';
COMMENT ON COLUMN employment_type.sort_order         IS '顯示順序';
COMMENT ON COLUMN employment_type.is_active          IS '使用中；停用時改為否';
COMMENT ON COLUMN employment_type.created_at         IS '建立時間';
COMMENT ON COLUMN employment_type.updated_at         IS '最後修改時間';

COMMENT ON TABLE  department               IS '部門';
COMMENT ON COLUMN department.department_id IS '部門識別碼（系統自動編號）';
COMMENT ON COLUMN department.name          IS '部門名稱';
COMMENT ON COLUMN department.parent_id     IS '上層部門；最上層留空';
COMMENT ON COLUMN department.sort_order    IS '顯示順序';
COMMENT ON COLUMN department.phone_ext     IS '單位分機';
COMMENT ON COLUMN department.is_active     IS '使用中；裁撤時改為否';
COMMENT ON COLUMN department.disabled_on   IS '停用日期';
COMMENT ON COLUMN department.created_at    IS '建立時間';
COMMENT ON COLUMN department.updated_at    IS '最後修改時間';

COMMENT ON TABLE  employee                    IS '員工';
COMMENT ON COLUMN employee.employee_id        IS '員工識別碼（系統自動編號）';
COMMENT ON COLUMN employee.employee_no        IS '員工編號（打卡機上的號碼）';
COMMENT ON COLUMN employee.name               IS '姓名';
COMMENT ON COLUMN employee.gender             IS '性別：M 男、F 女';
COMMENT ON COLUMN employee.birth_date         IS '出生日期';
COMMENT ON COLUMN employee.national_id        IS '身分證字號（外籍同仁填居留證號）';
COMMENT ON COLUMN employee.mobile_phone       IS '手機';
COMMENT ON COLUMN employee.email              IS '電子郵件';
COMMENT ON COLUMN employee.department_id      IS '所屬部門';
COMMENT ON COLUMN employee.job_title_id       IS '職稱';
COMMENT ON COLUMN employee.employment_type_id IS '聘用類別';
COMMENT ON COLUMN employee.employment_status  IS '在職狀態：active 在職、on_leave 留職停薪、resigned 離職';
COMMENT ON COLUMN employee.hire_date          IS '到職日';
COMMENT ON COLUMN employee.resign_date        IS '離職日';
COMMENT ON COLUMN employee.card_no            IS '識別證卡號（刷卡打卡用）';
COMMENT ON COLUMN employee.zk_user_id         IS '打卡系統編號（舊打卡軟體 ZKTime 的人員編號）';
COMMENT ON COLUMN employee.staff_code         IS '人事代碼（P／H 開頭，用途待確認）';
COMMENT ON COLUMN employee.note               IS '備註';
COMMENT ON COLUMN employee.created_at         IS '建立時間';
COMMENT ON COLUMN employee.updated_at         IS '最後修改時間';

COMMENT ON TABLE  department_manager                       IS '部門主管';
COMMENT ON COLUMN department_manager.department_manager_id IS '主管紀錄編號（系統自動編號）';
COMMENT ON COLUMN department_manager.department_id         IS '部門';
COMMENT ON COLUMN department_manager.employee_id           IS '主管人員；可兼任多個部門';
COMMENT ON COLUMN department_manager.role                  IS '主管類別：head 主管、deputy 副主管、acting 代理主管';
COMMENT ON COLUMN department_manager.start_date            IS '任期開始';
COMMENT ON COLUMN department_manager.end_date              IS '任期結束；空白代表現任';
COMMENT ON COLUMN department_manager.created_at            IS '建立時間';
COMMENT ON COLUMN department_manager.updated_at            IS '最後修改時間';

ALTER TABLE job_title          ENABLE ROW LEVEL SECURITY;
ALTER TABLE employment_type    ENABLE ROW LEVEL SECURITY;
ALTER TABLE department         ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee           ENABLE ROW LEVEL SECURITY;
ALTER TABLE department_manager ENABLE ROW LEVEL SECURITY;;
