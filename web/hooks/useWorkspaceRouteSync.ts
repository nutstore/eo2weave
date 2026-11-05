'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useT } from '@/i18n'
import { useProjectStore } from '@/store/project.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useConversationStore } from '@/store/conversation.store'
import { projectWorkspacePath } from '@/lib/route-paths'

/**
 * useWorkspaceRouteSync — URL params → store sync for workspace pages.
 *
 * Ported verbatim from the legacy `WorkspaceRoute` component in
 * WorkspaceApp.tsx (the ~200-line `syncFromRoute` effect). Next.js now owns
 * route matching; this hook only reacts to param changes and keeps the
 * project/workspace/conversation stores in sync with the URL.
 *
 * StrictMode note (kept from the original): the effect subscribes to
 * `projectLoading` so it re-runs once a project switch (setIsLoading
 * true→false) completes. Without this, StrictMode (dev) double-invokes the
 * effect: the first run sets `isLoading=true` via setActiveProject and is
 * then cancelled by cleanup; the second run sees `isLoading=true`, hits the
 * guard, and returns — leaving the URL :workspaceId never activated.
 */
export function useWorkspaceRouteSync(projectId: string, workspaceId?: string) {
  const router = useRouter()
  // Only gate the first restore. Later route changes must keep the workspace
  // UI mounted so switching conversations preserves its layout and controls.
  const [initialSyncComplete, setInitialSyncComplete] = useState(false)
  // Canonical navigation can replay the effect after the store installs
  // metadata/active IDs but before their transcript reads have finished.
  const pendingLoad = useRef<Promise<void> | null>(null)
  const pendingActivation = useRef<{ workspaceId: string; promise: Promise<void> } | null>(null)

  const setActiveProject = useProjectStore((s) => s.setActiveProject)
  const initialized = useProjectStore((s) => s.initialized)
  // Subscribe to isLoading so the route-sync effect re-runs once a project
  // switch finishes (see the StrictMode note above).
  const projectLoading = useProjectStore((s) => s.isLoading)
  const t = useT()

  // Route → store sync effect (ported from original syncFromRoute)
  useEffect(() => {
    if (!projectId) return
    // Snapshot store state via getState() to avoid subscribing to values
    // that this effect itself modifies (prevents infinite loops).
    const _isStorageReady = useProjectStore.getState().initialized
    const _projectLoading = useProjectStore.getState().isLoading
    if (!_isStorageReady || _projectLoading) return
    // Note: projectLoading is in deps so the effect re-runs when a project
    // switch (set isLoading true→false) completes. The guard above returns
    // early while loading is in flight; this subscription is what wakes us
    // back up.

    let cancelled = false

    const syncFromRoute = async () => {
      const _projects = useProjectStore.getState().projects
      const _activeProjectId = useProjectStore.getState().activeProjectId
      console.log('[syncFromRoute] enter', {
        projectId,
        workspaceId,
        activeProjectId: _activeProjectId,
        projectsCount: _projects.length,
      })

      // Step 1: Validate project exists
      const projectExists = _projects.some((project) => project.id === projectId)
      if (!projectExists) {
        console.warn('[syncFromRoute] project not found, redirecting to /projects', { projectId })
        toast.error(t('app.projectNotFound'))
        router.replace('/projects')
        return
      }

      // Step 2: Switch project if needed (this clears workspace state & loads new list)
      if (_activeProjectId !== projectId) {
        console.log('[syncFromRoute] switching project', { from: _activeProjectId, to: projectId })
        const switched = await setActiveProject(projectId)
        if (!switched) {
          console.warn('[syncFromRoute] setActiveProject returned false')
          if (!cancelled) {
            toast.error(t('app.switchProjectFailed'))
            router.replace('/projects')
          }
          return
        }
      }

      if (cancelled) return

      // Step 3: Determine which workspace to activate
      const workspaces = useConversationContextStore.getState().workspaces
      const scopedWorkspaceIds = workspaces.map((w) => w.id)
      const activeWorkspaceId = useConversationContextStore.getState().activeWorkspaceId
      console.log('[syncFromRoute] step3 workspaces loaded', {
        count: workspaces.length,
        scopedIds: scopedWorkspaceIds,
        activeWorkspaceId,
        hasTargetInScope: workspaceId ? scopedWorkspaceIds.includes(workspaceId) : null,
      })

      // Resolve target workspace ID:
      // - If URL specifies one, use it (if valid)
      // - Otherwise fall back to current active or most recent
      let targetWorkspaceId: string | null = null

      if (workspaceId && scopedWorkspaceIds.includes(workspaceId)) {
        targetWorkspaceId = workspaceId
      } else if (workspaceId) {
        // URL workspace not found in this project — check if it's a brand-new conversation
        // (not yet in workspace list). Allow transient pass-through.
        const convState = useConversationStore.getState()
        const isNewConversation = convState.conversations.some((c) => c.id === workspaceId)
        if (isNewConversation) {
          targetWorkspaceId = workspaceId
        }
      }

      // Fallback: use active workspace or pick most recent.
      if (!targetWorkspaceId) {
        if (activeWorkspaceId && scopedWorkspaceIds.includes(activeWorkspaceId)) {
          targetWorkspaceId = activeWorkspaceId
        } else if (scopedWorkspaceIds.length > 0) {
          const sorted = [...workspaces].sort((a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0))
          targetWorkspaceId = sorted[0].id
        }
      }

      // No workspace available — redirect to bare project URL
      if (!targetWorkspaceId) {
        console.warn('[syncFromRoute] no targetWorkspaceId — redirecting to bare project URL', {
          requestedWorkspaceId: workspaceId,
        })
        if (!workspaceId) {
          // Already on bare project URL, nothing more to do
          setInitialSyncComplete(true)
          return
        }
        router.replace(projectWorkspacePath(projectId))
        return
      }

      // Step 4: Update URL to include the resolved workspace (replace, not push)
      if (targetWorkspaceId !== workspaceId) {
        console.log('[syncFromRoute] replacing URL workspace', { from: workspaceId, to: targetWorkspaceId })
        router.replace(projectWorkspacePath(projectId, targetWorkspaceId))
      }

      if (cancelled) return

      // Step 5: Switch workspace (OPFS/SQLite operations only, no conversation side-effects)
      if (activeWorkspaceId !== targetWorkspaceId) {
        await useConversationContextStore.getState().switchWorkspace(targetWorkspaceId)
      } else {
        // Already active (typical after a page refresh where initialize()
        // restored activeWorkspaceId from the persisted record). switchWorkspace
        // would noop, so we must explicitly refresh pending changes here —
        // otherwise the badge keeps showing the SQLite-cached count that
        // initialize() wrote, which may be stale / from the wrong workspace.
        await useConversationContextStore.getState().refreshPendingChanges(true)
      }

      if (cancelled) return

      // WorkspaceLayout is held behind the initial gate, so its mount effect
      // cannot load cold conversation metadata for us. Await the full load,
      // including the active transcript (loaded=true alone only means metadata).
      if (!useConversationStore.getState().loaded && !pendingLoad.current) {
        pendingLoad.current = useConversationStore.getState().loadFromDB()
      }
      const load = pendingLoad.current
      if (load) {
        try {
          await load
        } finally {
          if (pendingLoad.current === load) pendingLoad.current = null
        }
      }

      if (cancelled) return

      // Step 6: Activate conversation (loads messages, no workspace side-effects)
      const activeConversationId = useConversationStore.getState().activeConversationId
      console.log('[syncFromRoute] step6 activate conversation', {
        targetWorkspaceId,
        activeConversationId,
        willCall: activeConversationId !== targetWorkspaceId,
      })
      if (activeConversationId !== targetWorkspaceId &&
          pendingActivation.current?.workspaceId !== targetWorkspaceId) {
        pendingActivation.current = {
          workspaceId: targetWorkspaceId,
          promise: useConversationStore.getState().setActive(targetWorkspaceId),
        }
      }
      const activation = pendingActivation.current
      if (activation?.workspaceId === targetWorkspaceId) {
        try {
          await activation.promise
        } finally {
          if (pendingActivation.current === activation) pendingActivation.current = null
        }
      }
      if (cancelled) return
      setInitialSyncComplete(true)
      console.log('[syncFromRoute] done', { targetWorkspaceId })
    }

    void syncFromRoute().catch((error: unknown) => {
      if (cancelled) return
      console.error('[syncFromRoute] Failed to restore workspace:', error)
      toast.error(error instanceof Error ? error.message : t('app.switchProjectFailed'))
      // Preserve the workspace navigation and existing recovery controls
      // instead of stranding an initialization failure behind a loading screen.
      setInitialSyncComplete(true)
    })

    return () => {
      cancelled = true
    }
  }, [projectId, workspaceId, setActiveProject, router, t, initialized, projectLoading])

  return initialSyncComplete
}
