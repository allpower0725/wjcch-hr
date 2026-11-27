-- Standalone synthetic test project only. Apply before the binding migration and test functions.
DO $$
BEGIN
  IF current_database() <> 'postgres' OR to_regnamespace('hr') IS NOT NULL THEN
    RAISE EXCEPTION 'Cloud LINE fixtures require a blank Supabase project';
  END IF;
END;
$$;

CREATE ROLE hr NOLOGIN NOINHERIT;
CREATE ROLE hr_collector NOLOGIN NOINHERIT;
CREATE ROLE hr_line_web_test NOLOGIN NOINHERIT;
GRANT hr TO postgres;
CREATE SCHEMA hr AUTHORIZATION hr;
REVOKE ALL ON SCHEMA hr FROM PUBLIC, anon, authenticated, service_role;
GRANT CONNECT ON DATABASE postgres TO hr_line_web_test;

SET LOCAL ROLE hr;
CREATE TABLE hr.department (
  department_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id integer REFERENCES hr.department(department_id),
  name varchar(100) NOT NULL,
  is_active boolean NOT NULL DEFAULT true
);
CREATE UNIQUE INDEX uq_department_active_name
  ON hr.department (parent_id, name) NULLS NOT DISTINCT WHERE is_active;

CREATE TABLE hr.employee (
  employee_id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_no varchar(10) NOT NULL UNIQUE,
  name varchar(50) NOT NULL,
  national_id varchar(10) UNIQUE CHECK (national_id ~ '^Z0[0-9]{8}$'),
  birth_date date,
  department_id integer NOT NULL REFERENCES hr.department(department_id),
  employment_status varchar(10) NOT NULL DEFAULT 'active' CHECK (employment_status IN ('active', 'on_leave', 'resigned'))
);

ALTER TABLE hr.department ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.employee ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hr.department, hr.employee FROM PUBLIC, anon, authenticated, service_role, hr_collector, hr_line_web_test;

CREATE FUNCTION hr.line_web_test_provider()
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$ SELECT 'cloud-line-test'::text $$;
REVOKE ALL ON FUNCTION hr.line_web_test_provider() FROM PUBLIC, anon, authenticated, service_role, hr_collector, hr_line_web_test;
RESET ROLE;
