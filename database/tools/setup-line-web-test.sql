\set ON_ERROR_STOP on

BEGIN;
DO $$
BEGIN
  IF current_database() <> 'wjcch_db_test' THEN
    RAISE EXCEPTION 'LINE web fixtures require wjcch_db_test';
  END IF;
END;
$$;

SELECT 'CREATE ROLE hr_line_web_test NOINHERIT' WHERE to_regrole('hr_line_web_test') IS NULL \gexec
ALTER ROLE hr_line_web_test LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'app_password';
GRANT CONNECT ON DATABASE wjcch_db_test TO hr_line_web_test;

\if :configure_tunnel
SELECT 'CREATE ROLE hr_line_web_tunnel NOINHERIT' WHERE to_regrole('hr_line_web_tunnel') IS NULL \gexec
ALTER ROLE hr_line_web_tunnel LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
  PASSWORD :'tunnel_password';
GRANT CONNECT ON DATABASE wjcch_db_test TO hr_line_web_tunnel;
GRANT hr_line_web_test TO hr_line_web_tunnel WITH INHERIT TRUE, SET FALSE;
\endif

SET LOCAL ROLE hr;
CREATE OR REPLACE FUNCTION hr.line_web_test_provider()
RETURNS text LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN session_user = 'hr_line_web_tunnel' THEN 'local-tunnel-line' ELSE 'local-synthetic-line' END
$$;
REVOKE ALL ON FUNCTION hr.line_web_test_provider() FROM PUBLIC, hr_collector, hr_line_web_test;

CREATE OR REPLACE FUNCTION hr.line_web_local_admin_status(p_hash bytea)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT session_user = 'hr_line_web_test' AND EXISTS (
    SELECT 1 FROM hr.line_login_identity(p_hash) AS i
    JOIN hr.line_login_session AS s ON s.token_hash = p_hash
    JOIN hr.employee_line_binding AS b ON b.binding_id = s.binding_id
    WHERE b.provider_id = hr.line_web_test_provider() AND hr.has_system_admin_grant(i.employee_id)
  )
$$;
REVOKE ALL ON FUNCTION hr.line_web_local_admin_status(bytea) FROM PUBLIC, hr_collector;
GRANT EXECUTE ON FUNCTION hr.line_web_local_admin_status(bytea) TO hr_line_web_test;
RESET ROLE;
