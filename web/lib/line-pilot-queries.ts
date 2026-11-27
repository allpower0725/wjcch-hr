// All operations bind the verified provider, LINE subject and pilot employee number before the session token.
export const linePilotQueries = {
  begin: `
    WITH approved AS MATERIALIZED (
      SELECT $1::text AS provider_id, $2::text AS line_user_id
      FROM hr.employee AS e
      WHERE e.employee_no = $3 AND e.employment_status IN ('active', 'on_leave')
        AND NOT EXISTS (
          SELECT 1 FROM hr.employee_line_binding AS b
          WHERE b.revoked_at IS NULL
            AND (b.employee_id = e.employee_id OR (b.provider_id = $1 AND b.line_user_id = $2))
            AND NOT (b.employee_id = e.employee_id AND b.provider_id = $1 AND b.line_user_id = $2)
        )
    )
    SELECT opened.* FROM approved
    CROSS JOIN LATERAL hr.begin_line_login(approved.provider_id, approved.line_user_id, $4::bytea) AS opened`,

  match: `
    WITH pending AS MATERIALIZED (
      SELECT s.token_hash FROM hr.line_login_session AS s
      WHERE s.pending_provider_id = $1 AND s.pending_line_user_id = $2 AND s.token_hash = $4
    ), candidate AS MATERIALIZED (
      SELECT e.employee_no, e.name, e.department_id, e.national_id FROM hr.employee AS e
      WHERE e.employee_no = $3 AND e.national_id = $5
    )
    SELECT checked.*, candidate.employee_no, candidate.name AS employee_name, d.name AS department
    FROM pending CROSS JOIN LATERAL hr.verify_line_employee(
      pending.token_hash, (SELECT national_id FROM candidate), $6::date
    ) AS checked
    LEFT JOIN candidate ON checked.outcome = 'matched'
    LEFT JOIN hr.department AS d ON d.department_id = candidate.department_id`,

  confirm: `
    WITH pending AS MATERIALIZED (
      SELECT s.token_hash FROM hr.line_login_session AS s
      WHERE s.pending_provider_id = $1 AND s.pending_line_user_id = $2 AND s.token_hash = $4
        AND (s.matched_employee_id IS NULL OR EXISTS (
          SELECT 1 FROM hr.employee AS e WHERE e.employee_no = $3 AND e.employee_id = s.matched_employee_id
        ))
    )
    SELECT hr.confirm_line_binding(pending.token_hash, $5::bytea) AS outcome FROM pending`,

  identity: `
    SELECT e.employee_no, e.name AS employee_name, d.name AS department,
      hr.has_system_admin_grant(e.employee_id) AS is_admin
    FROM hr.line_login_identity($4) AS identity
    JOIN hr.employee AS e ON e.employee_id = identity.employee_id
    JOIN hr.department AS d ON d.department_id = e.department_id
    JOIN hr.line_login_session AS s ON s.token_hash = $4
    JOIN hr.employee_line_binding AS b ON b.binding_id = s.binding_id
    WHERE b.provider_id = $1 AND b.line_user_id = $2 AND e.employee_no = $3`,

  end: `
    DELETE FROM hr.line_login_session AS s WHERE s.token_hash = $4
      AND ((s.pending_provider_id = $1 AND s.pending_line_user_id = $2) OR EXISTS (
        SELECT 1 FROM hr.employee_line_binding AS b JOIN hr.employee AS e USING (employee_id)
        WHERE b.binding_id = s.binding_id AND b.provider_id = $1 AND b.line_user_id = $2 AND e.employee_no = $3
      ))`,
}
