import "server-only"

import type { Pool, PoolClient } from "pg"
import { rosterPool, rosterSessionHash, rosterWorkspaceParams, type RosterDraftMode, type RosterWorkspace } from "./roster-db"
import { rosterIntervals, rosterSegmentError, type RosterDraft, type RosterEdit } from "./roster-draft"
import { rosterWorkspaceQuery } from "./roster-queries"

async function draftsAvailable(db: Pool | PoolClient) {
  const { rows: [state] } = await db.query<{ available: boolean }>(`
    SELECT to_regclass('hr.roster_version') IS NOT NULL
      AND to_regclass('hr.roster_day') IS NOT NULL
      AND to_regclass('hr.roster_shift_segment') IS NOT NULL AS available
  `)
  return state.available
}

export async function readRosterDraft(mode: RosterDraftMode, employeeNo: string, unitId: number, month: string) {
  const hash = await rosterSessionHash(mode)
  if (!hash) return
  const database = rosterPool(mode)
  if (!await draftsAvailable(database)) return

  const { rows: [draft] } = await database.query<RosterDraft>(`
    WITH scope AS (${rosterWorkspaceQuery}),
    selected AS (
      SELECT scope."selectedUnitId" AS department_id, v.revision
      FROM scope
      LEFT JOIN hr.roster_version AS v
        ON v.department_id = scope."selectedUnitId" AND v.month_start = $5 AND v.status = 'draft'
      WHERE scope."selectedUnitId" = $3
    )
    SELECT COALESCE(selected.revision, 0) AS revision, COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'employeeId', d.employee_id,
        'date', to_char(d.work_date, 'YYYY-MM-DD'),
        'kind', d.day_kind,
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
        AND d.work_date >= $5::date - 7
        AND d.work_date < ($5::date + interval '1 month')::date + 7
        AND EXISTS (
        SELECT 1 FROM scope CROSS JOIN LATERAL jsonb_array_elements(scope.people) AS person
        WHERE (person->>'employeeId')::integer = d.employee_id
      )
    ), '[]'::jsonb) AS days
    FROM selected
  `, [...rosterWorkspaceParams(mode, hash, employeeNo, unitId), month + "-01"])
  return draft
}

type SaveResult = { revision: number } | { status: number; error: string }
const stale = { status: 409, error: "這個月的草稿已更新。請重新載入班表，再核對要儲存的日期。" }

export async function saveRosterDraft(mode: RosterDraftMode, employeeNo: string, edit: RosterEdit): Promise<SaveResult> {
  const hash = await rosterSessionHash(mode)
  if (!hash) return { status: 401, error: "請重新登入。" }
  const intervals = edit.entry?.kind === "work" ? rosterIntervals(edit.dates, edit.entry.segments) : []
  const error = edit.entry?.kind === "work" && rosterSegmentError(edit.entry.segments)
  if (error) return { status: 422, error }
  if (intervals.some((segment, index) => index > 0 && segment.starts_at < intervals[index - 1].ends_at)) {
    return { status: 422, error: "這次選取的日期之間有班次時段重疊。" }
  }

  const db = await rosterPool(mode).connect()
  let committed = false
  try {
    await db.query("BEGIN READ WRITE")
    if (!await draftsAvailable(db)) return { status: 503, error: "草稿儲存目前尚未啟用。" }
    const scopeParams = rosterWorkspaceParams(mode, hash, employeeNo, edit.unitId)
    const { rows: [scope] } = await db.query<RosterWorkspace>(rosterWorkspaceQuery, scopeParams)
    if (!scope?.selectedUnitId || !scope.people.some((person) => person.employeeId === edit.employeeId)) {
      return { status: 403, error: "這位人員超出目前的排班範圍。" }
    }

    // Serialize writes for the same employee across unit and month boundaries.
    await db.query("SELECT pg_advisory_xact_lock(8291, $1::integer)", [edit.employeeId])
    const versionParams = [edit.unitId, edit.month + "-01"]
    if (edit.entry && edit.revision === 0) {
      await db.query(`
        INSERT INTO hr.roster_version (department_id, month_start, updated_by_employee_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (department_id, month_start) WHERE status = 'draft' DO NOTHING
      `, [...versionParams, scope.viewerId])
    }
    const { rows: [version] } = await db.query<{ version_id: string; revision: number }>(`
      SELECT version_id, revision FROM hr.roster_version
      WHERE department_id = $1 AND month_start = $2 AND status = 'draft'
      FOR UPDATE
    `, versionParams)
    if ((version?.revision ?? 0) !== edit.revision) return stale
    if (!version) return { revision: 0 }

    if (intervals.length) {
      const { rows: [conflict] } = await db.query<{ date: string }>(`
        SELECT to_char(d.work_date, 'YYYY-MM-DD') AS date
        FROM hr.roster_day AS d
        JOIN hr.roster_shift_segment AS s USING (roster_day_id)
        JOIN hr.roster_version AS v USING (version_id)
        WHERE d.employee_id = $1 AND v.status = 'draft'
          AND NOT (d.version_id = $2 AND d.work_date = ANY($3::date[]))
          AND EXISTS (
            SELECT 1 FROM jsonb_to_recordset($4) AS proposed(starts_at timestamptz, ends_at timestamptz)
            WHERE proposed.starts_at < s.ends_at AND s.starts_at < proposed.ends_at
          )
        ORDER BY d.work_date LIMIT 1
      `, [edit.employeeId, version.version_id, edit.dates, JSON.stringify(intervals)])
      if (conflict) return { status: 409, error: `時段與 ${conflict.date} 的既有班次重疊。` }
    }

    const newRevision = version.revision + 1
    const datesParams = [version.version_id, edit.employeeId, edit.dates]
    await db.query(`
      DELETE FROM hr.roster_day
      WHERE version_id = $1 AND employee_id = $2 AND work_date = ANY($3::date[])
    `, datesParams)
    if (edit.entry) {
      await db.query(`
        WITH added AS (
          INSERT INTO hr.roster_day (version_id, employee_id, work_date, day_kind)
          SELECT $1, $2, date, $4 FROM unnest($3::date[]) AS date
          RETURNING roster_day_id, work_date
        )
        INSERT INTO hr.roster_shift_segment (roster_day_id, segment_no, starts_at, ends_at)
        SELECT d.roster_day_id, row_number() OVER (PARTITION BY d.work_date ORDER BY s.starts_at),
          s.starts_at, s.ends_at
        FROM added AS d
        JOIN jsonb_to_recordset($5) AS s(work_date date, starts_at timestamptz, ends_at timestamptz)
          ON s.work_date = d.work_date
      `, [...datesParams, edit.entry.kind, JSON.stringify(intervals)])
    }
    await db.query(`
      UPDATE hr.roster_version SET revision = $2, updated_by_employee_id = $3 WHERE version_id = $1
    `, [version.version_id, newRevision, scope.viewerId])
    await db.query("COMMIT")
    committed = true
    return { revision: newRevision }
  } finally {
    try {
      if (!committed) await db.query("ROLLBACK")
      db.release()
    } catch {
      db.release(true)
    }
  }
}
