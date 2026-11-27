SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

CREATE TABLE hr.roster_version (
  version_id             bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id          integer NOT NULL REFERENCES hr.department(department_id) ON DELETE RESTRICT,
  month_start            date    NOT NULL CHECK (extract(day FROM month_start) = 1),
  version_no             integer NOT NULL DEFAULT 1 CHECK (version_no > 0),
  status                 text    NOT NULL DEFAULT 'draft' CHECK (status = 'draft'),
  revision               integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_by_employee_id integer NOT NULL REFERENCES hr.employee(employee_id) ON DELETE RESTRICT,
  UNIQUE (department_id, month_start, version_no)
);

CREATE UNIQUE INDEX uq_roster_version_editable_draft
  ON hr.roster_version (department_id, month_start) WHERE status = 'draft';

CREATE TABLE hr.roster_day (
  roster_day_id bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  version_id    bigint  NOT NULL REFERENCES hr.roster_version(version_id) ON DELETE RESTRICT,
  employee_id   integer NOT NULL REFERENCES hr.employee(employee_id) ON DELETE RESTRICT,
  work_date     date    NOT NULL,
  day_kind      text    NOT NULL CHECK (day_kind IN ('work', 'off')),
  UNIQUE (version_id, employee_id, work_date)
);

CREATE INDEX ix_roster_day_employee_date ON hr.roster_day (employee_id, work_date);

CREATE TABLE hr.roster_shift_segment (
  roster_day_id bigint      NOT NULL REFERENCES hr.roster_day(roster_day_id) ON DELETE CASCADE,
  segment_no    integer     NOT NULL CHECK (segment_no > 0),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL CHECK (ends_at > starts_at),
  PRIMARY KEY (roster_day_id, segment_no)
);

ALTER TABLE hr.roster_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.roster_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.roster_shift_segment ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON hr.roster_version, hr.roster_day, hr.roster_shift_segment FROM PUBLIC, hr_collector;
REVOKE ALL ON SEQUENCE hr.roster_version_version_id_seq, hr.roster_day_roster_day_id_seq FROM PUBLIC, hr_collector;

DO $$
DECLARE portal_role name;
BEGIN
  FOR portal_role IN
    SELECT rolname FROM pg_catalog.pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role', 'hr_line_web_test', 'hr_line_web_tunnel')
  LOOP
    EXECUTE format('REVOKE ALL ON hr.roster_version, hr.roster_day, hr.roster_shift_segment FROM %I', portal_role);
    EXECUTE format('REVOKE ALL ON SEQUENCE hr.roster_version_version_id_seq, hr.roster_day_roster_day_id_seq FROM %I', portal_role);
  END LOOP;
END $$;

RESET ROLE;
