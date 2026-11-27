import "server-only"

import { createHash, randomBytes } from "node:crypto"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { cookies } from "next/headers"
import { Pool, type QueryResultRow } from "pg"
import { cloudPilotEnabled, isApprovedCloudPilotSubject, queryCloudPilot } from "./cloud-pilot-db"
import { linePilotQueries } from "./line-pilot-queries"
import { isLocalPrototypeHost, localLineTunnelOrigin } from "./prototype-host"

export type LineTestMode = "local" | "tunnel" | "cloud" | "pilot" | "cloud-pilot"

export function lineCookieNames(mode: LineTestMode) {
  return mode === "cloud-pilot"
    ? { session: "__Host-hr_line_pilot_session", binding: "__Host-hr_line_pilot_binding" }
    : { session: "hr_line_test_session", binding: "hr_line_test_binding" }
}

export function isLinePilot(mode: LineTestMode | undefined) {
  return mode === "pilot" || mode === "cloud-pilot"
}

const cloudHost = "wjcch-hr-liff-test.vercel.app"
const cloudDatabase = "HR_LINE_CLOUD_TEST_DATABASE_URL"
const cloudProject = "zakixjdjnwetrvhsqsyg"
const cloudCertificate = "HR_LINE_CLOUD_TEST_CA"
const pilotProvider = "2005826039"
const pilotEmployee = "P271"

export function localLineTestEnabled(host: string | null) {
  return process.env.HR_LINE_TEST === "1" && isLocalPrototypeHost(host)
}

export function lineTestMode(headers: Pick<Headers, "get">): LineTestMode | undefined {
  const host = headers.get("host")
  if (localLineTestEnabled(host)) return "local"
  if (cloudPilotEnabled(host)) return "cloud-pilot"
  if (host === cloudHost && process.env.VERCEL === "1" && process.env[cloudDatabase]) return "cloud"
  if (host && localLineTunnelOrigin() === `https://${host}`
    && headers.get("x-forwarded-proto")?.split(",").at(-1)?.trim() === "https") {
    return process.env.HR_LINE_PILOT === "1" ? "pilot" : "tunnel"
  }
}

type ExistingLineMode = Exclude<LineTestMode, "cloud-pilot">

function makePool(mode: ExistingLineMode) {
  const options = { max: 3, connectionTimeoutMillis: 4000, statement_timeout: 5000 }
  if (mode === "cloud") {
    const config = new URL(process.env[cloudDatabase] ?? "")
    const user = decodeURIComponent(config.username)
    if (user !== `hr_line_web_test.${cloudProject}` || config.protocol !== "postgresql:" || config.pathname !== "/postgres"
      || !config.hostname.endsWith(".pooler.supabase.com") || !config.password || config.port !== "6543") {
      throw new Error("Unexpected cloud test database configuration")
    }
    const ca = process.env[cloudCertificate]?.trim()
    if (!ca) throw new Error("Cloud test database CA is missing")
    return new Pool({ ...options, host: config.hostname, port: 6543, database: "postgres", user,
      password: decodeURIComponent(config.password), ssl: { ca, rejectUnauthorized: true } })
      .on("error", () => { console.error("Cloud LINE test database connection interrupted") })
  }

  const user = mode === "pilot" ? "hr" : mode === "tunnel" ? "hr_line_web_tunnel" : "hr_line_web_test"
  const passwordFile = mode === "pilot" ? "hr_local_password" : `${user}_password`
  return new Pool({
    ...options,
    host: "127.0.0.1", port: 5432, database: mode === "pilot" ? "wjcch_db" : "wjcch_db_test", user,
    password: async () => (await readFile(resolve(`../.local/database/secrets/${passwordFile}`), "utf8")).trim(),
  }).on("error", () => { console.error("Local LINE test database connection interrupted") })
}

const shared = globalThis as typeof globalThis & { hrLineTestPools?: Partial<Record<ExistingLineMode, Pool>> }

type EmployeeRow = { employee_no: string; employee_name: string; department: string }
type IdentityRow = EmployeeRow & { is_admin?: boolean }
type BindingRow = { outcome: string; deadline: Date | null; attempts_remaining: number | null }
type MatchRow = BindingRow & Partial<EmployeeRow>

async function query<T extends QueryResultRow>(mode: ExistingLineMode, sql: string, params: unknown[]) {
  const pools = shared.hrLineTestPools ??= {}
  const pool = pools[mode] ??= makePool(mode)
  return (await pool.query<T>(sql, params)).rows[0] as T | undefined
}

async function pilotSubject() {
  const value = (await readFile(resolve("../.local/database/secrets/hr_line_pilot_subject"), "utf8")).trim()
  if (!/^U[0-9a-fA-F]{32}$/.test(value)) throw new Error("Invalid LINE pilot subject configuration")
  return value
}

async function pilotQuery<T extends QueryResultRow>(sql: string, params: unknown[]) {
  return query<T>("pilot", sql, [pilotProvider, await pilotSubject(), pilotEmployee, ...params])
}

export function newLineWebToken() {
  const value = randomBytes(32).toString("base64url")
  return { value, hash: createHash("sha256").update(value).digest() }
}

export function lineWebTokenHash(value: string | undefined) {
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? createHash("sha256").update(value).digest() : undefined
}

export async function openLineTest(mode: LineTestMode, subject: string, hash: Buffer) {
  if (mode === "cloud-pilot") {
    if (!isApprovedCloudPilotSubject(subject)) return { outcome: "pilot_denied", deadline: null, attempts_remaining: null }
    return await queryCloudPilot<BindingRow>("SELECT * FROM hr.line_web_pilot_begin($1, $2)", [subject, hash])
      ?? { outcome: "ineligible", deadline: null, attempts_remaining: null }
  }
  if (mode === "pilot") {
    const approved = await pilotSubject()
    if (subject !== approved) return { outcome: "pilot_denied", deadline: null, attempts_remaining: null }
    return await query<BindingRow>(mode, linePilotQueries.begin, [pilotProvider, approved, pilotEmployee, hash])
      ?? { outcome: "ineligible", deadline: null, attempts_remaining: null }
  }
  return query<BindingRow>(mode, "SELECT * FROM hr.line_web_test_begin($1, $2)", [subject, hash])
}

export async function matchLineTest(mode: LineTestMode, hash: Buffer, documentNo: string, birthDate: string): Promise<MatchRow | undefined> {
  if (mode === "cloud-pilot") {
    return await queryCloudPilot<MatchRow>("SELECT * FROM hr.line_web_pilot_match($1, $2, $3::date)", [hash, documentNo, birthDate])
      ?? { outcome: "expired", deadline: null, attempts_remaining: null }
  }
  if (mode === "pilot") {
    return await pilotQuery<MatchRow>(linePilotQueries.match, [hash, documentNo, birthDate])
      ?? { outcome: "expired", deadline: null, attempts_remaining: null }
  }
  return query<MatchRow>(mode, "SELECT * FROM hr.line_web_test_match($1, $2, $3::date)", [hash, documentNo, birthDate])
}

export async function confirmLineTest(mode: LineTestMode, pendingHash: Buffer, loginHash: Buffer) {
  if (mode === "cloud-pilot") {
    return await queryCloudPilot<{ outcome: string }>("SELECT hr.line_web_pilot_confirm($1, $2) AS outcome", [pendingHash, loginHash])
      ?? { outcome: "expired" }
  }
  if (mode === "pilot") {
    return await pilotQuery<{ outcome: string }>(linePilotQueries.confirm, [pendingHash, loginHash]) ?? { outcome: "expired" }
  }
  return query<{ outcome: string }>(mode, "SELECT hr.line_web_test_confirm($1, $2) AS outcome", [pendingHash, loginHash])
}

export async function endLineTest(mode: LineTestMode, hash: Buffer | undefined) {
  if (!hash) return
  if (mode === "cloud-pilot") await queryCloudPilot("SELECT hr.line_web_pilot_end($1)", [hash])
  else if (mode === "pilot") await pilotQuery(linePilotQueries.end, [hash])
  else await query(mode, "SELECT hr.line_web_test_end($1)", [hash])
}

export async function currentLineTestIdentity(mode: LineTestMode) {
  const hash = lineWebTokenHash((await cookies()).get(lineCookieNames(mode).session)?.value)
  if (!hash) return
  const employee = mode === "cloud-pilot" ? await queryCloudPilot<IdentityRow>("SELECT * FROM hr.line_web_pilot_identity($1)", [hash])
    : mode === "pilot" ? await pilotQuery<IdentityRow>(linePilotQueries.identity, [hash])
    : await query<IdentityRow>(mode, mode === "local"
      ? "SELECT i.*, hr.line_web_local_admin_status($1) AS is_admin FROM hr.line_web_test_identity($1) AS i"
      : "SELECT * FROM hr.line_web_test_identity($1)", [hash])
  if (!employee) return
  const isAdmin = employee.is_admin === true

  return { employee: {
    employeeNo: employee.employee_no, name: employee.employee_name, department: employee.department,
    role: isAdmin ? "admin" as const : "employee" as const, scope: isAdmin ? "全院單位" : "本人",
  } }
}
