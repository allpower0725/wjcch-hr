SET LOCAL ROLE hr;
SET LOCAL lock_timeout = '10s';

CREATE TABLE hr.roster_shift_type (
  code       text    PRIMARY KEY,
  name       text    NOT NULL,
  kind       text    NOT NULL CHECK (kind IN ('work', 'off')),
  sort_order integer NOT NULL,
  legacy     boolean NOT NULL DEFAULT false,
  UNIQUE (code, kind)
);

CREATE TABLE hr.roster_shift_type_segment (
  shift_code   text    NOT NULL REFERENCES hr.roster_shift_type(code),
  segment_no   integer NOT NULL CHECK (segment_no > 0),
  start_minute integer NOT NULL CHECK (start_minute >= 0),
  end_minute   integer NOT NULL CHECK (end_minute > start_minute AND end_minute < 2880),
  PRIMARY KEY (shift_code, segment_no)
);

INSERT INTO hr.roster_shift_type (code, name, kind, sort_order, legacy) VALUES
  ('A', 'A 班', 'work', 10, false),
  ('B', '兩頭班', 'work', 20, false),
  ('D', '日班', 'work', 30, false),
  ('E', '小夜', 'work', 40, false),
  ('N', '大夜', 'work', 50, false),
  ('PM', '上午班', 'work', 60, false),
  ('AM', '下午班', 'work', 70, false),
  ('R', '例假', 'off', 80, false),
  ('L', '請假', 'off', 90, false),
  ('X', '自訂工時', 'work', 100, true),
  ('OFF', '休息日', 'off', 110, true);

INSERT INTO hr.roster_shift_type_segment (shift_code, segment_no, start_minute, end_minute) VALUES
  ('A', 1, 480, 1020),
  ('B', 1, 480, 720),
  ('B', 2, 1080, 1290),
  ('D', 1, 480, 960),
  ('E', 1, 960, 1440),
  ('N', 1, 0, 480),
  ('PM', 1, 480, 720),
  ('AM', 1, 840, 1080);

ALTER TABLE hr.roster_day
  ADD COLUMN shift_code text,
  ADD COLUMN note text CHECK (char_length(note) <= 100),
  ADD CONSTRAINT roster_day_shift_kind_fkey FOREIGN KEY (shift_code, day_kind)
    REFERENCES hr.roster_shift_type(code, kind);

ALTER TABLE hr.roster_shift_type ENABLE ROW LEVEL SECURITY;
ALTER TABLE hr.roster_shift_type_segment ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION hr.roster_shift_options()
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'code', t.code, 'name', t.name, 'kind', t.kind, 'legacy', t.legacy,
    'defaults', coalesce((
      SELECT jsonb_agg(jsonb_build_object('start', s.start_minute, 'end', s.end_minute) ORDER BY s.segment_no)
      FROM hr.roster_shift_type_segment AS s WHERE s.shift_code = t.code
    ), '[]'::jsonb)
  ) ORDER BY t.sort_order, t.code), '[]'::jsonb)
  FROM hr.roster_shift_type AS t
$$;

CREATE FUNCTION hr.roster_paid_ranges(p_code text, p_date date, p_start timestamptz, p_end timestamptz)
RETURNS tstzmultirange LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT tstzmultirange(tstzrange(p_start, p_end))
    - CASE WHEN p_code = 'A' THEN tstzmultirange(
        tstzrange((p_date + time '12:00') AT TIME ZONE 'Asia/Taipei', (p_date + time '13:00') AT TIME ZONE 'Asia/Taipei'),
        tstzrange((p_date + 1 + time '12:00') AT TIME ZONE 'Asia/Taipei', (p_date + 1 + time '13:00') AT TIME ZONE 'Asia/Taipei')
      ) ELSE '{}'::tstzmultirange END
$$;

CREATE FUNCTION hr.roster_draft_save(
  p_viewer_id integer, p_unit_id integer, p_employee_id integer, p_month date,
  p_revision integer, p_dates date[], p_kind text, p_starts integer[], p_ends integer[],
  p_code text, p_note text, p_legacy boolean
)
RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  draft_id bigint;
  draft_revision integer;
  conflict_date date;
  invalid constant jsonb := jsonb_build_object('status', 422, 'error', '請檢查日期、班別、備註及時段起訖。');
  stale constant jsonb := jsonb_build_object('status', 409, 'error', '這個月的草稿已更新。請重新載入班表，再核對要儲存的日期。');
BEGIN
  IF p_month IS NULL OR p_month NOT BETWEEN DATE '1000-01-01' AND DATE '9999-12-01'
    OR extract(day FROM p_month) <> 1 OR p_revision IS NULL OR p_revision < 0
    OR p_dates IS NULL OR cardinality(p_dates) NOT BETWEEN 1 AND 31
    OR cardinality(p_dates) <> (SELECT count(DISTINCT day) FROM unnest(p_dates) AS day)
    OR EXISTS (SELECT 1 FROM unnest(p_dates) AS day WHERE day < p_month OR day >= p_month + interval '1 month')
    OR p_starts IS NULL OR p_ends IS NULL OR cardinality(p_starts) <> cardinality(p_ends)
    OR (p_kind IS NOT NULL AND p_kind NOT IN ('work', 'off'))
    OR (p_kind IS DISTINCT FROM 'work' AND cardinality(p_starts) <> 0)
    OR (p_kind IS NULL AND (p_code IS NOT NULL OR p_note IS NOT NULL))
    OR (p_kind IS NOT NULL AND NOT p_legacy AND p_code IS NULL)
    OR (p_code IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM hr.roster_shift_type WHERE code = p_code AND kind = p_kind
    ))
    OR char_length(p_note) > 100
  THEN
    RETURN invalid;
  END IF;

  IF p_kind = 'work' AND (
    cardinality(p_starts) NOT BETWEEN 1 AND 1440
    OR EXISTS (
      SELECT 1
      FROM unnest(p_starts, p_ends) AS part(first_minute, last_minute)
      WHERE first_minute IS NULL OR last_minute IS NULL
        OR first_minute < 0 OR last_minute > 2879 OR first_minute >= last_minute
    )
    OR EXISTS (
      SELECT 1 FROM (
        SELECT first_minute, lag(last_minute) OVER (ORDER BY first_minute) AS previous_end
        FROM unnest(p_starts, p_ends) AS part(first_minute, last_minute)
      ) AS ordered WHERE first_minute < previous_end
    )
  ) THEN
    RETURN invalid;
  END IF;

  -- Serialize saves across unit and month boundaries for the same employee.
  PERFORM pg_advisory_xact_lock(8291, p_employee_id);
  SELECT v.version_id, v.revision INTO draft_id, draft_revision FROM hr.roster_version AS v
  WHERE v.department_id = p_unit_id AND v.month_start = p_month AND v.status = 'draft'
  FOR UPDATE;
  IF coalesce(draft_revision, 0) <> p_revision OR draft_revision = 2147483647 THEN RETURN stale; END IF;

  IF p_legacy AND EXISTS (
    SELECT 1 FROM hr.roster_day WHERE version_id = draft_id AND employee_id = p_employee_id
      AND work_date = ANY(p_dates) AND (shift_code IS NOT NULL OR note IS NOT NULL)
  ) THEN
    RETURN jsonb_build_object('status', 409, 'error', '請重新載入新版班表，再修改已登記的班次。');
  END IF;

  IF p_kind = 'work' THEN
    WITH proposed AS MATERIALIZED (
      SELECT day, paid.period
      FROM unnest(p_dates) AS day
      CROSS JOIN unnest(p_starts, p_ends) AS part(first_minute, last_minute)
      CROSS JOIN LATERAL unnest(hr.roster_paid_ranges(p_code, day,
        (day::timestamp + first_minute * interval '1 minute') AT TIME ZONE 'Asia/Taipei',
        (day::timestamp + last_minute * interval '1 minute') AT TIME ZONE 'Asia/Taipei'
      )) AS paid(period)
    ), proposed_conflict AS (
      SELECT following.day
      FROM (
        SELECT day, lower(period) AS starts_at, lag(upper(period)) OVER (ORDER BY period) AS previous_end
        FROM proposed
      ) AS following
      WHERE starts_at < previous_end
    )
    SELECT candidate.day INTO conflict_date
    FROM (
      SELECT day FROM proposed_conflict
      UNION ALL
      SELECT d.work_date
      FROM hr.roster_day AS d
      JOIN hr.roster_shift_segment AS s USING (roster_day_id)
      JOIN hr.roster_version AS v USING (version_id)
      WHERE d.employee_id = p_employee_id AND v.status = 'draft'
        AND d.work_date BETWEEN (SELECT min(day) - 1 FROM unnest(p_dates) AS day)
          AND (SELECT max(day) + 1 FROM unnest(p_dates) AS day)
        AND NOT (d.version_id IS NOT DISTINCT FROM draft_id AND d.work_date = ANY(p_dates))
        AND EXISTS (SELECT 1 FROM proposed WHERE
          hr.roster_paid_ranges(d.shift_code, d.work_date, s.starts_at, s.ends_at) && proposed.period)
    ) AS candidate ORDER BY candidate.day LIMIT 1;

    IF FOUND THEN
      RETURN jsonb_build_object('status', 409, 'error', '時段與 ' || to_char(conflict_date, 'YYYY-MM-DD') || ' 的班次重疊。');
    END IF;
  END IF;

  IF draft_id IS NULL THEN
    IF p_kind IS NULL THEN RETURN jsonb_build_object('revision', 0); END IF;
    INSERT INTO hr.roster_version (department_id, month_start, updated_by_employee_id)
    VALUES (p_unit_id, p_month, p_viewer_id)
    ON CONFLICT DO NOTHING;

    SELECT v.version_id, v.revision INTO draft_id, draft_revision FROM hr.roster_version AS v
    WHERE v.department_id = p_unit_id AND v.month_start = p_month AND v.status = 'draft'
    FOR UPDATE;
    IF NOT FOUND OR draft_revision <> p_revision THEN RETURN stale; END IF;
  END IF;

  DELETE FROM hr.roster_day WHERE version_id = draft_id AND employee_id = p_employee_id AND work_date = ANY(p_dates);
  IF p_kind IS NOT NULL THEN
    WITH added AS (
      INSERT INTO hr.roster_day (version_id, employee_id, work_date, day_kind, shift_code, note)
      SELECT draft_id, p_employee_id, day, p_kind, p_code, nullif(btrim(p_note), '')
      FROM unnest(p_dates) AS day
      RETURNING roster_day_id, work_date
    )
    INSERT INTO hr.roster_shift_segment (roster_day_id, segment_no, starts_at, ends_at)
    SELECT d.roster_day_id, row_number() OVER (PARTITION BY d.work_date ORDER BY part.first_minute),
      (d.work_date::timestamp + part.first_minute * interval '1 minute') AT TIME ZONE 'Asia/Taipei',
      (d.work_date::timestamp + part.last_minute * interval '1 minute') AT TIME ZONE 'Asia/Taipei'
    FROM added AS d CROSS JOIN unnest(p_starts, p_ends) AS part(first_minute, last_minute);
  END IF;
  UPDATE hr.roster_version
  SET revision = draft_revision + 1, updated_by_employee_id = p_viewer_id
  WHERE version_id = draft_id;
  RETURN jsonb_build_object('revision', draft_revision + 1);
END;
$$;

DO $permissions$
DECLARE
  principal name;
  principals text := 'PUBLIC';
BEGIN
  FOR principal IN SELECT rolname FROM pg_roles WHERE rolname IN (
    'hr_collector', 'anon', 'authenticated', 'service_role', 'hr_line_web_test', 'hr_line_web_tunnel', 'hr_web_pilot'
  ) LOOP
    principals := principals || ', ' || quote_ident(principal);
  END LOOP;
  EXECUTE 'REVOKE ALL ON hr.roster_shift_type, hr.roster_shift_type_segment FROM ' || principals;
  EXECUTE 'REVOKE ALL ON FUNCTION hr.roster_shift_options(), '
    'hr.roster_paid_ranges(text,date,timestamptz,timestamptz), '
    'hr.roster_draft_save(integer,integer,integer,date,integer,date[],text,integer[],integer[],text,text,boolean) FROM ' || principals;
END;
$permissions$;

RESET ROLE;
