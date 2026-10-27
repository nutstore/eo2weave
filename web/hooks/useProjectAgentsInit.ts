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
    ;(async () => {
      try {
        const { ProjectManager } = await import('@/opfs')
        const pm = await ProjectManager.create()
        if (cancelled) return
        const store = useAgentsStore.getState()
        store.setProjectManager(pm)
        await store.initialize(activeProjectId)
      } catch (error) {
        if (!cancelled) {
          console.warn('[useProjectAgentsInit] Failed to initialize agents:', error)
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [activeProjectId])
}
