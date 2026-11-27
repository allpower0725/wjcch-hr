import { notFound } from "next/navigation"
import { headers } from "next/headers"
import { FeaturePage, LineEntry, PortalEntry } from "../../components/portal"
import { featureForPath } from "../../lib/features"
import { currentLineTestIdentity, lineTestMode } from "../../lib/line-test-db"
import { currentIdentity, demoSubject } from "../../lib/prototype-auth"
import { isLocalPrototypeHost } from "../../lib/prototype-host"

export default async function FeatureRoute({ params, searchParams }: PageProps<"/[feature]">) {
  const requestHeaders = await headers()
  const host = requestHeaders.get("host")
  const mode = lineTestMode(requestHeaders)
  if (!mode && !isLocalPrototypeHost(host)) notFound()

  const [{ feature: slug }, { entry, demo }] = await Promise.all([params, searchParams])
  const feature = featureForPath(`/${slug}`)
  if (!feature) notFound()

  if (mode) {
    const identity = await currentLineTestIdentity(mode)
    const hosted = mode !== "local"
    return identity ? <FeaturePage identity={identity} feature={feature} database hosted={hosted} /> : <PortalEntry feature={feature} database hosted={hosted} />
  }
  if (entry === "line") return <LineEntry scenario={demoSubject(demo) ?? "first"} feature={feature} />

  const identity = await currentIdentity()
  return identity ? <FeaturePage identity={identity} feature={feature} /> : <PortalEntry feature={feature} />
}
