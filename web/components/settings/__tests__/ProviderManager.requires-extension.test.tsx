/**
 * Providers whose endpoints refuse direct cross-origin browser requests must be
 * flagged in the settings UI, so a failing setup is not mistaken for a bad key.
 *
 * OpenCode Go and 火山方舟 Coding only answer CORS preflights when the request
 * goes out through the browser extension's network bridge; the flagged set is
 * what ProviderCard renders the "Extension required" badge for.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const settingsState = vi.hoisted(() => ({
  triggerProviderRefresh: vi.fn(),
  pinModel: vi.fn(),
  unpinModel: vi.fn(),
  removePinnedModels: vi.fn(() => 0),
  markPinnedModelsSeen: vi.fn(),
  getStalePinnedModels: vi.fn(() => []),
  pinnedModelsByProvider: {} as Record<string, string[]>,
  modelCredentialStatus: 'unknown',
  modelCredentialStatusError: null as string | null,
  setModelCredentialStatusError: vi.fn(),
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
  loadApiKey: vi.fn(async () => null),
  deleteApiKey: vi.fn(async () => {}),
}))

vi.mock('@/agent/providers/use-dynamic-models', () => ({
  useDynamicModels: vi.fn(() => ({
    models: [],
    source: 'static' as const,
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
    dynamicCount: 0,
  })),
}))

vi.mock('@/agent/providers/model-store', () => ({
  getCachedModels: vi.fn(() => null),
  getCachedModelsResult: vi.fn(() => null),
  getModelContextWindow: vi.fn(() => 200_000),
  mergeModelLists: vi.fn((_providerType: string, dynamicModels: Array<{ id: string }>) => dynamicModels),
}))

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

import { ProviderCard } from '@/components/settings/ProviderManager'
import { PROVIDER_META } from '@/agent/providers/types'

describe('ProviderCard: extension-only providers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('badges a provider that needs the extension', () => {
    render(
      <ProviderCard
        providerType="opencode-go"
        displayName="OpenCode Go"
        requiresExtension
        isCustom={false}
        isExpanded={false}
        onToggle={() => {}}
      />
    )

    expect(screen.getByText('settings.requiresExtension')).toBeTruthy()
  })

  it('leaves a browser-direct provider unbadged', () => {
    render(
      <ProviderCard
        providerType="openai"
        displayName="OpenAI"
        isCustom={false}
        isExpanded={false}
        onToggle={() => {}}
      />
    )

    expect(screen.queryByText('settings.requiresExtension')).toBeNull()
  })

  it('marks OpenCode Go, the 智谱 providers and 火山方舟 Coding in the catalog', () => {
    const flagged = Object.entries(PROVIDER_META)
      .filter(([, meta]) => meta.requiresExtension)
      .map(([type]) => type)
      .sort()

    expect(flagged).toEqual(['glm', 'glm-coding', 'opencode-go', 'volcengine-coding'])
  })
})
