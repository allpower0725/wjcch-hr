SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

CREATE FUNCTION hr.line_web_pilot_begin(p_subject text, p_hash bytea)
RETURNS TABLE(outcome text, deadline timestamptz, attempts_remaining integer)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH approved AS MATERIALIZED (
    SELECT e.employee_id
    FROM hr.employee AS e
    WHERE e.employee_no = 'P271' AND e.employment_status IN ('active', 'on_leave')
      AND p_subject ~ '^U[0-9A-Fa-f]{32}$'
      AND encode(sha256(convert_to(p_subject, 'UTF8')), 'hex') = '__PILOT_SUBJECT_SHA256__'
      AND NOT EXISTS (
        SELECT 1 FROM hr.employee_line_binding AS b
        WHERE b.revoked_at IS NULL
          AND (b.employee_id = e.employee_id OR (b.provider_id = '2005826039' AND b.line_user_id = p_subject))
          AND NOT (b.employee_id = e.employee_id AND b.provider_id = '2005826039' AND b.line_user_id = p_subject)
      )
  )
  SELECT opened.*
  FROM approved
  CROSS JOIN LATERAL hr.begin_line_login('2005826039', p_subject, p_hash) AS opened;
$$;

CREATE FUNCTION hr.line_web_pilot_match(p_hash bytea, p_document_no text, p_birth_date date)
RETURNS TABLE(outcome text, deadline timestamptz, attempts_remaining integer,
  employee_no text, employee_name text, department text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  WITH pending AS MATERIALIZED (
    SELECT s.token_hash FROM hr.line_login_session AS s
    WHERE s.token_hash = p_hash AND s.pending_provider_id = '2005826039'
      AND encode(sha256(convert_to(s.pending_line_user_id, 'UTF8')), 'hex') = '__PILOT_SUBJECT_SHA256__'
  ), candidate AS MATERIALIZED (
    SELECT e.employee_no, e.name, e.department_id, e.national_id
    FROM hr.employee AS e
    WHERE e.employee_no = 'P271' AND e.national_id = p_document_no
  )
  SELECT checked.*, candidate.employee_no::text, candidate.name::text, d.name::text
  FROM pending
  CROSS JOIN LATERAL hr.verify_line_employee(
    pending.token_hash, (SELECT national_id FROM candidate), p_birth_date
  ) AS checked
  LEFT JOIN candidate ON checked.outcome = 'matched'
  LEFT JOIN hr.department AS d USING (department_id);
$$;

CREATE FUNCTION hr.line_web_pilot_confirm(p_pending_hash bytea, p_login_hash bytea)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT hr.confirm_line_binding(s.token_hash, p_login_hash)
  FROM hr.line_login_session AS s
  WHERE s.token_hash = p_pending_hash AND s.pending_provider_id = '2005826039'
    AND encode(sha256(convert_to(s.pending_line_user_id, 'UTF8')), 'hex') = '__PILOT_SUBJECT_SHA256__'
    AND (s.matched_employee_id IS NULL OR EXISTS (
      SELECT 1 FROM hr.employee AS e WHERE e.employee_no = 'P271' AND e.employee_id = s.matched_employee_id
    ));
$$;

CREATE FUNCTION hr.line_web_pilot_identity(p_hash bytea)
RETURNS TABLE(employee_id integer, employee_no text, employee_name text, department text, is_admin boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT e.employee_id, e.employee_no::text, e.name::text, d.name::text, hr.has_system_admin_grant(e.employee_id)
  FROM hr.line_login_identity(p_hash) AS identity
  JOIN hr.employee AS e USING (employee_id)
  JOIN hr.department AS d USING (department_id)
  JOIN hr.line_login_session AS s ON s.token_hash = p_hash
  JOIN hr.employee_line_binding AS b ON b.binding_id = s.binding_id
  WHERE e.employee_no = 'P271' AND b.provider_id = '2005826039'
    AND encode(sha256(convert_to(b.line_user_id, 'UTF8')), 'hex') = '__PILOT_SUBJECT_SHA256__';
$$;

CREATE FUNCTION hr.line_web_pilot_end(p_hash bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  DELETE FROM hr.line_login_session AS s
  WHERE s.token_hash = p_hash AND (
    (s.pending_provider_id = '2005826039'
      AND encode(sha256(convert_to(s.pending_line_user_id, 'UTF8')), 'hex') = '__PILOT_SUBJECT_SHA256__')
    OR EXISTS (
      SELECT 1 FROM hr.employee_line_binding AS b JOIN hr.employee AS e USING (employee_id)
      WHERE b.binding_id = s.binding_id AND b.provider_id = '2005826039' AND e.employee_no = 'P271'
        AND encode(sha256(convert_to(b.line_user_id, 'UTF8')), 'hex') = '__PILOT_SUBJECT_SHA256__'
    )
  );
$$;

CREATE FUNCTION hr.roster_web_pilot_workspace(p_hash bytea, p_unit_id integer)
RETURNS TABLE("viewerId" integer, units jsonb, "selectedUnitId" integer, people jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
__PILOT_ROSTER_QUERY__
$$;

DO $permissions$
DECLARE
  functions constant text := 'hr.line_web_pilot_begin(text,bytea), hr.line_web_pilot_match(bytea,text,date), '
    'hr.line_web_pilot_confirm(bytea,bytea), hr.line_web_pilot_identity(bytea), '
    'hr.line_web_pilot_end(bytea), hr.roster_web_pilot_workspace(bytea,integer)';
  principals text := 'PUBLIC';
  principal name;
BEGIN
  FOR principal IN SELECT rolname FROM pg_roles
    WHERE rolname IN ('hr_collector', 'anon', 'authenticated', 'service_role')
  LOOP
    principals := principals || ', ' || quote_ident(principal);
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION ' || functions || ' FROM ' || principals;
  EXECUTE 'GRANT EXECUTE ON FUNCTION ' || functions || ' TO hr_web_pilot';
END;
$permissions$;

GRANT USAGE ON SCHEMA hr TO hr_web_pilot;
RESET ROLE;
