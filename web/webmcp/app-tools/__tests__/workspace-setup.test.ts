import { describe, expect, it, vi } from 'vitest'
import {
  ensureConversationWorkspaceWithMeta,
  META_PERSIST_WAIT_TIMEOUT_MS,
} from '@/webmcp/app-tools/workspace-setup'

describe('ensureConversationWorkspaceWithMeta', () => {
  it('returns the workspace once both setup and the metadata persist settle', async () => {
    const workspace = { id: 'conv-1' }
    const result = await ensureConversationWorkspaceWithMeta({
      ensureWorkspace: async () => workspace,
      deleteWorkspace: vi.fn(),
      waitForConversationMetaPersist: async () => {},
    })
    expect(result).toBe(workspace)
  })

  it('bounds the metadata wait and surfaces a timeout instead of hanging', async () => {
    let resolvePersist!: () => void
    const pendingPersist = new Promise<void>((resolve) => {
      resolvePersist = resolve
    })
    const settledWorkspace = { id: 'conv-1' }

    const attempt = ensureConversationWorkspaceWithMeta({
      ensureWorkspace: async () => settledWorkspace,
      deleteWorkspace: vi.fn(),
      waitForConversationMetaPersist: () => pendingPersist,
      timeoutMs: 20,
    })

    await expect(attempt).rejects.toThrow('Timed out after 20ms waiting')
    // The timed-out wait must not strand the workspace: setup completed, so
    // the created workspace is deleted as part of surfacing the failure.
    resolvePersist()
    await pendingPersist
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

  it('keeps the default deadline at 15 seconds', () => {
    expect(META_PERSIST_WAIT_TIMEOUT_MS).toBe(15_000)
  })
})
