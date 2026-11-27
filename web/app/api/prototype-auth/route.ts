import { NextRequest, NextResponse } from "next/server"
import { bindingFailureLimit } from "../../../lib/binding-policy"
import {
  bindingCookie, bindingWindowFor, canUsePortal, confirmBinding, demoSubject, getBindingFlow,
  linkedEmployee, matchEmployee, revokeBindingFlow, revokeSession, safeReturnPath, sessionCookie,
  sessionSeconds, startBinding, startSession,
} from "../../../lib/prototype-auth"
import { isLocalPrototypeHost } from "../../../lib/prototype-host"

export const runtime = "nodejs"

function bindingLimitResponse(window: ReturnType<typeof bindingWindowFor>) {
  if (window.failures < bindingFailureLimit) return
  const retryAfter = Math.max(1, Math.ceil((window.expiresAt - Date.now()) / 1000))
  return NextResponse.json({
    error: `已達 ${bindingFailureLimit} 次比對失敗上限，請於約 ${Math.ceil(retryAfter / 60)} 分鐘後重試。`,
    restart: true,
  }, { status: 429, headers: { "Retry-After": String(retryAfter) } })
}

export async function POST(request: NextRequest) {
  const host = request.headers.get("host")
  if (!isLocalPrototypeHost(host)) return new NextResponse(null, { status: 404 })

  const protocol = request.nextUrl.protocol
  if (!host || request.headers.get("origin") !== `${protocol}//${host}`) {
    return NextResponse.json({ error: "請從人資工作台重新操作。" }, { status: 403 })
  }

  const body: unknown = await request.json().catch(() => null)
  if (!body || typeof body !== "object" || !("action" in body)) {
    return NextResponse.json({ error: "無法辨識操作。" }, { status: 400 })
  }

  const input = body as Record<string, unknown>
  const flowId = request.cookies.get(bindingCookie)?.value
  const sessionId = request.cookies.get(sessionCookie)?.value
  const cookieOptions = {
    httpOnly: true, sameSite: "lax" as const, path: "/", secure: protocol === "https:",
  }

  function expireFlow(response: NextResponse) {
    revokeBindingFlow(flowId)
    response.cookies.set(bindingCookie, "", { ...cookieOptions, maxAge: 0 })
    return response
  }

  function signIn(employee: Parameters<typeof startSession>[0], destination: string, subject: Parameters<typeof startSession>[1]) {
    const response = NextResponse.json({ destination })
    revokeSession(sessionId)
    const token = startSession(employee, subject)
    response.cookies.set(sessionCookie, token, { ...cookieOptions, maxAge: sessionSeconds })
    return expireFlow(response)
  }

  switch (input.action) {
    case "logout": {
      revokeSession(sessionId)
      const response = NextResponse.json({ destination: "/" })
      response.cookies.set(sessionCookie, "", { ...cookieOptions, maxAge: 0 })
      return expireFlow(response)
    }
    case "cancel":
      return expireFlow(NextResponse.json({ destination: "/" }))
    case "open-line": {
      const subject = demoSubject(input.scenario)
      if (!subject) return NextResponse.json({ error: "無法辨識 LINE 測試情境。" }, { status: 400 })
      const destination = safeReturnPath(input.returnTo)
      const employee = linkedEmployee(subject)
      if (employee) {
        if (!canUsePortal(employee)) {
          return expireFlow(NextResponse.json({ error: "目前無法使用人資服務，請聯絡人資。" }, { status: 403 }))
        }
        return signIn(employee, destination, subject)
      }

      const window = bindingWindowFor(subject)
      const limited = bindingLimitResponse(window)
      if (limited) return expireFlow(limited)
      revokeBindingFlow(flowId)
      const response = NextResponse.json({ needsBinding: true, remainingAttempts: bindingFailureLimit - window.failures })
      const secondsLeft = Math.ceil((window.expiresAt - Date.now()) / 1000)
      response.cookies.set(bindingCookie, startBinding(subject, destination, window), { ...cookieOptions, maxAge: secondsLeft })
      return response
    }
    case "match-employee": {
      const flow = getBindingFlow(flowId)
      if (!flow) {
        return NextResponse.json({ error: "驗證已逾時，請重新開啟 LINE 入口。", restart: true }, { status: 409 })
      }
      const limited = bindingLimitResponse(flow.window)
      if (limited) return expireFlow(limited)

      delete flow.employeeId
      const employee = matchEmployee(input.documentNo, input.birthDate)
      if (!employee) {
        flow.window.failures += 1
        const locked = bindingLimitResponse(flow.window)
        if (locked) return expireFlow(locked)
        return NextResponse.json({
          error: "資料比對未通過。請確認所填資料後重試。",
          remainingAttempts: bindingFailureLimit - flow.window.failures,
        }, { status: 422 })
      }

      flow.employeeId = employee.id
      return NextResponse.json({ employee: { name: employee.name, employeeNo: employee.employeeNo, department: employee.department } })
    }
    case "confirm-binding": {
      const flow = getBindingFlow(flowId)
      if (!flow) {
        return NextResponse.json({ error: "綁定已逾時，請重新開啟 LINE 入口。", restart: true }, { status: 409 })
      }
      const limited = bindingLimitResponse(flow.window)
      if (limited) return expireFlow(limited)
      const result = confirmBinding(flow)
      if (result.error) return NextResponse.json({ error: result.error }, { status: 409 })
      return signIn(result.employee, flow.returnTo, flow.subject)
    }
    default:
      return NextResponse.json({ error: "無法辨識操作。" }, { status: 400 })
  }
}
