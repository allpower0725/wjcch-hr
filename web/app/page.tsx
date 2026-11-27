import { headers } from "next/headers"
import { Dashboard, HostedLiffLanding, LineEntry, PortalEntry } from "../components/portal"
import { currentLineTestIdentity, lineTestMode } from "../lib/line-test-db"
import { currentIdentity, demoSubject } from "../lib/prototype-auth"
import { isLocalPrototypeHost } from "../lib/prototype-host"
import { isRosterMode } from "../lib/roster-db"

export default async function Home({ searchParams }: PageProps<"/">) {
  const requestHeaders = await headers()
  const host = requestHeaders.get("host")
  const mode = lineTestMode(requestHeaders)
  if (mode) {
    const identity = await currentLineTestIdentity(mode)
    const hosted = mode !== "local"
    return identity
      ? <Dashboard identity={identity} database hosted={hosted} showRoster={isRosterMode(mode)} />
      : <PortalEntry database hosted={hosted} />
  }
  if (!isLocalPrototypeHost(host)) return <HostedLiffLanding showEntry />

  const { entry, demo } = await searchParams
  if (entry === "line") return <LineEntry scenario={demoSubject(demo) ?? "first"} />

  const identity = await currentIdentity()
  return identity ? <Dashboard identity={identity} /> : <PortalEntry />
}
