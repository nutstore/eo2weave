'use client'

import { useEffect } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { isSidePanelMode } from '@/agent/workspace-assistant-context'

/**
 * Re-settle the Edge side-panel URL after in-app navigation.
 *
 * Edge (#222) reloads the panel whenever its live URL diverges from the path
 * registered via sidePanel.setOptions. The settle protocol pins the URL at
 * panel open, but the app legitimately keeps navigating afterwards (workspace
 * resolution replaces the bare project URL with /workspaces/:id, draft ?new=1,
 * project switches...). Every such change re-opens the reload window.
 *
 * First run of each page load also performs reload-recovery: if a settle's
 * setOptions reloaded the panel, the app boots on a clean URL with no
 * side-panel session — the extension is the source of truth for "this
 * document is the panel", so we ask it and restore binding/hostname before
 * settling. (Module-load recovery can't do this: the injected bridge isn't on
 * the window yet at module-eval time.)
 *
 * The module-level settled-path guard in workspace-assistant-context dedupes
 * repeats and swallows the echo of our own settle. Chrome (per-tab panels)
 * and plain tabs are unaffected: the hook early-returns when not in side-panel
 * mode, and the extension answers ok:false to non-panel senders anyway.
 */
let recoveryAttempted = false

export function useSidePanelSettle(): void {
  const pathname = usePathname()
  const searchParams = useSearchParams()

  useEffect(() => {
    const path = pathname + (searchParams.size > 0 ? `?${searchParams.toString()}` : '')
    void import('@/agent/workspace-assistant-context').then(
      ({ recoverSidePanelSession, settleSidePanelPath }) => {
        if (recoveryAttempted || isSidePanelMode()) {
          void settleSidePanelPath(path)
          return
        }
        // First run after a clean-URL reload: try to recover the panel
        // session from the extension before settling. No-op (false) when not
        // the panel document — settle then also no-ops.
        recoveryAttempted = true
        void recoverSidePanelSession().then((recovered) => {
          if (recovered) {
            console.log('[SidePanelSettle] side-panel session recovered after reload')
          }
          void settleSidePanelPath(path)
        })
      },
    )
  }, [pathname, searchParams])
}
