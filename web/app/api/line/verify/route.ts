import { NextRequest, NextResponse } from "next/server"
import { beginVerifiedLineBinding, bindingError } from "../../../../lib/line-binding-response"
import { lineTestMode } from "../../../../lib/line-test-db"
import { localLineTunnelOrigin } from "../../../../lib/prototype-host"

const lineVerifier = "https://api.line.me/oauth2/v2.1/verify"
const tokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

function result(verified: boolean, status: number) {
  return NextResponse.json({ verified }, { status, headers: { "Cache-Control": "no-store" } })
}

export async function POST(request: NextRequest) {
  const host = request.headers.get("host")
  const mode = lineTestMode(request.headers)
  const verifiedMode = mode !== "local" ? mode : undefined
  if (localLineTunnelOrigin() && !verifiedMode) return result(false, 404)
  const protocol = verifiedMode ? "https:" : request.nextUrl.protocol
  if (!host || request.headers.get("origin") !== protocol + "//" + host) {
    return result(false, 403)
  }

  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return result(false, 415)
  }

  const channelId = process.env.LINE_LOGIN_CHANNEL_ID?.trim()
  if (!channelId) return result(false, 503)

  const body: unknown = await request.json().catch(() => null)
  const token = body && typeof body === "object" && "idToken" in body ? body.idToken : null
  if (typeof token !== "string" || token.length > 8192 || !tokenPattern.test(token)) {
    return result(false, 400)
  }

  try {
    const response = await fetch(lineVerifier, {
      method: "POST",
      body: new URLSearchParams({ id_token: token, client_id: channelId }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(6000),
    })

    if (response.status === 400 || response.status === 401) return result(false, 401)
    if (!response.ok) return result(false, 502)

    const claims = await response.json()
    const verified = claims?.iss === "https://access.line.me"
      && claims.aud === channelId
      && typeof claims.sub === "string" && !!claims.sub
      && typeof claims.exp === "number" && claims.exp > Date.now() / 1000

    if (!verified) return result(false, 401)
    if (!verifiedMode) return result(true, 200)
    if (!/^U[0-9a-fA-F]{32}$/.test(claims.sub)) return result(false, 401)
    const returnTo = body && typeof body === "object" && "returnTo" in body ? body.returnTo : undefined
    try {
      return await beginVerifiedLineBinding(request, verifiedMode, claims.sub, returnTo)
    } catch {
      return bindingError(undefined)
    }
  } catch {
    return result(false, 502)
  }
}
