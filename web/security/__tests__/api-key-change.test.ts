import { beforeEach, describe, expect, it, vi } from 'vitest'

const repo = vi.hoisted(() => ({ save: vi.fn(), delete: vi.fn() }))
vi.mock('@/sqlite', () => ({ initSQLiteDB: vi.fn(async () => {}), getApiKeyRepository: () => repo }))

import { deleteApiKey, saveApiKey } from '../api-key-store'
import { API_KEY_CHANGE_STORAGE_KEY } from '../api-key-change'

describe('API key cross-tab notifications', () => {
  beforeEach(() => {
    localStorage.clear()
    repo.save.mockReset().mockResolvedValue(undefined)
    repo.delete.mockReset().mockResolvedValue(undefined)
  })

  it('announces successful writes and deletes without exposing the secret', async () => {
    await saveApiKey('openai', 'private-secret')
    const saved = localStorage.getItem(API_KEY_CHANGE_STORAGE_KEY)!
    expect(JSON.parse(saved).provider).toBe('openai')
    expect(saved).not.toContain('private-secret')
    await deleteApiKey('openai')
    const deleted = localStorage.getItem(API_KEY_CHANGE_STORAGE_KEY)!
    expect(JSON.parse(deleted).provider).toBe('openai')
    expect(deleted).not.toBe(saved)
  })

  it('does not announce failed writes or gateway-owned records', async () => {
    repo.save.mockRejectedValueOnce(new Error('write failed'))
    await expect(saveApiKey('openai', 'secret')).rejects.toThrow('write failed')
    expect(localStorage.getItem(API_KEY_CHANGE_STORAGE_KEY)).toBeNull()
    await saveApiKey('__llm_gateway_refresh_token__', 'refresh')
    expect(localStorage.getItem(API_KEY_CHANGE_STORAGE_KEY)).toBeNull()
  })
  it('uses explicit internal identities without hiding other provider IDs', async () => {
    for (const key of ['__llm_gateway_refresh_token__', '__llm_gateway_token__',
      '__secret__:_global:API_TOKEN', '__secret__:project-id:API_TOKEN', 'llm-gateway']) {
      localStorage.removeItem(API_KEY_CHANGE_STORAGE_KEY)
      await saveApiKey(key, 'private')
      expect(localStorage.getItem(API_KEY_CHANGE_STORAGE_KEY)).toBeNull()
    }
    await saveApiKey('__external-provider', 'private')
    expect(JSON.parse(localStorage.getItem(API_KEY_CHANGE_STORAGE_KEY)!).provider).toBe('__external-provider')
  })

})
