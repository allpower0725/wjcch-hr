import "server-only"

import { NextRequest, NextResponse } from "next/server"
import { endLineTest, lineCookieNames, lineWebTokenHash, newLineWebToken, openLineTest, type LineTestMode } from "./line-test-db"
import { safeReturnPath } from "./prototype-auth"

export function lineResult(data: object, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } })
}

export function bindingError(outcome: string | undefined, remainingAttempts?: number | null) {
  switch (outcome) {
    case "locked": return lineResult({ error: "比對失敗已達 5 次，請於原驗證期限結束後再試。", remainingAttempts: 0, restart: true }, 423)
    case "expired": return lineResult({ error: "這次綁定驗證已逾時，請重新確認 LINE 身分。", restart: true }, 410)
    case "mismatch": return lineResult({ error: "員工資料比對未通過，請核對證件號碼及出生日期。", remainingAttempts }, 422)
    case "match_required": return lineResult({ error: "請重新比對員工資料後再確認綁定。", restart: true }, 409)
    case "binding_conflict": return lineResult({ error: "目前無法完成綁定。請重新確認 LINE 身分。", restart: true }, 409)
    case "pilot_denied": return lineResult({ error: "此 LINE 帳號尚未開放本次驗收。" }, 403)
    case "ineligible": return lineResult({ error: "目前無法使用這個身分登入。" }, 403)
    default: return lineResult({ error: "暫時無法連線，請稍後重試。" }, 503)
  }
}

export function lineCookieOptions(request: NextRequest, mode: LineTestMode) {
  return { httpOnly: true, sameSite: "lax" as const, secure: mode !== "local" || request.nextUrl.protocol === "https:", path: "/" }
}

export async function beginVerifiedLineBinding(request: NextRequest, mode: LineTestMode, subject: string, returnTo: unknown) {
  const token = newLineWebToken()
  const report = await openLineTest(mode, subject, token.hash)
  if (!report?.deadline || (report.outcome !== "authenticated" && report.outcome !== "binding_required")) {
    return bindingError(report?.outcome)
  }

  const names = lineCookieNames(mode)
  const pendingHash = lineWebTokenHash(request.cookies.get(names.binding)?.value)
  const loginHash = lineWebTokenHash(request.cookies.get(names.session)?.value)
  await endLineTest(mode, pendingHash)
  await endLineTest(mode, loginHash)
  const cookieOptions = lineCookieOptions(request, mode)
  if (report.outcome === "authenticated") {
    const response = lineResult({ destination: safeReturnPath(returnTo) })
    response.cookies.set(names.binding, "", { ...cookieOptions, maxAge: 0 })
    response.cookies.set(names.session, token.value, { ...cookieOptions, expires: report.deadline })
    return response
  }

  const response = lineResult({ needsBinding: true, remainingAttempts: report.attempts_remaining })
  response.cookies.set(names.session, "", { ...cookieOptions, maxAge: 0 })
  response.cookies.set(names.binding, token.value, { ...cookieOptions, expires: report.deadline })
  return response
}
