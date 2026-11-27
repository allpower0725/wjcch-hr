import "server-only"

const loopbackHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i

export function localLineTunnelOrigin() {
  return process.env.VERCEL !== "1" ? process.env.HR_LINE_TUNNEL_ORIGIN?.trim() : undefined
}

export function isLocalPrototypeHost(host: string | null) {
  return process.env.VERCEL !== "1" && !localLineTunnelOrigin() && host !== null && loopbackHost.test(host)
}
