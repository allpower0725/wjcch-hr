import { ArrowLeft, ArrowRight, BadgeCheck, Building2, CalendarDays, ChartNoAxesColumnIncreasing, ChevronDown, ChevronRight, ClipboardList, Clock3, Fingerprint, IdCard, Link2, MessageCircle, ShieldCheck, UserRound, Users } from "lucide-react"
import { LineBinding, LogoutButton } from "./auth-client"
import { AnimatedMain } from "./animated-main"
import { PortalLink } from "./loading-state"
import { AppShell } from "./shell"
import { canOpenFeature, features, roleLabels, rosterFeature, type Feature, type Role } from "../lib/features"

type PortalIdentity = { employee: { employeeNo: string; name: string; department: string; role: Role; scope: string } }

const featureIcons = {
  clock: Clock3, calendar: CalendarDays, clipboard: ClipboardList, user: UserRound,
  chart: ChartNoAxesColumnIncreasing, users: Users, link: Link2,
}

export function HostedLiffLanding({ showEntry = false }: { showEntry?: boolean }) {
  return (
    <AppShell hosted>
      <main id="main-content" tabIndex={-1} className="site-width binding-layout">
        <section className="auth-card" aria-labelledby="liff-title">
          <div className="auth-heading">
            <span className="auth-icon"><BadgeCheck aria-hidden="true" /></span>
            <h1 id="liff-title">人資 LIFF 測試入口</h1>
            <p>{showEntry ? "開啟測試入口，以 LINE 帳號驗證登入連線。" : "測試站已就緒，等待設定 LINE 登入測試。"}</p>
          </div>
          {showEntry && (
            <PortalLink className="button primary" href="/liff">
              前往 LINE 身分驗證<ArrowRight size={18} aria-hidden="true" />
            </PortalLink>
          )}
        </section>
      </main>
    </AppShell>
  )
}

export function PortalEntry({ feature, database = false, hosted = false }: { feature?: Feature; database?: boolean; hosted?: boolean }) {
  const returnTo = feature ? `/${feature.slug}` : "/"
  const lineEntry = database ? `/liff?returnTo=${encodeURIComponent(returnTo)}` : `${returnTo}?entry=line`
  return (
    <AppShell database={database} hosted={hosted}>
      <AnimatedMain className="site-width portal-entry" scene="entry">
        <div className="entry-copy">
          <div className="entry-heading" data-reveal>
            <p className="entry-label"><span />院內員工服務</p>
            <h1>人資工作台</h1>
            <p className="entry-description">
              {feature ? "使用已綁定的 LINE 身分開啟「" + feature.title + "」。" : "使用已綁定的 LINE 身分，開啟院內打卡、班表與申請服務。"}
            </p>
          </div>
          <div className="entry-actions" data-reveal>
            <PortalLink className="button primary" href={lineEntry}>
              <MessageCircle size={20} aria-hidden="true" /> {hosted ? "使用 LINE 驗證" : "模擬從 LINE 進入"} <ArrowRight size={19} aria-hidden="true" />
            </PortalLink>
            <p className="form-note">首次使用時，請先在 LINE 完成員工身分綁定。</p>
          </div>
          {!database && <details className="demo-scenarios">
            <summary>預覽已綁定的角色 <ChevronDown size={16} aria-hidden="true" /></summary>
            <ul>
              <li><PortalLink href={lineEntry + "&demo=department"}>部級主管 <ArrowRight size={14} aria-hidden="true" /></PortalLink></li>
              <li><PortalLink href={lineEntry + "&demo=executive"}>院級主管 <ArrowRight size={14} aria-hidden="true" /></PortalLink></li>
              <li><PortalLink href={lineEntry + "&demo=admin"}>系統管理者 <ArrowRight size={14} aria-hidden="true" /></PortalLink></li>
            </ul>
          </details>}
        </div>
        <div className="entry-illustration" aria-hidden="true">
          <div className="circuit-orbit" />
          <div className="circuit-axis" />
          <div className="circuit-node node-line"><MessageCircle size={28} strokeWidth={1.65} /></div>
          <div className="circuit-node node-employee"><IdCard size={28} strokeWidth={1.65} /></div>
          <div className="circuit-card">
            <div className="circuit-avatar"><UserRound size={40} strokeWidth={1.4} /></div>
            <div className="circuit-bars"><i /><i /><i /></div>
            <div className="circuit-shield"><ShieldCheck size={29} strokeWidth={1.65} /></div>
          </div>
          <span className="circuit-marker marker-top" />
          <span className="circuit-marker marker-bottom" />
        </div>
      </AnimatedMain>
    </AppShell>
  )
}

export function LineEntry({ scenario, feature, database = false }: { scenario: string; feature?: Feature; database?: boolean }) {
  return (
    <AppShell database={database}>
      <main id="main-content" tabIndex={-1} className="site-width binding-layout">
        <LineBinding key={scenario + (feature?.slug ?? "/")} database={database} scenario={scenario} returnTo={feature ? "/" + feature.slug : "/"} />
      </main>
    </AppShell>
  )
}

function FeatureCard({ feature }: { feature: Feature }) {
  const Icon = featureIcons[feature.icon]
  return (
    <PortalLink className="feature-card" href={`/${feature.slug}`}
      prefetch={feature === rosterFeature ? false : undefined} data-reveal>
      <span className="feature-icon"><Icon size={23} aria-hidden="true" /></span>
      <div>
        <h3>{feature.title}</h3>
        <p>{feature.description}</p>
      </div>
      <ArrowRight size={18} className="feature-arrow" aria-hidden="true" />
    </PortalLink>
  )
}

export function Dashboard({ identity, database = false, hosted = false, showRoster = false }: {
  identity: PortalIdentity
  database?: boolean
  hosted?: boolean
  showRoster?: boolean
}) {
  const { employee } = identity
  const available = features.filter((item) => (item !== rosterFeature || showRoster) && canOpenFeature(employee.role, item))
  const management = available.filter((item) => item.group !== "personal")

  return (
    <AppShell database={database} hosted={hosted} actions={<LogoutButton database={database} />}>
      <AnimatedMain className="site-width workspace" scene="dashboard">
        <nav className="breadcrumbs" aria-label="目前位置"><span aria-current="page">工作台首頁</span></nav>
        <div className="overview">
          <section className="welcome" data-reveal>
            <span className="entry-status"><MessageCircle size={15} aria-hidden="true" /> {hosted ? "LINE 身分已驗證" : "LINE 模擬工作階段"}</span>
            <h1>您好，{employee.name}</h1>
            <p className="welcome-unit"><Building2 size={17} aria-hidden="true" />{employee.department}</p>
          </section>
          <section className="identity-card" aria-labelledby="identity-title" data-reveal>
            <h2 id="identity-title"><Fingerprint size={20} aria-hidden="true" />目前身分</h2>
            <dl className="identity-data">
              <div><dt>員工帳號</dt><dd>{employee.employeeNo}</dd></div>
              <div><dt>權限角色</dt><dd>{roleLabels[employee.role]}</dd></div>
              <div><dt>資料範圍</dt><dd>{employee.scope}</dd></div>
              <div><dt>LINE 綁定</dt><dd><span className="binding-status">已綁定</span></dd></div>
            </dl>
          </section>
        </div>
        <section className="features" aria-labelledby="personal-title">
          <h2 id="personal-title">個人服務</h2>
          <div className="feature-grid">
            {available.filter((item) => item.group === "personal").map((item) => <FeatureCard key={item.slug} feature={item} />)}
          </div>
        </section>
        {management.length > 0 && (
          <section className="features" aria-labelledby="management-title">
            <h2 id="management-title">管理服務</h2>
            <p className="section-note">資料範圍為{employee.scope}。案件簽核依實際關卡分派。</p>
            <div className="feature-grid">
              {management.map((item) => <FeatureCard key={item.slug} feature={item} />)}
            </div>
          </section>
        )}
      </AnimatedMain>
    </AppShell>
  )
}

export function FeaturePage({ identity, feature, database = false, hosted = false }: { identity: PortalIdentity; feature: Feature; database?: boolean; hosted?: boolean }) {
  const authorized = canOpenFeature(identity.employee.role, feature)
  const Icon = authorized ? featureIcons[feature.icon] : ShieldCheck

  return (
    <AppShell database={database} hosted={hosted} actions={<LogoutButton database={database} />}>
      <AnimatedMain key={feature.slug} className="site-width workspace" scene="feature">
        <nav className="breadcrumbs" aria-label="目前位置">
          <PortalLink href="/">工作台首頁</PortalLink><ChevronRight size={15} aria-hidden="true" />
          <span aria-current="page">{authorized ? feature.title : "權限檢查"}</span>
        </nav>
        {authorized && (
          <div className="notice info entry-notice" data-reveal><BadgeCheck size={20} aria-hidden="true" />
            已以綁定的 LINE 身分開啟「{feature.title}」。
          </div>
        )}
        <section className="feature-panel" data-reveal>
          <span className="feature-icon"><Icon size={24} aria-hidden="true" /></span>
          <h1>{authorized ? feature.title : "您沒有此功能的存取權"}</h1>
          {authorized ? (
            <>
              <p>{feature.description}。此頁為功能入口預覽。</p>
              <dl className="binding-details">
                <div><dt>目前員工</dt><dd>{identity.employee.name} · {identity.employee.employeeNo}</dd></div>
                <div><dt>資料範圍</dt><dd>{feature.group === "personal" ? "本人" : identity.employee.scope}</dd></div>
              </dl>
            </>
          ) : <p>您可以回到工作台，查看目前身分可使用的服務。</p>}
          <PortalLink className="text-link" href="/"><ArrowLeft size={18} aria-hidden="true" />返回工作台</PortalLink>
        </section>
      </AnimatedMain>
    </AppShell>
  )
}
