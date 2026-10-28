import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dismissPackagePromptMock = vi.fn()
const enablePackageAndReloadMock = vi.fn<
  (id: string, token: string, late: unknown) => Promise<unknown>
>()

vi.mock('@/agent/sidepanel-package-prompt', () => ({
  dismissPackagePrompt: (...args: unknown[]) => dismissPackagePromptMock(...args),
  enablePackageAndReload: (...args: unknown[]) =>
    enablePackageAndReloadMock(...(args as [string, string, unknown])),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}))

import { toast } from 'sonner'
import { PackageOptInModal } from '../PackageOptInModal'

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
    // CJK-symbol emoji, keycaps and modifiers must never appear.
    const EMOJI =
      /[\u{1F000}-\u{1FAFF}]|[\u{2190}-\u{2BFF}]|[\u{FE00}-\u{FE0F}]|[\u{1F1E6}-\u{1F1FF}]|\u200d/u
    const text = container.textContent ?? ''
    expect(EMOJI.test(text)).toBe(false)
  })

  it('marks read-only and write tools with their own badges', () => {
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Expand tool list/ }))
    expect(screen.getByText('Read only')).toBeTruthy()
    expect(screen.getByText('Write')).toBeTruthy()
  })

  it('clicking the toggle label text flips the switch (no nested-label dead zone)', () => {
    const { container } = render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)
    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    expect(toggle.checked).toBe(true)
    fireEvent.click(screen.getByText('Enable and reload the page on confirm'))
    expect(toggle.checked).toBe(false)
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

  it('confirm with timeout: shows the dedicated timeout toast', async () => {
    enablePackageAndReloadMock.mockResolvedValue({ ok: false, errorCode: 'TIMEOUT' })
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining('timed out'),
      )
      expect(toast.error).not.toHaveBeenCalledWith(ENABLE_FAILED_TOAST)
    })
  })

  it('a late enable success (after the timeout answer) still shows the success toast', async () => {
    let lateCallback: ((result: { ok: boolean }) => void) | undefined
    enablePackageAndReloadMock.mockImplementation(
      async (_id: string, _token: string, onSettledLate: unknown) => {
        lateCallback = onSettledLate as (result: { ok: boolean }) => void
        return { ok: false, errorCode: 'TIMEOUT' }
      },
    )
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => expect(toast.error).toHaveBeenCalled())
    lateCallback?.({ ok: true })
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(ENABLED_TOAST))
  })

  it('"not now" records the dismissal cooldown and closes without enabling', () => {
    const onClose = vi.fn()
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: /Not now/ }))
    expect(dismissPackagePromptMock).toHaveBeenCalledWith('world.jmail.archive')
    expect(enablePackageAndReloadMock).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('unticking the switch turns confirm into a dismissal (no enable call)', async () => {
    const onClose = vi.fn()
    const { container } = render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))

    await waitFor(() => {
      expect(dismissPackagePromptMock).toHaveBeenCalledWith('world.jmail.archive')
      expect(enablePackageAndReloadMock).not.toHaveBeenCalled()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })

  it('a backdrop click does not close the modal', () => {
    const onClose = vi.fn()
    const { container } = render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    const backdrop = container.querySelector('[role="dialog"]') as HTMLElement
    fireEvent.click(backdrop)
    expect(onClose).not.toHaveBeenCalled()
  })
})
