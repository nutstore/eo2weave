import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { state, refreshModels, getToken } = vi.hoisted(() => ({
  state: {
    providerType: 'llm-gateway',
    modelName: 'glm-5.2',
    modelCredentialStatus: 'valid',
    _providerRefreshVersion: 0,
    getAvailableProviders: vi.fn(async () => [{
      providerType: 'llm-gateway',
      displayName: 'Nutstore AI',
      providerKey: 'llm-gateway',
      current: true,
      models: [{ id: 'glm-5.2', name: 'GLM' }],
      authoritativeIds: ['glm-5.2'],
      catalogStatus: 'failed',
    }]),
    getStalePinnedModels: vi.fn((_provider: string, _ids: string[], status?: string) =>
      status === 'failed' ? [] : ['glm-5.2']),
    switchProviderAndModel: vi.fn(),
    triggerProviderRefresh: vi.fn(),
  },
  refreshModels: vi.fn(async () => []),
  getToken: vi.fn(async () => 'token'),
}))

vi.mock('@/store/settings.store', () => {
  const useSettingsStore = ((selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state) as unknown as typeof import('@/store/settings.store').useSettingsStore
  ;(useSettingsStore as unknown as { getState: () => typeof state }).getState = () => state
  return { useSettingsStore }
})

vi.mock('@/agent/providers/llm-gateway-provider', () => ({
  getLLMGatewayBaseURL: () => 'https://gateway.example',
  getLLMGatewayClientId: () => 'client',
  getValidAccessToken: getToken,
  updateGatewayModels: refreshModels,
}))
vi.mock('@/i18n', () => ({ useT: () => (key: string) => ({
  'topbar.modelSwitcher.catalogUnavailable': 'Model list unavailable',
  'topbar.modelSwitcher.retryCatalog': 'Retry model list',
  'topbar.modelSwitcher.delisted': 'Delisted',
  'topbar.modelSwitcher.loading': 'Loading models…',
})[key] ?? key }))
vi.mock('@creatorweave/ui', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BrandButton: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => <button {...props}>{children}</button>,
  BrandSwitch: () => <button>switch</button>,
}))

import { ModelQuickSwitch } from '@/components/layout/ModelQuickSwitch'
import { registerDynamicProvider, unregisterDynamicProvider } from '@/agent/providers/types'

describe('ModelQuickSwitch gateway catalog failure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerDynamicProvider('llm-gateway',
      { baseURL: 'https://gateway.example/v1', modelName: 'glm-5.2', headers: {} },
      { category: 'chinese', displayName: 'Nutstore AI', models: [{ id: 'glm-5.2', name: 'GLM', capabilities: ['code'] }], catalogStatus: 'failed' },
    )
  })
  afterEach(() => unregisterDynamicProvider('llm-gateway'))

  it('shows a retryable unavailable state without marking the selected model delisted', async () => {
    render(<ModelQuickSwitch />)

    expect(await screen.findByText('Model list unavailable')).toBeInTheDocument()
    expect(screen.queryByText('Delisted')).not.toBeInTheDocument()
    expect(state.getStalePinnedModels).toHaveBeenCalledWith('llm-gateway', ['glm-5.2'], 'failed')
    expect(state.switchProviderAndModel).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry model list' }))
    await waitFor(() => expect(refreshModels).toHaveBeenCalledWith('token'))
    expect(state.triggerProviderRefresh).toHaveBeenCalled()
  })
})
