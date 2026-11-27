"use client"

import { useGSAP } from "@gsap/react"
import gsap from "gsap"
import { useRef, type ReactNode } from "react"

gsap.registerPlugin(useGSAP)

export function AnimatedMain({ children, className, scene }: {
  children: ReactNode
  className: string
  scene: "entry" | "dashboard" | "feature"
}) {
  const main = useRef<HTMLElement>(null)

  useGSAP(() => {
    const media = gsap.matchMedia(main)
    media.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.from("[data-reveal]", {
        y: 9, opacity: 0.88, duration: 0.32, stagger: { amount: 0.16 },
        ease: "power2.out", clearProps: "transform,opacity",
      })
    })

    if (scene === "entry") {
      media.add("(min-width: 701px) and (prefers-reduced-motion: no-preference)", () => {
        gsap.timeline({ defaults: { ease: "power2.out", clearProps: "transform,opacity" } })
          .from(".circuit-card", { y: 14, opacity: 0.78, duration: 0.44 })
          .from(".circuit-node", { y: 8, opacity: 0.75, duration: 0.32, stagger: 0.07 }, "-=0.24")
      })
    }

    return () => media.revert()
  }, { scope: main, dependencies: [scene], revertOnUpdate: true })

  return <main ref={main} id="main-content" tabIndex={-1} className={className}>{children}</main>
}
