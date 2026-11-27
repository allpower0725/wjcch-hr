import Image from "next/image"
import { FlaskConical } from "lucide-react"
import type { ReactNode } from "react"
import { PortalLink } from "./loading-state"

export function AppShell({ children, actions, hosted = false, database = false }: { children: ReactNode; actions?: ReactNode; hosted?: boolean; database?: boolean }) {
  return (
    <>
      <a className="skip-link" href="#main-content">跳至主要內容</a>
      <header className="masthead">
        <div className="site-width masthead-inner">
          <PortalLink className="brand" href="/" aria-label="烏日澄清醫院 人力資源管理系統首頁">
            <Image src="/hospital-logo.svg" width={240} height={45} alt="烏日澄清醫院" unoptimized />
            <span className="brand-name">人力資源管理系統</span>
          </PortalLink>
          <div className="header-actions">
            <span className={actions ? "prototype-label header-with-actions" : "prototype-label"}><FlaskConical size={16} aria-hidden="true" /> {hosted ? "HTTPS 測試站" : database ? "本機串接測試" : "本機原型"}</span>
            {actions}
          </div>
        </div>
      </header>
      {children}
      <footer className="site-footer site-width">
        <span>人力資源管理系統</span>
        <span>{hosted ? "院內人資測試環境" : "本機測試環境 · 使用合成資料"}</span>
      </footer>
    </>
  )
}
