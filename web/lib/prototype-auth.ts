import "server-only"
import { randomUUID } from "node:crypto"
import { cookies } from "next/headers"
import { bindingMinutes } from "./binding-policy"
import { featureForPath, type Role } from "./features"

const employees = [
  { id: 1001, employeeNo: "DEMO-1001", name: "林予安", department: "護理部／病房組", role: "employee", scope: "本人", employmentStatus: "active", documentNo: "TEST000001", birthDate: "1992-06-15" },
  { id: 1002, employeeNo: "DEMO-1002", name: "許書庭", department: "護理部", role: "department", scope: "護理部及各級下層單位", employmentStatus: "active" },
  { id: 1003, employeeNo: "DEMO-1003", name: "陳以寧", department: "院長室", role: "executive", scope: "全院單位", employmentStatus: "active" },
  { id: 1004, employeeNo: "DEMO-1004", name: "周允哲", department: "資訊室", role: "admin", scope: "全院單位", employmentStatus: "active" },
  { id: 1005, employeeNo: "DEMO-1005", name: "何若晴", department: "護理部／病房組", role: "employee", scope: "本人", employmentStatus: "on_leave", documentNo: "TEST000005", birthDate: "1990-10-25" },
  { id: 1006, employeeNo: "DEMO-1006", name: "吳若寧", department: "護理部／病房組", role: "employee", scope: "本人", employmentStatus: "resigned", documentNo: "TEST000006", birthDate: "1988-01-10" },
] as const satisfies readonly {
  id: number; employeeNo: string; name: string; department: string; role: Role; scope: string;
  employmentStatus: "active" | "on_leave" | "resigned";
  documentNo?: string; birthDate?: string;
}[]

const subjects = ["first", "department", "executive", "admin", "leave", "resigned"] as const
type DemoSubject = (typeof subjects)[number]
type Employee = (typeof employees)[number]
type Expiring = { expiresAt: number }
type Session = Expiring & { employeeId: Employee["id"]; subject: DemoSubject }
type BindingWindow = Expiring & { failures: number }
type BindingFlow = Expiring & { subject: DemoSubject; returnTo: string; window: BindingWindow; employeeId?: Employee["id"] }

export const sessionCookie = "hr_prototype_session"
export const bindingCookie = "hr_prototype_binding"
export const sessionSeconds = 60 * 60 * 4

function createPrototypeStore() {
  return {
    sessions: new Map<string, Session>(),
    flows: new Map<string, BindingFlow>(),
    bindingWindows: new Map<string, BindingWindow>(),
    bindings: new Map<DemoSubject, Employee["id"]>([
      ["department", 1002], ["executive", 1003], ["admin", 1004], ["resigned", 1006],
    ]),
  }
}

// The local prototype runs in one Node process. None of this state survives a restart.
const shared = globalThis as typeof globalThis & { hrEmployeeBindingPrototype?: ReturnType<typeof createPrototypeStore> }
const store = (shared.hrEmployeeBindingPrototype ??= createPrototypeStore())

function readActive<T extends Expiring>(entries: Map<string, T>, id: string | undefined) {
  if (!id) return
  const record = entries.get(id)
  if (record && record.expiresAt <= Date.now()) {
    entries.delete(id)
    return
  }
  return record
}

function saveActive<T extends Expiring>(entries: Map<string, T>, record: T) {
  for (const [id, previous] of entries) {
    if (previous.expiresAt <= Date.now()) entries.delete(id)
  }
  const id = randomUUID()
  entries.set(id, record)
  return id
}

function findEmployee(id: Employee["id"] | undefined) {
  return employees.find((employee) => employee.id === id)
}

export function demoSubject(value: unknown) {
  return subjects.find((subject) => subject === value)
}

export function canUsePortal(employee: Employee) {
  return employee.employmentStatus !== "resigned"
}

export function matchEmployee(documentNo: unknown, birthDate: unknown) {
  if (typeof documentNo !== "string" || typeof birthDate !== "string") return
  const normalized = documentNo.trim().toUpperCase()
  return employees.find((employee) =>
    "documentNo" in employee && canUsePortal(employee)
      && employee.documentNo === normalized && employee.birthDate === birthDate,
  )
}

export function safeReturnPath(path: unknown) {
  return typeof path === "string" && featureForPath(path) ? path : "/"
}

export function bindingWindowFor(subject: DemoSubject) {
  const current = readActive(store.bindingWindows, subject)
  if (current) return current

  const window = { expiresAt: Date.now() + bindingMinutes * 60_000, failures: 0 }
  store.bindingWindows.set(subject, window)
  return window
}

export function startBinding(subject: DemoSubject, returnTo: string, window: BindingWindow) {
  return saveActive(store.flows, { subject, returnTo, window, expiresAt: window.expiresAt })
}

export function revokeBindingFlow(id: string | undefined) {
  if (id) store.flows.delete(id)
}

export function getBindingFlow(id: string | undefined) {
  return readActive(store.flows, id)
}

export function linkedEmployee(subject: DemoSubject) {
  return findEmployee(store.bindings.get(subject))
}

export function confirmBinding(flow: BindingFlow) {
  const employee = findEmployee(flow.employeeId)
  if (!employee) return { error: "請先完成員工資料比對。" } as const
  if (!canUsePortal(employee)) return { error: "目前無法使用人資服務，請聯絡人資。" } as const

  const linked = linkedEmployee(flow.subject)
  if (linked && linked.id !== employee.id) {
    return { error: "此 LINE 身分已綁定其他帳號，請聯絡系統管理者。" } as const
  }

  for (const [subject, employeeId] of store.bindings) {
    if (employeeId === employee.id && subject !== flow.subject) {
      return { error: "此院內帳號已綁定另一個 LINE 身分。如需換綁，請聯絡系統管理者。" } as const
    }
  }

  store.bindings.set(flow.subject, employee.id)
  return { employee } as const
}

export function startSession(employee: Employee, subject: DemoSubject) {
  return saveActive(store.sessions, {
    employeeId: employee.id, subject, expiresAt: Date.now() + sessionSeconds * 1000,
  })
}

export function revokeSession(id: string | undefined) {
  if (id) store.sessions.delete(id)
}

export async function currentIdentity() {
  const jar = await cookies()
  const session = readActive(store.sessions, jar.get(sessionCookie)?.value)
  if (!session) return
  const employee = linkedEmployee(session.subject)
  if (!employee || employee.id !== session.employeeId || !canUsePortal(employee)) return
  const { id, employeeNo, name, department, role, scope } = employee
  return { employee: { id, employeeNo, name, department, role, scope } }
}

export type Identity = NonNullable<Awaited<ReturnType<typeof currentIdentity>>>
