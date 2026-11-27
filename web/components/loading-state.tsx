"use client"

import Link, { useLinkStatus } from "next/link"
import { createContext, useCallback, useContext, useEffect, useState, type ComponentProps, type ReactNode } from "react"
import styles from "./loading-overlay.module.css"

const loadingPageMessage = "載入中，請稍候…"

type Operation = { message: string }
const LoadingContext = createContext<((message: string) => () => void) | null>(null)

export function LoadingProvider({ children }: { children: ReactNode }) {
  const [operations, setOperations] = useState<Operation[]>([])
  const [showOverlay, setShowOverlay] = useState(false)
  const message = operations.at(-1)?.message
  const isWaiting = message !== undefined

  const begin = useCallback((label: string) => {
    const operation = { message: label }
    setOperations((active) => [...active, operation])
    return () => setOperations((active) => active.filter((item) => item !== operation))
  }, [])

  useEffect(() => {
    if (!isWaiting) return
    // Skip the overlay for operations that finish before a perceptible wait.
    const delay = window.setTimeout(() => setShowOverlay(true), 150)
    return () => {
      window.clearTimeout(delay)
      setShowOverlay(false)
    }
  }, [isWaiting])

  return (
    <LoadingContext.Provider value={begin}>
      {children}
      <div role="status" aria-atomic="true">
        {showOverlay && message && (
          <div className={styles.overlay} data-loading-overlay>
            <div className={styles.content}>
              <div className={styles.cogs} aria-hidden="true">
                {[styles.pink, styles.blue, styles.yellow].map((color) => (
                  <div key={color} className={styles.gear + " " + color}>
                    <i /><i /><i /><b />
                  </div>
                ))}
              </div>
              <p>{message}</p>
            </div>
          </div>
        )}
      </div>
    </LoadingContext.Provider>
  )
}

export function LoadingFeedback({ message }: { message?: string }) {
  const begin = useContext(LoadingContext)

  useEffect(() => {
    if (message && begin) return begin(message)
  }, [begin, message])
  return null
}

export function PageLoadingFeedback() {
  return <LoadingFeedback message={loadingPageMessage} />
}

function LinkLoading() {
  const { pending } = useLinkStatus()
  return <LoadingFeedback message={pending ? loadingPageMessage : undefined} />
}

export function PortalLink({ children, ...props }: ComponentProps<typeof Link>) {
  return <Link {...props}>{children}<LinkLoading /></Link>
}
