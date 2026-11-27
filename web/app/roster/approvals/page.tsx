import type { Metadata } from "next"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { Button } from "@ui-sdk/react/button"
import { ArrowLeft } from "lucide-react"
import { AnimatedMain } from "../../../components/animated-main"
import { LogoutButton } from "../../../components/auth-client"
import { PortalLink } from "../../../components/loading-state"
import { PortalEntry } from "../../../components/portal"
import { ApprovalAction, ApprovalPolicyEditor } from "../../../components/roster-approval-actions"
import { AppShell } from "../../../components/shell"
import { rosterApprovalFeature } from "../../../lib/features"
import { currentLineTestIdentity, lineTestMode } from "../../../lib/line-test-db"
import { approvalActionLabels, approvalCaseId, approvalStatusLabels, type ApprovalDetail, type ApprovalQueue } from "../../../lib/roster-approval"
import { rosterApproval } from "../../../lib/roster-approval-db"
import { canUseRosterDrafts, isRosterMode } from "../../../lib/roster-db"
import panel from "../../../components/roster-workspace.module.css"
import styles from "../../../components/roster-approval.module.css"

export const metadata: Metadata = { title: rosterApprovalFeature.title }
const timestamp = new Intl.DateTimeFormat("zh-TW", {
  dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Taipei",
})

export default async function RosterApprovalsPage({ searchParams }: PageProps<"/roster/approvals">) {
  const mode = lineTestMode(await headers())
  if (!isRosterMode(mode)) notFound()
  const hosted = mode !== "local"
  const identity = await currentLineTestIdentity(mode)
  if (!identity) return <PortalEntry feature={rosterApprovalFeature} database hosted={hosted} />
  if (!canUseRosterDrafts(mode)) notFound()

  const { case: selected } = await searchParams
  if (selected !== undefined && !approvalCaseId(selected)) notFound()
  const request = selected ? { action: "detail" as const, caseId: selected } : { action: "queue" as const }
  const result = await rosterApproval<ApprovalQueue | ApprovalDetail>(mode, request, identity.employee.employeeNo)
    .catch(() => ({ status: 503, error: "暫時無法讀取班表簽核。" }))
  const back = selected ? "/roster/approvals" : "/roster?view=edit"

  return (
    <AppShell database hosted={hosted} actions={<LogoutButton database />}>
      <AnimatedMain className={`site-width workspace ${panel.page}`} scene="feature">
        <div className={`${panel.workspace} ${styles.workflow}`} data-reveal>
          <header className={panel.pageHeader}>
            <Button className={panel.back} render={<PortalLink href={back} />} aria-label={selected ? "返回主管簽核" : "返回班表"}>
              <ArrowLeft size={22} aria-hidden="true" />
            </Button>
            <h1 className={panel.title}>主管簽核</h1>
          </header>
          {"error" in result ? <p className="notice error" role="alert">{result.error}</p>
            : "cards" in result ? <ApprovalList queue={result} /> : <ApprovalCase detail={result} />}
        </div>
      </AnimatedMain>
    </AppShell>
  )
}

function ApprovalList({ queue }: { queue: ApprovalQueue }) {
  return (
    <>
      <section className={`${panel.panel} ${styles.stack}`} aria-labelledby="approval-inbox-title">
        <div className={styles.heading}>
          <h2 className={styles.title} id="approval-inbox-title">班表待辦與知會</h2>
          <span className={panel.count}>{queue.cards.length} 件</span>
        </div>
        {queue.cards.length === 0 && <p>目前沒有待處理的班表。</p>}
        <ul className={styles.items}>
          {queue.cards.map((card) => <li key={card.caseId} className={styles.item}>
            <PortalLink href={`/roster/approvals?case=${card.caseId}`}>{card.unit} · {card.month}</PortalLink>
            <p>{card.notice ? "院級知會" : approvalStatusLabels[card.status]} · 第 {card.version} 版{card.late && " · 逾期送出"}</p>
            {card.blockReason && <p className={styles.warning}>{card.blockReason}</p>}
          </li>)}
        </ul>
      </section>
      {queue.admin && <ApprovalPolicyEditor policies={queue.policies} />}
    </>
  )
}

function ApprovalCase({ detail }: { detail: ApprovalDetail }) {
  return (
    <>
      <section className={`${panel.panel} ${styles.stack}`} aria-labelledby="approval-case-title">
        <div className={styles.heading}>
          <h2 className={styles.title} id="approval-case-title">{detail.unit} · {detail.month}</h2>
          <span className={panel.count}>{approvalStatusLabels[detail.status]}</span>
        </div>
        <p>第 {detail.version} 版 · {detail.submittedBy} · {timestamp.format(new Date(detail.submittedAt))}
          {detail.late && <span className={styles.warning}> · 逾期送出</span>}</p>
        {detail.assignee && detail.status === "submitted" && <p>目前簽核人 {detail.assignee}</p>}
        {detail.blockReason && <p className={styles.warning}>{detail.blockReason}</p>}
        {detail.canReview && detail.position !== null && <div className={styles.actions}>
          {(["approve", "return", "reject"] as const).map((action) =>
            <ApprovalAction key={action} request={{ action, caseId: detail.caseId, position: detail.position!, reason: "" }} />,
          )}
        </div>}
      </section>
      <section className={`${panel.panel} ${styles.stack}`} aria-labelledby="approval-steps-title">
        <h2 className={styles.title} id="approval-steps-title">簽核關卡</h2>
        {detail.steps.length === 0 && <p>目前沒有已分派的關卡。</p>}
        <ol className={styles.items}>
          {detail.steps.map((step) => <li key={step.position} className={styles.item}>
            <strong>{step.position}. {step.units.join("、")} · {step.employee ?? "待分派"}</strong>
            <p>{approvalActionLabels[step.action]} · {approvalStatusLabels[step.status]}</p>
          </li>)}
        </ol>
      </section>
      <section className={`${panel.panel} ${styles.stack}`} aria-labelledby="approval-days-title">
        <h2 className={styles.title} id="approval-days-title">送出班表（{detail.days.length} 筆）</h2>
        <ul className={styles.items}>
          {detail.days.map((day) => <li key={day.id} className={styles.item}>
            <strong>{day.date} · {day.employee} · {day.shift}</strong>
            {day.times.length > 0 && <p>{day.times.map(([start, end]) => `${start}–${end}`).join("、")}</p>}
            {day.note && <p>{day.note}</p>}
          </li>)}
        </ul>
      </section>
      <section className={`${panel.panel} ${styles.stack}`} aria-labelledby="approval-events-title">
        <h2 className={styles.title} id="approval-events-title">處理紀錄</h2>
        <ul className={styles.items}>
          {detail.events.map((event) => <li key={event.id} className={styles.item}>
            <strong>{approvalActionLabels[event.action]} · {event.actor}</strong>
            <p>{timestamp.format(new Date(event.at))}{event.reason && ` · ${event.reason}`}</p>
          </li>)}
        </ul>
      </section>
    </>
  )
}
