import "server-only"

import { queryCloudPilot } from "./cloud-pilot-db"
import { rosterPool, rosterSessionHash, rosterWorkspaceParams, type RosterDraftMode, type RosterMode, type RosterWorkspace } from "./roster-db"
import { rosterDraftQuery } from "./roster-draft-queries"
import { rosterMinutes, type RosterDraft, type RosterEdit, type RosterShiftType } from "./roster-draft"
import { rosterWorkspaceQuery } from "./roster-queries"

type StoredDraft = Pick<RosterDraft, "revision" | "days">
type SaveResult = { revision: number } | { status: number; error: string }
const unavailable = { status: 503, error: "草稿儲存目前尚未啟用。" }

export async function readRosterDraft(mode: RosterMode, employeeNo: string, unitId: number, month: string): Promise<RosterDraft | undefined> {
  const hash = await rosterSessionHash(mode)
  if (!hash) return
  if (mode === "cloud-pilot") {
    const [draft, options] = await Promise.all([
      queryCloudPilot<StoredDraft>("SELECT * FROM hr.roster_web_pilot_draft_read($1, $2, $3::date)", [hash, unitId, month + "-01"]),
      queryCloudPilot<{ shifts: RosterShiftType[] }>("SELECT hr.roster_web_pilot_shift_options($1, $2) AS shifts", [hash, unitId]),
    ])
    if (draft && options?.shifts) return { ...draft, shifts: options.shifts }
    return
  }
  const database = rosterPool(mode)
  const { rows: [state] } = await database.query<{ available: boolean }>(
    "SELECT to_regclass('hr.roster_shift_type') IS NOT NULL AS available",
  )
  if (!state.available) return

  const { rows: [draft] } = await database.query<RosterDraft>(`
    SELECT draft.*, hr.roster_shift_options() AS shifts
    FROM (${rosterDraftQuery(rosterWorkspaceQuery, "$3", "$5")}) AS draft
  `, [...rosterWorkspaceParams(mode, hash, employeeNo, unitId), month + "-01"])
  return draft
}

function draftWriteParams(edit: RosterEdit) {
  const segments = edit.entry?.segments ?? []
  return [
    edit.unitId, edit.employeeId, edit.month + "-01", edit.revision, edit.dates, edit.entry?.kind ?? null,
    segments.map((segment) => rosterMinutes(segment.start, segment.startNextDay)),
    segments.map((segment) => rosterMinutes(segment.end, segment.endNextDay)),
    edit.legacy ? null : edit.entry?.code ?? null, edit.entry?.note ?? null,
  ]
}

export async function saveCloudRosterDraft(edit: RosterEdit): Promise<SaveResult> {
  const hash = await rosterSessionHash("cloud-pilot")
  if (!hash) return { status: 401, error: "請重新登入。" }
  const saved = await queryCloudPilot<{ result: SaveResult }>(
    "SELECT hr.roster_web_pilot_draft_save($1, $2, $3, $4::date, $5, $6::date[], $7, $8::integer[], $9::integer[], $10, $11) AS result",
    [hash, ...draftWriteParams(edit)],
  )
  return saved?.result ?? unavailable
}

export async function saveRosterDraft(mode: RosterDraftMode, employeeNo: string, edit: RosterEdit): Promise<SaveResult> {
  const hash = await rosterSessionHash(mode)
  if (!hash) return { status: 401, error: "請重新登入。" }
  const db = await rosterPool(mode).connect()
  let committed = false
  try {
    await db.query("BEGIN READ WRITE")
    const { rows: [scope] } = await db.query<RosterWorkspace>(
      rosterWorkspaceQuery, rosterWorkspaceParams(mode, hash, employeeNo, edit.unitId),
    )
    if (!scope?.selectedUnitId || !scope.people.some((person) => person.employeeId === edit.employeeId)) {
      return { status: 403, error: "這位人員超出目前的排班範圍。" }
    }

    const { rows: [{ result }] } = await db.query<{ result: SaveResult }>(
      "SELECT hr.roster_draft_save($1, $2, $3, $4::date, $5, $6::date[], $7, $8::integer[], $9::integer[], $10, $11, $12) AS result",
      [scope.viewerId, ...draftWriteParams(edit), Boolean(edit.legacy)],
    )
    if ("status" in result) return result
    await db.query("COMMIT")
    committed = true
    return result
  } finally {
    try {
      if (!committed) await db.query("ROLLBACK")
      db.release()
    } catch {
      db.release(true)
    }
  }
}
