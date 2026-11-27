"use client"

import { Fragment, useId, useMemo, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { AlertDialog, AlertDialogClose, AlertDialogContent, AlertDialogDescription, AlertDialogTitle, AlertDialogTrigger } from "@ui-sdk/react/alert-dialog"
import { Button } from "@ui-sdk/react/button"
import { Calendar, CalendarDay, CalendarGrid, CalendarWeekday, CalendarWeekdays, CalendarWeeks } from "@ui-sdk/react/calendar"
import { Checkbox, CheckboxIndicator } from "@ui-sdk/react/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@ui-sdk/react/dialog"
import { Field, FieldLabel } from "@ui-sdk/react/field"
import { Input } from "@ui-sdk/react/input"
import { SegmentedControl, SegmentedControlItem } from "@ui-sdk/react/segmented-control"
import { Select, SelectContent, SelectGroup, SelectGroupLabel, SelectItem, SelectItemIndicator, SelectLabel, SelectTrigger, SelectValue } from "@ui-sdk/react/select"
import { ArrowRight, CalendarDays, CalendarPlus, Check, ChevronDown, ChevronLeft, ChevronRight,
  CircleAlert, Eraser, Plus, Save, Trash2, X } from "lucide-react"
import type { RosterPerson, RosterUnit } from "../lib/roster-db"
import type { ApprovalState } from "../lib/roster-approval"
import {
  dateWeekday, dayMinutes, durationLabel, groupRosterDays, monthDates, offsetDate, offsetMonth, paidRosterRanges,
  presetSegments, rangeLabel, rosterDateLabel, rosterEntrySummary, rosterHours, rosterShiftTitle, segmentRanges,
  shortRosterDate, workWindow, type RosterView,
} from "../lib/roster-calendar"
import { rosterNoteLimit, rosterSegmentIssue, validRosterDate, validRosterMonth, type RosterDraft, type RosterEntry,
  type RosterSegment, type RosterShiftType } from "../lib/roster-draft"
import { LoadingFeedback, LoadingProvider } from "./loading-state"
import { RosterApprovalFooter } from "./roster-approval-actions"
import { RosterDateDetails, RosterMonthlyHours, RosterTimeTrack, RosterWeek } from "./roster-overview"
import { RosterUnitSelect } from "./roster-unit-select"
import panel from "./roster-workspace.module.css"
import styles from "./roster-draft.module.css"

gsap.registerPlugin(useGSAP)

type BatchMode = "add" | "delete"
const blankSegment: RosterSegment = { start: "", end: "", startNextDay: false, endNextDay: false }
const emptyDraft: RosterDraft = { revision: 0, days: [], shifts: [] }
const shiftBadges: Record<string, string> = { R: "例", L: "假", OFF: "休", X: "自" }

export function RosterDraftEditor({ unit, units, month, back, people, viewerId, draft, approval, approvalError, initialView, initialDate, initialPerson }: {
  unit: RosterUnit
  units: RosterUnit[]
  month: string
  back: ReactNode
  people: RosterPerson[]
  viewerId: number
  draft?: RosterDraft
  approval?: ApprovalState
  approvalError?: string
  initialView: RosterView
  initialDate: string
  initialPerson?: number
}) {
  const router = useRouter()
  const [monthPending, startMonthNavigation] = useTransition()
  const [employeeId, setEmployeeId] = useState(() =>
    people.find((person) => person.employeeId === initialPerson)?.employeeId ??
    people.find((person) => person.employeeId === viewerId)?.employeeId ?? people[0]?.employeeId,
  )
  const [view, setView] = useState<RosterView>(initialView)
  const [overview, setOverview] = useState<"month" | "week">(initialView === "week" ? "week" : "month")
  const [activeDate, setActiveDate] = useState(initialDate)
  const [monthInput, setMonthInput] = useState(month)
  const [monthIssue, setMonthIssue] = useState("")
  const [batch, setBatch] = useState<BatchMode | null>(null)
  const [batchDates, setBatchDates] = useState<string[]>([])
  const [editorDates, setEditorDates] = useState<string[]>([])
  const [current, setCurrent] = useState(draft ?? emptyDraft)
  const [versionId, setVersionId] = useState(approval?.versionId)
  const [dirty, setDirty] = useState(false)
  const [writeMessage, setWriteMessage] = useState<string>()
  const writeInFlight = useRef(false)
  const [dismissMessage, setDismissMessage] = useState("")
  const [status, setStatus] = useState("")
  const employee = people.find((person) => person.employeeId === employeeId)
  const saving = writeMessage !== undefined
  const grouped = useMemo(() => groupRosterDays(current.days), [current.days])
  const personDays = employee ? grouped.get(employee.employeeId) : undefined
  const monthDays = monthDates(month)
  const editMode = view === "edit"
  const editable = Boolean(draft && approval?.status === "draft")
  const weekly = view === "week"
  const initialShift = batch ? undefined : personDays?.get(editorDates[0])
  const filled = current.days.filter((day) => day.date.startsWith(month + "-") && (!editMode || day.employeeId === employeeId)).length

  if (versionId !== approval?.versionId) {
    setVersionId(approval?.versionId)
    setCurrent(draft ?? emptyDraft)
  }

  function stopBatch() {
    setBatch(null)
    setBatchDates([])
  }

  function navigate(date: string) {
    if (monthPending || !validRosterDate(date)) return
    if (date.startsWith(month + "-")) {
      setActiveDate(date)
      return
    }
    const query = new URLSearchParams({ unit: String(unit.id), month: date.slice(0, 7), date, view })
    if (employeeId) query.set("person", String(employeeId))
    startMonthNavigation(() => router.push(`/roster?${query}`, { scroll: false }))
  }

  function changeMonth(target: string) {
    if (monthPending) return
    if (!validRosterMonth(target)) {
      setMonthIssue("請輸入有效的班表月份，例如 2026-11。")
      return
    }
    const dates = monthDates(target)
    setMonthIssue("")
    navigate(dates[Math.min(Number(activeDate.slice(8)), dates.length) - 1])
  }

  function openEditor(dates: string[]) {
    setEditorDates(dates)
    setDirty(false)
    setDismissMessage("")
    setStatus("")
  }

  function calendarChanged(value: string | string[] | null) {
    if (monthPending) return
    if (batch) {
      setBatchDates(Array.isArray(value) ? value.filter((date) =>
        date.startsWith(month + "-") && (batch !== "delete" || personDays?.has(date)),
      ) : [])
      return
    }
    if (typeof value !== "string") return
    if (!editMode) navigate(value)
    else if (value.startsWith(month + "-") && employee) {
      setActiveDate(value)
      if (editable) openEditor([value])
    }
  }

  async function persist(entry: RosterEntry | null, dates: string[]) {
    if (writeInFlight.current) return "正在處理班次，請稍候。"
    if (!employee || !dates.length) return "請先選擇人員和日期。"
    writeInFlight.current = true
    setWriteMessage(entry ? "正在儲存班次…" : "正在刪除班次…")
    setStatus("")
    try {
      const response = await fetch("/api/roster/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ unitId: unit.id, employeeId: employee.employeeId, month, dates, revision: current.revision, entry }),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error ?? "暫時無法儲存班次，請稍後再試。")
      setCurrent((saved) => ({
        ...saved,
        revision: result.revision,
        days: saved.days.filter((day) => day.employeeId !== employee.employeeId || !dates.includes(day.date))
          .concat(entry ? dates.map((date) => ({ ...entry, date, employeeId: employee.employeeId })) : []),
      }))
      setStatus(entry ? `已儲存 ${dates.length} 日班次。` : `已將 ${dates.length} 日清為未排。`)
    } catch (error) {
      return error instanceof Error ? error.message : "暫時無法儲存班次，請稍後再試。"
    } finally {
      writeInFlight.current = false
      setWriteMessage(undefined)
    }
  }

  async function saveFromEditor(entry: RosterEntry | null, next: boolean, overwrite: boolean) {
    const targets = batch === "add" && !overwrite ? editorDates.filter((date) => !personDays?.has(date)) : editorDates
    if (!targets.length) return "選取的日期都已排班。若要替換，請勾選「覆蓋已排的日期」。"
    const issue = await persist(entry, targets)
    if (issue) return issue
    const skipped = editorDates.length - targets.length
    if (skipped) setStatus(`已儲存 ${targets.length} 日班次，保留 ${skipped} 日原班次。`)
    const tomorrow = offsetDate(editorDates[0], 1)
    if (next && !batch && tomorrow.startsWith(month + "-")) {
      setActiveDate(tomorrow)
      setEditorDates([tomorrow])
      setDirty(false)
      setDismissMessage("")
    } else {
      setEditorDates([])
      if (batch) stopBatch()
    }
  }

  const datesValue = batch ? batchDates : editMode && editable ? null : activeDate
  const monthPrevious = offsetMonth(month, -1)
  const monthNext = offsetMonth(month, 1)

  return (
    <>
      <LoadingFeedback message={editorDates.length ? undefined : writeMessage ?? (monthPending ? "正在載入班表…" : undefined)} />
      <header className={panel.pageHeader} inert={saving}>
        {back}
        <h1 className={panel.title}>月班表編輯</h1>
        {draft && <RosterMonthlyHours month={month} unitName={unit.name} people={people} days={grouped} />}
      </header>
      <div className={styles.unitControl} inert={saving}>
        <RosterUnitSelect units={units} selectedId={unit.id} month={month} date={activeDate} view={view} />
      </div>
      <div className={styles.surface} data-view={view} aria-busy={monthPending || saving} inert={saving}>
        <section className={panel.panel} aria-label="選擇排班日期">
          <SegmentedControl aria-label="班表檢視方式" className={styles.switch}
            value={editMode ? "edit" : "overview"} onValueChange={(value) => {
              stopBatch()
              setStatus("")
              if (value === "edit" || value === "overview") setView(value === "edit" ? "edit" : overview)
            }}>
            <SegmentedControlItem value="overview">班表一覽</SegmentedControlItem>
            <SegmentedControlItem value="edit">班表編輯</SegmentedControlItem>
          </SegmentedControl>
          <div className={styles.toolbar}>
            <Field className={styles.monthField}>
              <FieldLabel className="sr-only">班表月份</FieldLabel>
              <div className={styles.monthNav}>
                <Button className={styles.navButton} aria-label="上個月" disabled={monthPending || !validRosterMonth(monthPrevious)}
                  focusableWhenDisabled={monthPending}
                  onClick={() => changeMonth(monthPrevious)}><ChevronLeft size={20} aria-hidden="true" /></Button>
                <Input className={styles.monthInput} type="month" name="month" min="1000-01" max="9999-12"
                  value={monthInput} readOnly={monthPending} placeholder="YYYY-MM" aria-invalid={Boolean(monthIssue)}
                  aria-describedby={monthIssue ? "roster-month-error" : undefined}
                  onChange={(event) => {
                    const input = event.currentTarget
                    setMonthInput(input.value)
                    if (input.type === "month" && validRosterMonth(input.value)) changeMonth(input.value)
                  }}
                  onBlur={(event) => {
                    const input = event.currentTarget
                    if ((input.type === "text" && input.value !== month) || !validRosterMonth(input.value)) changeMonth(input.value)
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter" && event.currentTarget.type === "text") changeMonth(event.currentTarget.value) }} />
                <Button className={styles.navButton} aria-label="下個月" disabled={monthPending || !validRosterMonth(monthNext)}
                  focusableWhenDisabled={monthPending}
                  onClick={() => changeMonth(monthNext)}><ChevronRight size={20} aria-hidden="true" /></Button>
              </div>
            </Field>
            {!editMode && (
              <SegmentedControl className={`${styles.switch} ${styles.periodSwitch}`} aria-label="班表一覽期間" value={overview} onValueChange={(value) => {
                if (value === "month" || value === "week") {
                  setOverview(value)
                  setView(value)
                }
              }}>
                <SegmentedControlItem value="month">月</SegmentedControlItem>
                <SegmentedControlItem value="week">週</SegmentedControlItem>
              </SegmentedControl>
            )}
            {monthIssue && <p id="roster-month-error" className={`notice error ${styles.monthIssue}`} role="alert">{monthIssue}</p>}
          </div>
          {editMode && (
            <div className={styles.toolbar}>
              <div className={styles.personControl}>
                <Select items={people.map((person) => ({ value: String(person.employeeId), label: `${person.name} · ${person.employeeNo}` }))}
                  value={employee ? String(employee.employeeId) : null} presentation="auto" onValueChange={(value) => {
                    if (!value) return
                    setEmployeeId(Number(value))
                    setBatchDates([])
                    setStatus("")
                  }}>
                  <SelectLabel className={`${panel.label} ${styles.personLabel}`}>排班人員</SelectLabel>
                  <SelectTrigger className={`${styles.select} ${styles.personTrigger}`}>
                    <SelectValue className={panel.triggerValue} /><ChevronDown size={20} aria-hidden="true" />
                  </SelectTrigger>
                  <SelectContent className={panel.options} sideOffset={8}>
                    {people.map((person) => (
                      <SelectItem key={person.employeeId} value={String(person.employeeId)} className={panel.option}>
                        <span>{person.name} · {person.employeeNo}</span>
                        <SelectItemIndicator className={panel.indicator}><Check size={16} aria-hidden="true" /></SelectItemIndicator>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {editable && <div className={styles.batchTools}>
                {batch ? <Button className={styles.secondary} onClick={stopBatch}>結束批次{batch === "add" ? "新增" : "刪除"}</Button> : <>
                  <BatchGuide kind="add" disabled={!employee} start={() => setBatch("add")} />
                  <BatchGuide kind="delete" disabled={!employee} start={() => setBatch("delete")} />
                </>}
              </div>}
              <p className={styles.personProgress}>{draft
                ? `${filled}/${monthDays.length} 日已填 · ${editable ? "點日期編輯" : "唯讀"}`
                : "草稿儲存尚未啟用"}</p>
            </div>
          )}
          {weekly ? <RosterWeek date={activeDate} people={people} days={grouped} shifts={current.shifts}
            navigationPending={monthPending} selectDate={navigate} /> : (
            <Calendar key={batch ?? view} mode={batch ? "multiple" : "single"} month={month}
              value={datesValue} locale="zh-TW" weekdayFormat="narrow" showOutsideDays={false}
              unavailable={batch === "delete" ? monthDays.filter((date) => !personDays?.has(date)) : undefined}
              onValueChange={calendarChanged}>
              <CalendarGrid className={styles.calendar} aria-label={`${month} 班表`}>
                <CalendarWeekdays>{(index) => <CalendarWeekday index={index} />}</CalendarWeekdays>
                <CalendarWeeks>{(cell) => {
                  const entry = personDays?.get(cell.date)
                  const count = editMode ? 0 : people.filter((person) => grouped.get(person.employeeId)?.has(cell.date)).length
                  const lanes = editMode ? [] : people.map((person) => workWindow(grouped.get(person.employeeId), cell.date, 0, dayMinutes))
                    .filter((slots) => slots.length)
                  return (
                    <CalendarDay value={cell.date} className={styles.day} data-weekend={dateWeekday(cell.date) % 6 === 0}
                      aria-label={`${rosterDateLabel(cell.date)}，${!draft ? "草稿尚未啟用" : editMode ? rosterEntrySummary(entry, current.shifts) : `${count}/${people.length} 人已填，${lanes.length} 人排定工作時段`}`}>
                      <span className={styles.dayContent}>
                        {Number(cell.date.slice(8))}
                        {editMode ? <>
                          <span className={styles.dayBadge} data-kind={entry?.kind ?? "empty"} data-shift={entry?.code}>
                            {entry ? shiftBadges[entry.code] ?? entry.code : editable ? "＋" : "—"}
                          </span>
                          {!batch && entry?.kind === "work" && <span className={styles.dayTimes}>{segmentRanges(entry.segments).map(rangeLabel).join("、")}</span>}
                        </> : <>
                          <span className={styles.dayCount} data-filled={count > 0}>
                            {draft ? <>{count}<span className={styles.dayCountTotal}>/{people.length}</span></> : "—"}
                          </span>
                          <span className={styles.dayTracks} aria-hidden="true">
                            {lanes.slice(0, 4).map((slots, index) =>
                              <RosterTimeTrack key={index} slots={slots} start={0} end={dayMinutes} />,
                            )}
                          </span>
                        </>}
                      </span>
                    </CalendarDay>
                  )
                }}</CalendarWeeks>
              </CalendarGrid>
            </Calendar>
          )}
          {batch && (
            <div className={styles.batchPanel}>
              <p>{batch === "add" ? "選日期套用同一班次。已排日期預設保留。" : "選取有排班記錄的日期，確認後清為未排。"}</p>
              <div className={styles.actionRow}>
                <Button data-tone="neutral" onClick={() => setBatchDates(monthDays.filter((date) =>
                  batch === "add" ? dateWeekday(date) >= 1 && dateWeekday(date) <= 5 : personDays?.has(date),
                ))}><CalendarDays size={17} aria-hidden="true" /><span>{batch === "add" ? "選取週間" : "選取已排"}</span></Button>
                <Button data-tone="neutral" disabled={!batchDates.length} onClick={() => setBatchDates([])}>
                  <Eraser size={17} aria-hidden="true" /><span>清除選取</span>
                </Button>
                {batch === "add" ? <Button data-tone="primary" disabled={!batchDates.length} onClick={() => openEditor(batchDates)}>
                  <CalendarPlus size={17} aria-hidden="true" /><span>設定班次（{batchDates.length} 日）</span>
                </Button> : <AlertDialog onOpenChange={(open, details) => {
                  if (!open && details.returnValue === "confirm") {
                    void persist(null, batchDates).then((problem) => {
                      if (problem) setStatus(problem)
                      else stopBatch()
                    })
                  }
                }}>
                  <AlertDialogTrigger render={<Button />} data-tone="danger" disabled={saving || !batchDates.length}>
                    <Trash2 size={17} aria-hidden="true" /><span>刪除所選（{batchDates.length} 日）</span>
                  </AlertDialogTrigger>
                  <AlertDialogContent className={`${styles.dialog} ${styles.summaryDialog}`}>
                    <AlertDialogTitle className={styles.dialogTitle}>確認批次刪除</AlertDialogTitle>
                    <AlertDialogDescription className={styles.description}>
                      {employee?.name}的 {batchDates.length} 筆記錄會清為未排。
                    </AlertDialogDescription>
                    <p>{batchDates.map(shortRosterDate).join("、")}</p>
                    <div className={styles.actions}>
                      <AlertDialogClose className={styles.cancel}>取消</AlertDialogClose>
                      <AlertDialogClose className={styles.danger} value="confirm">確認刪除</AlertDialogClose>
                    </div>
                  </AlertDialogContent>
                </AlertDialog>}
              </div>
            </div>
          )}
          <p className={styles.saveStatus} role="status" aria-atomic="true">{status}</p>
        </section>
        {!editMode && <RosterDateDetails date={activeDate} people={people} days={grouped} shifts={current.shifts} weekly={weekly} draftAvailable={!!draft} />}
      </div>
      {editMode && approval && <RosterApprovalFooter approval={approval} unitId={unit.id} month={month}
        revision={current.revision} hasEntries={current.days.some((day) => day.date.startsWith(month + "-"))}
        disabled={monthPending || saving} />}
      {editMode && approvalError && <p className="notice error" role="alert">{approvalError}</p>}
      <Dialog open={editorDates.length > 0} presentation="auto" dismissible={!dirty && !saving}
        onDismissAttempt={() => {
          if (!saving) setDismissMessage("有未儲存的變更。請儲存，或使用「放棄變更」。")
        }}
        onOpenChange={(open) => { if (!open && !saving) setEditorDates([]) }}>
        <DialogContent className={styles.dialog}>
          <LoadingProvider contained>
            <LoadingFeedback message={writeMessage} />
            <div className={styles.dialogStack}>
              <DialogTitle className={styles.dialogTitle}>{batch ? "批次新增班次" : initialShift ? "編輯班次" : "新增班次"}</DialogTitle>
              <DialogDescription className={styles.description}>
                {unit.name} · {employee?.name} · {batch ? `${editorDates.length} 個選取日期` : editorDates[0] && rosterDateLabel(editorDates[0])}
              </DialogDescription>
              {editorDates.length > 0 && <ShiftForm key={editorDates.join(",")} initial={initialShift} shifts={current.shifts} saving={saving} dirty={dirty}
                date={batch ? undefined : editorDates[0]}
                batch={batch === "add"} canContinue={!batch && offsetDate(editorDates[0], 1).startsWith(month + "-")}
                markDirty={() => { setDirty(true); setDismissMessage("") }} save={saveFromEditor} dismissMessage={dismissMessage} />}
            </div>
          </LoadingProvider>
        </DialogContent>
      </Dialog>
    </>
  )
}

function BatchGuide({ kind, disabled, start }: { kind: BatchMode; disabled: boolean; start(): void }) {
  const deleting = kind === "delete"
  return (
    <Dialog presentation="auto" onOpenChange={(open, details) => {
      if (!open && details.returnValue === "start") start()
    }}>
      <DialogTrigger render={<Button />} className={styles.secondary} disabled={disabled}>{deleting ? "批次刪除" : "批次新增"}</DialogTrigger>
      <DialogContent className={`${styles.dialog} ${styles.summaryDialog}`}>
        <DialogTitle className={styles.dialogTitle}>{deleting ? "批次刪除班次" : "批次新增班次"}</DialogTitle>
        <DialogDescription className={styles.description}>
          {deleting ? "選取有排班記錄的日期，核對筆數後清為未排。" : "一次為同一位人員排多個日期。已排日期會保留，勾選覆蓋才會替換。"}
        </DialogDescription>
        <div className={styles.actions}>
          <DialogClose className={styles.cancel}>取消</DialogClose>
          <DialogClose className={styles.secondary} value="start">開始選日期</DialogClose>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ShiftForm({ initial, shifts, saving, dirty, batch, date, canContinue, markDirty, save, dismissMessage }: {
  initial?: RosterEntry
  shifts: RosterShiftType[]
  saving: boolean
  dirty: boolean
  batch: boolean
  date?: string
  canContinue: boolean
  markDirty(): void
  save(entry: RosterEntry | null, next: boolean, overwrite: boolean): Promise<string | undefined>
  dismissMessage: string
}) {
  const [code, setCode] = useState(initial?.code ?? null)
  const [segments, setSegments] = useState(() => (initial?.segments ?? []).map((segment, key) => ({ key, ...segment })))
  const [note, setNote] = useState(initial?.note ?? "")
  const [overwrite, setOverwrite] = useState(false)
  const [error, setError] = useState("")
  const [missingShift, setMissingShift] = useState(false)
  const [validationAttempt, setValidationAttempt] = useState(0)
  const shiftTrigger = useRef<HTMLButtonElement>(null)
  const fields = useRef<HTMLDivElement>(null)
  const errorId = useId()
  const timeErrorId = useId()
  const choices = shifts.filter((shift) => !shift.legacy || shift.code === initial?.code)
  const selected = choices.find((shift) => shift.code === code)
  const timeIssue = selected?.kind === "work" ? rosterSegmentIssue(segments) : undefined
  const highlighted = validationAttempt ? timeIssue : undefined
  const firstInvalid = highlighted?.invalid.size ? Math.min(...highlighted.invalid) : undefined
  const timeConflict = error.startsWith("時段與 ")
  const timeError = highlighted?.message ?? (timeConflict ? error : undefined)
  const totals = selected?.kind === "work" && !timeIssue
    ? rosterHours(paidRosterRanges(selected.code, segmentRanges(segments))) : undefined

  useGSAP(() => {
    const body = fields.current
    const message = body?.querySelector<HTMLElement>("[data-time-error]")
    if (!body || !message) return
    body.scrollTop += message.getBoundingClientRect().top - body.getBoundingClientRect().top - 4
    message.focus({ preventScroll: true })
    const media = gsap.matchMedia(body)
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from("[data-time-invalid]", { scale: 0.985, duration: 0.32, ease: "power2.out", clearProps: "transform" })
    })
    return () => media.revert()
  }, { scope: fields, dependencies: [validationAttempt], revertOnUpdate: true })

  function updateForm() {
    markDirty()
    setError("")
  }

  function applyDefaults(shift: RosterShiftType) {
    updateForm()
    setMissingShift(false)
    setValidationAttempt(0)
    const defaults = presetSegments(shift)
    setSegments((defaults.length || shift.kind === "off" ? defaults : [blankSegment])
      .map((segment, key) => ({ key, ...segment })))
  }

  function changeSegment(key: number, value: Partial<RosterSegment>) {
    updateForm()
    setSegments((items) => items.map((item) => item.key === key ? { ...item, ...value } : item))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    if (!selected) {
      setMissingShift(true)
      setError("請先選擇工作班別或休假類型。")
      shiftTrigger.current?.focus({ preventScroll: true })
      return
    }
    if (timeIssue) {
      setError("")
      setValidationAttempt((attempt) => attempt + 1)
      return
    }
    const values = segments.map(({ start, end, startNextDay, endNextDay }) => ({ start, end, startNextDay, endNextDay }))
    const details = { code: selected.code, note: note.trim() || null }
    const entry: RosterEntry = selected.kind === "off"
      ? { ...details, kind: "off", segments: [] }
      : { ...details, kind: "work", segments: values }
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    setError("")
    const problem = await save(entry, submitter?.getAttribute("value") === "next", overwrite)
    if (problem) {
      setError(problem)
      setValidationAttempt((attempt) => attempt + 1)
    }
  }

  const timingAlert = timeError && <p id={timeErrorId} className={styles.timeError}
    role="alert" tabIndex={-1} data-time-error><CircleAlert size={18} aria-hidden="true" />{timeError}</p>

  return (
    <form className={styles.form} method="post" action="/api/roster/draft" onSubmit={submit} noValidate aria-busy={saving}>
      <div className={styles.fields} ref={fields} inert={saving}>
        {initial && (
          <div className={styles.savedShift + " " + styles.currentShift}>
            <div>
              <strong>目前班次</strong>
              <p>{rosterEntrySummary(initial, shifts)}</p>
            </div>
            <Button type="button" className={styles.clearShift} disabled={saving} onClick={async () => {
              setError("")
              const problem = await save(null, false, false)
              if (problem) setError(problem)
            }}>清為未排</Button>
          </div>
        )}
        <Select items={choices.map((shift) => ({ value: shift.code, label: rosterShiftTitle(shift) }))}
          value={code} name="code" placeholder="選擇班別" presentation="popover" disabled={saving} onValueChange={(value) => {
          const choice = choices.find((shift) => shift.code === value)
          if (!choice) return
          setCode(choice.code)
          applyDefaults(choice)
        }}>
          <SelectLabel className={panel.label}>班別</SelectLabel>
          <SelectTrigger ref={shiftTrigger} className={styles.select} aria-required="true"
            aria-invalid={missingShift} aria-describedby={missingShift ? errorId : undefined}>
            <SelectValue /><ChevronDown size={20} aria-hidden="true" />
          </SelectTrigger>
          <SelectContent className={panel.options} sideOffset={4}>
            <ShiftOptions heading="工作班別" shifts={choices.filter((shift) => !shift.legacy && shift.kind === "work")} />
            <ShiftOptions heading="休假與其他" shifts={choices.filter((shift) => !shift.legacy && shift.kind === "off")} />
            <ShiftOptions heading="既有班別" shifts={choices.filter((shift) => shift.legacy)} />
          </SelectContent>
        </Select>
        {selected?.kind === "work" && (
          <>
            <div className={styles.shiftMetrics}>
              <div className={styles.savedShift}>
                <strong>工作時數</strong>
                <output aria-label="工作時數">{totals ? durationLabel(totals.work) : "—"}</output>
              </div>
              <div className={styles.savedShift}>
                <strong>加給時數</strong>
                <output aria-label="加給時數">{totals ? durationLabel(totals.allowance) : "—"}</output>
              </div>
            </div>
            <p className={styles.shiftHelp}>加給時段為每日 18:00–次日 08:00。</p>
            {code === "A" && <p className={styles.shiftHelp}>A 班扣除 12:00–13:00 午休。</p>}
            {code === "B" && <p className={styles.shiftHelp} aria-live="polite">
              兩頭班每段起訖各打卡一次{totals ? "，目前共 " + segments.length * 2 + " 次。" : "。"}
            </p>}
            <div className={styles.shiftTiming} data-time-invalid={timeConflict || undefined}>
              <div className={styles.shiftTimingHeader}>
                <h3 className={styles.sectionHeading}>排定時段</h3>
                {selected.defaults.length > 0 && <Button type="button" className={styles.timingAction} onClick={() => applyDefaults(selected)}>
                  套用班別預設
                </Button>}
              </div>
              {firstInvalid === undefined && timingAlert}
              {segments.map((segment, index) => {
                const invalid = highlighted?.invalid.has(index)
                const description = invalid ? timeErrorId : undefined
                return (
                  <Fragment key={segment.key}>
                    {index === firstInvalid && timingAlert}
                    <fieldset className={styles.segment} data-time-invalid={invalid || undefined}
                      aria-describedby={description}>
                      <legend>第 {index + 1} 段</legend>
                      <TimeFields kind="start" index={index} date={date} segment={segment}
                        issueId={description} change={(value) => changeSegment(segment.key, value)} />
                      <TimeFields kind="end" index={index} date={date} segment={segment}
                        issueId={description} change={(value) => changeSegment(segment.key, value)} />
                      {segments.length > 1 && <Button type="button" className={styles.timingAction} onClick={() => {
                        updateForm()
                        setSegments((items) => items.filter((item) => item.key !== segment.key))
                      }}>移除第 {index + 1} 段</Button>}
                    </fieldset>
                  </Fragment>
                )
              })}
              <Button type="button" className={styles.timingAction} onClick={() => {
                updateForm()
                setSegments((items) => [...items, { key: items[items.length - 1].key + 1, ...blankSegment }])
              }}><Plus size={18} aria-hidden="true" />新增時段</Button>
            </div>
          </>
        )}
        {selected && (
          <Field>
            <FieldLabel className={panel.label}>備註（選填）</FieldLabel>
            <Input className={styles.note} type="text" name="note" value={note} maxLength={rosterNoteLimit}
              onChange={(event) => { updateForm(); setNote(event.target.value) }} />
          </Field>
        )}
        {batch && <Field className={styles.nextDay}>
          <Checkbox name="overwrite" checked={overwrite}
            onCheckedChange={(checked) => {
              updateForm()
              setMissingShift(false)
              setOverwrite(checked === true)
            }}>
            <CheckboxIndicator><Check size={16} aria-hidden="true" /></CheckboxIndicator>
          </Checkbox>
          <FieldLabel>覆蓋已排的日期</FieldLabel>
        </Field>}
        {((error && !timeConflict) || dismissMessage) && <p id={errorId} className="notice error" role="alert"
          ref={(node) => {
            const body = node?.parentElement
            if (body) body.scrollTop = body.scrollHeight
          }}>{(!timeConflict && error) || dismissMessage}</p>}
      </div>
      <div className={styles.actionRow + " " + styles.formActions}>
        <DialogClose render={<Button focusableWhenDisabled />} data-tone="neutral" disabled={saving}>
          <X size={17} aria-hidden="true" /><span>{dirty ? "放棄變更" : "取消"}</span>
        </DialogClose>
        <Button data-tone="primary" type="submit" value="save" disabled={saving} focusableWhenDisabled>
          <Save size={17} aria-hidden="true" /><span>儲存班次</span>
        </Button>
        {canContinue && <Button data-tone="next" type="submit" value="next" disabled={saving} focusableWhenDisabled>
          <ArrowRight size={17} aria-hidden="true" /><span>儲存並編下一日</span>
        </Button>}
      </div>
    </form>
  )
}

function ShiftOptions({ heading, shifts }: { heading: string; shifts: RosterShiftType[] }) {
  if (!shifts.length) return null
  return (
    <SelectGroup>
      <SelectGroupLabel className={styles.shiftGroupLabel}>{heading}</SelectGroupLabel>
      {shifts.map((shift) => (
        <SelectItem key={shift.code} value={shift.code} className={panel.option}>
          <span className={styles.shiftChoice}>
            <strong>{rosterShiftTitle(shift)}</strong>
            {shift.defaults.length > 0 && <span>
              {shift.defaults.map(rangeLabel).join("、")}（{durationLabel(rosterHours(paidRosterRanges(shift.code, shift.defaults)).work)}）
            </span>}
          </span>
          <SelectItemIndicator className={panel.indicator}><Check size={16} aria-hidden="true" /></SelectItemIndicator>
        </SelectItem>
      ))}
    </SelectGroup>
  )
}

function TimeFields({ kind, index, date, segment, issueId, change }: {
  kind: "start" | "end"
  index: number
  date?: string
  segment: RosterSegment
  issueId?: string
  change(value: Partial<RosterSegment>): void
}) {
  const title = kind === "start" ? "開始" : "結束"
  const nextDay = kind === "start" ? "startNextDay" : "endNextDay"
  const dates = [
    { value: "same", label: date ? `${shortRosterDate(date)} 當日` : "當日" },
    { value: "next", label: date ? `${shortRosterDate(offsetDate(date, 1))} 次日` : "次日" },
  ]
  return (
    <div className={styles.timeGroup}>
      <span className={styles.timeLabel} aria-hidden="true">{title}時間</span>
      <Select items={dates} value={segment[nextDay] ? "next" : "same"} name={`${nextDay}-${index}`}
        presentation="popover" onValueChange={(value) => {
          if (value === "same" || value === "next") change({ [nextDay]: value === "next" })
        }}>
        <SelectLabel className="sr-only">{title}日期，第 {index + 1} 段</SelectLabel>
        <SelectTrigger className={`${styles.select} ${styles.dateSelect}`} aria-invalid={Boolean(issueId)} aria-describedby={issueId}>
          <SelectValue /><ChevronDown size={16} aria-hidden="true" />
        </SelectTrigger>
        <SelectContent className={panel.options} sideOffset={4}>
          {dates.map((item) => (
            <SelectItem key={item.value} value={item.value} className={panel.option}>
              {item.label}<SelectItemIndicator className={panel.indicator}><Check size={16} aria-hidden="true" /></SelectItemIndicator>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Field>
        <FieldLabel className="sr-only">{title}時間，第 {index + 1} 段</FieldLabel>
        <Input className={styles.time} type="time" name={`${kind}-${index}`} value={segment[kind]}
          onChange={(event) => change({ [kind]: event.target.value })} aria-invalid={Boolean(issueId)} aria-describedby={issueId} required />
      </Field>
    </div>
  )
}
