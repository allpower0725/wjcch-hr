import "server-only"

import { createHash } from "node:crypto"
import { Pool, type QueryResultRow } from "pg"

const projectRef = "tbulauezaixdjzdcqsem"
const runtimeRole = "hr_web_pilot"
const shared = globalThis as typeof globalThis & { hrCloudPilotPool?: Pool }

export function cloudPilotEnabled(host: string | null) {
  return process.env.VERCEL === "1" && process.env.VERCEL_ENV === "production"
    && Boolean(host && host === process.env.HR_LINE_PILOT_HOST?.trim())
    && Boolean(process.env.HR_LINE_PILOT_DATABASE_URL && process.env.HR_LINE_PILOT_DATABASE_CA)
    && /^[a-f0-9]{64}$/.test(process.env.HR_LINE_PILOT_SUBJECT_SHA256 ?? "")
    && Boolean(process.env.LINE_LIFF_ID && process.env.LINE_LOGIN_CHANNEL_ID)
}

export function isApprovedCloudPilotSubject(subject: string) {
  return createHash("sha256").update(subject).digest("hex") === process.env.HR_LINE_PILOT_SUBJECT_SHA256
}

function makeCloudPilotPool() {
  const url = new URL(process.env.HR_LINE_PILOT_DATABASE_URL ?? "")
  if (url.protocol !== "postgresql:" || url.pathname !== "/postgres" || !url.password || url.port !== "6543"
    || !/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname)
    || decodeURIComponent(url.username) !== `${runtimeRole}.${projectRef}`) {
    throw new Error("Unexpected cloud pilot database configuration")
  }
  const ca = process.env.HR_LINE_PILOT_DATABASE_CA?.trim()
  if (!ca) throw new Error("Cloud pilot database CA is missing")

  return new Pool({
    host: url.hostname,
    port: Number(url.port),
    database: "postgres",
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    ssl: { ca, rejectUnauthorized: true },
    max: 2,
    connectionTimeoutMillis: 4000,
    statement_timeout: 5000,
  }).on("error", () => { console.error("Cloud pilot database connection interrupted") })
}

export async function queryCloudPilot<T extends QueryResultRow>(sql: string, params: unknown[]) {
  const pool = shared.hrCloudPilotPool ??= makeCloudPilotPool()
  return (await pool.query<T>(sql, params)).rows[0] as T | undefined
}
