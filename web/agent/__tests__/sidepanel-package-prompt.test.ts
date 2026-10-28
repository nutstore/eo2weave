import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Module mocks ──
// The binding id comes from the side-panel context module; the bridge is a
// global. Both are controlled per-test below.
const getSidePanelBindingIdMock = vi.fn<() => string | null>(() => null)

vi.mock('@/agent/workspace-assistant-context', () => ({
  getSidePanelBindingId: () => getSidePanelBindingIdMock(),
}))

import {
  dismissPackagePrompt,
  enablePackageAndReload,
  getPendingPackagePrompt,
  isPackagePromptDismissed,
  resetPackagePromptDismissals,
  type PackageOptInStatus,
} from '../sidepanel-package-prompt'

type AgentWebShape = {
  webMCPPackageOptInStatus?: (binding: string) => Promise<PackageOptInStatus>
  webMCPPackageOptInEnable?: (binding: string, packageId: string) => Promise<{ ok?: boolean; error?: string }>
}

function setAgentWeb(agentWeb: AgentWebShape | undefined): void {
  ;(globalThis as { __agentWeb?: AgentWebShape }).__agentWeb = agentWeb
}

function okStatus(overrides: Partial<PackageOptInStatus> = {}): PackageOptInStatus {
  return {
    ok: true,
    applicable: true,
    enabled: false,
    package: {
      id: 'world.jmail.archive',
      description: 'Search and read the released archive emails.',
      hostname: 'jmail.world',
      activation: 'disabled',
      tools: [
        { name: 'read_page', description: 'Read a snapshot of the page.', readOnly: true },
        { name: 'search_emails', description: 'Search the archive.', readOnly: true },
      ],
    },
    ...overrides,
  }
}

const BINDING = '7b0a2c66-6b1d-4a2e-9f0c-1c2d3e4f5a6b'

describe('getPendingPackagePrompt', () => {
  beforeEach(() => {
    getSidePanelBindingIdMock.mockReturnValue(null)
    setAgentWeb(undefined)
    resetPackagePromptDismissals()
  })

  it('returns null when not in side-panel mode (no binding)', async () => {
    const result = await getPendingPackagePrompt()
    expect(result).toBeNull()
  })

  it('returns null when the extension bridge is unavailable', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    const result = await getPendingPackagePrompt()
    expect(result).toBeNull()
  })

  it('returns null when no package matches the bound tab', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb({
      webMCPPackageOptInStatus: vi.fn().mockResolvedValue({ ok: true, applicable: false }),
    })
    expect(await getPendingPackagePrompt()).toBeNull()
  })

  it('returns null when the bridge reports a failure', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb({
      webMCPPackageOptInStatus: vi.fn().mockResolvedValue({ ok: false, applicable: false, errorCode: 'UNAUTHORIZED_TARGET' }),
    })
    expect(await getPendingPackagePrompt()).toBeNull()
  })

  it('returns null when the package is already enabled', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb({
      webMCPPackageOptInStatus: vi.fn().mockResolvedValue(okStatus({ enabled: true })),
    })
    expect(await getPendingPackagePrompt()).toBeNull()
  })

  it('returns null when the package activation is already enabled', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    const status = okStatus()
    status.package = { ...status.package!, activation: 'enabled' }
    setAgentWeb({ webMCPPackageOptInStatus: vi.fn().mockResolvedValue(status) })
    expect(await getPendingPackagePrompt()).toBeNull()
  })

  it('returns the package when applicable, disabled and not dismissed', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    const status = vi.fn().mockResolvedValue(okStatus())
    setAgentWeb({ webMCPPackageOptInStatus: status })

    const result = await getPendingPackagePrompt()
    expect(status).toHaveBeenCalledWith(BINDING)
    expect(result?.applicable).toBe(true)
    expect(result?.package?.id).toBe('world.jmail.archive')
    expect(result?.enabled).toBe(false)
  })

  it('returns null while the 1-day dismissal cooldown is active, and again afterwards', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb({
      webMCPPackageOptInStatus: vi.fn().mockResolvedValue(okStatus()),
    })

    dismissPackagePrompt('world.jmail.archive')
    expect(await getPendingPackagePrompt()).toBeNull()

    // Simulate cooldown expiry: backdate the dismissal past 24 hours.
    const raw = localStorage.getItem('cw_webmcp_package_prompt_dismissed_v1')!
    const map = JSON.parse(raw) as Record<string, number>
    map['world.jmail.archive'] = Date.now() - 25 * 60 * 60 * 1000
    localStorage.setItem('cw_webmcp_package_prompt_dismissed_v1', JSON.stringify(map))

    expect(isPackagePromptDismissed('world.jmail.archive')).toBe(false)
    const result = await getPendingPackagePrompt()
    expect(result?.package?.id).toBe('world.jmail.archive')
  })

  it('resolves null when the bridge probe rejects (never throws)', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb({
      webMCPPackageOptInStatus: vi.fn().mockRejectedValue(new Error('bridge gone')),
    })
    expect(await getPendingPackagePrompt()).toBeNull()
  })
})

describe('dismissPackagePrompt', () => {
  beforeEach(() => {
    resetPackagePromptDismissals()
  })

  it('records the dismissal per package id', () => {
    dismissPackagePrompt('world.jmail.archive')
    expect(isPackagePromptDismissed('world.jmail.archive')).toBe(true)
    expect(isPackagePromptDismissed('com.douban.movie')).toBe(false)
  })

  it('persists the timestamp in localStorage', () => {
    dismissPackagePrompt('world.jmail.archive')
    const map = JSON.parse(
      localStorage.getItem('cw_webmcp_package_prompt_dismissed_v1')!,
    ) as Record<string, number>
    expect(typeof map['world.jmail.archive']).toBe('number')
    expect(map['world.jmail.archive']).toBeLessThanOrEqual(Date.now())
  })
})

describe('enablePackageAndReload', () => {
  beforeEach(() => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb(undefined)
  })

  it('passes binding + packageId to the bridge and returns true on ok', async () => {
    const enable = vi.fn().mockResolvedValue({ ok: true, packageId: 'world.jmail.archive', reloaded: true })
    setAgentWeb({ webMCPPackageOptInEnable: enable })
    const result = await enablePackageAndReload('world.jmail.archive')
    expect(enable).toHaveBeenCalledWith(BINDING, 'world.jmail.archive')
    expect(result).toBe(true)
  })

  it('returns false when the bridge answers ok: false', async () => {
    setAgentWeb({
      webMCPPackageOptInEnable: vi.fn().mockResolvedValue({ ok: false, error: 'PACKAGE_MISMATCH' }),
    })
    expect(await enablePackageAndReload('world.jmail.archive')).toBe(false)
  })

  it('returns false without a binding (non-side-panel context)', async () => {
    getSidePanelBindingIdMock.mockReturnValue(null)
    setAgentWeb({ webMCPPackageOptInEnable: vi.fn() })
    expect(await enablePackageAndReload('world.jmail.archive')).toBe(false)
  })

  it('returns false when the bridge method is missing (stale extension)', async () => {
    setAgentWeb({})
    expect(await enablePackageAndReload('world.jmail.archive')).toBe(false)
  })
})
