import type { Metadata } from "next"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { Button } from "@ui-sdk/react/button"
import { ArrowLeft } from "lucide-react"
import { AnimatedMain } from "../../components/animated-main"
import { LogoutButton } from "../../components/auth-client"
import { PortalLink } from "../../components/loading-state"
import { PortalEntry } from "../../components/portal"
import { RosterDraftEditor } from "../../components/roster-draft-editor"
import { RosterUnitSelect } from "../../components/roster-unit-select"
import { AppShell } from "../../components/shell"
import { rosterFeature } from "../../lib/features"
import { currentLineTestIdentity, lineTestMode } from "../../lib/line-test-db"
import { isRosterMode, readRosterWorkspace } from "../../lib/roster-db"
import { readRosterDraft } from "../../lib/roster-draft-db"
import { taipeiDate, validRosterDate, validRosterMonth } from "../../lib/roster-draft"
import styles from "../../components/roster-workspace.module.css"

export const metadata: Metadata = { title: rosterFeature.title }

export default async function RosterPage({ searchParams }: PageProps<"/roster">) {
  const mode = lineTestMode(await headers())
  if (!isRosterMode(mode)) notFound()

  const hosted = mode !== "local"
  const identity = await currentLineTestIdentity(mode)
  if (!identity) return <PortalEntry feature={rosterFeature} database hosted={hosted} />

  const { unit, month: requestedMonth, date, view, person } = await searchParams
  if (requestedMonth !== undefined && !validRosterMonth(requestedMonth)) notFound()
  let unitId: number | null = null
  if (unit !== undefined) {
    if (typeof unit !== "string" || !/^[1-9][0-9]{0,9}$/.test(unit)) notFound()
    unitId = Number(unit)
    if (unitId > 2147483647) notFound()
  }

  const roster = await readRosterWorkspace(mode, identity.employee.employeeNo, unitId)
  if (!roster) return <PortalEntry feature={rosterFeature} database hosted={hosted} />

  const selected = roster.units.find((item) => item.id === roster.selectedUnitId)
  if (unitId !== null && !selected) notFound()
  const today = taipeiDate()
  const month = requestedMonth ?? today.slice(0, 7)
  const initialDate = validRosterDate(date) && date.startsWith(month + "-") ? date
    : today.startsWith(month + "-") ? today : month + "-01"
  const initialView = view === "edit" || view === "week" ? view : "month"
  const initialPerson = typeof person === "string" && /^[1-9][0-9]{0,9}$/.test(person) ? Number(person) : undefined
  const draft = selected ? await readRosterDraft(mode, identity.employee.employeeNo, selected.id, month) : undefined
  const back = (
    <Button className={styles.back} render={<PortalLink href="/" />} aria-label="返回工作台">
      <ArrowLeft size={22} aria-hidden="true" />
    </Button>
  )

  return (
    <AppShell database hosted={hosted} actions={<LogoutButton database />}>
      <AnimatedMain className={`site-width workspace ${styles.page}`} scene="feature">
        <div className={styles.workspace} data-reveal>
          {selected ? (
            <RosterDraftEditor key={`${selected.id}/${month}/${initialDate}`} unit={selected} units={roster.units}
              month={month} back={back} people={roster.people} viewerId={roster.viewerId} draft={draft}
              initialDate={initialDate} initialView={initialView} initialPerson={initialPerson} />
          ) : <>
            <header className={styles.pageHeader}>{back}<h1 className={styles.title}>月班表編輯</h1></header>
            <p className={styles.panel}>目前沒有可排班的單位。</p>
          </>}
        </div>
      </AnimatedMain>
    </AppShell>
  )
}
