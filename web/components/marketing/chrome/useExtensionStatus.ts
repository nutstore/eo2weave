'use client'

import { useEffect, useState } from 'react'

export type ExtensionStatus = 'checking' | 'connected' | 'not_detected'

type AgentWebWindow = Window & { __agentWeb?: { ready?: boolean } }

function readStatus(): ExtensionStatus {
  const bridge = (window as AgentWebWindow).__agentWeb
  return bridge?.ready ? 'connected' : 'not_detected'
}

/**
 * Tracks whether the browser extension bridge is present.
 *
 * The bridge is injected by the content script, so it can appear after the
 * page mounts (and can come back on focus after the extension reloads).
 *
 * One module-level poll feeds every subscriber: the header and each install
 * control used to start their own 1 Hz interval (2-4 per page). The poll also
 * stops once the bridge is connected — a live extension cannot disappear
 * without a reload — while `not_detected` keeps polling so a mid-session
 * install is still picked up.
 */
let current: ExtensionStatus = 'checking'
let timer: number | null = null
const subscribers = new Set<(status: ExtensionStatus) => void>()

function publish(next: ExtensionStatus): void {
  if (next === current) return
  current = next
  for (const subscriber of subscribers) subscriber(next)
}

function sync(): void {
  publish(readStatus())
  if (current === 'connected' && timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}

export function useExtensionStatus(): ExtensionStatus {
  const [status, setStatus] = useState<ExtensionStatus>(current)

  useEffect(() => {
    subscribers.add(setStatus)
    if (timer === null) timer = window.setInterval(sync, 1000)
    window.addEventListener('focus', sync)
    sync()
    // Another subscriber may have published before this effect subscribed.
    setStatus(current)
    return () => {
      subscribers.delete(setStatus)
      window.removeEventListener('focus', sync)
      if (subscribers.size === 0 && timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }
  }, [])

  return status
}
