import { rosterMinutes, type RosterDay, type RosterEntry, type RosterSegment, type RosterShiftType } from "./roster-draft"

export const dayMinutes = 24 * 60
const weekdays = ["日", "一", "二", "三", "四", "五", "六"]

export type RosterView = "month" | "week" | "edit"
export type MinuteRange = { start: number; end: number }
export type RosterDays = Map<number, Map<string, RosterDay>>

const utcDate = (date: string) => new Date(date + "T00:00:00Z")

export function offsetDate(date: string, offset: number) {
  const next = utcDate(date)
  next.setUTCDate(next.getUTCDate() + offset)
  return next.toISOString().split("T")[0]
}

export function offsetMonth(month: string, offset: number) {
  const next = utcDate(month + "-01")
  next.setUTCMonth(next.getUTCMonth() + offset)
  return next.toISOString().split("T")[0].slice(0, -3)
}

export function monthDates(month: string) {
  const first = month + "-01"
  const last = utcDate(first)
  last.setUTCMonth(last.getUTCMonth() + 1, 0)
  const count = last.getUTCDate()
  return Array.from({ length: count }, (_, index) => offsetDate(first, index))
}

export function weekDates(date: string) {
  const monday = (utcDate(date).getUTCDay() + 6) % 7
  return Array.from({ length: 7 }, (_, index) => offsetDate(date, index - monday))
}

export const dateWeekday = (date: string) => utcDate(date).getUTCDay()
export const shortRosterDate = (date: string) => `${Number(date.slice(-5, -3))}/${Number(date.slice(-2))}`
export const rosterDateLabel = (date: string) => `${shortRosterDate(date)}（${weekdays[dateWeekday(date)]}）`

export function groupRosterDays(days: RosterDay[]): RosterDays {
  const groups: RosterDays = new Map()
  for (const day of days) {
    const person = groups.get(day.employeeId) ?? new Map()
    person.set(day.date, day)
    groups.set(day.employeeId, person)
  }
  return groups
}

export function clockTime(minutes: number) {
  const time = minutes % dayMinutes
  return `${String(Math.floor(time / 60)).padStart(2, "0")}:${String(time % 60).padStart(2, "0")}`
}

export function rangeLabel({ start, end }: MinuteRange) {
  const startNextDay = start >= dayMinutes
  const first = `${startNextDay ? "次日 " : ""}${clockTime(start)}`
  const last = end === dayMinutes ? "24:00" : `${end >= dayMinutes && !startNextDay ? "次日 " : ""}${clockTime(end)}`
  return `${first}–${last}`
}

export function segmentRanges(segments: RosterSegment[]): MinuteRange[] {
  return segments.map((part) => ({
    start: rosterMinutes(part.start, part.startNextDay),
    end: rosterMinutes(part.end, part.endNextDay),
  })).sort((first, second) => first.start - second.start)
}

export function presetSegments(shift: RosterShiftType): RosterSegment[] {
  return shift.defaults.map(({ start, end }) => ({
    start: clockTime(start),
    end: clockTime(end),
    startNextDay: start >= dayMinutes,
    endNextDay: end >= dayMinutes,
  }))
}

export function paidRosterRanges(code: string, ranges: MinuteRange[]): MinuteRange[] {
  if (code !== "A") return ranges
  return ranges.flatMap(({ start, end }) => {
    const paid: MinuteRange[] = []
    let cursor = start
    for (let day = Math.floor(start / dayMinutes) * dayMinutes; day < end; day += dayMinutes) {
      const lunchStart = day + 12 * 60
      const lunchEnd = day + 13 * 60
      if (lunchEnd <= cursor || lunchStart >= end) continue
      if (cursor < lunchStart) paid.push({ start: cursor, end: lunchStart })
      cursor = lunchEnd
    }
    if (cursor < end) paid.push({ start: cursor, end })
    return paid
  })
}

export function rosterHours(ranges: MinuteRange[]) {
  let work = 0
  let allowance = 0
  for (const { start, end } of ranges) {
    work += end - start
    for (let day = Math.floor(start / dayMinutes) * dayMinutes; day < end; day += dayMinutes) {
      allowance += Math.max(0, Math.min(end, day + 8 * 60) - Math.max(start, day))
      allowance += Math.max(0, Math.min(end, day + dayMinutes) - Math.max(start, day + 18 * 60))
    }
  }
  return { work, allowance }
}

export function rosterShiftTitle(shift: RosterShiftType) {
  return shift.kind === "work" && !shift.legacy && shift.code !== "A" ? `${shift.code} ${shift.name}` : shift.name
}

export function rosterEntrySummary(entry: RosterEntry | undefined, shifts: RosterShiftType[]) {
  if (!entry) return "未排"
  const shift = shifts.find((item) => item.code === entry.code)
  const name = shift ? rosterShiftTitle(shift) : entry.code
  return entry.kind === "off" ? name : `${name} · ${segmentRanges(entry.segments).map(rangeLabel).join("、")}`
}

export function workWindow(days: Map<string, RosterDay> | undefined, date: string, start: number, end: number) {
  return [-1, 0, 1].flatMap((offset) => {
    const entry = days?.get(offsetDate(date, offset))
    if (entry?.kind !== "work") return []
    return paidRosterRanges(entry.code, segmentRanges(entry.segments)).flatMap((segment) => {
      const first = Math.max(start, segment.start + offset * dayMinutes)
      const last = Math.min(end, segment.end + offset * dayMinutes)
      return first < last ? [{ start: first, end: last }] : []
    })
  }).sort((first, second) => first.start - second.start)
}

export function durationLabel(total: number) {
  const hours = Math.floor(total / 60)
  const minutes = total % 60
  return `${hours} 小時${minutes ? ` ${minutes} 分` : ""}`
}

export function concurrentStaffing(lanes: MinuteRange[][], start: number, end: number) {
  const boundaries = [...new Set([start, end, ...lanes.flatMap((lane) => lane.flatMap((range) => [range.start, range.end]))])]
    .sort((a, b) => a - b)
  const counts: (MinuteRange & { count: number })[] = []
  for (let index = 1; index < boundaries.length; index += 1) {
    const first = boundaries[index - 1]
    const last = boundaries[index]
    const count = lanes.filter((lane) => lane.some((range) => range.start <= first && range.end >= last)).length
    const previous = counts.at(-1)
    if (previous?.count === count) previous.end = last
    else counts.push({ start: first, end: last, count })
  }
  return counts
}
