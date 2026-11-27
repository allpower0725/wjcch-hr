export type RosterSegment = {
  start: string
  end: string
  startNextDay: boolean
  endNextDay: boolean
}

export type RosterEntry = { kind: "work"; segments: RosterSegment[] } | { kind: "off"; segments: [] }
export type RosterDay = RosterEntry & { employeeId: number; date: string }
export type RosterDraft = { revision: number; days: RosterDay[] }

export type RosterEdit = {
  unitId: number
  employeeId: number
  month: string
  dates: string[]
  revision: number
  entry: RosterEntry | null
}

const monthPattern = /^[1-9][0-9]{3}-(0[1-9]|1[0-2])$/
const datePattern = /^[1-9][0-9]{3}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/
const timePattern = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
const dayMinutes = 24 * 60

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
  if (entry.kind === "off" && !entry.segments.length) {
    return { unitId, employeeId, month, dates, revision, entry: { kind: "off", segments: [] } }
  }
  if (entry.kind !== "work" || !entry.segments.length || entry.segments.length > dayMinutes ||
      !entry.segments.every(validSegment)) return
  return { unitId, employeeId, month, dates, revision, entry: { kind: "work", segments: entry.segments } }
}

export function rosterMinutes(time: string, nextDay: boolean) {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3)) + (nextDay ? dayMinutes : 0)
}

export function rosterSegmentError(segments: RosterSegment[]) {
  if (!segments.length || segments.some((segment) => !validSegment(segment))) return "請填寫各時段的開始和結束時間。"
  const intervals = segments
    .map((segment) => [rosterMinutes(segment.start, segment.startNextDay), rosterMinutes(segment.end, segment.endNextDay)])
    .sort(([first], [second]) => first - second)
  if (intervals[0][0] >= dayMinutes) return "第一段班次須從出勤歸屬日開始。"
  if (intervals.some(([start, end], index) => end <= start || (index > 0 && start < intervals[index - 1][1]))) {
    return "請確認各時段起訖、是否為次日，以及時段有無重疊。"
  }
}

function shiftTime(date: string, time: string, nextDay: boolean) {
  const startOfDay = new Date(date + "T00:00:00+08:00").getTime()
  return new Date(startOfDay + rosterMinutes(time, nextDay) * 60000).toISOString()
}

export function rosterIntervals(dates: string[], segments: RosterSegment[]) {
  return dates.flatMap((date) => segments.map((segment) => ({
    work_date: date,
    starts_at: shiftTime(date, segment.start, segment.startNextDay),
    ends_at: shiftTime(date, segment.end, segment.endNextDay),
  }))).sort((first, second) => first.starts_at.localeCompare(second.starts_at))
}
