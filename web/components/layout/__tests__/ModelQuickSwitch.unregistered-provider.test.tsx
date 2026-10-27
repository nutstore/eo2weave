/**
 * Tests for the unregistered-dynamic-provider chip state (issue #87).
 *
 * When the persisted selection names a dynamic provider (codex-oauth) that
 * never registered this session (extension removed / auth revoked), the
 * chip must:
 *  - show the amber "Codex unavailable — sign in again" warning instead of
 *    pretending the model name is usable,
 *  - carry the warning triangle + accessible label (same family as the
 *    gateway-expired state from #84),
 *  - keep the persisted selection (no switchProviderAndModel call) so a
 *    successful re-login seamlessly restores it.
 */

import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { settingsState } = vi.hoisted(() => ({
  settingsState: {
    providerType: 'codex-oauth',
    modelName: 'gpt-6-luna',
    modelCredentialStatus: 'unknown' as 'unknown' | 'valid' | 'expired' | 'unauthorized' | 'missing',
    switchProviderAndModel: vi.fn(),
    getAvailableProviders: vi.fn(async () => [] as Array<{
      providerType: string
      displayName: string
      models: Array<{ id: string; name: string }>
      providerKey: string
    }>),
    // Read by ModelQuickSwitch's memo via useSettingsStore.getState():
    // the live provider config registry — null means "not registered".
    getEffectiveProviderConfig: vi.fn<() => unknown>(() => null),
    getStalePinnedModels: vi.fn(() => [] as string[]),
    _providerRefreshVersion: 0,
  },
}))

vi.mock('@/store/settings.store', () => {
  const useSettingsStore = ((selector?: (s: typeof settingsState) => unknown) =>
    selector ? selector(settingsState) : settingsState) as unknown as
    typeof import('@/store/settings.store').useSettingsStore
  ;(useSettingsStore as unknown as { getState: () => typeof settingsState }).getState =
    () => settingsState
  return { useSettingsStore }
})

// The real @/agent/providers/types module is deliberately NOT mocked:
// isPotentiallyDynamicProviderType / getProviderConfig are pure registry
// reads, and an empty dynamic registry is exactly the #87 scenario.

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => ({
    'topbar.modelSwitcher.loading': 'Loading models…',
    'topbar.modelSwitcher.noModels': 'No models available',
    'topbar.modelSwitcher.codexUnavailableWarning': 'Codex unavailable — sign in again',
    'topbar.modelSwitcher.credentialExpired': 'Re-login required',
    'topbar.modelSwitcher.credentialExpiredWarning': 'Selected model needs re-login — click to manage the gateway credential',
    'topbar.modelSwitcher.noUsableModelWarning': 'No usable model selected — click to pick one',
    'topbar.modelSwitcher.currentModelDelistedTooltip': 'The selected model may have been delisted.',
    'topbar.modelSwitcher.title': 'Quick Model Switch',
  })[key] ?? key,
}))

vi.mock('@creatorweave/ui', () => ({
  Popover: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BrandButton: ({
    children,
    ...rest
  }: { children: ReactNode } & Record<string, unknown>) => (
    <button type="button" {...rest}>
      {children}
    </button>
  ),
  BrandSwitch: () => <button type="button">switch</button>,
}))

import { ModelQuickSwitch } from '../ModelQuickSwitch'

describe('ModelQuickSwitch unregistered dynamic provider (#87)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settingsState.providerType = 'codex-oauth'
    settingsState.modelName = 'gpt-6-luna'
    settingsState.modelCredentialStatus = 'unknown'
    settingsState.getEffectiveProviderConfig = vi.fn(() => null)
    settingsState.getAvailableProviders = vi.fn(async () => [])
  })

  it('shows the amber Codex-unavailable warning instead of a usable model name', async () => {
    render(<ModelQuickSwitch />)

    // Label waits for the provider list load to settle.
    await vi.waitFor(() => {
      expect(screen.getByTitle(/gpt-6-luna/)).toHaveTextContent(
        'gpt-6-luna · Codex unavailable — sign in again',
      )
    })
    // Amber warning state on the trigger.
    const trigger = screen.getByRole('button', { name: 'Codex unavailable — sign in again' })
    expect(trigger.className).toContain('text-amber-600')
    // Warning triangle carries the same accessible label.
    expect(screen.getByLabelText('Codex unavailable — sign in again')).toBeInTheDocument()
  })

  it('keeps the persisted selection — no switch/clear is issued', async () => {
    render(<ModelQuickSwitch />)

    await vi.waitFor(() => {
      expect(screen.getByTitle(/gpt-6-luna/)).toBeInTheDocument()
    })
    expect(settingsState.switchProviderAndModel).not.toHaveBeenCalled()
    expect(settingsState.providerType).toBe('codex-oauth')
    expect(settingsState.modelName).toBe('gpt-6-luna')
  })

  it('does not warn when the codex-oauth provider IS registered this session', async () => {
    settingsState.getEffectiveProviderConfig = vi.fn(() => ({
      baseURL: 'https://codex.example',
      modelName: 'gpt-6-luna',
    }))
    settingsState.getAvailableProviders = vi.fn(async () => [
      {
        providerType: 'codex-oauth',
        displayName: 'Codex (Browser OAuth)',
        models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }],
        providerKey: 'codex-oauth',
      },
    ])

    render(<ModelQuickSwitch />)

    await vi.waitFor(() => {
      expect(screen.getAllByTitle('GPT-6 Luna').length).toBeGreaterThan(0)
    })
    expect(screen.queryByLabelText('Codex unavailable — sign in again')).not.toBeInTheDocument()
    expect(screen.queryByText(/Codex unavailable/)).not.toBeInTheDocument()
  })

  it('does not warn for non-dynamic providers that are simply missing from the list', async () => {
    settingsState.providerType = 'openai'
    settingsState.modelName = 'gpt-4o'

    render(<ModelQuickSwitch />)

    await vi.waitFor(() => {
      expect(screen.getByTitle('gpt-4o')).toBeInTheDocument()
    })
    expect(screen.queryByLabelText('Codex unavailable — sign in again')).not.toBeInTheDocument()
  })

  it('treats the unregistered provider as no-usable-model even when the credential reads expired', async () => {
    // The stale virtual codex key satisfies hasApiKey and the status can
    // read expired — the dead-route warning must still win (#87: the
    // registry, not the credential, is what is missing).
    settingsState.modelCredentialStatus = 'expired'

    render(<ModelQuickSwitch />)

    await vi.waitFor(() => {
      expect(screen.getByTitle(/gpt-6-luna/)).toHaveTextContent(
        'Codex unavailable — sign in again',
      )
    })
    expect(screen.queryByText(/Re-login required/)).not.toBeInTheDocument()
  })
})
