"use client"

import { useEffect, useRef, useState, type FormEvent } from "react"
import { ArrowRight, CircleAlert, Fingerprint, Link2, LogOut, ShieldCheck } from "lucide-react"
import gsap from "gsap"
import { useGSAP } from "@gsap/react"
import { bindingFailureLimit, bindingMinutes } from "../lib/binding-policy"
import { lineTestScenarios, lineTunnelTestScenarios } from "../lib/line-test-scenarios"
import { LoadingFeedback } from "./loading-state"

gsap.registerPlugin(useGSAP)

type VerifiedEmployee = { employeeNo: string; name: string; department: string }
type Flow =
  | { step: "open" }
  | { step: "match" }
  | { step: "bind"; employee: VerifiedEmployee }

type AuthResult = {
  destination?: string
  employee?: VerifiedEmployee
  error?: string
  needsBinding?: boolean
  restart?: boolean
  remainingAttempts?: number
}

const prototypeEndpoint = "/api/prototype-auth"
const databaseEndpoint = "/api/line/test"

async function requestAuth(input: Record<string, string>, endpoint: string): Promise<AuthResult> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  return response.json()
}

const connectionError = "暫時無法連線，請稍後重試。"
const openingMessage = "正在確認 LINE 身分…"
const bindingMessages = {
  "match-employee": "正在比對員工資料…",
  "confirm-binding": "正在完成 LINE 綁定…",
  cancel: "正在取消綁定…",
}

export function LineBinding({ scenario, returnTo, database = false, verifiedAttempts, tunnel = false, pilot = false }: {
  scenario: string; returnTo: string; database?: boolean; verifiedAttempts?: number; tunnel?: boolean; pilot?: boolean;
}) {
  const verifiedByLiff = verifiedAttempts !== undefined
  const [flow, setFlow] = useState<Flow>({ step: verifiedByLiff ? "match" : "open" })
  const [pendingMessage, setPendingMessage] = useState<string | undefined>(verifiedByLiff ? undefined : openingMessage)
  const pending = pendingMessage !== undefined
  const [error, setError] = useState("")
  const [attempt, setAttempt] = useState(0)
  const [remainingAttempts, setRemainingAttempts] = useState(verifiedAttempts ?? bindingFailureLimit)
  const [matchFailed, setMatchFailed] = useState(false)
  const request = useRef<{ attempt: number; result: Promise<AuthResult> }>(null)
  const inFlight = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)
  const documentField = useRef<HTMLInputElement>(null)
  const previousStep = useRef<Flow["step"]>("open")
  const panel = useRef<HTMLDivElement>(null)
  const endpoint = database ? databaseEndpoint : prototypeEndpoint
  const sample = database ? (tunnel ? lineTunnelTestScenarios : lineTestScenarios)[scenario === "leave" ? "leave" : "first"]
    : scenario === "leave"
      ? { documentNo: "TEST000005", birthDate: "1990-10-25" }
      : { documentNo: "TEST000001", birthDate: "1992-06-15" }
  const documentFormat = database ? "Z0 加上八位數字" : "TEST 加上六位數字"
  const documentPattern = pilot ? "[A-Za-z][A-Za-z0-9][0-9]{8}"
    : database ? "[Zz]0[0-9]{8}" : "[Tt][Ee][Ss][Tt][0-9]{6}"
  const documentHint = pilot ? "請輸入員工主檔登記的證件號碼。" : `合成證件格式為 ${documentFormat}。`

  useEffect(() => {
    if (verifiedByLiff) return
    if (request.current?.attempt !== attempt) {
      const identity: Record<string, string> = database ? { idToken: `local.line.${scenario}` } : { scenario }
      request.current = { attempt, result: requestAuth({ action: "open-line", ...identity, returnTo }, endpoint) }
    }
    let active = true
    void request.current.result.then((result) => {
      if (!active) return
      if (result.destination) {
        window.location.replace(result.destination)
        return
      }
      if (result.needsBinding) {
        setRemainingAttempts(result.remainingAttempts ?? bindingFailureLimit)
        setFlow({ step: "match" })
      } else {
        setError(result.error ?? connectionError)
      }
      setPendingMessage(undefined)
    }).catch(() => {
      if (active) {
        setError(connectionError)
        setPendingMessage(undefined)
      }
    })
    return () => { active = false }
  }, [attempt, database, endpoint, scenario, returnTo, verifiedByLiff])

  useEffect(() => {
    if (previousStep.current !== flow.step) {
      previousStep.current = flow.step
      heading.current?.focus()
    }
  }, [flow.step])

  useEffect(() => {
    if (matchFailed) documentField.current?.focus()
  }, [matchFailed])

  useGSAP(() => {
    if (flow.step === "open") return
    const media = gsap.matchMedia()
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from("[data-binding-content]", {
        opacity: 0.86, y: 7, duration: 0.26, ease: "power2.out", clearProps: "transform,opacity",
      })
    }, panel)
    return () => media.revert()
  }, { scope: panel, dependencies: [flow.step], revertOnUpdate: true })

  async function send(input: Record<string, string> & { action: keyof typeof bindingMessages }) {
    if (inFlight.current) return
    inFlight.current = true
    setPendingMessage(bindingMessages[input.action])
    setError("")
    setMatchFailed(false)
    let leaving = false
    try {
      const result = await requestAuth({ ...input, returnTo }, endpoint)
      if (result.destination) {
        window.location.replace(result.destination)
        leaving = true
      } else if (result.employee) {
        setFlow({ step: "bind", employee: result.employee })
      } else {
        if (result.restart) setFlow({ step: "open" })
        if (result.error && !result.restart && result.remainingAttempts !== undefined && input.action === "match-employee") setMatchFailed(true)
        if (result.remainingAttempts !== undefined) setRemainingAttempts(result.remainingAttempts)
        setError(result.error ?? connectionError)
      }
    } catch {
      setError(connectionError)
    } finally {
      if (!leaving) {
        inFlight.current = false
        setPendingMessage(undefined)
      }
    }
  }

  function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    void send({
      action: "match-employee", documentNo: String(fields.get("documentNo") ?? ""),
      birthDate: String(fields.get("birthDate") ?? ""),
    })
  }

  function restart() {
    setError("")
    setPendingMessage(openingMessage)
    if (verifiedByLiff) {
      window.location.reload()
      return
    }
    setAttempt((previous) => previous + 1)
  }

  function clearFieldError() {
    if (!matchFailed) return
    setMatchFailed(false)
    setError("")
  }

  const title = {
    open: "確認 LINE 身分", match: "驗證員工身分", bind: "確認 LINE 綁定",
  }[flow.step]

  return (
    <div className="auth-card" ref={panel} aria-busy={pending}>
      <LoadingFeedback message={pendingMessage} />
      {flow.step !== "open" && (
        <ol className="steps" aria-label="首次綁定步驟">
          <li aria-current={flow.step === "match" ? "step" : undefined}>驗證員工{flow.step === "bind" && <span className="sr-only">（已完成）</span>}</li>
          <li aria-current={flow.step === "bind" ? "step" : undefined}>確認綁定</li>
        </ol>
      )}
      <div data-binding-content>
        <div className="auth-heading">
          <span className="auth-icon">{flow.step === "match" ? <Fingerprint aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}</span>
          <h1 ref={heading} tabIndex={-1}>{title}</h1>
          {flow.step === "match" && <p>首次使用請先比對員工資料，再將目前的 LINE 身分綁定到您的員工帳號。</p>}
          {flow.step === "bind" && <p>核對下列資料後，即可使用人資服務。</p>}
        </div>
        <div role="alert" aria-atomic="true">
          {error && <p className="notice error" id="verification-error"><CircleAlert size={18} aria-hidden="true" />{error}</p>}
        </div>
        {flow.step === "open" && (
          pending ? <p className="form-note">正在檢查 LINE 綁定狀態…</p> :
            <button className="button primary" type="button" onClick={restart}>重新確認 LINE 身分<ArrowRight size={18} aria-hidden="true" /></button>
        )}
        {flow.step === "match" && (
          <form className="flow-form" action={endpoint} method="POST" onSubmit={verify} onInput={clearFieldError} autoComplete="off">
            {pilot ? <p className="form-note">正式資料驗收。請使用你本人的資料驗證。</p> :
              <aside className="demo-help" aria-label="合成測試資料">
                <strong>請使用合成資料</strong>
                <p>證件號碼 <code>{sample.documentNo}</code><br />出生日期 <code>{sample.birthDate}</code></p>
              </aside>}
            <div className="field">
              <label htmlFor="binding-document">身分證字號或居留證號</label>
              <input id="binding-document" ref={documentField} type="text" name="documentNo" maxLength={10} required
                spellCheck={false} autoCorrect="off" autoCapitalize="characters" enterKeyHint="next"
                pattern={documentPattern} title={documentHint}
                aria-invalid={matchFailed} aria-describedby={matchFailed ? "binding-format verification-error" : "binding-format"} />
              <small id="binding-format">{documentHint}</small>
            </div>
            <div className="field">
              <label htmlFor="binding-birthdate">出生日期（西元）</label>
              <input id="binding-birthdate" type="date" name="birthDate" required enterKeyHint="done"
                aria-invalid={matchFailed} aria-describedby={matchFailed ? "verification-error" : undefined} />
            </div>
            <button className="button primary" type="submit" aria-disabled={pending}>
              {pending ? "比對中…" : "比對員工資料"}<ArrowRight size={18} aria-hidden="true" />
            </button>
            <p className="form-note" role="status">綁定限時 {bindingMinutes} 分鐘。目前剩餘 {remainingAttempts} 次比對機會。</p>
          </form>
        )}
        {flow.step === "bind" && (
          <div className="flow-form">
            <dl className="binding-details">
              <div><dt>員工姓名</dt><dd>{flow.employee.name}</dd></div>
              <div><dt>員工帳號</dt><dd>{flow.employee.employeeNo}</dd></div>
              <div><dt>所屬單位</dt><dd>{flow.employee.department}</dd></div>
            </dl>
            <button className="button primary" type="button" aria-disabled={pending} onClick={() => void send({ action: "confirm-binding" })}>
              {pending ? "綁定中…" : "確認並綁定"}<Link2 size={18} aria-hidden="true" />
            </button>
          </div>
        )}
        {flow.step !== "open" && (
          <button className="text-link" type="button" aria-disabled={pending} onClick={() => void send({ action: "cancel" })}>取消綁定</button>
        )}
      </div>
    </div>
  )
}

export function LogoutButton({ database = false }: { database?: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState(false)

  async function logout() {
    if (pending) return
    setPending(true)
    setError(false)
    try {
      const { destination } = await requestAuth({ action: "logout" }, database ? databaseEndpoint : prototypeEndpoint)
      if (destination) {
        window.location.assign(destination)
        return
      }
    } catch {
      // Keep the user on the current page so they can retry.
    }
    setError(true)
    setPending(false)
  }

  return (
    <div className="logout-control">
      <LoadingFeedback message={pending ? "正在登出…" : undefined} />
      <button className="logout" aria-disabled={pending} onClick={logout}>
        <LogOut size={17} aria-hidden="true" />{pending ? "登出中…" : "登出"}
      </button>
      {error && <span className="logout-error" role="alert">登出失敗，請重試。</span>}
    </div>
  )
}
