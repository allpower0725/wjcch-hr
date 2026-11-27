import { PageLoadingFeedback } from "../components/loading-state"
import { AppShell } from "../components/shell"

export default function Loading() {
  return (
    <AppShell>
      <main id="main-content" tabIndex={-1} aria-busy="true" />
      <PageLoadingFeedback />
    </AppShell>
  )
}
