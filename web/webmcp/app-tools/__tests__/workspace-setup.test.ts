import { describe, expect, it, vi } from 'vitest'
import {
  ensureConversationWorkspaceWithMeta,
  META_PERSIST_WAIT_TIMEOUT_MS,
} from '@/webmcp/app-tools/workspace-setup'

describe('ensureConversationWorkspaceWithMeta', () => {
  it('returns the workspace once both setup and the metadata persist settle', async () => {
    const workspace = { id: 'conv-1' }
    // Deferred (NOT pre-resolved) persistence promise: the helper must stay
    // pending until the metadata wait resolves — resolving only the setup is
    // not enough to satisfy this test.
    let resolvePersist!: () => void
    const persistPromise = new Promise<void>((resolve) => {
      resolvePersist = resolve
    })
    const attempt = ensureConversationWorkspaceWithMeta({
      ensureWorkspace: async () => workspace,
      deleteWorkspace: vi.fn(),
      waitForConversationMetaPersist: () => persistPromise,
    })

    let settled = false
    void attempt.then(() => { settled = true }, () => { settled = true })
    // Give the helper every chance to (wrongly) resolve early.
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    resolvePersist()
    await expect(attempt).resolves.toBe(workspace)
  })

  it('bounds the metadata wait and surfaces a timeout instead of hanging', async () => {
    let resolvePersist!: () => void
    const pendingPersist = new Promise<void>((resolve) => {
      resolvePersist = resolve
    })
    const settledWorkspace = { id: 'conv-1' }
    const deleteWorkspace = vi.fn(async () => {})

    const attempt = ensureConversationWorkspaceWithMeta({
      ensureWorkspace: async () => settledWorkspace,
      deleteWorkspace,
      waitForConversationMetaPersist: () => pendingPersist,
      timeoutMs: 20,
    })

    await expect(attempt).rejects.toThrow('Timed out after 20ms waiting')
    // The timed-out wait must not strand the workspace: setup completed, so
    // the created workspace is deleted as part of surfacing the failure.
    expect(deleteWorkspace).toHaveBeenCalledWith('conv-1')
    resolvePersist()
    await pendingPersist
  })

  it('awaits a late metadata persist inside the timeout cleanup before rejecting', async () => {
    let resolvePersist!: () => void
    const pendingPersist = new Promise<void>((resolve) => {
      resolvePersist = resolve
    })
    const settledWorkspace = { id: 'conv-late' }
    const deleteWorkspace = vi.fn(async () => {})

    const attempt = ensureConversationWorkspaceWithMeta({
      ensureWorkspace: async () => settledWorkspace,
      deleteWorkspace,
      waitForConversationMetaPersist: () => pendingPersist,
      timeoutMs: 20,
    })

    const rejection = expect(attempt).rejects.toThrow('Timed out after 20ms waiting')
    // Let the timeout fire BEFORE resolving the persist — otherwise the race
    // would simply succeed and no cleanup would run at all.
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
    // The persist lands AFTER the timeout fired — cleanup must wait for it
    // (bounded) before rejecting, so the caller's rollback that follows can
    // never race a late INSERT into the conversations table.
    resolvePersist()
    await rejection
    expect(deleteWorkspace).toHaveBeenCalledWith('conv-late')
  })

  it('deletes the created workspace when metadata persistence rejects', async () => {
    const workspace = { id: 'conv-orphan' }
    const deleteWorkspace = vi.fn(async () => {})

    await expect(
      ensureConversationWorkspaceWithMeta({
        ensureWorkspace: async () => workspace,
        deleteWorkspace,
        waitForConversationMetaPersist: async () => {
          throw new Error('sqlite write rejected')
        },
      })
    ).rejects.toThrow('sqlite write rejected')

    expect(deleteWorkspace).toHaveBeenCalledWith('conv-orphan')
  })

  it('still rejects with the original error when the workspace setup itself fails', async () => {
    const deleteWorkspace = vi.fn(async () => {})

    await expect(
      ensureConversationWorkspaceWithMeta({
        ensureWorkspace: async () => {
          throw new Error('opfs exploded')
        },
        deleteWorkspace,
        waitForConversationMetaPersist: async () => {},
      })
    ).rejects.toThrow('opfs exploded')

    // Nothing was created, so there is nothing to delete.
    expect(deleteWorkspace).not.toHaveBeenCalled()
  })

  it('sweeps conversation-keyed artifacts even when setup rejects before reporting a workspace', async () => {
    const deleteWorkspace = vi.fn(async () => {})

    await expect(
      ensureConversationWorkspaceWithMeta({
        workspaceId: 'conv-partial',
        ensureWorkspace: async () => {
          // Partial creation: a workspace row / OPFS dir already exists, then
          // a later step (e.g. binding persistence) fails before returning.
          throw new Error('binding persist failed')
        },
        deleteWorkspace,
        waitForConversationMetaPersist: async () => {},
      })
    ).rejects.toThrow('binding persist failed')

    // The partial artifacts must be swept even though setup never reported
    // the workspace it created.
    expect(deleteWorkspace).toHaveBeenCalledWith('conv-partial')
  })

  it('does not hang past the timeout when a cleanup sweep delete stalls', async () => {
    const settledWorkspace = { id: 'conv-stalled-sweep' }
    // Setup completed but reported its workspace AFTER the timeout fired, so
    // cleanup sweeps it — and THAT delete stalls forever. The sweep is
    // best-effort and bounded: it must be abandoned so the timeout error still
    // propagates and the caller reaches its conversation rollback.
    let resolveSetup!: (workspace: { id: string }) => void
    const attempt = ensureConversationWorkspaceWithMeta({
      ensureWorkspace: () =>
        new Promise<{ id: string }>((resolve) => {
          resolveSetup = resolve
        }),
      deleteWorkspace: () => new Promise<void>(() => {}), // never settles
      waitForConversationMetaPersist: () => new Promise<void>(() => {}), // never settles
      timeoutMs: 20,
    })

    const rejection = expect(attempt).rejects.toThrow('Timed out after 20ms waiting')
    // Fire the timeout, then let setup settle so the sweep path runs.
    await new Promise<void>((resolve) => setTimeout(resolve, 40))
    resolveSetup(settledWorkspace)
    // If the sweep were unbounded, this await would hang forever.
    await rejection
  })

  it('keeps the default deadline at 15 seconds', () => {
    expect(META_PERSIST_WAIT_TIMEOUT_MS).toBe(15_000)
  })
})
