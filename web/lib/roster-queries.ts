export const rosterWorkspaceQuery = `
  WITH RECURSIVE viewer AS (
    SELECT e.employee_id, e.department_id, e.employment_status,
      hr.has_system_admin_grant(e.employee_id) AS is_admin
    FROM hr.line_login_identity($1::bytea) AS session
    JOIN hr.employee AS e USING (employee_id)
    WHERE e.employee_no = $2
  ), organization AS (
    SELECT d.department_id, d.name, ARRAY[d.department_id] AS path_ids,
      ARRAY[d.name::text] AS path_names,
      ARRAY[d.sort_order::integer, d.department_id] AS path_order
    FROM hr.department AS d
    WHERE d.parent_id IS NULL AND d.is_active
      AND ($4::integer IS NULL OR d.department_id = $4)

    UNION ALL

    SELECT d.department_id, d.name, o.path_ids || d.department_id,
      o.path_names || d.name::text, o.path_order || ARRAY[d.sort_order::integer, d.department_id]
    FROM organization AS o
    JOIN hr.department AS d ON d.parent_id = o.department_id
    WHERE d.is_active
  ), management_roots AS (
    SELECT m.department_id
    FROM hr.department_manager AS m
    JOIN viewer AS v USING (employee_id)
    CROSS JOIN (SELECT (statement_timestamp() AT TIME ZONE 'Asia/Taipei')::date AS today) AS calendar
    WHERE ((m.department_id = 1 AND m.role IN ('head', 'deputy'))
        OR (m.department_id <> 1 AND m.role IN ('head', 'acting')))
      AND (m.start_date IS NULL OR m.start_date <= calendar.today)
      AND (m.end_date IS NULL OR m.end_date >= calendar.today)
  ), scoped AS (
    SELECT o.*, v.department_id AS home_department_id,
      v.employment_status = 'active' AND o.department_id = v.department_id AS is_own_unit,
      v.is_admin OR EXISTS (
        SELECT 1 FROM management_roots AS m WHERE m.department_id = ANY(o.path_ids)
      ) AS manages_unit
    FROM organization AS o CROSS JOIN viewer AS v
  ), units AS (
    SELECT s.*
    FROM scoped AS s
    WHERE (s.manages_unit OR s.is_own_unit)
      AND EXISTS (
        SELECT 1 FROM hr.employee AS e
        WHERE e.department_id = s.department_id AND e.employment_status = 'active'
      )
  ), selected AS (
    SELECT u.*
    FROM units AS u
    WHERE $3::integer IS NULL OR u.department_id = $3
    ORDER BY (u.department_id = u.home_department_id) DESC, u.path_order
    LIMIT 1
  )
  SELECT
    v.employee_id AS "viewerId",
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', u.department_id,
        'name', u.name,
        'label', COALESCE(NULLIF(array_to_string(u.path_names[2:], '／'), ''), u.name)
      ) ORDER BY u.path_order)
      FROM units AS u
    ), '[]'::jsonb) AS units,
    (SELECT s.department_id FROM selected AS s) AS "selectedUnitId",
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'employeeId', e.employee_id, 'employeeNo', e.employee_no, 'name', e.name, 'jobTitle', title.name
      ) ORDER BY e.employee_no)
      FROM selected AS s
      JOIN hr.employee AS e ON e.department_id = s.department_id
      LEFT JOIN hr.job_title AS title USING (job_title_id)
      WHERE e.employment_status = 'active'
        AND (s.manages_unit OR e.employee_id = v.employee_id)
    ), '[]'::jsonb) AS people
  FROM viewer AS v
`
