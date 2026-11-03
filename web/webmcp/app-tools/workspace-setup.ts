/**
 * Shared setup coordination for create_conversation (and any caller that must
 * not outrun the conversation's SQLite metadata write).
 *
 * Two failure modes are handled here:
 * - Timeout: a stalled SQLite/bridge write would otherwise leave the joined
 *   wait pending forever — the caller would never return, not even to its
 *   rollback handler. The metadata wait is bounded; on expiry the error
 *   propagates and the caller rolls the conversation back. A persist that
 *   lands late is harmless: the row is deleted after it.
 * - Persist rejection: workspace setup runs concurrently and cannot be
 *   cancelled, so it is awaited to completion, then any workspace it created
 *   is deleted (row + OPFS dir) before rethrowing — otherwise a failed
 *   creation leaves an orphan workspace behind.
 */

export const META_PERSIST_WAIT_TIMEOUT_MS = 15_000

export interface ConversationWorkspaceSetupDeps {
  ensureWorkspace: () => Promise<{ id: string; projectId?: string }>
  deleteWorkspace: (id: string) => Promise<void>
  waitForConversationMetaPersist: () => Promise<void>
  timeoutMs?: number
}

export async function ensureConversationWorkspaceWithMeta(
  deps: ConversationWorkspaceSetupDeps
): Promise<{ id: string; projectId?: string }> {
  const timeoutMs = deps.timeoutMs ?? META_PERSIST_WAIT_TIMEOUT_MS
  const workspacePromise = deps.ensureWorkspace()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const [workspace] = await Promise.race([
      Promise.all([workspacePromise, deps.waitForConversationMetaPersist()]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for conversation metadata to persist`
            )
          ),
          timeoutMs
        )
      }),
    ])
    return workspace
  } catch (error) {
    try {
      const workspace = await workspacePromise
      await deps.deleteWorkspace(workspace.id)
    } catch {
      // Workspace setup never completed (or cleanup failed) — nothing more to
      // do here; orphan OPFS dirs are GC-able later, same as the store's own
      // deleteConversation rollback path.
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
