import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writePendingAssetsToOPFS } from '@/services/asset.service'

const { getActiveConversation } = vi.hoisted(() => ({ getActiveConversation: vi.fn() }))
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
        return { createWritable: async () => ({ write: async () => { if (name === 'second.txt') throw new Error('write failed') }, close: async () => {} }) }
      }),
      removeEntry: vi.fn(async (name: string) => { entries.delete(name) }),
    }
    getActiveConversation.mockResolvedValue({ conversation: { getAssetsDir: async () => dir } })
    const files = ['first.txt', 'second.txt'].map((name) => ({ name, file: new File(['x'], name) }))
    await expect(writePendingAssetsToOPFS(files)).rejects.toThrow('write failed')
    expect([...entries.keys()]).toEqual([])
  })
})
