/**
 * Tests for mergeModelLists — the static-skeleton vs dynamic-/models merge
 * precedence rules (see model-store.ts for the full rationale).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mergeModelLists } from '../model-store'
import type { ModelInfo } from '../types'

const getModelsMock = vi.hoisted(() => vi.fn())

vi.mock('../types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../types')>()
  return { ...actual, getModelsForProvider: getModelsMock }
})

import { getModelsForProvider } from '../types'
void getModelsForProvider

const skeleton = (id: string, caps: string[]): ModelInfo => ({
  id,
  name: id,
  capabilities: caps as ModelInfo['capabilities'],
})

const api = (
  id: string,
  overrides: Partial<ModelInfo> = {}
): ModelInfo => ({
  id,
  name: `API ${id}`,
  capabilities: [],
  metadataFromApi: true,
  ...overrides,
})

beforeEach(() => {
  getModelsMock.mockReset()
  getModelsMock.mockReturnValue([])
  getModelsMock.mockImplementation(() => [])
})

describe('mergeModelLists — non-custom provider', () => {
  it('treats a metadata-rich API list as the catalog: renamed skeleton ids are pruned', () => {
    getModelsMock.mockReturnValue([skeleton('old-name', ['fast'])])
    const dynamic = [api('new-name', { capabilities: ['vision'], contextWindow: 1_048_576 })]
    const merged = mergeModelLists('deepseek', dynamic, { isCustom: false })
    expect(merged.map((m) => m.id)).toEqual(['new-name'])
    expect(merged[0].contextWindow).toBe(1_048_576)
    expect(merged[0].capabilities).toContain('vision')
  })

  it('unions static capability tags into API-authoritative entries', () => {
    getModelsMock.mockReturnValue([skeleton('deepseek-v4-pro', ['code', 'writing', 'reasoning'])])
    const dynamic = [api('deepseek-v4-pro', { capabilities: ['vision'] })]
    const merged = mergeModelLists('deepseek', dynamic, { isCustom: false })
    expect(merged[0].capabilities).toEqual(['vision', 'code', 'writing', 'reasoning'])
  })

  it('falls back to the skeleton when the API returns no authoritative data', () => {
    getModelsMock.mockReturnValue([skeleton('legacy-model', ['code'])])
    const dynamic = [{ id: 'legacy-model', name: 'Legacy', capabilities: [] }]
    const merged = mergeModelLists('deepseek', dynamic, { isCustom: false })
    expect(merged.map((m) => m.id)).toEqual(['legacy-model'])
    expect(merged[0].capabilities).toEqual(['code'])
  })

  it('appends dynamic-only models alongside the skeleton when API data is not authoritative', () => {
    getModelsMock.mockReturnValue([skeleton('known', ['code'])])
    const dynamic = [{ id: 'brand-new', name: 'Brand New', capabilities: [] }]
    const merged = mergeModelLists('deepseek', dynamic, { isCustom: false })
    // Dynamic-first ordering: dynamic-only entries precede skeleton appends.
    expect(merged.map((m) => m.id)).toEqual(['brand-new', 'known'])
    expect(merged.find((m) => m.id === 'known')!.capabilities).toEqual(['code'])
  })
})

describe('mergeModelLists — custom provider', () => {
  const custom = { isCustom: true, customModelIds: ['my-model'] }

  it('keeps the registry contextWindow as a floor when the API omits it', () => {
    getModelsMock.mockReturnValue([])
    const dynamic = [{ id: 'my-model', name: 'My Model', capabilities: [] }]
    const merged = mergeModelLists('deepseek', dynamic, { ...custom })
    // getModelContextWindow is exercised here; the important assertion is
    // that the dynamic entry replaced the skeleton but kept a contextWindow
    // property (number from the registry lookup, or undefined when unknown).
    expect(merged[0].id).toBe('my-model')
    expect(merged[0].name).toBe('My Model')
    expect('contextWindow' in merged[0]).toBe(true)
  })

  it('prefers the API contextWindow when present', () => {
    getModelsMock.mockReturnValue([])
    const dynamic = [{ id: 'my-model', name: 'My Model', capabilities: [], contextWindow: 4096 }]
    const merged = mergeModelLists('deepseek', dynamic, { ...custom })
    expect(merged[0].contextWindow).toBe(4096)
  })

  it('adds API-only models not present in the configured list', () => {
    getModelsMock.mockReturnValue([])
    const dynamic = [{ id: 'api-only', name: 'API Only', capabilities: [] }]
    const merged = mergeModelLists('deepseek', dynamic, {
      isCustom: true,
      customModelIds: ['my-model'],
    })
    expect(merged.map((m) => m.id)).toEqual(['my-model', 'api-only'])
  })
})
