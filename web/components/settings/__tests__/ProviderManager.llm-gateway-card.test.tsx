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

const loadApiKeyMock = vi.hoisted(() =>
  vi.fn(async () => apiKeyState.key)
)

vi.mock('@/security/api-key-store', () => ({
  saveApiKey: vi.fn(async () => {}),
  loadApiKey: loadApiKeyMock,
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
  getGatewayCredentialStatus: vi.fn(() => 'unknown'),
  hasStoredTokens: vi.fn(() => true),
  registerGatewayModels: vi.fn(),
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
  getGatewayCredentialStatus: gatewayMock.getGatewayCredentialStatus,
  hasStoredTokens: gatewayMock.hasStoredTokens,
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
  // The card re-registers a fetched catalog with the gateway provider via a
  // DYNAMIC import of this module (finding: "unusable model catalog").
  registerGatewayModels: gatewayMock.registerGatewayModels,
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
    // Logout's session-freshness guard: default to "no newer login" so the
    // logged-out UI path runs; individual tests override when needed.
    gatewayMock.getGatewayCredentialStatus.mockReturnValue('unknown')
    // Shared credential state: default to live tokens so the login/logout
    // freshness guards pass; tests override to simulate another tab's purge.
    gatewayMock.hasStoredTokens.mockReturnValue(true)
    applyGatewayLoginTokensMock.mockImplementation(async (_token, options) => {
      options.onCommit()
      settingsState.setModelCredentialStatus('valid')
      return { ok: true, accessToken: 'new-access-token', models: [] }
    })
    settingsState.modelCredentialStatus = 'unknown'
    settingsState.pinnedModelsByProvider = {}
    apiKeyState.key = 'stale-access-token'
    // Reset once-queues from other tests, then restore the default read.
    loadApiKeyMock.mockReset()
    loadApiKeyMock.mockImplementation(async () => apiKeyState.key)
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

  it('rejects the login confirmation when a concurrent logout purges the shared credentials before the in-lock re-read', async () => {
    // Sourcery (PR #128): the freshness re-read must consult SHARED
    // credential state, not the tab-local modelCredentialStatus field —
    // that field is excluded from the cross-tab settings snapshots, so a
    // logout committing in ANOTHER tab leaves a stale 'valid' here and the
    // old check accepted it. The re-read now runs INSIDE the credential
    // lock against the shared token cache / access shadow, so a logout
    // that committed before it wins: the login must surface the auth
    // failure instead of repainting "Logged in" over purged credentials.
    settingsState.modelCredentialStatus = 'expired'
    applyGatewayLoginTokensMock.mockImplementation(async (_token, options) => {
      options.onCommit()
      // Simulate the concurrent logout committing FIRST (it holds the same
      // lock): it deleted the shared access-token shadow, while the
      // tab-local status field — excluded from cross-tab sync — still
      // carries whatever this tab last saw. The pre-lock token-cache guard
      // passes (the cache delete has not landed here yet), so the IN-LOCK
      // re-read is what must catch the purge.
      apiKeyState.key = null
      return { ok: true, accessToken: 'new-access-token', models: [] }
    })

    const user = userEvent.setup()
    render(<LLMGatewayCard isExpanded onToggle={() => {}} />)

    await waitForLoggedInPanel()
    await user.click(screen.getByRole('button', { name: 'Log in again' }))

    await waitFor(() => {
      expect(screen.getByText('Authentication failed')).toBeTruthy()
    })
    expect(screen.queryByText('Logged in')).toBeNull()
    // The stale 'valid' write must NOT have happened after the logout's
    // purge.
    expect(settingsState.setModelCredentialStatus).not.toHaveBeenCalledWith('valid')
  })

  it('rejects the login when a concurrent logout purged the shared token cache before the freshness guard', async () => {
    // The pre-lock direction of the same bug: another tab's logout wiped
    // the shared llm-gateway-tokens cache before this tab's guard ran, but
    // the old check consulted the tab-local status field (stale 'valid'),
    // so the login painted "Logged in" over purged credentials.
    settingsState.modelCredentialStatus = 'expired'
    applyGatewayLoginTokensMock.mockImplementation(async (_token, options) => {
      options.onCommit()
      gatewayMock.hasStoredTokens.mockReturnValue(false)
      return { ok: true, accessToken: 'new-access-token', models: [] }
    })

    const user = userEvent.setup()
    render(<LLMGatewayCard isExpanded onToggle={() => {}} />)

    await waitForLoggedInPanel()
    await user.click(screen.getByRole('button', { name: 'Log in again' }))

    await waitFor(() => {
      expect(screen.getByText('Authentication failed')).toBeTruthy()
    })
    expect(screen.queryByText('Logged in')).toBeNull()
  })

  it('accepts the login confirmation when only the tab-local status is stale but the shared credentials are live', async () => {
    // The inverse staleness direction: another tab's login committed (the
    // shared token cache + access shadow are live), but this tab's status
    // field still reads 'missing' because it is not synced cross-tab. The
    // shared-state re-read must keep this login's confirmation instead of
    // rejecting live credentials.
    settingsState.modelCredentialStatus = 'expired'
    applyGatewayLoginTokensMock.mockImplementation(async (_token, options) => {
      options.onCommit()
      // The stale tab-local field keeps saying 'missing' — the verdict must
      // come from the shared state, which stays live.
      settingsState.modelCredentialStatus = 'missing'
      return { ok: true, accessToken: 'new-access-token', models: [] }
    })

    const user = userEvent.setup()
    render(<LLMGatewayCard isExpanded onToggle={() => {}} />)

    await waitForLoggedInPanel()
    await user.click(screen.getByRole('button', { name: 'Log in again' }))

    await waitFor(() => {
      expect(screen.getByText('Logged in')).toBeTruthy()
    })
    expect(screen.queryByText('Authentication failed')).toBeNull()
  })

  it('keeps the logged-in UI when a concurrent login commits shared credentials before the logout in-lock re-read', async () => {
    // Sourcery (PR #128): the logout's in-lock supersession check read the
    // tab-local modelCredentialStatus — not synced cross-tab, so another
    // tab's committed login stayed invisible here and the logout cleared
    // the card over a live session. The check now re-reads the SHARED
    // token cache + access shadow inside the credential lock: their
    // survival means a newer login won.
    settingsState.modelCredentialStatus = 'valid'
    gatewayMock.logoutGateway.mockImplementation(async () => {
      // The purge removed the shared credentials...
      gatewayMock.hasStoredTokens.mockReturnValue(false)
      apiKeyState.key = null
      // The out-of-lock freshness read below sees the purge (the queue's
      // first `once` returns null)...
      loadApiKeyMock.mockImplementationOnce(async () => null)
      // ...and the concurrent login commits right after it (it queued on
      // the same credential lock), repopulating the shared token cache and
      // shadow — so the IN-LOCK re-read sees the newer session (the
      // queue's second `once` returns the new key).
      gatewayMock.hasStoredTokens.mockReturnValue(true)
      loadApiKeyMock.mockImplementationOnce(async () => 'newer-login-access-token')
    })

    const user = userEvent.setup()
    render(<LLMGatewayCard isExpanded onToggle={() => {}} />)

    await waitForLoggedInPanel()
    await user.click(screen.getByRole('button', { name: 'Log out' }))

    await waitFor(() => {
      expect(screen.getByText('Logged in')).toBeTruthy()
    })
    // The logout must not have cleared the newer login's state.
    expect(settingsState.setModelCredentialStatus).not.toHaveBeenCalledWith('missing')
    expect(screen.queryByText('Login expired')).toBeNull()
  })
})
