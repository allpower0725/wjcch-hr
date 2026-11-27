import "server-only"

import { queryCloudPilot } from "./cloud-pilot-db"
import { currentLineTestIdentity } from "./line-test-db"
import { rosterPool, rosterSessionHash, type RosterMode } from "./roster-db"
import type { ApprovalFailure, ApprovalRequest } from "./roster-approval"

export async function rosterApproval<T>(mode: RosterMode, request: ApprovalRequest, expectedEmployeeNo?: string): Promise<T | ApprovalFailure> {
  const hash = await rosterSessionHash(mode)
  if (!hash) return { status: 401, error: "請重新登入。" }
  const dueDay = Number(process.env.HR_ROSTER_SUBMISSION_DAY ?? "25")
  if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) {
    return { status: 503, error: "班表截止日設定有誤。" }
  }

  const params = [hash, JSON.stringify(request), dueDay]
  if (mode === "cloud-pilot") {
    const row = await queryCloudPilot<{ body: T | ApprovalFailure }>(
      "SELECT hr.roster_web_pilot_approval($1, $2::jsonb, $3) AS body", params,
    )
    return row?.body ?? { status: 401, error: "請重新登入。" }
  }
  const pool = rosterPool(mode)
  const employeeNo = expectedEmployeeNo ?? (await currentLineTestIdentity(mode))?.employee.employeeNo
  if (!employeeNo) return { status: 401, error: "請重新登入。" }
  const localParams = [...params, employeeNo]
  const sql = `
    SELECT hr.roster_approval_request(i.employee_id, $2::jsonb, $3) AS body
    FROM hr.line_login_identity($1::bytea) AS i
    JOIN hr.employee AS e USING (employee_id) WHERE e.employee_no = $4
  `
  if (request.action === "state" || request.action === "queue" || request.action === "detail") {
    const { rows: [row] } = await pool.query<{ body: T | ApprovalFailure }>(sql, localParams)
    return row?.body ?? { status: 401, error: "請重新登入。" }
  }

  const db = await pool.connect()
  try {
    await db.query("BEGIN READ WRITE")
    const { rows: [row] } = await db.query<{ body: T | ApprovalFailure }>(sql, localParams)
    await db.query("COMMIT")
    return row?.body ?? { status: 401, error: "請重新登入。" }
  } catch (error) {
    await db.query("ROLLBACK")
    throw error
  } finally {
    db.release()
  }
}
