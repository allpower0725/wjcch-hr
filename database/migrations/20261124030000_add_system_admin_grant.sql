SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

CREATE TABLE hr.system_admin_grant (
  grant_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_id integer NOT NULL REFERENCES hr.employee(employee_id) ON DELETE RESTRICT,
  source text NOT NULL CHECK (source IN ('initial', 'maintenance')),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  granted_by name NOT NULL DEFAULT session_user,
  revoked_at timestamptz,
  revoked_by name,
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CHECK (revoked_at >= granted_at)
);

CREATE UNIQUE INDEX uq_system_admin_grant_initial
  ON hr.system_admin_grant(source) WHERE source = 'initial';
CREATE UNIQUE INDEX uq_system_admin_grant_active
  ON hr.system_admin_grant(employee_id) WHERE revoked_at IS NULL;
CREATE INDEX ix_system_admin_grant_employee_history ON hr.system_admin_grant(employee_id);

ALTER TABLE hr.system_admin_grant ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON hr.system_admin_grant FROM PUBLIC, hr_collector;

-- Call with the employee ID from a validated application session.
CREATE FUNCTION hr.has_system_admin_grant(p_employee_id integer)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM hr.system_admin_grant AS g
    WHERE g.employee_id = p_employee_id AND g.revoked_at IS NULL
  )
$$;
REVOKE ALL ON FUNCTION hr.has_system_admin_grant(integer) FROM PUBLIC, hr_collector;

RESET ROLE;
