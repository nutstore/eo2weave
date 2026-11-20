/**
 * Shared permission-restoration flow for File System Access roots.
 *
 * Used by both the FolderSelector dropdown action and the workspace
 * re-authorization banner (issue #83) so the two surfaces behave
 * identically: side-panel runs hand off to a top-level `/folder-pick`
 * page (cross-origin panels cannot prompt), full tabs call
 * `requestPermission()` directly, and a grant re-binds the runtime
 * handle + syncs agent.store.
 */

import { toast } from 'sonner'
import { bindRuntimeDirectoryHandle } from '@/native-fs'
import { PERMISSION_REQUEST_DEADLINE_MS, requestPermissionWithDeadline } from '@/lib/handle-permission'
import type { RootInfo } from '@/types/folder-access'

export interface RestoreRootPermissionOptions {
  projectId: string
  root: RootInfo
  /** True when running inside the extension side panel. */
  sidePanel: boolean
  /** Localized strings for the result toasts. */
  strings: {
    restored: string
    denied: string
    failed: string
    /** Shown when the browser never answers the request. */
    timedOut: string
  }
  /** Store action that reloads root statuses after a successful grant. */
  loadRoots: () => Promise<void>
}

export async function restoreRootPermission({
  projectId,
  root,
  sidePanel,
  strings,
  loadRoots,
}: RestoreRootPermissionOptions): Promise<boolean> {
  if (!root.persistedHandle) return false

  if (sidePanel) {
    // Re-grant in a top-level page; cross-origin panels cannot prompt.
    const url = new URL(window.location.href)
    url.hash = ''
    url.search = `?projectId=${encodeURIComponent(projectId)}`
    url.pathname = '/folder-pick'
    window.open(url.toString(), '_blank', 'noopener')
    return false
  }

  try {
    // Bounded: `requestPermission` is not cancellable and Chromium can leave it
    // pending forever on the same handle whose probe already timed out — the
    // click then looked like it did nothing at all (issue #316).
    const requestedAt = performance.now()
    const permission = await requestPermissionWithDeadline(root.persistedHandle)
    console.log('[folder-permission] requestPermission settled', {
      projectId,
      root: root.name,
      permission,
      elapsedMs: Math.round(performance.now() - requestedAt),
    })

    if (permission === 'timeout') {
      console.warn(
        `[folder-permission] requestPermission did not answer within ${PERMISSION_REQUEST_DEADLINE_MS}ms for "${root.name}"`
      )
      toast.error(strings.timedOut)
      return false
    }

    if (permission === 'granted') {
      bindRuntimeDirectoryHandle(projectId, root.name, root.persistedHandle)

      // Sync to agent.store first: the grant itself succeeded, so agent and
      // UI state must reflect it even if the subsequent root reload fails.
      const { useAgentStore } = await import('@/store/agent.store')
      useAgentStore.setState({
        directoryHandle: root.persistedHandle,
        directoryName: root.name,
      })

      // Optimistically mark the granted root ready in folder-access.store
      // (Sourcery round 3): the permission IS granted, so any snapshot still
      // showing needs_user_activation is stale by definition. Updating it
      // here means the banner clears immediately even when the best-effort
      // reload below fails — the user must never see a success toast next
      // to a re-authorization warning for the folder they just re-granted.
      try {
        const { useFolderAccessStore } = await import('@/store/folder-access.store')
        useFolderAccessStore.setState((state) => ({
          roots: state.roots.map((r) =>
            r.id === root.id
              ? { ...r, status: 'ready' as const, handle: root.persistedHandle }
              : r
          ),
        }))
      } catch (error) {
        console.error('[folder-permission] Failed to mark granted root ready:', error)
      }

      // The root reload is best-effort: a failure here must not make the
      // granted permission look like a failed restore (the optimistic
      // update above already reflects the grant; the reload only
      // reconciles the remaining roots and re-binds runtime handles).
      try {
        await loadRoots()
      } catch (error) {
        console.error('[folder-permission] Failed to refresh roots after grant:', error)
      }

      toast.success(strings.restored)
      return true
    }
    toast.error(strings.denied)
    return false
  } catch (error) {
    console.error('[folder-permission] Failed to restore permission:', error)
    toast.error(strings.failed)
    return false
  }
}
