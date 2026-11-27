import "server-only"

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { cookies } from "next/headers"
import { Pool } from "pg"
import { queryCloudPilot } from "./cloud-pilot-db"
import { lineCookieNames, lineWebTokenHash, type LineTestMode } from "./line-test-db"
import { rosterWorkspaceQuery } from "./roster-queries"

export type RosterMode = Exclude<LineTestMode, "cloud">
export type RosterDraftMode = Exclude<RosterMode, "cloud-pilot">

export type RosterUnit = { id: number; name: string; label: string }
export type RosterPerson = { employeeId: number; employeeNo: string; name: string; jobTitle: string | null }

export type RosterWorkspace = {
  viewerId: number
  units: RosterUnit[]
  selectedUnitId: number | null
  people: RosterPerson[]
}

const shared = globalThis as typeof globalThis & { hrRosterPools?: Record<string, Pool> }

export function isRosterMode(mode: LineTestMode | undefined): mode is RosterMode {
  return mode === "cloud-pilot" || isRosterDraftMode(mode)
}

export function isRosterDraftMode(mode: LineTestMode | undefined): mode is RosterDraftMode {
  return mode === "local" || mode === "tunnel" || mode === "pilot"
}

export function canUseRosterDrafts(mode: LineTestMode | undefined): mode is RosterMode {
  return isRosterDraftMode(mode) || (mode === "cloud-pilot" && process.env.HR_ROSTER_CLOUD_DRAFTS === "1")
}

export async function rosterSessionHash(mode: RosterMode) {
  return lineWebTokenHash((await cookies()).get(lineCookieNames(mode).session)?.value)
}

export function rosterPool(mode: RosterDraftMode) {
  const database = mode === "pilot" ? "wjcch_db" : "wjcch_db_test"
  const pools = shared.hrRosterPools ??= {}
  return pools[database] ??= new Pool({
    host: "127.0.0.1",
    port: 5432,
    database,
    user: "hr",
    password: async () => (await readFile(resolve("../.local/database/secrets/hr_local_password"), "utf8")).trim(),
    options: "-c default_transaction_read_only=on",
    max: 3,
    connectionTimeoutMillis: 4000,
    statement_timeout: 5000,
  }).on("error", () => { console.error("Roster database connection interrupted") })
}

export function rosterWorkspaceParams(mode: RosterDraftMode, hash: Buffer, employeeNo: string, unitId: number | null) {
  return [hash, employeeNo, unitId, mode === "pilot" ? 1 : null]
}

export async function readRosterWorkspace(mode: RosterMode, employeeNo: string, unitId: number | null) {
  const hash = await rosterSessionHash(mode)
  if (!hash) return
  if (mode === "cloud-pilot") {
    return queryCloudPilot<RosterWorkspace>("SELECT * FROM hr.roster_web_pilot_workspace($1, $2)", [hash, unitId])
  }
  const params = rosterWorkspaceParams(mode, hash, employeeNo, unitId)
  return (await rosterPool(mode).query<RosterWorkspace>(rosterWorkspaceQuery, params)).rows[0]
}
