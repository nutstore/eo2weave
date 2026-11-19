/**
 * MarkdownLink workspace-file link interception tests.
 *
 * AI replies reference workspace files with plain relative markdown links
 * (e.g. `[Open the updated document](daily/2026-08-OKR.md)`). Those hrefs resolve
 * against the PAGE URL in the browser, so a plain anchor would navigate the
 * whole app away (404 / download). The interceptor must:
 *  - detect relative file links (no scheme, not anchor, not root-relative)
 *  - probe the workspace runtime (OPFS-first, so pending not-yet-synced files
 *    also resolve) and prefix candidates with each known rootName
 *  - open the resolved file via workspace store's openInFilePreview
 *  - fall back to a "file not found" toast when the probe misses — never
 *    navigate
 *  - leave absolute URLs / anchors / root-relative links untouched
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { MarkdownContent } from '../MarkdownContent'

const openInFilePreview = vi.fn()
const readFileMock = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string, params?: Record<string, unknown>) => {
    if (!params) return key
    let out = key
    for (const [k, v] of Object.entries(params)) {
      out = out.replace(`{${k}}`, String(v))
    }
    return out
  },
}))

vi.mock('@/store/workspace.store', () => ({
  useWorkspaceStore: {
    subscribe: vi.fn(),
    getState: () => ({
      activeWorkspaceId: 'ws-1',
      openInFilePreview,
    }),
  },
}))

vi.mock('@/opfs', () => ({
  getWorkspaceManager: async () => ({
    getWorkspace: async () => ({
      readFile: readFileMock,
    }),
  }),
}))

vi.mock('@/sqlite/repositories/project.repository', () => ({
  getProjectRepository: () => ({
    findActiveProject: async () => ({ id: 'project-1' }),
  }),
}))

vi.mock('@/sqlite/repositories/project-root.repository', () => ({
  getProjectRootRepository: () => ({
    findByProject: async () => [
      { name: 'creatorweave', isDefault: true, readOnly: false, backend: 'native-host' },
    ],
  }),
}))

vi.mock('@/native-fs', () => ({
  getRuntimeHandlesForProject: () => new Map(),
}))

vi.mock('@/store/folder-access.store', () => ({
  useFolderAccessStore: {
    getState: () => ({
      roots: [{ id: 'r1', name: 'creatorweave', backend: 'native-host', status: 'ready', handle: null, persistedHandle: null, isDefault: true, readOnly: false, scopeId: 's1' }],
    }),
  },
}))

describe('MarkdownContent link interception', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: the workspace resolves `creatorweave/daily/report.md`.
    readFileMock.mockRejectedValue(new Error('ENOENT'))
    readFileMock.mockImplementation(async (path: string) => {
      if (path === 'creatorweave/daily/report.md') {
        return { content: '# Report', metadata: { path }, source: 'opfs' }
      }
      if (path === 'creatorweave/daily/2026-09-16-周报.md') {
        return { content: '# 周报', metadata: { path }, source: 'opfs' }
      }
      throw new Error(`File not found: ${path}`)
    })
  })

  it('intercepts workspace-relative links and opens FilePreview with the rootName-prefixed path', async () => {
    render(<MarkdownContent content="[打开更新后的 OKR 进展文档](daily/report.md)" />)

    // Resolution is async — wait until the resolved path shows up in title.
    const link = await screen.findByTitle('creatorweave/daily/report.md')
    expect(link).not.toHaveAttribute('target', '_blank')

    fireEvent.click(link)
    expect(openInFilePreview).toHaveBeenCalledWith('creatorweave/daily/report.md')
  })

  it('decodes percent-encoded non-ASCII hrefs before probing the workspace', async () => {
    // react-markdown serializes non-ASCII hrefs percent-encoded (normalizeUri)
    render(<MarkdownContent content="[打开周报](daily/2026-09-16-%E5%91%A8%E6%8A%A5.md)" />)

    const link = await screen.findByTitle('creatorweave/daily/2026-09-16-周报.md')
    fireEvent.click(link)
    expect(openInFilePreview).toHaveBeenCalledWith('creatorweave/daily/2026-09-16-周报.md')
  })

  it('does not navigate the app for a missing file and shows the not-found toast instead', async () => {
    readFileMock.mockRejectedValue(new Error('File not found'))

    render(<MarkdownContent content="[打开文档](daily/gone.md)" />)

    const link = await screen.findByTitle('daily/gone.md')
    fireEvent.click(link)

    await waitFor(() => {
      // The mocked useT passes the key through (it has no {path} placeholder),
      // so toast.error receives the final message string only.
      expect(toast.error).toHaveBeenCalledWith('filePreview.workspaceLinkNotFound')
    })
    expect(openInFilePreview).not.toHaveBeenCalled()
  })

  it('keeps absolute URLs as regular external links', () => {
    render(<MarkdownContent content="[官网](https://example.com)" />)

    const link = screen.getByText('官网').closest('a') as HTMLAnchorElement | null
    expect(link).not.toBeNull()
    expect(link!).toHaveAttribute('href', 'https://example.com')
    expect(link!).toHaveAttribute('target', '_blank')
    expect(link!).toHaveAttribute('rel', 'noopener noreferrer')

    fireEvent.click(link!)
    expect(openInFilePreview).not.toHaveBeenCalled()
  })

  it('does not intercept anchors or root-relative links', async () => {
    render(
      <MarkdownContent
        content={['[跳到章节](#section)', '[文档](/docs/zh/getting-started)'].join('\n\n')}
      />,
    )

    const anchorLink = screen.getByText('跳到章节').closest('a') as HTMLAnchorElement | null
    expect(anchorLink).not.toBeNull()
    expect(anchorLink!).toHaveAttribute('href', '#section')

    const docsLink = screen.getByText('文档').closest('a') as HTMLAnchorElement | null
    expect(docsLink).not.toBeNull()
    expect(docsLink!).toHaveAttribute('href', '/docs/zh/getting-started')
    expect(docsLink).toHaveAttribute('target', '_blank')

    // Give any (incorrect) async lookup a chance to flush, then assert no
    // preview request happened.
    await waitFor(() => {
      expect(openInFilePreview).not.toHaveBeenCalled()
    })
  })
})
