import { validRosterMonth } from "./roster-draft"

export type ApprovalState = {
  versionId: string | null
  revision: number
  status: "draft" | "submitted" | "effective"
  caseId: string | null
  late: boolean
  dueDate: string
  responsible: string | null
  isSubmitter: boolean
  canSubmit: boolean
  canWithdraw: boolean
  canReview: boolean
  missingUnits: string[]
  blockReason: string | null
  lastReturn: string | null
}

export type ApprovalCard = {
  caseId: string
  unit: string
  month: string
  version: number
  status: string
  submittedAt: string
  submittedBy: string
  late: boolean
  position: number | null
  assignee: string | null
  canReview: boolean
  canWithdraw: boolean
  notice: boolean
  blockReason: string | null
}

export type ApprovalDetail = ApprovalCard & {
  steps: { position: number; employee: string | null; action: "approve" | "notify"; status: string; units: string[] }[]
  events: { id: string; actor: string; action: string; at: string; reason: string | null }[]
  days: { id: string; employee: string; date: string; shift: string; note: string | null; times: [string, string][] }[]
}

export type HospitalAction = "approve" | "notify"
export type HospitalRole = "head" | "deputy"
export type ApprovalPolicy = {
  unitId: number
  unit: string
  hospitalAction: HospitalAction | null
  hospitalRole: HospitalRole | null
}

export type ApprovalQueue = { admin: boolean; manager: boolean; cards: ApprovalCard[]; policies: ApprovalPolicy[] }
export type ApprovalMutation =
  | { action: "submit"; unitId: number; month: string; revision: number }
  | { action: "withdraw"; caseId: string }
  | { action: "approve" | "return" | "reject"; caseId: string; position: number; reason: string }
  | { action: "policy"; unitId: number; hospitalAction: HospitalAction; hospitalRole: HospitalRole }
export type ApprovalRequest = ApprovalMutation
  | { action: "state"; unitId: number; month: string }
  | { action: "queue" }
  | { action: "detail"; caseId: string }
export type ApprovalFailure = { error: string; status: number }

const integer = (value: unknown, min: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= 2147483647
export const approvalCaseId = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n

export function parseApprovalMutation(value: unknown): ApprovalMutation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return
  const { action, unitId, month, revision, caseId, position, reason, hospitalAction, hospitalRole } = value as Record<string, unknown>
  if (action === "submit" && integer(unitId, 1) && validRosterMonth(month) && integer(revision, 0)) {
    return { action, unitId, month, revision }
  }
  if (action === "withdraw" && approvalCaseId(caseId)) return { action, caseId }
  if ((action === "approve" || action === "return" || action === "reject") && approvalCaseId(caseId) &&
      integer(position, 1) && typeof reason === "string" && Array.from(reason).length <= 500) {
    return { action, caseId, position, reason: reason.trim() }
  }
  if (action === "policy" && integer(unitId, 1) && (hospitalAction === "approve" || hospitalAction === "notify")
      && (hospitalRole === "head" || hospitalRole === "deputy")) return { action, unitId, hospitalAction, hospitalRole }
}

export const approvalStatusLabels: Record<string, string> = {
  draft: "草稿", submitted: "簽核中", effective: "已生效", withdrawn: "已取回", returned: "已退回",
  rejected: "已駁回", superseded: "已替換", waiting: "待處理", approved: "已核准", notified: "已知會",
}
export const approvalActionLabels: Record<string, string> = {
  submit: "送出", withdraw: "取回", approve: "核准", return: "退回", reject: "駁回", effective: "生效", notify: "知會", policy: "儲存設定",
}
