import { NextRequest, NextResponse } from "next/server"
import { lineTestMode } from "../../../../lib/line-test-db"
import { parseApprovalMutation } from "../../../../lib/roster-approval"
import { rosterApproval } from "../../../../lib/roster-approval-db"
import { canUseRosterDrafts } from "../../../../lib/roster-db"

export async function POST(request: NextRequest) {
  const mode = lineTestMode(request.headers)
  if (!canUseRosterDrafts(mode)) return NextResponse.json({}, { status: 404 })
  const protocol = mode === "local" ? request.nextUrl.protocol : "https:"
  if (request.headers.get("origin") !== protocol + "//" + request.headers.get("host")) {
    return NextResponse.json({ error: "無法從這個來源處理簽核。" }, { status: 403 })
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "班表簽核資料格式有誤。" }, { status: 415 })
  }
  const mutation = parseApprovalMutation(await request.json().catch(() => null))
  if (!mutation) return NextResponse.json({ error: "請檢查班表簽核資料。" }, { status: 400 })
  try {
    const result = await rosterApproval<{ caseId?: string; saved?: boolean; effective?: boolean }>(mode, mutation)
    return "error" in result
      ? NextResponse.json({ error: result.error }, { status: result.status })
      : NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: "暫時無法處理班表簽核，請稍後再試。" }, { status: 503 })
  }
}
