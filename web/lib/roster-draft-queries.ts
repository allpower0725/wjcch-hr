export function rosterDraftQuery(scope: string, unit: string, month: string) {
  return `
    WITH scope AS (${scope}),
    selected AS (
      SELECT scope."selectedUnitId" AS department_id, v.revision
      FROM scope
      LEFT JOIN hr.roster_version AS v
        ON v.department_id = scope."selectedUnitId" AND v.month_start = ${month} AND v.status = 'draft'
      WHERE scope."selectedUnitId" = ${unit}
    )
    SELECT COALESCE(selected.revision, 0) AS revision, COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'employeeId', d.employee_id,
        'date', to_char(d.work_date, 'YYYY-MM-DD'),
        'kind', d.day_kind,
        'code', coalesce(d.shift_code, CASE d.day_kind WHEN 'work' THEN 'X' ELSE 'OFF' END),
        'note', d.note,
        'segments', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'start', to_char(s.starts_at AT TIME ZONE 'Asia/Taipei', 'HH24:MI'),
            'end', to_char(s.ends_at AT TIME ZONE 'Asia/Taipei', 'HH24:MI'),
            'startNextDay', (s.starts_at AT TIME ZONE 'Asia/Taipei')::date > d.work_date,
            'endNextDay', (s.ends_at AT TIME ZONE 'Asia/Taipei')::date > d.work_date
          ) ORDER BY s.segment_no)
          FROM hr.roster_shift_segment AS s WHERE s.roster_day_id = d.roster_day_id
        ), '[]'::jsonb)
      ) ORDER BY d.work_date)
      FROM hr.roster_day AS d
      JOIN hr.roster_version AS v USING (version_id)
      WHERE v.department_id = selected.department_id AND v.status = 'draft'
        AND d.work_date >= ${month}::date - 7
        AND d.work_date < (${month}::date + interval '1 month')::date + 7
        AND EXISTS (
        SELECT 1 FROM scope CROSS JOIN LATERAL jsonb_array_elements(scope.people) AS person
        WHERE (person->>'employeeId')::integer = d.employee_id
      )
    ), '[]'::jsonb) AS days
    FROM selected
  `
}
