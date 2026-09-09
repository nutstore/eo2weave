import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DocumentationPage } from '@/components/docs/DocsPage'
import type { DocIndex, DocsIndexes } from '@/lib/docs-server'

// The docs page navigates via next/navigation (App Router). In unit tests
// there is no Next router, so provide a minimal mock whose push() writes to
// window.location (like the real router would) — the tests below assert the
// pushed path after clicking locale buttons.
const pushMock = vi.fn((to: string) => {
  window.history.pushState({}, '', to)
})

vi.mock('next/navigation', () => ({
  useNavigate: () => pushMock,
  useRouter: () => ({ push: pushMock, replace: pushMock, back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}))

const { localeState, setLocaleMock } = vi.hoisted(() => ({
  localeState: { value: 'zh-CN' as 'zh-CN' | 'en-US' },
  setLocaleMock: vi.fn(),
}))

vi.mock('@/i18n', () => ({
  useLocale: () => [localeState.value, setLocaleMock] as const,
}))

// Content is resolved server-side (lib/docs-server.ts) and passed in as
// props — the component itself never fetches, so tests provide the data.
const zhUserIndex: DocIndex = {
  title: '用户文档',
  pages: [{ slug: 'getting-started', title: '快速入门', file: 'getting-started.md', order: 1 }],
}

const enUserIndex: DocIndex = {
  title: 'User Documentation',
  pages: [{ slug: 'getting-started', title: 'Getting Started', file: 'getting-started.md', order: 1 }],
}

const zhDeveloperIndex: DocIndex = {
  title: '开发者文档',
  pages: [{ slug: 'guides-quick-start', title: '快速入门', file: 'guides/quick-start.md', category: 'guides', order: 101 }],
}

const enDeveloperIndex: DocIndex = {
  title: 'Developer Documentation',
  pages: [{ slug: 'quick-start', title: 'Quick Start', file: 'quick-start.md', order: 1 }],
}

const indexes: DocsIndexes = {
  zh: { user: zhUserIndex, developer: zhDeveloperIndex },
  en: { user: enUserIndex, developer: enDeveloperIndex },
}

function pageContentFor(index: DocIndex, slug: string, markdown: string) {
  const entry = index.pages.find((p) => p.slug === slug)
  if (!entry) throw new Error(`no entry ${slug}`)
  return { entry, markdown }
}

describe('DocsPage (server-provided props)', () => {
  beforeEach(() => {
    pushMock.mockClear()
    // Guard for the new architecture: rendering + navigating must not fetch.
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    localeState.value = 'zh-CN'
    setLocaleMock.mockReset()
    window.history.replaceState({}, '', '/')
    vi.unstubAllGlobals()
  })

  it('renders user docs without group headers', async () => {
    render(<DocumentationPage category="user" indexes={indexes} pageContent={null} />)

    const entries = await screen.findAllByText('快速入门')
    expect(entries.length).toBeGreaterThan(0)
    expect(screen.queryByText('使用指南')).not.toBeInTheDocument()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('renders developer docs without group headers', () => {
    render(<DocumentationPage category="developer" indexes={indexes} pageContent={null} />)

    expect(screen.getAllByText('快速入门').length).toBeGreaterThan(0)
    expect(screen.queryByText('开发指南')).not.toBeInTheDocument()
    expect(screen.queryByText('Guides')).not.toBeInTheDocument()
  })

  it('renders the locale-matching index for english locale', () => {
    localeState.value = 'en-US'

    render(<DocumentationPage category="user" indexes={indexes} pageContent={null} />)

    expect(screen.getAllByText('Getting Started').length).toBeGreaterThan(0)
  })

  it('switches locale to english from docs home', () => {
    render(<DocumentationPage indexes={indexes} pageContent={null} />)

    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    expect(setLocaleMock).toHaveBeenCalledWith('en-US')
  })

  it('renders server-provided markdown without frontmatter noise', async () => {
    render(
      <DocumentationPage
        category="user"
        page="getting-started"
        indexes={indexes}
        pageContent={pageContentFor(zhUserIndex, 'getting-started', '\n# 快速入门正文')}
      />,
    )

    await screen.findByText('快速入门正文')
    expect(screen.queryByText('title: 快速入门')).not.toBeInTheDocument()
    expect(screen.queryByText('order: 1')).not.toBeInTheDocument()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('shows the not-found state when the server resolved no page', () => {
    render(
      <DocumentationPage
        category="user"
        page="getting-started"
        indexes={indexes}
        pageContent={null}
      />,
    )

    expect(screen.getByText('文档未找到')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '返回目录' })).toBeInTheDocument()
  })

  it('keeps current page on locale switch when same slug exists', async () => {
    render(
      <DocumentationPage
        category="user"
        page="getting-started"
        indexes={indexes}
        pageContent={pageContentFor(zhUserIndex, 'getting-started', '\n# 快速入门正文')}
      />,
    )

    await screen.findByText('快速入门正文')
    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    await waitFor(() => {
      expect(window.location.pathname).toBe('/docs/en/user/getting-started')
    })
  })

  it('falls back to category home on locale switch when slug is missing', async () => {
    render(
      <DocumentationPage
        category="developer"
        page="guides-quick-start"
        indexes={indexes}
        pageContent={pageContentFor(zhDeveloperIndex, 'guides-quick-start', '\n# 开发者快速入门')}
      />,
    )

    await screen.findByText('开发者快速入门')
    fireEvent.click(screen.getByRole('button', { name: 'English' }))

    await waitFor(() => {
      expect(window.location.pathname).toBe('/docs/en/developer')
    })
  })
})
