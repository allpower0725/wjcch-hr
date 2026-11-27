import type { NextConfig } from "next"

const config: NextConfig = {
  devIndicators: false,
  distDir: process.env.VERCEL !== "1" && process.env.HR_LINE_TUNNEL_ORIGIN?.trim()
    ? process.env.HR_LINE_PILOT === "1" ? ".next-pilot" : ".next-tunnel"
    : ".next",
}

export default config
