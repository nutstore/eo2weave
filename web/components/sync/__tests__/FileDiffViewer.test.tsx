import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FileDiffViewer } from '../FileDiffViewer'

const getActiveConversationMock = vi.fn()
const getNativeDirectoryHandleMock = vi.fn()

const fileExistsInNativeFSMock = vi.fn()
const readFileFromOPFSMock = vi.fn()
const readFileFromNativeFSMock = vi.fn()

vi.mock('../MonacoDiffEditor', () => ({
  default: () => <div data-testid="monaco-diff-editor" />,
}))

vi.mock('../LazyDiffViewer', () => ({
  default: () => <div data-testid="lazy-diff-viewer" />,
}))

vi.mock('@/store/conversation-context.store', () => ({
  getActiveConversation: () => getActiveConversationMock(),
}))

vi.mock('@/opfs', () => ({
  isImageFile: () => false,
  getFileContentType: () => 'text',
  fileExistsInNativeFS: (...args: unknown[]) => fileExistsInNativeFSMock(...args),
  readFileFromOPFS: (...args: unknown[]) => readFileFromOPFSMock(...args),
  readFileFromNativeFS: (...args: unknown[]) => readFileFromNativeFSMock(...args),
  readBinaryFileFromOPFS: vi.fn(),
  readBinaryFileFromNativeFS: vi.fn(),
}))

describe('FileDiffViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getNativeDirectoryHandleMock.mockResolvedValue({} as FileSystemDirectoryHandle)
    getActiveConversationMock.mockResolvedValue({
      conversationId: 'conv_1',
      conversation: {
        getNativeDirectoryHandle: getNativeDirectoryHandleMock,
      },
    })
    fileExistsInNativeFSMock.mockResolvedValue(true)
    readFileFromOPFSMock.mockResolvedValue('const n = 2')
    readFileFromNativeFSMock.mockResolvedValue('const n = 1')
  })

  it('renders lazy diff viewer for text file changes', async () => {
    render(
      <FileDiffViewer
        fileChange={{
          type: 'modify',
          path: 'src/example.ts',
          size: 128,
        }}
      />
    )

    // Default renderer is LazyDiffViewer (only changed hunks).
    // Monaco full editor is opt-in via the "switch" button.
    expect(await screen.findByTestId('lazy-diff-viewer')).toBeDefined()
  })

  it('falls back to runtime readFile when readFileFromOPFS misses an added file', async () => {
    // Direct files/ navigation misses cache-layer drafts; the runtime's
    // routed reader (prefer_opfs) should still surface the body so the
    // add-type diff renders instead of the placeholder.
    readFileFromOPFSMock.mockResolvedValue(null)
    getActiveConversationMock.mockResolvedValue({
      conversationId: 'conv_1',
      conversation: {
        getNativeDirectoryHandle: getNativeDirectoryHandleMock,
        readFile: vi.fn().mockResolvedValue({
          source: 'opfs',
          content: 'new file body',
          metadata: {},
        }),
        readCachedFile: vi.fn().mockResolvedValue(null),
      },
    })

    render(
      <FileDiffViewer
        fileChange={{
          type: 'add',
          path: 'src/brand-new.ts',
          size: 14,
        }}
      />
    )

    expect(await screen.findByTestId('lazy-diff-viewer')).toBeDefined()
  })

  it('shows a non-error placeholder when an added file body cannot be loaded', async () => {
    readFileFromOPFSMock.mockResolvedValue(null)
    getActiveConversationMock.mockResolvedValue({
      conversationId: 'conv_1',
      conversation: {
        getNativeDirectoryHandle: getNativeDirectoryHandleMock,
        readFile: vi.fn().mockRejectedValue(new Error('not found')),
        readCachedFile: vi.fn().mockResolvedValue(null),
      },
    })

    render(
      <FileDiffViewer
        fileChange={{
          type: 'add',
          path: 'src/brand-new.ts',
          size: 14,
        }}
      />
    )

    expect(
      await screen.findByText('Preview body unavailable for this new file'),
    ).toBeDefined()
    // The generic error-style message must NOT appear for add-type changes.
    expect(screen.queryByText('Cannot read changed version content')).toBeNull()
  })

  it('hides the diff instead of rendering an all-deletions view when a modify body is unreadable', async () => {
    // OPFS body missing + disk side readable: diffing disk text against ''
    // would mark EVERY line as deleted. Must show the explicit banner instead.
    readFileFromOPFSMock.mockResolvedValue(null)
    getActiveConversationMock.mockResolvedValue({
      conversationId: 'conv_1',
      conversation: {
        getNativeDirectoryHandle: getNativeDirectoryHandleMock,
        readFile: vi.fn(async (_path: string, _h: unknown, opts?: { policy?: string }) => {
          if (opts?.policy === 'prefer_native') {
            return { source: 'native', content: 'old disk content', metadata: {} }
          }
          throw new Error('not found')
        }),
        readCachedFile: vi.fn().mockResolvedValue(null),
      },
    })

    render(
      <FileDiffViewer
        fileChange={{
          type: 'modify',
          path: 'src/example.ts',
          size: 128,
        }}
      />
    )

    expect(
      await screen.findByText('New version content could not be loaded — diff hidden to avoid showing every line as deleted.'),
    ).toBeDefined()
    expect(screen.queryByTestId('lazy-diff-viewer')).toBeNull()
  })
})
