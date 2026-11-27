export type RosterSegment = {
  start: string
  end: string
  startNextDay: boolean
  endNextDay: boolean
}

export type RosterEntry = { code: string; note: string | null } &
  ({ kind: "work"; segments: RosterSegment[] } | { kind: "off"; segments: [] })
export type RosterDay = RosterEntry & { employeeId: number; date: string }
export type RosterShiftType = {
  code: string
  name: string
  kind: RosterEntry["kind"]
  legacy: boolean
  defaults: { start: number; end: number }[]
}
export type RosterDraft = { revision: number; days: RosterDay[]; shifts: RosterShiftType[] }

export type RosterEdit = {
  unitId: number
  employeeId: number
  month: string
  dates: string[]
  revision: number
  entry: RosterEntry | null
  legacy?: boolean
}

const monthPattern = /^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/
const datePattern = /^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/
const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const dayMinutes = 24 * 60
export const rosterNoteLimit = 100

export const taipeiDate = () =>
  new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Taipei", dateStyle: "short" }).format(new Date())

export function validRosterMonth(value: unknown): value is string {
  return typeof value === "string" && monthPattern.test(value)
}

export function validRosterDate(value: unknown): value is string {
  if (typeof value !== "string" || !datePattern.test(value)) return false
  const parsed = new Date(value + "T00:00:00.000Z")
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)

const integer = (value: unknown, minimum: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= 2147483647

function validSegment(value: unknown): value is RosterSegment {
  return record(value) &&
    typeof value.start === "string" && timePattern.test(value.start) &&
    typeof value.end === "string" && timePattern.test(value.end) &&
    typeof value.startNextDay === "boolean" && typeof value.endNextDay === "boolean"
}

export function parseRosterEdit(value: unknown): RosterEdit | undefined {
  if (!record(value)) return
  const { unitId, employeeId, month, dates, revision, entry } = value
  if (!integer(unitId, 1) || !integer(employeeId, 1) || !integer(revision, 0) || !validRosterMonth(month)) return
  if (!Array.isArray(dates) || !dates.length || dates.length > 31 || new Set(dates).size !== dates.length ||
      !dates.every((date): date is string => validRosterDate(date) && date.startsWith(month + "-"))) return

  if (entry === null) return { unitId, employeeId, month, dates, revision, entry }
  if (!record(entry) || !Array.isArray(entry.segments)) return
  const legacy = entry.code === undefined && entry.note === undefined
  const code = legacy ? (entry.kind === "work" ? "X" : "OFF") : entry.code
  if (typeof code !== "string" || !/^[A-Z][A-Z0-9]{0,11}$/.test(code) ||
      (!legacy && entry.note !== null && (typeof entry.note !== "string" || Array.from(entry.note).length > rosterNoteLimit))) return
  const fields = { code, note: typeof entry.note === "string" ? entry.note.trim() || null : null }
  const edit = { unitId, employeeId, month, dates, revision, legacy }
  if (entry.kind === "off" && !entry.segments.length) {
    return { ...edit, entry: { ...fields, kind: "off", segments: [] } }
  }
  if (entry.kind !== "work" || !entry.segments.length || entry.segments.length > dayMinutes ||
      !entry.segments.every(validSegment)) return
  return { ...edit, entry: { ...fields, kind: "work", segments: entry.segments } }
}

export function rosterMinutes(time: string, nextDay: boolean) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) + (nextDay ? dayMinutes : 0)
}

export function rosterSegmentError(segments: RosterSegment[]) {
  if (!segments.length || segments.some((segment) => !validSegment(segment))) return "請填寫各時段的開始和結束時間。"
  const intervals = segments
    .map((segment) => [rosterMinutes(segment.start, segment.startNextDay), rosterMinutes(segment.end, segment.endNextDay)])
    .sort(([first], [second]) => first - second)
  if (intervals.some(([start, end], index) => end <= start || (index > 0 && start < intervals[index - 1][1]))) {
    return "請確認各時段起訖、是否為次日，以及時段有無重疊。"
  }
}
