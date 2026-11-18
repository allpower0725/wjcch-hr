SET LOCAL ROLE hr;

DROP VIEW hr.v_employee_license;
ALTER TABLE hr.employee_license DROP COLUMN source_import_row_id;

CREATE VIEW hr.v_employee_license WITH (security_invoker = true) AS
SELECT l.employee_license_id, l.employee_id, l.license_type_id, l.certificate_no,
  l.valid_from, l.valid_to, l.has_no_expiry, l.created_at, l.updated_at,
  t.name AS license_name,
  CASE
    WHEN l.valid_from > (now() AT TIME ZONE 'Asia/Taipei')::date THEN 'not_yet_valid'
    WHEN l.valid_to < (now() AT TIME ZONE 'Asia/Taipei')::date THEN 'expired'
    WHEN l.valid_from IS NULL OR (l.valid_to IS NULL AND NOT l.has_no_expiry) THEN 'validity_unknown'
    ELSE 'valid'
  END AS validity_status
FROM hr.employee_license l JOIN hr.license_type t USING (license_type_id);

REVOKE ALL ON hr.v_employee_license FROM PUBLIC, hr_collector;
DO $$
DECLARE api_role text;
BEGIN
  FOR api_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon', 'authenticated') LOOP
    EXECUTE format('REVOKE ALL ON hr.v_employee_license FROM %I', api_role);
  END LOOP;
END;
$$;

COMMENT ON VIEW hr.v_employee_license IS '證照有效狀態；日期未知不判定為有效';
RESET ROLE;
