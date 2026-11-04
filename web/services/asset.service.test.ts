import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writePendingAssetsToOPFS, removeAssetsFromOPFS } from '@/services/asset.service'

const { getActiveConversation, getWorkspace } = vi.hoisted(() => ({ getActiveConversation: vi.fn(), getWorkspace: vi.fn() }))
vi.mock('@/opfs', () => ({ getWorkspaceManager: async () => ({ getWorkspace }) }))
vi.mock('@/store/conversation-context.store', () => ({ getActiveConversation }))

describe('writePendingAssetsToOPFS', () => {
  beforeEach(() => getActiveConversation.mockReset())

  it('removes every newly created file when a later file write fails', async () => {
    const entries = new Map<string, string>()
    const dir = {
      getFileHandle: vi.fn(async (name: string, options?: { create: boolean }) => {
        if (!options?.create) {
          if (!entries.has(name)) throw new Error('not found')
          return {}
        }
        entries.set(name, '')
        return { createWritable: async () => ({ write: async () => { if (name.startsWith('second')) throw new Error('write failed') }, close: async () => {} }) }
      }),
      removeEntry: vi.fn(async (name: string) => { entries.delete(name) }),
    }
    getActiveConversation.mockResolvedValue({ conversation: { getAssetsDir: async () => dir } })
    const files = ['first.txt', 'second.txt'].map((name) => ({ name, file: new File(['x'], name) }))
    await expect(writePendingAssetsToOPFS(files)).rejects.toThrow('write failed')
    expect([...entries.keys()]).toEqual([])
  })
  it('cleans up files in the specified conversation instead of the active one', async () => {
    const source = { removeEntry: vi.fn() }
    const other = { removeEntry: vi.fn() }
    getWorkspace.mockResolvedValue({ getAssetsDir: async () => source })
    getActiveConversation.mockResolvedValue({ conversation: { getAssetsDir: async () => other } })
    await removeAssetsFromOPFS([{ id: '1', name: 'shared.txt', size: 1, mimeType: 'text/plain', direction: 'upload', createdAt: 0 }], 'source')
    expect(getWorkspace).toHaveBeenCalledWith('source')
    expect(source.removeEntry).toHaveBeenCalledWith('shared.txt')
    expect(other.removeEntry).not.toHaveBeenCalled()
  })

  it('allocates distinct names for concurrent uploads', async () => {
    const entries = new Set<string>()
    const dir = {
      getFileHandle: vi.fn(async (name: string, options?: { create: boolean }) => {
        if (!options?.create) {
          if (!entries.has(name)) throw new Error('not found')
          return {}
        }
        entries.add(name)
        return { createWritable: async () => ({ write: async () => {}, close: async () => {} }) }
      }),
      removeEntry: vi.fn(async (name: string) => { entries.delete(name) }),
    }
    getActiveConversation.mockResolvedValue({ conversationId: 'same', conversation: { getAssetsDir: async () => dir } })
    const file = new File(['x'], 'same.txt')
    const results = await Promise.all([writePendingAssetsToOPFS([{ name: file.name, file }]), writePendingAssetsToOPFS([{ name: file.name, file }])])
    expect(new Set(results.map((r) => r[0].name)).size).toBe(2)
  })

})
