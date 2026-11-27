SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

CREATE FUNCTION hr.roster_web_pilot_draft_read(p_hash bytea, p_unit_id integer, p_month date)
RETURNS TABLE(revision integer, days jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
__PILOT_DRAFT_QUERY__
$$;

CREATE FUNCTION hr.roster_web_pilot_draft_save(
  p_hash bytea, p_unit_id integer, p_employee_id integer, p_month date,
  p_revision integer, p_dates date[], p_kind text, p_starts integer[], p_ends integer[]
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  scope record;
  draft_id bigint;
  draft_revision integer;
  conflict_date date;
  invalid constant jsonb := jsonb_build_object('status', 422, 'error', '請檢查日期、班別以及時段起訖。');
  stale constant jsonb := jsonb_build_object('status', 409, 'error', '這個月的草稿已更新。請重新載入班表，再核對要儲存的日期。');
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

  IF p_month IS NULL OR p_month NOT BETWEEN DATE '1000-01-01' AND DATE '9999-12-01'
    OR extract(day FROM p_month) <> 1 OR p_revision IS NULL OR p_revision < 0
    OR p_dates IS NULL OR cardinality(p_dates) NOT BETWEEN 1 AND 31
    OR cardinality(p_dates) <> (SELECT count(DISTINCT day) FROM unnest(p_dates) AS day)
    OR EXISTS (SELECT 1 FROM unnest(p_dates) AS day WHERE day < p_month OR day >= p_month + interval '1 month')
    OR p_starts IS NULL OR p_ends IS NULL OR cardinality(p_starts) <> cardinality(p_ends)
    OR (p_kind IS NOT NULL AND p_kind NOT IN ('work', 'off'))
    OR (p_kind IS DISTINCT FROM 'work' AND cardinality(p_starts) <> 0)
  THEN
    RETURN invalid;
  END IF;

  IF p_kind = 'work' THEN
    IF cardinality(p_starts) NOT BETWEEN 1 AND 1440 OR EXISTS (
      SELECT 1 FROM unnest(p_starts, p_ends) AS part(first_minute, last_minute)
      WHERE first_minute IS NULL OR last_minute IS NULL
        OR first_minute < 0 OR last_minute > 2879 OR first_minute >= last_minute
    ) OR (SELECT min(first_minute) FROM unnest(p_starts) AS first_minute) >= 1440 THEN
      RETURN invalid;
    END IF;

    IF EXISTS (
      SELECT 1 FROM (
        SELECT day::timestamp + first_minute * interval '1 minute' AS starts_at,
          lag(day::timestamp + last_minute * interval '1 minute') OVER (ORDER BY day::timestamp + first_minute * interval '1 minute') AS previous_end
        FROM unnest(p_dates) AS day
        CROSS JOIN unnest(p_starts, p_ends) AS part(first_minute, last_minute)
      ) AS ordered WHERE ordered.starts_at < ordered.previous_end
    ) THEN
      RETURN jsonb_build_object('status', 422, 'error', '這次選取的日期之間有班次時段重疊。');
    END IF;
  END IF;

  -- Keep simultaneous saves for one employee in order, including different units and months.
  PERFORM pg_advisory_xact_lock(8291, p_employee_id);
  SELECT v.version_id, v.revision INTO draft_id, draft_revision FROM hr.roster_version AS v
  WHERE v.department_id = p_unit_id AND v.month_start = p_month AND v.status = 'draft'
  FOR UPDATE;
  IF coalesce(draft_revision, 0) <> p_revision THEN RETURN stale; END IF;

  IF p_kind = 'work' THEN
    WITH proposed AS MATERIALIZED (
      SELECT (day::timestamp + first_minute * interval '1 minute') AT TIME ZONE 'Asia/Taipei' AS starts_at,
        (day::timestamp + last_minute * interval '1 minute') AT TIME ZONE 'Asia/Taipei' AS ends_at
      FROM unnest(p_dates) AS day
      CROSS JOIN unnest(p_starts, p_ends) AS part(first_minute, last_minute)
    )
    SELECT d.work_date INTO conflict_date
    FROM hr.roster_day AS d
    JOIN hr.roster_shift_segment AS s USING (roster_day_id)
    JOIN hr.roster_version AS v USING (version_id)
    WHERE d.employee_id = p_employee_id AND v.status = 'draft'
      AND NOT (d.version_id IS NOT DISTINCT FROM draft_id AND d.work_date = ANY(p_dates))
      AND EXISTS (SELECT 1 FROM proposed WHERE proposed.starts_at < s.ends_at AND s.starts_at < proposed.ends_at)
    ORDER BY d.work_date LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object('status', 409, 'error', '時段與 ' || to_char(conflict_date, 'YYYY-MM-DD') || ' 的既有班次重疊。');
    END IF;
  END IF;

  IF draft_id IS NULL THEN
    IF p_kind IS NULL THEN RETURN jsonb_build_object('revision', 0); END IF;
    INSERT INTO hr.roster_version (department_id, month_start, updated_by_employee_id)
    VALUES (p_unit_id, p_month, scope."viewerId")
    ON CONFLICT DO NOTHING;

    SELECT v.version_id, v.revision INTO draft_id, draft_revision FROM hr.roster_version AS v
    WHERE v.department_id = p_unit_id AND v.month_start = p_month AND v.status = 'draft'
    FOR UPDATE;
    IF NOT FOUND OR draft_revision <> p_revision THEN RETURN stale; END IF;
  END IF;
  IF draft_revision = 2147483647 THEN RETURN stale; END IF;

  DELETE FROM hr.roster_day WHERE version_id = draft_id AND employee_id = p_employee_id AND work_date = ANY(p_dates);
  IF p_kind IS NOT NULL THEN
    WITH added AS (
      INSERT INTO hr.roster_day (version_id, employee_id, work_date, day_kind)
      SELECT draft_id, p_employee_id, day, p_kind FROM unnest(p_dates) AS day
      RETURNING roster_day_id, work_date
    )
    INSERT INTO hr.roster_shift_segment (roster_day_id, segment_no, starts_at, ends_at)
    SELECT d.roster_day_id, row_number() OVER (PARTITION BY d.work_date ORDER BY part.first_minute),
      (d.work_date::timestamp + part.first_minute * interval '1 minute') AT TIME ZONE 'Asia/Taipei',
      (d.work_date::timestamp + part.last_minute * interval '1 minute') AT TIME ZONE 'Asia/Taipei'
    FROM added AS d CROSS JOIN unnest(p_starts, p_ends) AS part(first_minute, last_minute);
  END IF;
  UPDATE hr.roster_version
  SET revision = draft_revision + 1, updated_by_employee_id = scope."viewerId"
  WHERE version_id = draft_id;
  RETURN jsonb_build_object('revision', draft_revision + 1);
END;
$$;

DO $permissions$
DECLARE
  functions constant text := 'hr.roster_web_pilot_draft_read(bytea,integer,date), '
    'hr.roster_web_pilot_draft_save(bytea,integer,integer,date,integer,date[],text,integer[],integer[])';
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

RESET ROLE;
