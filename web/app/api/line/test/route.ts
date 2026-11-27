import { NextRequest } from "next/server"
import { beginVerifiedLineBinding, bindingError, lineCookieOptions, lineResult as result } from "../../../../lib/line-binding-response"
import {
  confirmLineTest, endLineTest, isLinePilot, lineCookieNames, lineWebTokenHash,
  lineTestMode, matchLineTest, newLineWebToken,
} from "../../../../lib/line-test-db"
import { localLineTestSubject } from "../../../../lib/line-test-scenarios"
import { safeReturnPath, sessionSeconds } from "../../../../lib/prototype-auth"

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export async function POST(request: NextRequest) {
  const host = request.headers.get("host")
  const mode = lineTestMode(request.headers)
  if (!mode) return result({}, 404)
  const protocol = mode === "local" ? request.nextUrl.protocol : "https:"
  if (request.headers.get("origin") !== `${protocol}//${host}`) return result({}, 403)
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return result({}, 415)

  const input: unknown = await request.json().catch(() => null)
  if (!input || typeof input !== "object" || !("action" in input)) return result({}, 400)

  const cookieOptions = lineCookieOptions(request, mode)
  const names = lineCookieNames(mode)
  const loginHash = lineWebTokenHash(request.cookies.get(names.session)?.value)
  const pendingHash = lineWebTokenHash(request.cookies.get(names.binding)?.value)
  const destination = safeReturnPath("returnTo" in input ? input.returnTo : undefined)

  try {
    switch (input.action) {
      case "open-line": {
        if (mode !== "local") return result({}, 404)
        const subject = localLineTestSubject("idToken" in input ? input.idToken : undefined)
        if (!subject) return result({ error: "模擬 LINE 憑證驗證未通過，請重新開啟測試入口。" }, 401)
        return await beginVerifiedLineBinding(request, mode, subject, destination)
      }
      case "match-employee": {
        if (!pendingHash) return bindingError("expired")
        const id = "documentNo" in input && typeof input.documentNo === "string" && input.documentNo.trim().toUpperCase()
        const birthDate = "birthDate" in input ? input.birthDate : undefined
        const pilot = isLinePilot(mode)
        const documentPattern = pilot ? /^[A-Z][A-Z0-9][0-9]{8}$/ : /^Z0[0-9]{8}$/
        if (!id || !documentPattern.test(id) || !validDate(birthDate)) {
          return result({ error: pilot ? "請核對證件號碼格式與西元出生日期。" : "請輸入有效的合成證件號碼與西元出生日期。" }, 400)
        }
        const report = await matchLineTest(mode, pendingHash, id, birthDate)
        if (report?.outcome !== "matched") return bindingError(report?.outcome, report?.attempts_remaining)
        return result({ employee: { employeeNo: report.employee_no, name: report.employee_name, department: report.department } })
      }
      case "confirm-binding": {
        if (!pendingHash) return bindingError("expired")
        const token = newLineWebToken()
        const report = await confirmLineTest(mode, pendingHash, token.hash)
        if (report?.outcome !== "authenticated") return bindingError(report?.outcome)

        const response = result({ destination })
        response.cookies.set(names.binding, "", { ...cookieOptions, maxAge: 0 })
        response.cookies.set(names.session, token.value, { ...cookieOptions, maxAge: sessionSeconds })
        return response
      }
      case "cancel":
      case "logout": {
        await endLineTest(mode, pendingHash)
        const response = result({ destination: "/" })
        response.cookies.set(names.binding, "", { ...cookieOptions, maxAge: 0 })
        if (input.action === "logout") {
          await endLineTest(mode, loginHash)
          response.cookies.set(names.session, "", { ...cookieOptions, maxAge: 0 })
        }
        return response
      }
      default: return result({}, 400)
    }
  } catch {
    // The request may contain a token or identity fields, so keep details out of logs and responses.
    return bindingError(undefined)
  }
}
