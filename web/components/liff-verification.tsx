"use client"

import { ArrowRight, CircleAlert, ShieldCheck } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { LineBinding } from "./auth-client"
import { LoadingFeedback } from "./loading-state"

type LiffSdk = typeof import("@line/liff").default
type VerificationState =
  | { status: "loading"; message: string }
  | { status: "login"; reauthorize: boolean }
  | { status: "verified" }
  | { status: "binding"; attempts: number }
  | { status: "error"; message: string }

const connectionError = "暫時無法完成 LINE 驗證，請稍後重試。"

export function LiffVerification({ liffId, binding = false, returnTo = "/", scenario = "first", tunnel = false, pilot = false }: {
  liffId: string; binding?: boolean; returnTo?: string; scenario?: string; tunnel?: boolean; pilot?: boolean;
}) {
  const [state, setState] = useState<VerificationState>({ status: "loading", message: "正在初始化 LINE…" })
  const initialized = useRef<Promise<LiffSdk> | null>(null)

  useEffect(() => {
    const pending = new AbortController()
    let active = true

    async function verify() {
      try {
        initialized.current ??= import("@line/liff").then(async ({ default: liff }) => {
          await liff.init({ liffId })
          return liff
        })
        const liff = await initialized.current
        if (!active) return

        const idToken = liff.getIDToken()
        if (!idToken) {
          setState(liff.isInClient()
            ? { status: "error", message: "目前無法取得 LINE 憑證，請從 LINE 重新開啟入口。" }
            : { status: "login", reauthorize: liff.isLoggedIn() })
          return
        }

        setState({ status: "loading", message: "正在驗證 LINE 憑證…" })
        const response = await fetch("/api/line/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, returnTo }),
          signal: pending.signal,
        })
        const report = await response.json()
        if (!active) return

        if (response.ok && binding && typeof report.destination === "string") {
          window.location.replace(report.destination)
        } else if (response.ok && binding && report.needsBinding === true && Number.isInteger(report.remainingAttempts)) {
          setState({ status: "binding", attempts: report.remainingAttempts })
        } else if (response.ok && report.verified === true) {
          setState({ status: "verified" })
        } else if (binding && typeof report.error === "string") {
          setState({ status: "error", message: report.error })
        } else if (response.status === 401 || response.status === 400) {
          setState(liff.isInClient()
            ? { status: "error", message: "LINE 憑證驗證未通過，請從 LINE 重新開啟入口。" }
            : { status: "login", reauthorize: true })
        } else {
          setState({ status: "error", message: connectionError })
        }
      } catch {
        if (active) setState({ status: "error", message: connectionError })
      }
    }

    void verify()
    return () => {
      active = false
      pending.abort()
    }
  }, [binding, liffId, returnTo])

  async function login(reauthorize: boolean) {
    setState({ status: "loading", message: "正在開啟 LINE 授權…" })
    try {
      const liff = await initialized.current
      if (!liff) throw new Error("LIFF SDK unavailable")
      if (reauthorize && liff.isLoggedIn()) liff.logout()
      liff.login()
    } catch {
      setState({ status: "error", message: connectionError })
    }
  }

  if (state.status === "binding") {
    return <LineBinding database tunnel={tunnel} pilot={pilot} scenario={scenario} returnTo={returnTo} verifiedAttempts={state.attempts} />
  }

  const description = pilot ? "使用你的 LINE 帳號進行正式資料驗收。"
    : binding ? "使用 LINE 帳號進入人資工作台測試站。" : "使用 LINE 帳號確認這個測試入口的登入連線。"

  return (
    <div className="auth-card" aria-busy={state.status === "loading"}>
      <LoadingFeedback message={state.status === "loading" ? state.message : undefined} />
      <div className="auth-heading">
        <span className="auth-icon"><ShieldCheck aria-hidden="true" /></span>
        <h1>LINE 身分驗證</h1>
        <p>{description}</p>
      </div>
      <div role="status" aria-atomic="true">
        {state.status === "verified" && <p className="notice info"><ShieldCheck size={18} aria-hidden="true" />LINE 憑證驗證成功。</p>}
      </div>
      <div role="alert" aria-atomic="true">
        {state.status === "error" && <p className="notice error"><CircleAlert size={18} aria-hidden="true" />{state.message}</p>}
      </div>
      {state.status === "loading" && <p className="form-note">{state.message}</p>}
      {state.status === "login" && (
        <div className="flow-form">
          {state.reauthorize && <p className="form-note">請重新取得 LINE 授權，再完成驗證。</p>}
          <button className="button primary" onClick={() => void login(state.reauthorize)}>
            {state.reauthorize ? "重新取得 LINE 授權" : "使用 LINE 驗證"}<ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
      )}
      {state.status === "error" && (
        <button className="button primary" onClick={() => window.location.reload()}>重試<ArrowRight size={18} aria-hidden="true" /></button>
      )}
    </div>
  )
}
