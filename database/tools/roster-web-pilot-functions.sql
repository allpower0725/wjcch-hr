SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION hr.roster_web_pilot_draft_read(p_hash bytea, p_unit_id integer, p_month date)
RETURNS TABLE(revision integer, days jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
__PILOT_DRAFT_QUERY__
$$;

CREATE OR REPLACE FUNCTION hr.roster_web_pilot_shift_options(p_hash bytea, p_unit_id integer)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT hr.roster_shift_options()
  FROM hr.roster_web_pilot_workspace(p_hash, p_unit_id) AS scope
  WHERE scope."selectedUnitId" = p_unit_id
$$;

CREATE OR REPLACE FUNCTION hr.roster_web_pilot_write(
  p_hash bytea, p_unit_id integer, p_employee_id integer, p_month date,
  p_revision integer, p_dates date[], p_kind text, p_starts integer[], p_ends integer[],
  p_code text, p_note text, p_legacy boolean
)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  scope record;
BEGIN
  SELECT * INTO scope FROM hr.roster_web_pilot_workspace(p_hash, p_unit_id);
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 401, 'error', '請重新登入。');
  END IF;
  IF scope."selectedUnitId" IS DISTINCT FROM p_unit_id OR NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(scope.people) AS person
    WHERE (person->>'employeeId')::integer = p_employee_id
  ) THEN
    RETURN jsonb_build_object('status', 403, 'error', '這位人員超出目前的排班範圍。');
  END IF;

  RETURN hr.roster_draft_save(scope."viewerId", p_unit_id, p_employee_id, p_month, p_revision,
    p_dates, p_kind, p_starts, p_ends, p_code, p_note, p_legacy);
END;
$$;

CREATE OR REPLACE FUNCTION hr.roster_web_pilot_draft_save(
  p_hash bytea, p_unit_id integer, p_employee_id integer, p_month date,
  p_revision integer, p_dates date[], p_kind text, p_starts integer[], p_ends integer[],
  p_code text, p_note text
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT hr.roster_web_pilot_write(p_hash, p_unit_id, p_employee_id, p_month, p_revision,
    p_dates, p_kind, p_starts, p_ends, p_code, p_note, p_kind IS NOT NULL AND p_code IS NULL)
$$;

CREATE OR REPLACE FUNCTION hr.roster_web_pilot_draft_save(
  p_hash bytea, p_unit_id integer, p_employee_id integer, p_month date,
  p_revision integer, p_dates date[], p_kind text, p_starts integer[], p_ends integer[]
)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT hr.roster_web_pilot_write(p_hash, p_unit_id, p_employee_id, p_month, p_revision,
    p_dates, p_kind, p_starts, p_ends, NULL, NULL, true)
$$;

DO $permissions$
DECLARE
  functions constant text := 'hr.roster_web_pilot_draft_read(bytea,integer,date), '
    'hr.roster_web_pilot_draft_save(bytea,integer,integer,date,integer,date[],text,integer[],integer[]), '
    'hr.roster_web_pilot_draft_save(bytea,integer,integer,date,integer,date[],text,integer[],integer[],text,text), '
    'hr.roster_web_pilot_shift_options(bytea,integer)';
  wrapper constant text := 'hr.roster_web_pilot_write(bytea,integer,integer,date,integer,date[],text,integer[],integer[],text,text,boolean)';
  principals text := 'PUBLIC';
  principal name;
BEGIN
  FOR principal IN SELECT rolname FROM pg_roles
    WHERE rolname IN ('hr_collector', 'anon', 'authenticated', 'service_role', 'hr_line_web_test', 'hr_line_web_tunnel')
  LOOP
    principals := principals || ', ' || quote_ident(principal);
  END LOOP;
  EXECUTE 'REVOKE ALL ON FUNCTION ' || functions || ', ' || wrapper || ' FROM ' || principals;
  EXECUTE 'REVOKE ALL ON FUNCTION ' || wrapper || ' FROM hr_web_pilot';
  EXECUTE 'GRANT EXECUTE ON FUNCTION ' || functions || ' TO hr_web_pilot';
END;
$permissions$;

RESET ROLE;
