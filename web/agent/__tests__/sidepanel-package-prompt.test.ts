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
  webMCPPackageOptInEnable?: (
    binding: string,
    packageId: string,
    consentToken: string,
  ) => Promise<{ ok?: boolean; error?: string; errorCode?: string; reloaded?: boolean }>
}

function setAgentWeb(agentWeb: AgentWebShape | undefined): void {
  ;(globalThis as { __agentWeb?: AgentWebShape }).__agentWeb = agentWeb
}

function okStatus(overrides: Partial<PackageOptInStatus> = {}): PackageOptInStatus {
  return {
    ok: true,
    applicable: true,
    enabled: false,
    consentToken: 'token-abc',
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

  it('returns a terminal (non-retryable) outcome when the bridge reports a failure', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb({
      webMCPPackageOptInStatus: vi.fn().mockResolvedValue({ ok: false, applicable: false, errorCode: 'UNAUTHORIZED_TARGET' }),
    })
    const result = await getPendingPackagePrompt()
    expect(result).toEqual({ applicable: false, retryable: false })
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

  it('returns the package with its consent token when applicable, disabled and not dismissed', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    const status = vi.fn().mockResolvedValue(okStatus())
    setAgentWeb({ webMCPPackageOptInStatus: status })

    const result = await getPendingPackagePrompt()
    expect(status).toHaveBeenCalledWith(BINDING)
    expect(result?.applicable).toBe(true)
    if (!result?.applicable) throw new Error('expected an applicable prompt')
    expect(result.package.id).toBe('world.jmail.archive')
    expect(result.enabled).toBe(false)
    expect(result.package.consentToken).toBe('token-abc')
  })

  it('returns null while the 1-day dismissal cooldown is active, and again afterwards', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb({
      webMCPPackageOptInStatus: vi.fn().mockResolvedValue(okStatus()),
    })

    dismissPackagePrompt('world.jmail.archive')
    expect(await getPendingPackagePrompt()).toBeNull()

    // Simulate cooldown expiry: backdate the dismissal past 24 hours.
    const key = 'cw_webmcp_package_prompt_dismissed_v1.world.jmail.archive'
    const ts = JSON.parse(localStorage.getItem(key)!) as number
    localStorage.setItem(key, JSON.stringify(ts - 25 * 60 * 60 * 1000))

    expect(isPackagePromptDismissed('world.jmail.archive')).toBe(false)
    const result = await getPendingPackagePrompt()
    expect(result?.applicable).toBe(true)
    if (!result?.applicable) throw new Error('expected an applicable prompt')
    expect(result.package.id).toBe('world.jmail.archive')
  })

  it('resolves a retryable outcome when the bridge probe rejects (never throws)', async () => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb({
      webMCPPackageOptInStatus: vi.fn().mockRejectedValue(new Error('bridge gone')),
    })
    expect(await getPendingPackagePrompt()).toEqual({ applicable: false, retryable: true })
  })

  it('marks a 4s probe timeout as retryable', async () => {
    vi.useFakeTimers()
    try {
      getSidePanelBindingIdMock.mockReturnValue(BINDING)
      setAgentWeb({
        webMCPPackageOptInStatus: () => new Promise<PackageOptInStatus>(() => {}),
      })
      const pending = getPendingPackagePrompt()
      const assertion = pending.then(result => {
        expect(result).toEqual({ applicable: false, retryable: true })
      })
      await vi.advanceTimersByTimeAsync(4100)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('dismissPackagePrompt (concurrency-safe storage)', () => {
  beforeEach(() => {
    resetPackagePromptDismissals()
  })

  it('records the dismissal per package id', () => {
    dismissPackagePrompt('world.jmail.archive')
    expect(isPackagePromptDismissed('world.jmail.archive')).toBe(true)
    expect(isPackagePromptDismissed('com.douban.movie')).toBe(false)
  })

  it('uses one storage key per package so sibling dismissals cannot clobber each other', () => {
    dismissPackagePrompt('world.jmail.archive')
    dismissPackagePrompt('com.douban.movie')
    // Both cooldowns coexist — the shared-map race is structurally impossible.
    expect(isPackagePromptDismissed('world.jmail.archive')).toBe(true)
    expect(isPackagePromptDismissed('com.douban.movie')).toBe(true)

    const ts = JSON.parse(
      localStorage.getItem('cw_webmcp_package_prompt_dismissed_v1.world.jmail.archive')!,
    ) as number
    expect(typeof ts).toBe('number')
    expect(ts).toBeLessThanOrEqual(Date.now())
  })

  it('resetPackagePromptDismissals clears every per-package key', () => {
    dismissPackagePrompt('world.jmail.archive')
    dismissPackagePrompt('com.douban.movie')
    resetPackagePromptDismissals()
    expect(isPackagePromptDismissed('world.jmail.archive')).toBe(false)
    expect(isPackagePromptDismissed('com.douban.movie')).toBe(false)
  })
})

describe('enablePackageAndReload', () => {
  beforeEach(() => {
    getSidePanelBindingIdMock.mockReturnValue(BINDING)
    setAgentWeb(undefined)
  })

  it('passes binding + packageId + consentToken to the bridge and returns ok on success', async () => {
    const enable = vi.fn().mockResolvedValue({ ok: true, packageId: 'world.jmail.archive', reloaded: true })
    setAgentWeb({ webMCPPackageOptInEnable: enable })
    const result = await enablePackageAndReload('world.jmail.archive', 'token-1')
    expect(enable).toHaveBeenCalledWith(BINDING, 'world.jmail.archive', 'token-1')
    expect(result.ok).toBe(true)
    expect(result.reloaded).toBe(true)
  })

  it('returns the structured error when the bridge answers ok: false', async () => {
    setAgentWeb({
      webMCPPackageOptInEnable: vi.fn().mockResolvedValue({
        ok: false,
        errorCode: 'PACKAGE_MISMATCH',
        error: 'Package does not match the bound tab location.',
      }),
    })
    const result = await enablePackageAndReload('world.jmail.archive', 'token-1')
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('PACKAGE_MISMATCH')
    expect(result.error).toContain('does not match')
  })

  it('returns false without a binding (non-side-panel context)', async () => {
    getSidePanelBindingIdMock.mockReturnValue(null)
    setAgentWeb({ webMCPPackageOptInEnable: vi.fn() })
    const result = await enablePackageAndReload('world.jmail.archive', 'token-1')
    expect(result).toMatchObject({ ok: false, errorCode: 'NO_BINDING' })
  })

  it('returns false when the bridge method is missing (stale extension)', async () => {
    setAgentWeb({})
    const result = await enablePackageAndReload('world.jmail.archive', 'token-1')
    expect(result).toMatchObject({ ok: false, errorCode: 'BRIDGE_UNAVAILABLE' })
  })

  it('reports TIMEOUT at 8s and forwards the late bridge outcome through onSettledLate', async () => {
    vi.useFakeTimers()
    try {
      const lateResult = { ok: true, reloaded: true }
      const enable = vi
        .fn<
          (b: string, p: string, t: string) => Promise<{ ok?: boolean; reloaded?: boolean }>
        >()
        .mockImplementation(
          () =>
            new Promise(resolve => {
              // The bridge answers long after the 8s client timeout.
              setTimeout(() => resolve(lateResult), 20_000)
            }),
        )
      setAgentWeb({ webMCPPackageOptInEnable: enable })
      const onSettledLate = vi.fn()
      const pending = enablePackageAndReload('world.jmail.archive', 'token-1', onSettledLate)

      await vi.advanceTimersByTimeAsync(8_100)
      const timedOut = await pending
      expect(timedOut).toMatchObject({ ok: false, errorCode: 'TIMEOUT' })

      // The enable was called exactly once — the timeout must not re-fire it.
      expect(enable).toHaveBeenCalledTimes(1)

      // When the bridge call lands, the real outcome is forwarded.
      await vi.advanceTimersByTimeAsync(20_000)
      expect(onSettledLate).toHaveBeenCalledTimes(1)
      expect(onSettledLate).toHaveBeenCalledWith(expect.objectContaining({ ok: true }))
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the cause and reports a structured failure when the bridge call rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      setAgentWeb({
        webMCPPackageOptInEnable: vi.fn().mockRejectedValue(new Error('port closed')),
      })
      const result = await enablePackageAndReload('world.jmail.archive', 'token-1')
      expect(result.ok).toBe(false)
      expect(result.errorCode).toBe('ENABLE_FAILED')
      expect(result.error).toBe('port closed')
      expect(consoleError).toHaveBeenCalled()
    } finally {
      consoleError.mockRestore()
    }
  })
})
