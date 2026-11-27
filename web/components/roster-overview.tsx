import type { CSSProperties } from "react"
import { Button } from "@ui-sdk/react/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@ui-sdk/react/dialog"
import { ChevronLeft, ChevronRight } from "lucide-react"
import type { RosterPerson } from "../lib/roster-db"
import {
  concurrentStaffing, dateWeekday, dayMinutes, durationLabel, monthDates, offsetDate, rangeLabel, rosterDateLabel,
  rosterEntrySummary, rosterHours, segmentRanges, shortRosterDate, weekDates, workWindow, type MinuteRange, type RosterDays,
} from "../lib/roster-calendar"
import { validRosterDate, type RosterShiftType } from "../lib/roster-draft"
import panel from "./roster-workspace.module.css"
import styles from "./roster-draft.module.css"

export function RosterWeek({ date, people, days, shifts, navigationPending, selectDate }: {
  date: string
  people: RosterPerson[]
  days: RosterDays
  shifts: RosterShiftType[]
  navigationPending: boolean
  selectDate(date: string): void
}) {
  const week = weekDates(date)
  const previous = offsetDate(date, -7)
  const next = offsetDate(date, 7)
  const dateButton = (day: string) => (
    <Button key={day} className={styles.dayLink} aria-label={rosterDateLabel(day)} aria-pressed={day === date}
      disabled={navigationPending || !validRosterDate(day)} focusableWhenDisabled={navigationPending} onClick={() => selectDate(day)}>
      <span>{"日一二三四五六"[dateWeekday(day)]}</span>
      <span className={styles.weekDayDate}>{shortRosterDate(day)}</span>
    </Button>
  )
  return (
    <section className={styles.weekSection} aria-label="每週班表">
      <div className={styles.weekNav}>
        <Button className={styles.navButton} aria-label="上一週" disabled={navigationPending || !validRosterDate(previous)}
          focusableWhenDisabled={navigationPending} onClick={() => selectDate(previous)}>
          <ChevronLeft size={22} aria-hidden="true" />
        </Button>
        <h3 className={styles.weekRange}>{shortRosterDate(week[0])}–{shortRosterDate(week[6])}</h3>
        <Button className={styles.navButton} aria-label="下一週" disabled={navigationPending || !validRosterDate(next)}
          focusableWhenDisabled={navigationPending} onClick={() => selectDate(next)}>
          <ChevronRight size={22} aria-hidden="true" />
        </Button>
      </div>
      <div className={styles.weekDates} role="group" aria-label="選擇查看日期">{week.map(dateButton)}</div>
      <div className={styles.tableScroll} role="region" aria-label="每週班表，可左右捲動" tabIndex={0}>
        <table className={styles.weekTable}>
          <caption className="sr-only">每週班表</caption>
          <thead><tr><th scope="col">人員</th>{week.map((day) => (
            <th scope="col" key={day} data-current={day === date}>
              {dateButton(day)}
            </th>
          ))}</tr></thead>
          <tbody>{people.map((person) => (
            <tr key={person.employeeId}>
              <th scope="row">{person.name}</th>
              {week.map((day) => {
                const entry = days.get(person.employeeId)?.get(day)
                return <td key={day} data-current={day === date}>{rosterEntrySummary(entry, shifts)}</td>
              })}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  )
}

function barStyle(range: MinuteRange, start: number, end: number): CSSProperties {
  return {
    insetInlineStart: `${(range.start - start) * 100 / (end - start)}%`,
    inlineSize: `${(range.end - range.start) * 100 / (end - start)}%`,
  }
}

export function RosterTimeTrack({ slots, start, end }: { slots: MinuteRange[]; start: number; end: number }) {
  return (
    <span className={styles.timeTrack} aria-hidden="true">
      {slots.map((slot) => <span key={slot.start} className={styles.timeBar} style={barStyle(slot, start, end)} />)}
    </span>
  )
}

export function RosterDateDetails({ date, people, days, shifts, weekly, draftAvailable }: {
  date: string
  people: RosterPerson[]
  days: RosterDays
  shifts: RosterShiftType[]
  weekly: boolean
  draftAvailable: boolean
}) {
  const start = weekly ? 21 * 60 : 0
  const end = weekly ? dayMinutes + 9 * 60 : dayMinutes
  const lanes = people.map((person) => workWindow(days.get(person.employeeId), date, start, end))
  const hasWork = lanes.some((slots) => slots.length)
  const ticks = weekly ? ["21:00", "00:00", "03:00", "06:00", "09:00"] : ["00:00", "06:00", "12:00", "18:00", "24:00"]
  const filled = people.filter((person) => days.get(person.employeeId)?.has(date)).length
  return (
    <section className={`${panel.panel} ${styles.dateDetails}`} aria-labelledby="roster-date-title">
      <div className={`${styles.detailHeader} ${styles.dateHeader}`}>
        <h2 id="roster-date-title">{rosterDateLabel(date)} 班表</h2>
        <span className={panel.count}>{draftAvailable ? `${filled}/${people.length} 人已填` : `${people.length} 人`}</span>
      </div>
      <section className={styles.timeline} aria-labelledby="roster-timeline-title">
        <div className={styles.detailHeader}>
          <h3 id="roster-timeline-title">{weekly ? "夜間人力" : "當日排班時間軸"}</h3>
          {weekly && <p>{shortRosterDate(date)} 21:00–{shortRosterDate(offsetDate(date, 1))} 09:00</p>}
        </div>
        {hasWork ? <>
        <div className={styles.axis} aria-hidden="true">{ticks.map((tick) => <span key={tick}>{tick}</span>)}</div>
        {people.map((person, index) => {
          const slots = lanes[index]
          if (!slots.length) return null
          return (
            <div className={styles.timelineRow} key={person.employeeId}>
              <div><strong>{person.name}</strong><span>{slots.map(rangeLabel).join("、")}</span></div>
              <RosterTimeTrack slots={slots} start={start} end={end} />
            </div>
          )
        })}
        {weekly && (
          <div className={styles.staffing}>
            <strong>同時在班</strong>
            <ul>{concurrentStaffing(lanes, start, end).map((span) =>
              <li key={span.start}><span>{rangeLabel(span)}</span><strong>{span.count} 人</strong></li>
            )}</ul>
          </div>
        )}
        </> : <p>{draftAvailable ? "沒有排定工作時段" : "正式名冊已載入，班表草稿尚未啟用"}</p>}
      </section>
      <ul className={styles.detailList}>
        {people.map((person) => {
          const entry = days.get(person.employeeId)?.get(date)
          const compactSummary = entry?.kind === "work" && entry.segments.length > 1
            ? `${entry.code} ${segmentRanges(entry.segments).map(rangeLabel).join("/")}` : undefined
          return (
            <li key={person.employeeId}>
              <div><strong>{person.name}</strong>{person.jobTitle && <span>{person.jobTitle}</span>}</div>
              {draftAvailable && (
                <span>
                  <span className={compactSummary ? styles.fullShiftSummary : undefined}>{rosterEntrySummary(entry, shifts)}</span>
                  {compactSummary && <span className={styles.compactShiftSummary} aria-hidden="true">{compactSummary}</span>}
                </span>
              )}
              {entry?.note && <p className={styles.rosterNote}>{entry.note}</p>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function RosterMonthlyHours({ month, unitName, people, days }: {
  month: string
  unitName: string
  people: RosterPerson[]
  days: RosterDays
}) {
  const dates = monthDates(month)
  const totals = people.map((person) =>
    rosterHours(dates.flatMap((date) => workWindow(days.get(person.employeeId), date, 0, dayMinutes))),
  )
  const unit = totals.reduce((sum, hours) => ({
    work: sum.work + hours.work,
    allowance: sum.allowance + hours.allowance,
  }), { work: 0, allowance: 0 })
  return (
    <Dialog presentation="auto">
      <DialogTrigger render={<Button />} className={styles.secondary}>月結時數</DialogTrigger>
      <DialogContent className={`${styles.dialog} ${styles.summaryDialog}`}>
        <DialogTitle className={styles.dialogTitle}>月結時數</DialogTitle>
        <DialogDescription className={styles.description}>{unitName} · {month} · 排定工時</DialogDescription>
        <table className={styles.hoursTable}>
          <thead><tr><th scope="col">人員</th><th scope="col">工作時數</th><th scope="col">加給時數</th></tr></thead>
          <tbody>{people.map((person, index) =>
            <tr key={person.employeeId}>
              <th scope="row">{person.name}</th>
              <td>{durationLabel(totals[index].work)}</td><td>{durationLabel(totals[index].allowance)}</td>
            </tr>,
          )}</tbody>
          <tfoot><tr><th scope="row">單位合計</th><td>{durationLabel(unit.work)}</td><td>{durationLabel(unit.allowance)}</td></tr></tfoot>
        </table>
        <p className={styles.description}>跨月班次按實際工作日期分月。每日加給時段為 18:00–次日 08:00。</p>
        <DialogClose render={<Button />} className={styles.secondary}>關閉</DialogClose>
      </DialogContent>
    </Dialog>
  )
}
