/**
 * useProjectAgentsInit — make sure `useAgentsStore` is initialized for the
 * currently active project. Idempotent: re-mounts and re-runs are no-ops
 * once the store has loaded agents for the project.
 *
 * Why this exists as a separate hook:
 * - `useConversationLogic` originally contained the init effect, but it only
 *   runs on screens that mount `ConversationView`. The WelcomeScreen
 *   toolbar (added in the pre-conversation configuration PR) renders an
 *   `AgentDropdown` that needs live agent data on bare URLs to a workspace
 *   that has no conversation yet — there is no `ConversationView` mounted,
 *   so the init effect used to skip the toolbar entirely. Extracting the
 *   effect lets both screens call it.
 *
 * Behaviour:
 * - Loads when the route's project changes and clears on project exit.
 * - The store coalesces concurrent callers and rejects stale results; a
 *   legitimately empty catalog does not trigger an initialization loop.
 */

import { useEffect } from 'react'
import { useProjectStore } from '@/store/project.store'
import { useAgentsStore } from '@/store/agents.store'

export function useProjectAgentsInit(): void {
  const activeProjectId = useProjectStore((s) => s.activeProjectId)

  useEffect(() => {
    if (!activeProjectId) {
      void useAgentsStore.getState().initialize('')
      return
    }
    const state = useAgentsStore.getState()
    if (state.isInitialized && state.loadedProjectId === activeProjectId) return

    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    ;(async () => {
      const MAX_RETRIES = 3
      const RETRY_DELAY_MS = 5_000
      for (let attempt = 1; ; attempt++) {
        try {
          const { ProjectManager } = await import('@/opfs')
          const pm = await ProjectManager.create()
          if (cancelled) return
          const store = useAgentsStore.getState()
          store.setProjectManager(pm)
          await store.initialize(activeProjectId)
          // initialize records failures in store state instead of rejecting
          // (timeout included), so success must be verified from the state:
          // without this check a transient failure would end the loop as a
          // "success" and never be retried.
          const after = useAgentsStore.getState()
          if (!after.isInitialized || after.loadedProjectId !== activeProjectId) {
            throw new Error(after.error || 'Agent catalog initialization failed')
          }
          return
        } catch (error) {
          if (cancelled) return
          console.warn('[useProjectAgentsInit] Failed to initialize agents:', error)
          // Initialization failures are usually transient (OPFS bridge hiccup,
          // extension restart). The effect only re-runs on a project change,
          // so without a retry the catalog would stay unavailable until the
          // user switches projects or reloads. The store's initialize is
          // idempotent, so a retry after success is a cheap no-op.
          if (attempt >= MAX_RETRIES) return
          await new Promise<void>((resolve) => {
            retryTimer = setTimeout(resolve, RETRY_DELAY_MS)
          })
          if (cancelled) return
        }
      }
    })()

    return () => {
      cancelled = true
      clearTimeout(retryTimer)
    }
  }, [activeProjectId])
}
