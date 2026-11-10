'use client'

import { useEffect, type RefObject } from 'react'
import { useExtensionStatus } from './useExtensionStatus'

/**
 * Applies the `[data-extension-connected]` / `[data-extension-not-detected]`
 * markup contract to a subtree.
 *
 * The static pages toggled these with site-header-*.js; the React routes do not
 * load those scripts, so the markers would otherwise never change state.
 */
export function useExtensionMarkers(root: RefObject<HTMLElement | null>): void {
  const status = useExtensionStatus()

  useEffect(() => {
    const host = root.current
    if (!host) return
    const connected = status === 'connected'
    host.querySelectorAll<HTMLElement>('[data-extension-connected]').forEach((node) => {
      node.hidden = !connected
    })
    host.querySelectorAll<HTMLElement>('[data-extension-not-detected]').forEach((node) => {
      node.hidden = connected
    })
  }, [root, status])
}
