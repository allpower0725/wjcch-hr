import type { Metadata } from "next"
import { headers } from "next/headers"
import { notFound } from "next/navigation"
import { LiffVerification } from "../../components/liff-verification"
import { HostedLiffLanding, LineEntry } from "../../components/portal"
import { AppShell } from "../../components/shell"
import { featureForPath } from "../../lib/features"
import { lineTestMode } from "../../lib/line-test-db"
import { localLineTunnelOrigin } from "../../lib/prototype-host"

export const metadata: Metadata = {
  title: "LINE 身分驗證",
  referrer: "no-referrer",
}

export default async function LiffPage({ searchParams }: PageProps<"/liff">) {
  const mode = lineTestMode(await headers())
  if (localLineTunnelOrigin() && mode !== "tunnel" && mode !== "pilot") notFound()
  const { demo, returnTo } = await searchParams
  const feature = typeof returnTo === "string" ? featureForPath(returnTo) : undefined
  const scenario = demo === "leave" ? "leave" : "first"
  if (mode === "local") return <LineEntry database scenario={scenario} feature={feature} />

  const liffId = process.env.LINE_LIFF_ID?.trim()
  if (!liffId || !process.env.LINE_LOGIN_CHANNEL_ID?.trim()) return <HostedLiffLanding />

  return (
    <AppShell hosted>
      <main id="main-content" tabIndex={-1} className="site-width binding-layout">
        <LiffVerification liffId={liffId} binding={!!mode}
          tunnel={mode === "tunnel"} pilot={mode === "pilot"} scenario={scenario} returnTo={feature ? `/${feature.slug}` : "/"} />
      </main>
    </AppShell>
  )
}
