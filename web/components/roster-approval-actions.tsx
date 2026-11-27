"use client"

import { useRef, useState, useTransition, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@ui-sdk/react/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@ui-sdk/react/dialog"
import { Field, FieldLabel } from "@ui-sdk/react/field"
import { Select, SelectContent, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@ui-sdk/react/select"
import { Textarea } from "@ui-sdk/react/textarea"
import { ChevronDown, ClipboardCheck } from "lucide-react"
import { approvalActionLabels, approvalStatusLabels, type ApprovalMutation, type ApprovalPolicy, type ApprovalState,
  type HospitalAction, type HospitalRole } from "../lib/roster-approval"
import { LoadingFeedback, LoadingProvider, PortalLink } from "./loading-state"
import panel from "./roster-workspace.module.css"
import styles from "./roster-approval.module.css"

type ReviewAction = Extract<ApprovalMutation, { action: "approve" | "return" | "reject" }>
type DialogMutation = Exclude<ApprovalMutation, { action: "policy" }>
const actionDescription: Record<DialogMutation["action"], string> = {
  submit: "送出後會鎖定目前版本，並依實際主管指派進入簽核。",
  withdraw: "取回後會保留送出紀錄，並開立新草稿供你修改。",
  approve: "確認班表內容後核准本關，案件會接續下一關。",
  return: "保留本次送出的版本，另開草稿供原單位修正。",
  reject: "結束本案件並保留紀錄，原單位可重新編排。",
}

function useApprovalMutation() {
  const router = useRouter()
  const [inFlight, setInFlight] = useState(false)
  const [refreshing, startRefresh] = useTransition()
  const [error, setError] = useState("")
  const lock = useRef(false)

  async function run(request: ApprovalMutation) {
    if (lock.current) return false
    lock.current = true
    setError("")
    setInFlight(true)
    try {
      const response = await fetch("/api/roster/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || "暫時無法處理班表簽核。")
      startRefresh(() => router.refresh())
      return true
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "暫時無法處理班表簽核。")
      return false
    } finally {
      lock.current = false
      setInFlight(false)
    }
  }

  return { run, pending: inFlight || refreshing, error }
}

export function ApprovalAction({ request, disabled, late }: { request: DialogMutation; disabled?: boolean; late?: boolean }) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  const { run, pending, error } = useApprovalMutation()
  const label = approvalActionLabels[request.action]
  const review = request.action === "approve" || request.action === "return" || request.action === "reject"
  const reasonRequired = request.action === "return" || request.action === "reject"

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending || (reasonRequired && !reason.trim())) return
    if (await run(review ? { ...request as ReviewAction, reason: reason.trim() } : request)) {
      setOpen(false)
      setReason("")
    }
  }

  return (
    <Dialog open={open} presentation="auto" dismissible={!pending} onOpenChange={(next) => {
      if (!pending) setOpen(next)
    }}>
      <DialogTrigger render={<Button />} className={styles.action} data-primary={request.action === "submit" || request.action === "approve"}
        disabled={disabled || pending}>{label}</DialogTrigger>
      <DialogContent className={styles.dialog}>
        <LoadingProvider contained>
          <LoadingFeedback message={pending ? "正在處理班表簽核…" : undefined} />
          <DialogTitle className={styles.title}>確認{label}</DialogTitle>
          <DialogDescription>{actionDescription[request.action]}{late && request.action === "submit" && " 本次送出會標示為逾期。"}</DialogDescription>
          <form onSubmit={submit} className={styles.stack} aria-busy={pending}>
            {review && <Field>
              <FieldLabel className={panel.label}>{reasonRequired ? "處理原因" : "簽核意見（選填）"}</FieldLabel>
              <Textarea className={styles.input} rows={3} maxLength={500} value={reason}
                onChange={(event) => setReason(event.target.value)} required={reasonRequired} disabled={pending} />
            </Field>}
            {error && <p role="alert" className="notice error">{error}</p>}
            <div className={styles.actions}>
              <DialogClose render={<Button />} className={styles.action} disabled={pending}>取消</DialogClose>
              <Button type="submit" className={styles.action} data-primary="true"
                disabled={pending || (reasonRequired && !reason.trim())} focusableWhenDisabled>確認{label}</Button>
            </div>
          </form>
        </LoadingProvider>
      </DialogContent>
    </Dialog>
  )
}

export function RosterApprovalFooter({ approval, unitId, month, revision, hasEntries, disabled }: {
  approval: ApprovalState
  unitId: number
  month: string
  revision: number
  hasEntries: boolean
  disabled: boolean
}) {
  return (
    <section className={`${panel.panel} ${styles.footer}`} aria-label="班表送出進度">
      <div className={styles.heading}>
        <h2 className={styles.title}>班表送出</h2>
        <span className={panel.count}>{approvalStatusLabels[approval.status]}</span>
      </div>
      <p>截止日 {approval.dueDate} 24:00{approval.late && <span className={styles.warning}> · 已逾期</span>}</p>
      {approval.responsible && approval.status === "draft" && <p>送出主管 {approval.responsible}</p>}
      {approval.blockReason && <p className={styles.warning}>{approval.blockReason}</p>}
      {approval.lastReturn && approval.status === "draft" && <p>上次處理意見 {approval.lastReturn}</p>}
      {approval.missingUnits.length > 0 && <p className={styles.warning}>下層尚未送出 {approval.missingUnits.join("、")}</p>}
      <div className={styles.actions}>
        {approval.isSubmitter && approval.status === "draft" && <ApprovalAction request={{ action: "submit", unitId, month, revision }}
          disabled={disabled || !hasEntries || !approval.canSubmit} late={approval.late} />}
        {approval.canWithdraw && approval.caseId && <ApprovalAction request={{ action: "withdraw", caseId: approval.caseId }} disabled={disabled} />}
        {approval.canReview && <Button className={styles.action} render={<PortalLink href="/roster/approvals" />}>
          <ClipboardCheck size={17} aria-hidden="true" />主管簽核
        </Button>}
      </div>
    </section>
  )
}

const hospitalActions: { value: HospitalAction; label: string }[] = [
  { value: "approve", label: "院級簽核" }, { value: "notify", label: "院級知會" },
]
const hospitalRoles: { value: HospitalRole; label: string }[] = [
  { value: "head", label: "院長" }, { value: "deputy", label: "副院長" },
]

export function ApprovalPolicyEditor({ policies }: { policies: ApprovalPolicy[] }) {
  const [unitId, setUnitId] = useState<number>()
  const [hospitalAction, setAction] = useState<HospitalAction | null>(null)
  const [hospitalRole, setRole] = useState<HospitalRole | null>(null)
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = useApprovalMutation()
  const units = policies.map((policy) => ({ value: String(policy.unitId), label: policy.unit }))

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!unitId || !hospitalAction || !hospitalRole || pending) return
    setSaved(await run({ action: "policy", unitId, hospitalAction, hospitalRole }))
  }

  if (!units.length) return null
  return (
    <section className={`${panel.panel} ${styles.stack}`} aria-label="院級流程設定">
      <h2 className={styles.title}>院級流程設定</h2>
      <LoadingFeedback message={pending ? "正在儲存簽核設定…" : undefined} />
      <form onSubmit={submit} className={styles.stack} aria-busy={pending}>
        <Select items={units} value={unitId ? String(unitId) : null} placeholder="選擇排班單位" presentation="auto"
          disabled={pending} onValueChange={(value) => {
            const selected = policies.find((policy) => String(policy.unitId) === value)
            setUnitId(selected?.unitId)
            setAction(selected?.hospitalAction ?? null)
            setRole(selected?.hospitalRole ?? null)
            setSaved(false)
          }}>
          <SelectLabel className={panel.label}>排班單位</SelectLabel>
          <SelectTrigger className={styles.select}><SelectValue /><ChevronDown size={17} aria-hidden="true" /></SelectTrigger>
          <SelectContent className={panel.options}>{units.map((option) =>
            <SelectItem key={option.value} value={option.value} className={panel.option}>{option.label}</SelectItem>,
          )}</SelectContent>
        </Select>
        <div className={styles.policyChoices}>
          <Select items={hospitalActions} value={hospitalAction} placeholder="選擇院級動作" presentation="auto"
            disabled={!unitId || pending} onValueChange={(value) => {
              if (value === "approve" || value === "notify") { setAction(value); setSaved(false) }
            }}>
            <SelectLabel className={panel.label}>院級動作</SelectLabel>
            <SelectTrigger className={styles.select}><SelectValue /><ChevronDown size={17} aria-hidden="true" /></SelectTrigger>
            <SelectContent className={panel.options}>{hospitalActions.map((option) =>
              <SelectItem key={option.value} value={option.value} className={panel.option}>{option.label}</SelectItem>,
            )}</SelectContent>
          </Select>
          <Select items={hospitalRoles} value={hospitalRole} placeholder="選擇承接身分" presentation="auto"
            disabled={!unitId || pending} onValueChange={(value) => {
              if (value === "head" || value === "deputy") { setRole(value); setSaved(false) }
            }}>
            <SelectLabel className={panel.label}>承接身分</SelectLabel>
            <SelectTrigger className={styles.select}><SelectValue /><ChevronDown size={17} aria-hidden="true" /></SelectTrigger>
            <SelectContent className={panel.options}>{hospitalRoles.map((option) =>
              <SelectItem key={option.value} value={option.value} className={panel.option}>{option.label}</SelectItem>,
            )}</SelectContent>
          </Select>
        </div>
        {error && <p role="alert" className="notice error">{error}</p>}
        <p role="status">{saved ? "已儲存設定，適用於接下來送出的班表。" : ""}</p>
        <div className={styles.actions}><Button type="submit" className={styles.action} data-primary="true"
          disabled={!unitId || !hospitalAction || !hospitalRole || pending}>儲存設定</Button></div>
      </form>
    </section>
  )
}
