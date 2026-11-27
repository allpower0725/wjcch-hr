"use client"

import { useTransition } from "react"
import { useRouter } from "next/navigation"
import { Check, ChevronDown } from "lucide-react"
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectLabel, SelectTrigger, SelectValue } from "@ui-sdk/react/select"
import type { RosterUnit } from "../lib/roster-db"
import type { RosterView } from "../lib/roster-calendar"
import { LoadingFeedback } from "./loading-state"
import styles from "./roster-workspace.module.css"

export function RosterUnitSelect({ units, selectedId, month, date, view }: {
  units: RosterUnit[]
  selectedId: number
  month: string
  date: string
  view: RosterView
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const value = String(selectedId)
  const selected = units.find((unit) => unit.id === selectedId)
  const items = units.map((unit) => ({ value: String(unit.id), label: unit.label }))

  return (
    <>
      <Select items={items} value={value} presentation="auto" onValueChange={(next) => {
        if (next === null || next === value) return
        const search = new URLSearchParams({ unit: next, month, date, view })
        startTransition(() => router.replace(`/roster?${search}`, { scroll: false }))
      }}>
        <SelectLabel className={styles.label}>排班單位</SelectLabel>
        <SelectTrigger className={styles.trigger} title={selected?.label}>
          <SelectValue className={styles.triggerValue}>{() => selected?.name}</SelectValue>
          <ChevronDown className={styles.chevron} size={16} aria-hidden="true" />
        </SelectTrigger>
        <SelectContent className={styles.options} sideOffset={8} collisionPadding={12}>
          {items.map((item) => (
            <SelectItem className={styles.option} key={item.value} value={item.value}>
              <span className={styles.value}>{item.label}</span>
              <SelectItemIndicator className={styles.indicator}><Check size={16} aria-hidden="true" /></SelectItemIndicator>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <LoadingFeedback message={pending ? "載入排班人員…" : undefined} />
    </>
  )
}
