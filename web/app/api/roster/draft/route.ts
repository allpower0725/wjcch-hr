import { NextRequest, NextResponse } from "next/server"
import { currentLineTestIdentity, lineTestMode } from "../../../../lib/line-test-db"
import { saveCloudRosterDraft, saveRosterDraft } from "../../../../lib/roster-draft-db"
import { canUseRosterDrafts } from "../../../../lib/roster-db"
import { parseRosterEdit, rosterSegmentError } from "../../../../lib/roster-draft"

export async function POST(request: NextRequest) {
  const mode = lineTestMode(request.headers)
  if (!canUseRosterDrafts(mode)) return NextResponse.json({}, { status: 404 })
  const host = request.headers.get("host")
  const protocol = mode === "local" ? request.nextUrl.protocol : "https:"
  if (request.headers.get("origin") !== `${protocol}//${host}`) {
    return NextResponse.json({ error: "無法從這個來源儲存班次。" }, { status: 403 })
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return NextResponse.json({ error: "班表資料格式有誤。" }, { status: 415 })
  }
  const edit = parseRosterEdit(await request.json().catch(() => null))
  if (!edit) return NextResponse.json({ error: "請檢查人員、日期和班次內容。" }, { status: 400 })
  const issue = edit.entry?.kind === "work" && rosterSegmentError(edit.entry.segments)
  if (issue) return NextResponse.json({ error: issue }, { status: 422 })

  try {
    let result
    if (mode === "cloud-pilot") {
      result = await saveCloudRosterDraft(edit)
    } else {
      const identity = await currentLineTestIdentity(mode)
      if (!identity) return NextResponse.json({ error: "請重新登入。" }, { status: 401 })
      result = await saveRosterDraft(mode, identity.employee.employeeNo, edit)
    }
    return "status" in result
      ? NextResponse.json({ error: result.error }, { status: result.status })
      : NextResponse.json(result)
  } catch {
    return NextResponse.json({ error: "暫時無法儲存班次，請稍後再試。" }, { status: 503 })
  }
}
