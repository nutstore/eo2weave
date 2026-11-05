import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SkillDiscover } from '../SkillDiscover'
import { fetchSkillStoreManifest } from '@/skills/skill-store'

// i18n hook: return the key so assertions can match `skills.discover.*` directly.
// useLocale returns a controllable locale so tests can assert locale-aware
// description selection (#139 review: store ignores translated descriptions).
let mockLocale = 'en-US'
vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
  useLocale: () => [mockLocale, vi.fn()],
}))

// SkillToolbar: stub the shared toolbar primitives so the test stays focused
// on SkillDiscover behaviour rather than toolbar internals.
vi.mock('../SkillToolbar', () => ({
  SkillSearchInput: ({ placeholder, ariaLabel }: { placeholder: string; ariaLabel?: string }) => (
    <input type="search" placeholder={placeholder} aria-label={ariaLabel} />
  ),
  SkillSegmentFilter: ({ options }: { options: Array<{ value: string; label: string }> }) => (
    <div>
      {options.map((o) => (
        <span key={o.value}>{o.label}</span>
      ))}
    </div>
  ),
  SkillRefreshButton: ({ label, ariaLabel }: { label: string; ariaLabel?: string }) => (
    <button type="button" title={label} aria-label={ariaLabel ?? label}>
      refresh
    </button>
  ),
}))

// BrandButton: minimal stub matching the props SkillDiscover uses.
// BrandDialog* are pass-through stubs — the bundle-update consent dialog
// (#183) is only rendered as an element and never opened in these tests.
vi.mock('@creatorweave/ui', () => ({
  BrandButton: ({
    children,
    disabled,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode
    disabled?: boolean
    onClick?: () => void
    'aria-label'?: string
  }) => (
    <button type="button" disabled={disabled} onClick={onClick} aria-label={ariaLabel}>
      {children}
    </button>
  ),
  BrandCheckbox: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <input type="checkbox" aria-label={ariaLabel} />
  ),
  BrandDialog: ({ open, children }: { open?: boolean; children: React.ReactNode }) =>
    open ? <div>{children}</div> : null,
  BrandDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BrandDialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BrandDialogTitle: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BrandDialogBody: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  BrandDialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/store/skills.store', () => ({
  useSkillsStore: (selector: (state: { bumpSkillsScanVersion: () => void }) => unknown) =>
    selector({ bumpSkillsScanVersion: vi.fn() }),
}))

vi.mock('@/skills/skill-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/skills/skill-store')>()),
  fetchSkillStoreManifest: vi.fn().mockResolvedValue({ skills: [] }),
  annotateInstalled: vi.fn((skills: unknown[]) => skills),
  scanInstalledDirNames: vi.fn().mockResolvedValue(new Set<string>()),
  installSkillFromUrl: vi.fn(),
  invalidateSkillStoreCache: vi.fn(),
}))

describe('SkillDiscover', () => {
  beforeEach(() => {
    vi.mocked(fetchSkillStoreManifest).mockResolvedValue({
      version: '1',
      generated: '2026-08-04T00:00:00.000Z',
      count: 0,
      skills: [],
    })
  })

  it('renders search input and install-state filter after manifest loads', async () => {
    render(<SkillDiscover />)

    // Toolbar renders the search input and refresh button.
    expect(await screen.findByPlaceholderText('skills.discover.searchPlaceholder')).toBeInTheDocument()
    expect(screen.getByLabelText('skills.discover.checkUpdatesAria')).toBeInTheDocument()

    // Filter segment renders three options with i18n keys.
    expect(screen.getByText('skills.discover.filterAll')).toBeInTheDocument()
    expect(screen.getByText('skills.discover.filterUninstalled')).toBeInTheDocument()
    expect(screen.getByText('skills.discover.filterInstalled')).toBeInTheDocument()
  })

  it('renders an installable skill card', async () => {
    vi.mocked(fetchSkillStoreManifest).mockResolvedValue({
      version: '1',
      generated: '2026-08-04T00:00:00.000Z',
      count: 1,
      skills: [{
        id: 'demo-skill',
        dirName: 'demo-skill',
        name: 'Demo skill',
        description: 'A skill used to verify the discovery card.',
        category: 'general',
        tags: [],
        version: '1.0.0',
        zipUrl: 'https://example.test/demo-skill.zip',
      }],
    })

    render(<SkillDiscover />)

    expect(await screen.findByText('Demo skill')).toBeInTheDocument()
  })

  it('renders the localized description for the active locale (#139 review: store ignores translated descriptions)', async () => {
    mockLocale = 'ja-JP'
    vi.mocked(fetchSkillStoreManifest).mockResolvedValue({
      version: '1',
      generated: '2026-08-04T00:00:00.000Z',
      count: 1,
      skills: [{
        id: 'demo-skill',
        dirName: 'demo-skill',
        name: 'Demo skill',
        description: 'Base English description',
        description_i18n: { 'ja-JP': '日本語の説明テキスト' },
        category: 'general',
        tags: [],
        version: '1.0.0',
        zipUrl: 'https://example.test/demo-skill.zip',
      }],
    })

    render(<SkillDiscover />)

    expect(await screen.findByText('日本語の説明テキスト')).toBeInTheDocument()
    expect(screen.queryByText('Base English description')).not.toBeInTheDocument()
    mockLocale = 'en-US'
  })

  it('falls back to the base description when the active locale has no translation', async () => {
    mockLocale = 'ko-KR'
    vi.mocked(fetchSkillStoreManifest).mockResolvedValue({
      version: '1',
      generated: '2026-08-04T00:00:00.000Z',
      count: 1,
      skills: [{
        id: 'demo-skill',
        dirName: 'demo-skill',
        name: 'Demo skill',
        description: 'Base English description',
        description_i18n: { 'zh-CN': '中文描述' },
        category: 'general',
        tags: [],
        version: '1.0.0',
        zipUrl: 'https://example.test/demo-skill.zip',
      }],
    })

    render(<SkillDiscover />)

    expect(await screen.findByText('Base English description')).toBeInTheDocument()
    mockLocale = 'en-US'
  })

  it('offers an update button for an installed skill (#154)', async () => {
    // The store may ship a newer version than the installed copy — the card
    // must offer the update path instead of only "Uninstall".
    vi.mocked(fetchSkillStoreManifest).mockResolvedValue({
      version: '1',
      generated: '2026-08-04T00:00:00.000Z',
      count: 1,
      skills: [{
        id: 'demo-skill',
        dirName: 'demo-skill',
        name: 'Demo skill',
        description: 'A skill used to verify the discovery card.',
        category: 'general',
        tags: [],
        version: '2.0.0',
        zipUrl: 'https://example.test/demo-skill.zip',
        installed: true,
      }],
    })

    render(<SkillDiscover />)

    expect(await screen.findByText('skills.discover.update')).toBeInTheDocument()
    expect(screen.getByText('skills.discover.uninstall')).toBeInTheDocument()
  })

  it('reports a no-op install as "Already installed", not "Updated" (#154 round 8)', async () => {
    // The version-aware flow lands as 'current' when the installed copy
    // already matches — the done toast used to say "Updated" for every
    // update-button click, misreporting a no-op.
    const user = (await import('@testing-library/user-event')).default.setup()
    const { installSkillFromUrl, scanInstalledDirNames } = await import('@/skills/skill-store')
    vi.mocked(fetchSkillStoreManifest).mockResolvedValue({
      version: '1',
      generated: '2026-08-04T00:00:00.000Z',
      count: 1,
      skills: [{
        id: 'demo-skill',
        dirName: 'demo-skill',
        name: 'Demo skill',
        description: 'A skill used to verify the discovery card.',
        category: 'general',
        tags: [],
        version: '1.0.0',
        zipUrl: 'https://example.test/demo-skill.zip',
        installed: true,
      }],
    })
    vi.mocked(installSkillFromUrl).mockResolvedValue({
      count: 0,
      manifest: { id: 'demo-skill', dirName: 'demo-skill', name: 'Demo skill', description: '', category: '', tags: [], version: '1.0.0', zipUrl: 'https://example.test/demo-skill.zip' },
      outcome: 'current',
    })
    vi.mocked(scanInstalledDirNames).mockResolvedValue(new Set(['demo-skill']))

    render(<SkillDiscover />)

    const updateButtons = await screen.findAllByRole('button', { name: 'skills.discover.update' })
    await user.click(updateButtons[0])

    expect(await screen.findByText('skills.discover.alreadyInstalled')).toBeInTheDocument()
    expect(screen.queryByText('skills.discover.updateDone')).not.toBeInTheDocument()
  })
})
