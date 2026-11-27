import "server-only"

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { cookies } from "next/headers"
import { Pool } from "pg"
import { lineTestSession, lineWebTokenHash, type LineTestMode } from "./line-test-db"
import { rosterWorkspaceQuery } from "./roster-queries"

export type RosterMode = Exclude<LineTestMode, "cloud">

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
  return mode === "local" || mode === "tunnel" || mode === "pilot"
}

export async function rosterSessionHash() {
  return lineWebTokenHash((await cookies()).get(lineTestSession)?.value)
}

export function rosterPool(mode: RosterMode) {
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

export function rosterWorkspaceParams(mode: RosterMode, hash: Buffer, employeeNo: string, unitId: number | null) {
  return [hash, employeeNo, unitId, mode === "pilot" ? 1 : null]
}

export async function readRosterWorkspace(mode: RosterMode, employeeNo: string, unitId: number | null) {
  const hash = await rosterSessionHash()
  if (!hash) return
  const params = rosterWorkspaceParams(mode, hash, employeeNo, unitId)
  return (await rosterPool(mode).query<RosterWorkspace>(rosterWorkspaceQuery, params)).rows[0]
}
