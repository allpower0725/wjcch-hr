import type { Metadata } from "next"
import type { ReactNode } from "react"
import { LoadingProvider } from "../components/loading-state"
import "@ui-sdk/core/web.css"
import "./globals.css"

export const metadata: Metadata = {
  title: { default: "人資工作台", template: "%s｜人資工作台" },
  description: "WJCCH 人資工作台測試環境",
  robots: { index: false, follow: false },
  other: { "text-scale": "scale" },
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-Hant-TW"><body><LoadingProvider>{children}</LoadingProvider></body></html>
}
