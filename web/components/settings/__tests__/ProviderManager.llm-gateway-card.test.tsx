/**
 * Tests for the LLM Gateway (Nutstore AI) card's credential states.
 *
 * Regression: the card derived its "Logged in" badge from the mere presence
 * of the api-key row, so an expired session still showed "Logged in" with a
 * "Refresh" + "Log out" pair — the only available action was logging out
 * even though the user simply needed to log in again.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

type CredentialStatus = 'unknown' | 'valid' | 'expired' | 'missing'

const settingsState = vi.hoisted(() => ({
  triggerProviderRefresh: vi.fn(),
  pinModel: vi.fn(),
  unpinModel: vi.fn(),
  removePinnedModels: vi.fn(() => 0),
  markPinnedModelsSeen: vi.fn(),
  getStalePinnedModels: vi.fn(() => []),
  pinnedModelsByProvider: {} as Record<string, string[]>,
  modelCredentialStatus: 'unknown' as CredentialStatus,
  invalidateApiKeyCache: vi.fn(),
  setHasApiKey: vi.fn(),
  setModelCredentialStatus: vi.fn(),
  providerType: 'llm-gateway',
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: Object.assign(
    (selector?: (state: typeof settingsState) => unknown) =>
      selector ? selector(settingsState) : settingsState,
    { getState: () => settingsState }
  ),
}))

const apiKeyState = vi.hoisted(() => ({ key: 'stale-access-token' as string | null }))

vi.mock('@/security/api-key-store', () => ({
  saveApiKey: vi.fn(async () => {}),
  loadApiKey: vi.fn(async () => apiKeyState.key),
  deleteApiKey: vi.fn(async () => {}),
}))

const gatewayMock = vi.hoisted(() => ({
  performDeviceCodeFlow: vi.fn(
    async (
      _baseURL: string,
      _clientId: string,
      _onState?: (state: { status: string; userCode?: string }) => void
    ) => ({
      access_token: 'new-access-token',
      token_type: 'Bearer' as const,
      expires_in: 3600,
      refresh_token: 'new-refresh-token',
      refresh_expires_in: 3600,
    })
  ),
  logoutGateway: vi.fn(),
  getValidAccessToken: vi.fn(async () => 'stale-access-token'),
  fetchGatewayModels: vi.fn(async () => []),
  updateGatewayModels: vi.fn(async () => []),
  persistDeviceLoginTokens: vi.fn(),
  fetchGatewayRateLimits: vi.fn(async () => {
    throw new Error('Nutstore AI login has expired. Please log in again.')
  }),
}))

vi.mock('@/agent/providers/llm-gateway-auth', () => ({
  performDeviceCodeFlow: gatewayMock.performDeviceCodeFlow,
  persistDeviceLoginTokens: gatewayMock.persistDeviceLoginTokens,
  logoutGateway: gatewayMock.logoutGateway,
  getValidAccessToken: gatewayMock.getValidAccessToken,
  fetchGatewayModels: gatewayMock.fetchGatewayModels,
}))

const applyGatewayLoginTokensMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/gateway-login', () => ({
  applyGatewayLoginTokens: applyGatewayLoginTokensMock,
}))

vi.mock('@/agent/providers/llm-gateway-provider', () => ({
  LLM_GATEWAY_PROVIDER_TYPE: 'llm-gateway',
  getLLMGatewayApiKeyProviderKey: () => '__llm_gateway_token__',
  getLLMGatewayBaseURL: () => 'https://ai.jianguoyun.com',
  getLLMGatewayClientId: () => 'test-client-id',
  updateGatewayModels: gatewayMock.updateGatewayModels,
  isLLMGatewayConfigured: () => true,
  fetchGatewayRateLimits: gatewayMock.fetchGatewayRateLimits,
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

import { LLMGatewayCard } from '../ProviderManager'
import { useI18nStore } from '@/i18n/store'

/**
 * Wait for the logged-in panel — it owns the pinned-models section, which the
 * logged-out panel never renders.
 */
async function waitForLoggedInPanel() {
  await screen.findByText('My Models')
}

describe('LLMGatewayCard credential state', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    applyGatewayLoginTokensMock.mockImplementation(async (_token, options) => {
      options.onCommit()
      settingsState.setModelCredentialStatus('valid')
      return { ok: true, accessToken: 'new-access-token', models: [] }
    })
    settingsState.modelCredentialStatus = 'unknown'
    settingsState.pinnedModelsByProvider = {}
    apiKeyState.key = 'stale-access-token'
    // The store is a plain object here — mirror the write so the component
    // sees the state change it just made.
    settingsState.setModelCredentialStatus.mockImplementation((status: CredentialStatus) => {
      settingsState.modelCredentialStatus = status
    })
    useI18nStore.setState({ locale: 'en-US' })
  })

  it('offers only a re-login action when the session expired', async () => {
    settingsState.modelCredentialStatus = 'expired'

    render(<LLMGatewayCard isExpanded onToggle={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText('Login expired')).toBeTruthy()
    })
    await waitForLoggedInPanel()
    expect(screen.getByRole('button', { name: 'Log in again' })).toBeTruthy()
    // Refreshing a dead session can only fail again.
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
    // Logging out would throw away a credential the user can restore by
    // logging in again — re-login alone must be offered.
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull()
  })

  it('keeps the normal refresh action while the credential is valid', async () => {
    settingsState.modelCredentialStatus = 'valid'

    render(<LLMGatewayCard isExpanded onToggle={() => {}} />)

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeTruthy()
    })
    expect(screen.getByText('Logged in')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Log in again' })).toBeNull()
  })

  it('offers a re-login when the auth layer reports no credential while a key row survives', async () => {
    // The token pair was purged when the session expired but the api-key row
    // survived — the card must treat this as a dead session, not as a live
    // login (no "Log out" — there is nothing left to log out of).
    settingsState.modelCredentialStatus = 'missing'
    apiKeyState.key = 'stale-access-token'

    render(<LLMGatewayCard isExpanded onToggle={() => {}} />)

    await waitFor(() => {
      expect(screen.getByText('Login expired')).toBeTruthy()
    })
    await waitForLoggedInPanel()
    expect(screen.getByRole('button', { name: 'Log in again' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Refresh' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Log out' })).toBeNull()
    expect(screen.queryByText('Logged in')).toBeNull()
  })

  it('runs the device code flow when the user asks to log in again', async () => {
    settingsState.modelCredentialStatus = 'expired'
    // The flow stays pending — the card must show the user code meanwhile.
    gatewayMock.performDeviceCodeFlow.mockImplementationOnce(
      (
        _baseURL: string,
        _clientId: string,
        onState?: (state: { status: string; userCode?: string }) => void
      ) => {
        onState?.({ status: 'waiting', userCode: 'ABCD-1234' })
        // The flow stays pending for the rest of the test.
        return new Promise<never>(() => {})
      }
    )

    const user = userEvent.setup()
    render(<LLMGatewayCard isExpanded onToggle={() => {}} />)

    await waitForLoggedInPanel()
    await user.click(screen.getByRole('button', { name: 'Log in again' }))

    await waitFor(() => {
      expect(gatewayMock.performDeviceCodeFlow).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByText('ABCD-1234')).toBeTruthy()
  })

  it('returns to the logged-in state after a successful re-login', async () => {
    settingsState.modelCredentialStatus = 'expired'

    const user = userEvent.setup()
    render(<LLMGatewayCard isExpanded onToggle={() => {}} />)

    await waitForLoggedInPanel()
    await user.click(screen.getByRole('button', { name: 'Log in again' }))

    await waitFor(() => {
      expect(settingsState.setModelCredentialStatus).toHaveBeenCalledWith('valid')
    })
    expect(applyGatewayLoginTokensMock).toHaveBeenCalledWith(
      'new-access-token', expect.objectContaining({ onCommit: expect.any(Function) }),
    )
    expect(gatewayMock.persistDeviceLoginTokens).toHaveBeenCalled()
    await waitFor(() => {
      expect(screen.getByText('Logged in')).toBeTruthy()
    })
    expect(screen.queryByText('Login expired')).toBeNull()
  })
})
