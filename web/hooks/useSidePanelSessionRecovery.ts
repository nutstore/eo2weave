'use client'

import { useEffect } from 'react'

/** Restore a panel's binding without changing its registered entry URL. */
export function useSidePanelSessionRecovery(): void {
  useEffect(() => {
    void import('@/agent/workspace-assistant-context').then(({ recoverSidePanelSession }) => {
      void recoverSidePanelSession()
    })
  }, [])
}
