/**
 * Shared setup coordination for create_conversation (and any caller that must
 * not outrun the conversation's SQLite metadata write).
 *
 * Three failure modes are handled here:
 * - Timeout: a stalled SQLite/bridge write would otherwise leave the joined
 *   wait pending forever — the caller would never return, not even to its
 *   rollback handler. The metadata wait is bounded; on expiry the error
 *   propagates and the caller rolls the conversation back.
 * - Late persist: the metadata write may still be in flight when the timeout
 *   fires. Cleanup awaits it (bounded by a grace window) BEFORE the caller's
 *   rollback deletes the conversation, so a persist that lands late INSERTs
 *   first and is then removed — it can never resurrect the rolled-back row
 *   as an orphan conversation without a workspace.
 * - Persist rejection: workspace setup runs concurrently and cannot be
 *   cancelled. Cleanup observes what the setup promise settled with via a
 *   side channel WITHOUT awaiting an unresolved promise (a stalled setup must
 *   never hang the caller past its own timeout), deletes any workspace it
 *   created, and sweeps the conversation-keyed artifacts best-effort even
 *   when setup rejected before reporting a workspace id — otherwise a failed
 *   creation leaves an orphan workspace row / OPFS dir behind.
 */

export const META_PERSIST_WAIT_TIMEOUT_MS = 15_000

export interface ConversationWorkspaceSetupDeps {
  ensureWorkspace: () => Promise<{ id: string; projectId?: string }>
  deleteWorkspace: (id: string) => Promise<void>
  waitForConversationMetaPersist: () => Promise<void>
  /**
   * Conversation id the workspace is keyed by. Enables the best-effort
   * artifact sweep when setup rejects or stalls before reporting the
   * workspace it created. Optional so tests can omit it.
   */
  workspaceId?: string
  timeoutMs?: number
}

export async function ensureConversationWorkspaceWithMeta(
  deps: ConversationWorkspaceSetupDeps
): Promise<{ id: string; projectId?: string }> {
  const timeoutMs = deps.timeoutMs ?? META_PERSIST_WAIT_TIMEOUT_MS
  const workspacePromise = deps.ensureWorkspace()
  // Side channel: whatever the setup promise settles with, observed WITHOUT
  // awaiting it. Cleanup must never `await workspacePromise` directly — a
  // setup that stays pending (stalled OPFS bridge) would hang cleanup past
  // the timeout this function exists to guarantee. (Boxed in an object so
  // TypeScript does not narrow the field to `null` between the callback
  // assignment and the catch-block read.)
  const settled: { workspace: { id: string; projectId?: string } | null } = { workspace: null }
  void workspacePromise.then(
    (workspace) => { settled.workspace = workspace },
    () => { /* rejection observed in the catch path below */ },
  )
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
    // Give the in-flight metadata write a bounded grace window to settle
    // before surfacing the failure: the caller's rollback deletes the
    // conversation, and a persist that INSERTs after that delete would
    // resurrect an orphan conversation row. A persist still stalled after the
    // grace window is treated as dead (same assumption as the timeout above).
    await Promise.race([
      deps.waitForConversationMetaPersist().catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs)
      }),
    ])

    const sweep = async (id: string | undefined): Promise<void> => {
      if (!id) return
      try {
        // Best-effort AND bounded: a stalled workspace-manager/OPFS delete
        // must not hang the cleanup past the timeout this function exists to
        // guarantee — abandon it and let the caller reach its rollback.
        await Promise.race([
          deps.deleteWorkspace(id),
          new Promise<void>((resolve) => {
            setTimeout(resolve, timeoutMs)
          }),
        ])
      } catch {
        // Best-effort — orphan OPFS dirs are GC-able later, same as the
        // store's own deleteConversation rollback path.
      }
    }

    if (settled.workspace) {
      // Setup completed and reported its workspace — delete it now.
      await sweep(settled.workspace.id)
    } else {
      // Setup has not settled (or settled with nothing usable). Sweep the
      // conversation-keyed artifacts immediately — a rejected setup can leave
      // a partial workspace row / OPFS dir behind even though it never
      // reported a workspace — and re-sweep detached once setup eventually
      // settles, whichever way it settles.
      void workspacePromise.then(
        (workspace) => sweep(workspace.id),
        () => sweep(deps.workspaceId),
      )
      await sweep(deps.workspaceId)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
