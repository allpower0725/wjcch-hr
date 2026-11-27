\set ON_ERROR_STOP on
BEGIN;
SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

SELECT set_config('hr.initial_admin_employee_no', :'employee_no', true) AS requested_employee \gset

DO $$
DECLARE
  v_requested_no text := current_setting('hr.initial_admin_employee_no');
  v_employee_id integer;
  v_initial hr.system_admin_grant%ROWTYPE;
BEGIN
  IF current_database() NOT IN ('wjcch_db', 'wjcch_db_test') THEN
    RAISE EXCEPTION 'Initial system administrator requires a local HR database';
  END IF;

  LOCK TABLE hr.system_admin_grant IN SHARE ROW EXCLUSIVE MODE;
  SELECT e.employee_id INTO v_employee_id FROM hr.employee AS e
  WHERE e.employee_no = v_requested_no AND e.employment_status IN ('active', 'on_leave')
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Initial system administrator must be an eligible employee';
  END IF;

  PERFORM 1 FROM hr.employee_line_binding AS b
  WHERE b.employee_id = v_employee_id AND b.revoked_at IS NULL
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Initial system administrator must have an active LINE binding';
  END IF;

  SELECT g.* INTO v_initial FROM hr.system_admin_grant AS g WHERE g.source = 'initial';
  IF FOUND THEN
    IF v_initial.employee_id = v_employee_id AND v_initial.revoked_at IS NULL THEN
      RETURN;
    END IF;
    RAISE EXCEPTION 'Initial system administrator has already been assigned';
  END IF;
  IF EXISTS (SELECT 1 FROM hr.system_admin_grant) THEN
    RAISE EXCEPTION 'Existing administrator history requires the maintenance procedure';
  END IF;

  INSERT INTO hr.system_admin_grant(employee_id, source) VALUES (v_employee_id, 'initial');
END;
$$;
COMMIT;
