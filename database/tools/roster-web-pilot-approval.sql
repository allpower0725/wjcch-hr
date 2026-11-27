SET LOCAL ROLE hr;

CREATE OR REPLACE FUNCTION hr.roster_web_pilot_approval(p_hash bytea,p_request jsonb,p_due_day integer)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT coalesce((
    SELECT hr.roster_approval_request(i.employee_id,p_request,p_due_day)
    FROM hr.line_web_pilot_identity(p_hash) AS i
  ),hr.roster_approval_error(401,'請重新登入。'))
$$;

REVOKE ALL ON FUNCTION hr.roster_web_pilot_approval(bytea,jsonb,integer) FROM PUBLIC,anon,authenticated,service_role,hr_collector;
GRANT EXECUTE ON FUNCTION hr.roster_web_pilot_approval(bytea,jsonb,integer) TO hr_web_pilot;

RESET ROLE;
