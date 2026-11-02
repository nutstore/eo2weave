import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dismissPackagePromptMock = vi.fn()
const enablePackageAndReloadMock = vi.fn<
  (id: string, token: string, late: unknown) => Promise<unknown>
>()
const enableLegacyRecipeAndReloadMock = vi.fn<
  (id: string, late?: unknown) => Promise<unknown>
>()

vi.mock('@/agent/sidepanel-package-prompt', () => ({
  dismissPackagePrompt: (...args: unknown[]) => dismissPackagePromptMock(...args),
  enablePackageAndReload: (...args: unknown[]) =>
    enablePackageAndReloadMock(...(args as [string, string, unknown])),
  enableLegacyRecipeAndReload: (...args: unknown[]) =>
    enableLegacyRecipeAndReloadMock(...(args as [string, unknown])),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

import { toast } from 'sonner'
import { PackageOptInModal } from '@/components/sidepanel/PackageOptInModal'

const ENABLED_TOAST = 'world.jmail.archive enabled — the page will reload to activate the tools'
const ENABLE_FAILED_TOAST =
  'Failed to enable. Please make sure the extension is up to date and try again.'

const packageInfo = {
  id: 'world.jmail.archive',
  description: 'Search and read the released archive emails.',
  hostname: 'jmail.world',
  activation: 'disabled' as const,
  consentToken: 'consent-token-1',
  tools: [
    { name: 'read_page', description: 'Read a snapshot of the page.', readOnly: true },
    { name: 'search_emails', description: 'Search the archive.', readOnly: false },
  ],
}

/** The modal renders the en-US strings via the real i18n store (default locale). */
describe('PackageOptInModal', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    enablePackageAndReloadMock.mockResolvedValue({ ok: true, reloaded: true })
    enableLegacyRecipeAndReloadMock.mockResolvedValue({ ok: true, reloaded: true })
  })

  it('renders the hostname, package id and tool count', () => {
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('jmail.world')).toBeTruthy()
    expect(screen.getByText('world.jmail.archive')).toBeTruthy()
    // The description carries the interpolated tool count.
    expect(screen.getByText(/\(2 tools\)/)).toBeTruthy()
  })

  it('contains no emoji anywhere and hides the tool list until it is expanded', () => {
    const { container } = render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)
    expect(screen.queryByText('read_page')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Expand tool list/ }))
    expect(screen.getByText('read_page')).toBeTruthy()
    expect(screen.getByText('search_emails')).toBeTruthy()
    // Emoji regression guard (Sourcery finding): pictographs, dingbats,
    // CJK-symbol emoji, keycaps and modifiers must never appear. The keycap
    // arm covers U+20E3 BOTH with and without a preceding VS16 (finding:
    // "Keycap emoji slips through test" — `1\u{20E3}` alone is still a
    // keycap emoji, so the combining sequence is matched directly).
    const EMOJI =
      /[\u{1F000}-\u{1FAFF}]|[\u{2190}-\u{2BFF}]|[\u{FE00}-\u{FE0F}]|[\u{1F1E6}-\u{1F1FF}]|\u200d|\u{20E3}/u
    const text = container.textContent ?? ''
    expect(EMOJI.test(text)).toBe(false)
    // The guard itself must be able to catch a VS16-less keycap sequence.
    expect(
      /[\u{1F000}-\u{1FAFF}]|[\u{2190}-\u{2BFF}]|[\u{FE00}-\u{FE0F}]|[\u{1F1E6}-\u{1F1FF}]|\u200d|\u{20E3}/u.test(
        '1\u{20E3}',
      ),
    ).toBe(true)
  })

  it('marks read-only and write tools with their own badges', () => {
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Expand tool list/ }))
    expect(screen.getByText('Read only')).toBeTruthy()
    expect(screen.getByText('Write')).toBeTruthy()
  })

  it('discloses additional package-wide tools when the enable covers more origins', () => {
    render(
      <PackageOptInModal
        packageInfo={{ ...packageInfo, totalTools: 5 }}
        onClose={vi.fn()}
      />,
    )
    expect(
      screen.getByText(/activates 3 additional tool/),
    ).toBeTruthy()
  })

  it('hides the additional-tools note when totalTools is absent or equals the tab count', () => {
    const { container } = render(
      <PackageOptInModal packageInfo={{ ...packageInfo, totalTools: 2 }} onClose={vi.fn()} />,
    )
    expect(container.textContent).not.toContain('additional tool')
  })

  it('new protocol: an empty matching-tools list keeps the other-origins disclosure and claims no site tools', () => {
    // The new protocol's `tools` = tools matching THIS tab, `totalTools` =
    // the package-wide count. With no matching tools the summary must not
    // claim site tools, and the other-origins note must stay visible.
    const { container } = render(
      <PackageOptInModal
        packageInfo={{ ...packageInfo, tools: [], totalTools: 5 }}
        onClose={vi.fn()}
      />,
    )
    expect(container.textContent).toContain('(0 tools)')
    expect(container.textContent).toContain('activates 5 additional tool')
  })

  it('confirm: enables the package with the consent token + shows the localized success toast + closes', async () => {
    const onClose = vi.fn()
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(enablePackageAndReloadMock).toHaveBeenCalledWith(
        'world.jmail.archive',
        'consent-token-1',
        expect.any(Function),
      )
      expect(toast.success).toHaveBeenCalledWith(ENABLED_TOAST)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
    expect(dismissPackagePromptMock).not.toHaveBeenCalled()
  })

  it('confirm with enabled-but-reload-failed: informational toast instead of plain success', async () => {
    enablePackageAndReloadMock.mockResolvedValue({ ok: true, reloaded: false })
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(toast.info).toHaveBeenCalledWith(
        expect.stringContaining('reload it manually'),
        // first arg only; assert via stringContaining above
      )
      expect(toast.success).not.toHaveBeenCalled()
    })
  })

  it('confirm with failure: shows the localized error toast, records the cooldown, closes', async () => {
    enablePackageAndReloadMock.mockResolvedValue({ ok: false, errorCode: 'PACKAGE_MISMATCH' })
    const onClose = vi.fn()
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(ENABLE_FAILED_TOAST)
      expect(dismissPackagePromptMock).toHaveBeenCalledWith('world.jmail.archive')
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('confirm with timeout: shows the timeout guidance and KEEPS the modal open for the late outcome', async () => {
    enablePackageAndReloadMock.mockResolvedValue({ ok: false, errorCode: 'TIMEOUT' })
    const onClose = vi.fn()
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      // The timeout message is shown INSIDE the modal (role=alert), not as a
      // transient toast: the enable call may still land, and the modal must
      // stay up so the late-settle callback can correct the picture.
      expect(screen.getByRole('alert').textContent).toContain('timed out')
      // Finding "Late success appears as failure": no dismissal cooldown and
      // no unmount on timeout — the enable may still succeed in background.
      expect(onClose).not.toHaveBeenCalled()
      expect(dismissPackagePromptMock).not.toHaveBeenCalled()
      expect(screen.getByRole('dialog')).toBeTruthy()
    })
  })

  it('a late enable success still shows the success notice, and a late ok with reloaded:false demands a manual reload', async () => {
    let lateCallback: ((result: { ok: boolean; reloaded?: boolean }) => void) | undefined
    enablePackageAndReloadMock.mockImplementation(
      async (_id: string, _token: string, onSettledLate: unknown) => {
        lateCallback = onSettledLate as (result: { ok: boolean; reloaded?: boolean }) => void
        return { ok: false, errorCode: 'TIMEOUT' }
      },
    )
    const onClose = vi.fn()
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    // Finding "Late success appears as failure": on timeout the modal must
    // stay open (no dismissal cooldown, no unmount) so the late outcome can
    // still reach the user.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('timed out'))
    expect(onClose).not.toHaveBeenCalled()
    expect(dismissPackagePromptMock).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    // Late ok WITH reload → plain success notice.
    lateCallback?.({ ok: true, reloaded: true })
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('world.jmail.archive enabled')
    })
    // Late ok WITHOUT reload (finding: "Late success hides reload failure") —
    // the user must be told to reload manually, never shown plain success.
    lateCallback?.({ ok: true, reloaded: false })
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('reload it manually')
    })
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('a CONSENT_REQUIRED failure is retryable: no dismissal cooldown, guidance STAYS in the open modal', async () => {
    const onClose = vi.fn()
    enablePackageAndReloadMock.mockResolvedValue({
      ok: false,
      errorCode: 'CONSENT_REQUIRED',
      error: 'Consent token missing, expired, already used, or bound to another tab/package.',
    })
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('expired')
    })
    // Retryable → the 1-day cooldown must NOT be recorded (finding: "Failed
    // opt-ins block retry"); AppBootstrap re-probes for a fresh token.
    expect(dismissPackagePromptMock).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    // Finding "Retry guidance disappears": the modal used to close() right
    // after setErrorMessage, unmounting the guidance before it could be
    // read. It must stay open with the message visible.
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('a VERIFY_INCOMPLETE outcome is NOT a failure: warning toast, NO cooldown, closes', async () => {
    // Finding "Enabled package reported failed": the background wrote the
    // config and reloaded but the post-write verification read kept failing.
    // VERIFY_INCOMPLETE must NOT fall into the generic failure branch (which
    // records the 1-day cooldown and claims "Failed to enable") — the enable
    // itself is committed.
    enablePackageAndReloadMock.mockResolvedValue({
      ok: false,
      errorCode: 'VERIFY_INCOMPLETE',
      error: 'The package was enabled and the page reloaded, but the final check could not be read.',
    })
    const onClose = vi.fn()
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalled()
    })
    expect(String(vi.mocked(toast.warning).mock.calls[0][0])).toContain('could not be verified')
    expect(dismissPackagePromptMock).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
    expect(toast.success).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('"not now" records the dismissal cooldown and closes without enabling', () => {
    const onClose = vi.fn()
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /Not now/ }))
    expect(dismissPackagePromptMock).toHaveBeenCalledWith('world.jmail.archive')
    expect(enablePackageAndReloadMock).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a backdrop click does not close the modal', () => {
    const onClose = vi.fn()
    const { container } = render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    const backdrop = container.querySelector('[role="dialog"]') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })

  // ── Legacy protocol (pre-#102 extension, issue #113) ──

  const legacyPackageInfo = {
    ...packageInfo,
    consentToken: undefined,
    displayName: 'JMessage',
    totalTools: 4,
    tools: [],
  }

  it('legacy confirm: calls recipeEnable via enableLegacyRecipeAndReload (NO consent token), success toast + close', async () => {
    const onClose = vi.fn()
    render(
      <PackageOptInModal packageInfo={legacyPackageInfo} legacy onClose={onClose} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      // Exactly one id + the late-outcome callback — no consent token.
      expect(enableLegacyRecipeAndReloadMock).toHaveBeenCalledTimes(1)
      expect(enableLegacyRecipeAndReloadMock).toHaveBeenCalledWith(
        'world.jmail.archive',
        expect.any(Function),
      )
      expect(enablePackageAndReloadMock).not.toHaveBeenCalled()
      expect(toast.success).toHaveBeenCalledWith(ENABLED_TOAST)
      expect(onClose).toHaveBeenCalledTimes(1)
    })
    expect(dismissPackagePromptMock).not.toHaveBeenCalled()
  })

  it('legacy confirm with failure: existing error toast + cooldown, and the new-protocol path is untouched', async () => {
    enableLegacyRecipeAndReloadMock.mockResolvedValue({ ok: false, errorCode: 'RECIPE_MISMATCH' })
    const onClose = vi.fn()
    render(
      <PackageOptInModal packageInfo={legacyPackageInfo} legacy onClose={onClose} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(ENABLE_FAILED_TOAST)
      expect(dismissPackagePromptMock).toHaveBeenCalledWith('world.jmail.archive')
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('non-legacy modal never calls the legacy enable', async () => {
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(enablePackageAndReloadMock).toHaveBeenCalledTimes(1)
      expect(enableLegacyRecipeAndReloadMock).not.toHaveBeenCalled()
    })
  })
})
