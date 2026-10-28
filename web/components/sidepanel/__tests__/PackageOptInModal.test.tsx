import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const dismissPackagePromptMock = vi.fn()
const enablePackageAndReloadMock = vi.fn<(id: string) => Promise<boolean>>()

vi.mock('@/agent/sidepanel-package-prompt', () => ({
  dismissPackagePrompt: (...args: unknown[]) => dismissPackagePromptMock(...args),
  enablePackageAndReload: (...args: unknown[]) => enablePackageAndReloadMock(...(args as [string])),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

import { toast } from 'sonner'
import { PackageOptInModal } from '../PackageOptInModal'

const packageInfo = {
  id: 'world.jmail.archive',
  description: 'Search and read the released archive emails.',
  hostname: 'jmail.world',
  activation: 'disabled' as const,
  tools: [
    { name: 'read_page', description: 'Read a snapshot of the page.', readOnly: true },
    { name: 'search_emails', description: 'Search the archive.', readOnly: false },
  ],
}

describe('PackageOptInModal', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    enablePackageAndReloadMock.mockResolvedValue(true)
  })

  it('renders the hostname, package id and tool count', () => {
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('jmail.world')).toBeTruthy()
    expect(screen.getByText('world.jmail.archive')).toBeTruthy()
    // The description carries the interpolated tool count.
    expect(screen.getByText(/\(2 tools\)/)).toBeTruthy()
  })

  it('renders no emoji and hides the tool list until it is expanded', () => {
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)
    expect(screen.queryByText('read_page')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Expand tool list/ }))
    expect(screen.getByText('read_page')).toBeTruthy()
    expect(screen.getByText('search_emails')).toBeTruthy()
  })

  it('marks read-only and write tools with their own badges', () => {
    render(<PackageOptInModal packageInfo={packageInfo} onClose={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /Expand tool list/ }))
    expect(screen.getByText('Read only')).toBeTruthy()
    expect(screen.getByText('Write')).toBeTruthy()
  })

  it('confirm: enables the package + shows success toast + closes', async () => {
    const onClose = vi.fn()
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(enablePackageAndReloadMock).toHaveBeenCalledWith('world.jmail.archive')
      expect(toast.success).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalledTimes(1)
    })
    expect(dismissPackagePromptMock).not.toHaveBeenCalled()
  })

  it('confirm with failure: shows error toast, records the cooldown, closes', async () => {
    enablePackageAndReloadMock.mockResolvedValue(false)
    const onClose = vi.fn()
    render(<PackageOptInModal packageInfo={packageInfo} onClose={onClose} />)

    fireEvent.click(screen.getByRole('button', { name: 'Enable & reload page' }))
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalled()
      expect(dismissPackagePromptMock).toHaveBeenCalledWith('world.jmail.archive')
      expect(onClose).toHaveBeenCalledTimes(1)
    })
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
