SET LOCAL ROLE hr;

CREATE OR REPLACE FUNCTION hr.line_web_test_fixtures(p_tunnel boolean)
RETURNS TABLE(employee_no text, name text, national_id text, birth_date date, status text)
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT f.employee_no, f.name, f.national_id, f.birth_date, f.status
  FROM (VALUES
    (false, 'LTEST1001', '合成員工一', 'Z000000001', DATE '1992-06-15', 'active'),
    (false, 'LTEST1005', '合成員工五', 'Z000000005', DATE '1990-10-25', 'on_leave'),
    (true, 'LTEST2001', '合成員工一', 'Z000000011', DATE '1992-06-15', 'active'),
    (true, 'LTEST2005', '合成員工五', 'Z000000015', DATE '1990-10-25', 'on_leave')
  ) AS f(tunnel, employee_no, name, national_id, birth_date, status)
  WHERE f.tunnel = p_tunnel
$$;
REVOKE ALL ON FUNCTION hr.line_web_test_fixtures(boolean) FROM PUBLIC, hr_collector, hr_line_web_test;

INSERT INTO hr.department(name) VALUES ('人資工作台合成測試單位')
ON CONFLICT (parent_id, name) WHERE is_active DO NOTHING;

INSERT INTO hr.employee(employee_no, name, department_id, national_id, birth_date, employment_status)
SELECT sample.employee_no, sample.name, d.department_id, sample.national_id, sample.birth_date, sample.status
FROM hr.department AS d
CROSS JOIN (
  SELECT * FROM hr.line_web_test_fixtures(false)
  UNION ALL
  SELECT * FROM hr.line_web_test_fixtures(true)
  WHERE current_database() = 'wjcch_db_test' AND to_regrole('hr_line_web_tunnel') IS NOT NULL
) AS sample
WHERE d.parent_id IS NULL AND d.name = '人資工作台合成測試單位' AND d.is_active
ON CONFLICT (employee_no) DO NOTHING;

CREATE OR REPLACE FUNCTION hr.line_web_test_begin(p_subject text, p_hash bytea)
RETURNS TABLE(outcome text, deadline timestamptz, attempts_remaining integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_provider text := hr.line_web_test_provider();
BEGIN
  IF (v_provider = 'local-synthetic-line' AND p_subject IN ('first', 'leave', 'other'))
    OR (v_provider IN ('cloud-line-test', 'local-tunnel-line') AND p_subject ~ '^U[0-9A-Fa-f]{32}$') THEN
    RETURN QUERY SELECT r.* FROM hr.begin_line_login(v_provider, p_subject, p_hash) AS r;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION hr.line_web_test_match(p_hash bytea, p_id text, p_dob date)
RETURNS TABLE(outcome text, deadline timestamptz, attempts_remaining integer,
  employee_no text, employee_name text, department text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_outcome text;
  v_deadline timestamptz;
  v_attempts integer;
  v_id text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hr.line_login_session AS s
    WHERE s.token_hash = p_hash AND s.pending_provider_id = hr.line_web_test_provider()) THEN
    RETURN QUERY SELECT 'expired'::text, NULL::timestamptz, NULL::integer, NULL::text, NULL::text, NULL::text;
    RETURN;
  END IF;

  -- Only compare the synthetic employees belonging to this connection's LINE mode.
  SELECT e.national_id INTO v_id FROM hr.employee AS e
  JOIN hr.line_web_test_fixtures(hr.line_web_test_provider() = 'local-tunnel-line') AS f
    ON f.employee_no = e.employee_no AND f.national_id = e.national_id
  WHERE e.national_id = p_id;
  SELECT r.* INTO STRICT v_outcome, v_deadline, v_attempts FROM hr.verify_line_employee(p_hash, v_id, p_dob) AS r;

  RETURN QUERY SELECT v_outcome, v_deadline, v_attempts, e.employee_no::text, e.name::text, d.name::text
  FROM (VALUES (p_hash)) AS submitted(token_hash)
  LEFT JOIN hr.line_login_session AS s ON s.token_hash = submitted.token_hash AND v_outcome = 'matched'
  LEFT JOIN hr.employee AS e ON e.employee_id = s.matched_employee_id
  LEFT JOIN hr.department AS d USING (department_id);
END;
$$;

CREATE OR REPLACE FUNCTION hr.line_web_test_confirm(p_pending_hash bytea, p_login_hash bytea)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT CASE WHEN EXISTS (SELECT 1 FROM hr.line_login_session AS s
    WHERE s.token_hash = p_pending_hash AND s.pending_provider_id = hr.line_web_test_provider())
    THEN hr.confirm_line_binding(p_pending_hash, p_login_hash) ELSE 'expired' END;
$$;

CREATE OR REPLACE FUNCTION hr.line_web_test_identity(p_hash bytea)
RETURNS TABLE(employee_no text, employee_name text, department text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT e.employee_no::text, e.name::text, d.name::text
  FROM hr.line_login_identity(p_hash) AS i
  JOIN hr.employee AS e USING (employee_id)
  JOIN hr.line_web_test_fixtures(hr.line_web_test_provider() = 'local-tunnel-line') AS f
    ON f.employee_no = e.employee_no AND f.national_id = e.national_id
  JOIN hr.department AS d USING (department_id)
  JOIN hr.line_login_session AS s ON s.token_hash = p_hash
  JOIN hr.employee_line_binding AS b ON b.binding_id = s.binding_id
  WHERE b.provider_id = hr.line_web_test_provider();
$$;

CREATE OR REPLACE FUNCTION hr.line_web_test_end(p_hash bytea)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  DELETE FROM hr.line_login_session AS s WHERE s.token_hash = p_hash
    AND (s.pending_provider_id = hr.line_web_test_provider() OR EXISTS (
      SELECT 1 FROM hr.employee_line_binding AS b
      WHERE b.binding_id = s.binding_id AND b.provider_id = hr.line_web_test_provider()
    ));
$$;

GRANT USAGE ON SCHEMA hr TO hr_line_web_test;
REVOKE ALL ON FUNCTION hr.line_web_test_begin(text, bytea), hr.line_web_test_match(bytea, text, date),
  hr.line_web_test_confirm(bytea, bytea), hr.line_web_test_identity(bytea), hr.line_web_test_end(bytea)
FROM PUBLIC, hr_collector;
GRANT EXECUTE ON FUNCTION hr.line_web_test_begin(text, bytea), hr.line_web_test_match(bytea, text, date),
  hr.line_web_test_confirm(bytea, bytea), hr.line_web_test_identity(bytea), hr.line_web_test_end(bytea)
TO hr_line_web_test;
RESET ROLE;
