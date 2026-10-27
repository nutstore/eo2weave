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
    'topbar.modelSwitcher.providerUnavailableWarning': 'Provider unavailable — sign in again',
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
import { registerDynamicProvider, unregisterDynamicProvider } from '@/agent/providers/types'

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
    // (Sourcery round 4) The triangle is decoration only — it must be hidden
    // from assistive tech so it never duplicates/conflicts with the button's
    // provider-specific "sign in again" label.
    const triangle = document.querySelector<SVGElement>('svg.lucide-alert-triangle, svg.lucide-triangle-alert')
    expect(triangle).not.toBeNull()
    expect(triangle).toHaveAttribute('aria-hidden', 'true')
    // The old generic guidance label is gone from the accessibility tree.
    expect(screen.queryByLabelText('No usable model selected — click to pick one')).not.toBeInTheDocument()
    // Both elements inside the trigger carry the warning, so scope the
    // sanity check to the trigger's subtree.
    expect(trigger).toContainElement(triangle)
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
    // The component now treats the LIVE registry as authoritative, so the
    // "registered" case must actually register codex-oauth in the real
    // dynamic-provider registry (not just appear in the providers list).
    registerDynamicProvider(
      'codex-oauth',
      { baseURL: 'https://chatgpt.com/backend-api/codex', modelName: 'gpt-6-luna', headers: {} },
      {
        category: 'custom',
        displayName: 'Codex (Browser OAuth)',
        models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', capabilities: ['code', 'reasoning'] }],
      },
    )
    settingsState.getAvailableProviders = vi.fn(async () => [
      {
        providerType: 'codex-oauth',
        displayName: 'Codex (Browser OAuth)',
        models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }],
        providerKey: 'codex-oauth',
      },
    ])
    settingsState.getEffectiveProviderConfig = vi.fn(() => ({
      baseURL: 'https://codex.example',
      modelName: 'gpt-6-luna',
    }))

    try {
      render(<ModelQuickSwitch />)

      await vi.waitFor(() => {
        expect(screen.getAllByTitle('GPT-6 Luna').length).toBeGreaterThan(0)
      })
      expect(screen.queryByLabelText('Codex unavailable — sign in again')).not.toBeInTheDocument()
      expect(screen.queryByText(/Codex unavailable/)).not.toBeInTheDocument()
    } finally {
      unregisterDynamicProvider('codex-oauth')
    }
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

  // ── Sourcery round 5: the LIVE registry is authoritative ──
  it('still flags the provider as unregistered when a stale cached list still contains it', async () => {
    // The provider unregistered after the list was loaded: the cached
    // `providers` snapshot still contains codex-oauth, but the live
    // registry has no config for it. The old `liveInList` logic treated
    // the cached entry as proof of registration and showed a usable model.
    settingsState.getAvailableProviders = vi.fn(async () => [
      {
        providerType: 'codex-oauth',
        displayName: 'Codex (Browser OAuth)',
        models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }],
        providerKey: 'codex-oauth',
      },
    ])
    settingsState.getEffectiveProviderConfig = vi.fn(() => null)

    render(<ModelQuickSwitch />)

    // The stale cached list still resolves the model display name, but the
    // live-registry miss must still produce the unavailable warning.
    await vi.waitFor(() => {
      expect(screen.getByTitle(/Codex unavailable/)).toHaveTextContent(
        'GPT-6 Luna · Codex unavailable — sign in again',
      )
    })
    const trigger = screen.getByRole('button', { name: 'Codex unavailable — sign in again' })
    expect(trigger.className).toContain('text-amber-600')
  })

  // ── Sourcery round 5: warning copy must match the provider kind ──
  it('uses provider-neutral warning copy for an unregistered llm-gateway provider', async () => {
    settingsState.providerType = 'llm-gateway'
    settingsState.modelName = 'gateway-model'

    render(<ModelQuickSwitch />)

    await vi.waitFor(() => {
      expect(screen.getByTitle(/gateway-model/)).toHaveTextContent(
        'Provider unavailable — sign in again',
      )
    })
    expect(screen.queryByText(/Codex unavailable/)).not.toBeInTheDocument()
    const trigger = screen.getByRole('button', { name: 'Provider unavailable — sign in again' })
    expect(trigger.className).toContain('text-amber-600')
  })

  it('uses provider-neutral warning copy for an unregistered custom-* provider', async () => {
    settingsState.providerType = 'custom-abc123'
    settingsState.modelName = 'local-model'

    render(<ModelQuickSwitch />)

    await vi.waitFor(() => {
      expect(screen.getByTitle(/local-model/)).toHaveTextContent(
        'Provider unavailable — sign in again',
      )
    })
    expect(screen.queryByText(/Codex unavailable/)).not.toBeInTheDocument()
  })
})
