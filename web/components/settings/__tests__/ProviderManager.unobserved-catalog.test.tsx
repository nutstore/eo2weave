/**
 * Regression test for the PR #150 Sourcery round-9 finding 🟠 "Unloaded
 * catalog flags pin stale" (web/components/settings/ProviderManager.tsx
 * ProviderCard).
 *
 * A refresh-capable provider with static fallback models, a previously
 * seen dynamic-only pin, and NO cached /models refresh result yet used to
 * be classified 'ready' by the card (the static fallback read as a
 * positive report) — so the missing dynamic-only pin was flagged stale
 * even though the catalog is UNKNOWN. getAvailableProviders classifies
 * the same unobserved catalog as 'failed'. The card must agree: an
 * unobserved refresh-capable catalog stays 'failed' until a refresh
 * result is observed, so getStalePinnedModels defers (never flags).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from '@testing-library/react'

const settingsState = vi.hoisted(() => ({
  triggerProviderRefresh: vi.fn(),
  pinModel: vi.fn(),
  unpinModel: vi.fn(),
  removePinnedModels: vi.fn(() => 0),
  markPinnedModelsSeen: vi.fn(),
  getStalePinnedModels: vi.fn(
    (_providerType: string, availableIds: string[], catalogStatus?: string) => {
      // The REAL getStalePinnedModels contract: unknown catalogs never flag.
      if (catalogStatus === 'failed' || catalogStatus === 'loading') return []
      if (availableIds.length === 0 && catalogStatus !== 'empty') return []
      return []
    },
  ),
  pinnedModelsByProvider: { openai: ['dynamic-only-model'] } as Record<string, string[]>,
  modelCredentialStatus: 'unknown',
  modelCredentialStatusError: null as string | null,
  setModelCredentialStatusError: vi.fn(),
  invalidateApiKeyCache: vi.fn(),
  customProviders: [],
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: Object.assign(
    (selector?: (state: typeof settingsState) => unknown) =>
      selector ? selector(settingsState) : settingsState,
    { getState: () => settingsState }
  ),
}))

vi.mock('@/security/api-key-store', () => ({
  saveApiKey: vi.fn(async () => {}),
  loadApiKey: vi.fn(async () => 'key'),
  deleteApiKey: vi.fn(async () => {}),
  invalidateApiKeyCache: vi.fn(),
}))

const useDynamicModelsMock = vi.hoisted(() => ({
  models: [],
  source: 'static' as const,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(async () => {}),
  dynamicCount: 0,
}))

vi.mock('@/agent/providers/use-dynamic-models', () => ({
  useDynamicModels: vi.fn(() => useDynamicModelsMock),
}))

// getCachedModelsResult() === null is the "refresh never observed" state.
const modelStoreMock = vi.hoisted(() => ({
  getCachedModels: vi.fn<(type: string, key?: string) => unknown>(() => null),
  getCachedModelsResult: vi.fn<(type: string, key?: string) => unknown>(() => null),
  getModelContextWindow: vi.fn(() => 200_000),
  mergeModelLists: vi.fn(
    (_providerType: string, dynamicModels: Array<{ id: string }>) => dynamicModels,
  ),
}))

vi.mock('@/agent/providers/model-store', () => modelStoreMock)

import { ProviderCard } from '@/components/settings/ProviderManager'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

vi.mock('@creatorweave/ui', () => ({
  BrandInput: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  BrandButton: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{props.children}</button>
  ),
  BrandDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  BrandDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BrandDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BrandDialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BrandDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BrandDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BrandDialogClose: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('@/i18n/store', () => ({
  useI18nStore: { getState: () => ({ locale: 'en-US' }), setState: vi.fn() },
}))

describe('ProviderCard: unobserved refresh-capable catalog is unknown (PR #150 round 9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    modelStoreMock.getCachedModelsResult.mockReturnValue(null)
    useDynamicModelsMock.models = []
    useDynamicModelsMock.error = null
    settingsState.pinnedModelsByProvider = { openai: ['dynamic-only-model'] }
  })

  it('does NOT flag the seen dynamic-only pin stale while the /models refresh is unobserved', () => {
    // Static fallback list has content, the pin (dynamic-only) is missing
    // from it, and NO refresh result exists yet — the catalog is unknown,
    // so getStalePinnedModels must be consulted with 'failed' (defer), the
    // same classification getAvailableProviders reports for this state.
    render(
      <ProviderCard
        providerType="openai"
        displayName="OpenAI"
        isCustom={false}
        isExpanded
        onToggle={() => {}}
      />
    )

    expect(modelStoreMock.getCachedModelsResult).toHaveBeenCalledWith('openai', 'openai')
    const call = settingsState.getStalePinnedModels.mock.calls.find(
      (c) => c[0] === 'openai'
    )
    expect(call).toBeDefined()
    // The invariant: the unknown state defers the sweep — no pin flagging.
    expect(call?.[2]).toBe('failed')
  })
})
