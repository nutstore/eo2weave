'use client'

import { useEffect } from 'react'
import { legacyWorkspaceLaunch } from '@/lib/legacy-workspace-launch'

export function LegacyLaunch() {
  useEffect(() => {
    // iOS reports an installed home-screen app through navigator.standalone,
    // not the display-mode media query.
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    const destination = legacyWorkspaceLaunch(window.location.search, window.location.hash, standalone)
    if (destination) window.location.replace(destination)
  }, [])
  return null
}
