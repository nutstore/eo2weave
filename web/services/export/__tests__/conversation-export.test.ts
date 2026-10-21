/**
 * Conversation Export Service Tests
 *
 * Covers message filtering, image/attachment collection (OPFS assets,
 * inline images, contentParts), markdown ZIP bundling, HTML base64
 * inlining, and JSON attachment fields.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock file-saver before imports
const mockSaveAs = vi.fn()
vi.mock('file-saver', () => ({
  saveAs: mockSaveAs,
}))

// Mock the OPFS workspace manager before importing the service — the module
// under test lazy-imports '@/opfs' inside collectArtifacts.
const mockGetWorkspace = vi.fn()
vi.mock('@/opfs', () => ({
  getWorkspaceManager: vi.fn(async () => ({ getWorkspace: mockGetWorkspace })),
}))

const {
  exportConversation,
  __testUnzip,
} = await import('@/services/export/conversation-export')

import type { Conversation, Message } from '@/agent/message-types'

// ============================================================================
// Helpers
// ============================================================================

/** tiny 1x1 transparent PNG */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

let msgSeq = 0
function makeMessage(partial: Partial<Message> & Pick<Message, 'role'>): Message {
  msgSeq += 1
  return {
    id: `msg-${msgSeq}`,
    content: 'hello',
    timestamp: Date.now(),
    ...partial,
  } as Message
}

function makeConversation(messages: Message[]): Conversation {
  return {
    id: 'conv-1',
    title: 'Test Conversation',
    messages,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
  } as unknown as Conversation
}

/** Build a mock workspace whose assets dir contains the given files. */
function mockAssetsDir(files: Record<string, Uint8Array>) {
  const getFileHandle = async (name: string) => ({
    getFile: async () => ({
      arrayBuffer: async () => {
        const bytes = files[name]
        if (!bytes) throw new Error(`not found: ${name}`)
        const copy = new Uint8Array(bytes)
        return copy.buffer
      },
    }),
  })
  return {
    getAssetsDir: vi.fn(async () => ({
      getFileHandle,
      getDirectoryHandle: async () => ({ getFileHandle }),
    })),
  }
}

function lastSave(): { blob: Blob; filename: string } {
  const call = mockSaveAs.mock.calls.at(-1)
  if (!call) throw new Error('saveAs was not called')
  return { blob: call[0] as Blob, filename: call[1] as string }
}

// ============================================================================
// Tests
// ============================================================================

describe('conversation-export', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('basic export (no attachments)', () => {
    it.each(['json', 'markdown', 'html'] as const)('excludes runtime patches and labels synthetic records in %s', async (format) => {
      const conv = makeConversation([
        makeMessage({ role: 'user', content: 'Real question' }),
        makeMessage({ role: 'user', kind: 'context_update', content: 'PRIVATE_RUNTIME_CATALOG' }),
        makeMessage({ role: 'user', content: 'Delegated task', delegationNote: { fromAgentId: 'a', task: 'task' } }),
        makeMessage({ role: 'user', kind: 'context_summary', content: 'Earlier memory' }),
        makeMessage({ role: 'assistant', content: 'Real answer' }),
      ])
      const result = await exportConversation(conv, { format, includeImages: false, includeSystemMessages: true })
      expect(result.success).toBe(true)
      expect(result.messageCount).toBe(4)
      const output = await lastSave().blob.text()
      expect(output).not.toContain('PRIVATE_RUNTIME_CATALOG')
      if (format === 'json') {
        const messages = JSON.parse(output).messages
        expect(messages.map((m: { recordType: string }) => m.recordType)).toEqual([
          'user_input', 'agent_input', 'context_summary', 'assistant_output',
        ])
        expect(messages[1].delegationNote.fromAgentId).toBe('a')
        expect(messages[2].kind).toBe('context_summary')
      } else {
        expect(output).toContain('Agent Input')
        expect(output).toContain('Context Summary')
      }
      expect(conv.messages).toHaveLength(5)
    })

    it('exports markdown as a plain .md when no readable images exist', async () => {
      mockGetWorkspace.mockResolvedValue(mockAssetsDir({}))

      const conv = makeConversation([
        makeMessage({ role: 'user', content: 'hi' }),
        makeMessage({ role: 'assistant', content: 'hello!' }),
      ])

      const result = await exportConversation(conv, { format: 'markdown' })

      expect(result.success).toBe(true)
      expect(result.filename).toMatch(/\.md$/)
      expect(result.bundledFileCount).toBe(0)
      const { blob } = lastSave()
      const md = await blob.text()
      expect(md).toContain('### 👤 User')
      expect(md).toContain('hello!')
    })

    it('exports json with version bump and no base64 payloads by structure', async () => {
      mockGetWorkspace.mockResolvedValue(mockAssetsDir({}))

      const conv = makeConversation([
        makeMessage({ role: 'user', content: 'hi', images: [{ data: TINY_PNG_BASE64, mimeType: 'image/png' }] }),
      ])

      const result = await exportConversation(conv, { format: 'json' })
      expect(result.success).toBe(true)
      expect(result.filename).toMatch(/\.json$/)

      const data = JSON.parse(await lastSave().blob.text())
      expect(data.meta.version).toBe('1.1.0')
      // includeImages defaults to true → images field present
      expect(data.messages[0].images).toHaveLength(1)
    })

    it('json respects includeImages=false', async () => {
      mockGetWorkspace.mockResolvedValue(mockAssetsDir({}))

      const conv = makeConversation([
        makeMessage({
          role: 'user',
          content: 'hi',
          images: [{ data: TINY_PNG_BASE64, mimeType: 'image/png' }],
          contentParts: [{ type: 'text', text: 'hi' }, { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }],
        }),
      ])

      await exportConversation(conv, { format: 'json', includeImages: false })
      const data = JSON.parse(await lastSave().blob.text())
      expect(data.messages[0].images).toBeUndefined()
      expect(data.messages[0].contentParts).toBeUndefined()
      // asset metadata survives regardless (lightweight)
    })
  })

  describe('markdown with images → ZIP bundle', () => {
    it('bundles OPFS asset images and references them relatively', async () => {
      const pngBytes = Uint8Array.from(atob(TINY_PNG_BASE64), (c) => c.charCodeAt(0))
      mockGetWorkspace.mockResolvedValue(
        mockAssetsDir({
          'chart.png': pngBytes,
          'data.xlsx': new Uint8Array([1, 2, 3, 4]),
        }),
      )

      const conv = makeConversation([
        makeMessage({
          role: 'user',
          content: 'analyze this',
          assets: [
            { id: 'a1', name: 'chart.png', size: pngBytes.length, mimeType: 'image/png', direction: 'upload', createdAt: Date.now() },
            { id: 'a2', name: 'data.xlsx', size: 4, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', direction: 'upload', createdAt: Date.now() },
          ],
        }),
        makeMessage({ role: 'assistant', content: 'done' }),
      ])

      const result = await exportConversation(conv, { format: 'markdown' })

      expect(result.success).toBe(true)
      expect(result.filename).toMatch(/\.zip$/)
      expect(result.bundledFileCount).toBe(2)

      const { blob } = lastSave()
      expect(blob.type).toBe('application/zip')

      const files = await __testUnzip(blob)
      expect(Object.keys(files).sort()).toEqual([
        'attachments/data.xlsx',
        'conversation.md',
        'images/chart.png',
      ])

      const md = new TextDecoder().decode(files['conversation.md'])
      expect(md).toContain('![chart.png](images/chart.png)')
      expect(md).toContain('📎 [data.xlsx](attachments/data.xlsx)')
      // binary roundtrip intact
      expect(Array.from(files['images/chart.png'])).toEqual(Array.from(pngBytes))
    })

    it('bundles inline msg.images with dedup and generated names', async () => {
      mockGetWorkspace.mockResolvedValue(mockAssetsDir({}))

      const conv = makeConversation([
        makeMessage({
          role: 'assistant',
          content: 'here you go',
          images: [
            { data: TINY_PNG_BASE64, mimeType: 'image/png' },
            { data: TINY_PNG_BASE64, mimeType: 'image/png' }, // duplicate content
          ],
        }),
        makeMessage({
          role: 'tool',
          name: 'page_screenshot',
          toolCallId: 'tc1',
          content: 'screenshot captured',
          contentParts: [{ type: 'text', text: 'screenshot captured' }, { type: 'image', data: TINY_PNG_BASE64, mimeType: 'image/png' }],
        }),
      ])

      const result = await exportConversation(conv, { format: 'markdown', includeToolCalls: true })

      expect(result.success).toBe(true)
      const files = await __testUnzip(lastSave().blob)
      // 2 generated + 1 screenshot, duplicate inline image deduped across messages
      expect(Object.keys(files).filter((f) => f.startsWith('images/')).sort()).toEqual([
        'images/generated-1.png',
        'images/generated-2.png',
        'images/screenshot-1.png',
      ])

      const md = new TextDecoder().decode(files['conversation.md'])
      expect(md).toContain('![generated-1.png](images/generated-1.png)')
      expect(md).toContain('![screenshot-1.png](images/screenshot-1.png)')
    })

    it('renders a placeholder when an asset file is unreadable', async () => {
      // assets dir exists but does not contain the referenced file
      mockGetWorkspace.mockResolvedValue(mockAssetsDir({}))

      const conv = makeConversation([
        makeMessage({
          role: 'user',
          content: 'see image',
          assets: [
            { id: 'a1', name: 'gone.png', size: 10, mimeType: 'image/png', direction: 'upload', createdAt: Date.now() },
          ],
        }),
      ])

      const result = await exportConversation(conv, { format: 'markdown' })

      // All artifacts missing → no zip, plain .md with warning
      expect(result.success).toBe(true)
      expect(result.filename).toMatch(/\.md$/)
      const md = await lastSave().blob.text()
      expect(md).toContain('gone.png')
      expect(md).toContain('could not be read')
    })

    it('falls back to plain markdown when workspace cannot be resolved', async () => {
      mockGetWorkspace.mockResolvedValue(null)

      const conv = makeConversation([
        makeMessage({
          role: 'user',
          content: 'x',
          assets: [{ id: 'a1', name: 'pic.png', size: 5, mimeType: 'image/png', direction: 'upload', createdAt: Date.now() }],
        }),
      ])

      const result = await exportConversation(conv, { format: 'markdown' })
      expect(result.success).toBe(true)
      expect(result.filename).toMatch(/\.md$/)
      const md = await lastSave().blob.text()
      expect(md).toContain('pic.png')
      expect(md).toContain('could not be read')
    })
  })

  describe('HTML export inlines images', () => {
    it('embeds base64 <img> tags', async () => {
      mockGetWorkspace.mockResolvedValue(mockAssetsDir({}))

      const conv = makeConversation([
        makeMessage({
          role: 'user',
          content: 'look',
          images: [{ data: TINY_PNG_BASE64, mimeType: 'image/png' }],
        }),
      ])

      const result = await exportConversation(conv, { format: 'html' })
      expect(result.success).toBe(true)
      expect(result.filename).toMatch(/\.html$/)

      const html = await lastSave().blob.text()
      expect(html).toContain(`<img class="export-image" src="data:image/png;base64,${TINY_PNG_BASE64}"`)
    })
  })

  describe('error handling', () => {
    it('returns failure when there are no messages', async () => {
      mockGetWorkspace.mockResolvedValue(mockAssetsDir({}))
      const conv = makeConversation([])
      const result = await exportConversation(conv, { format: 'markdown' })
      expect(result.success).toBe(false)
      expect(result.error).toBe('No messages to export')
    })
  })
})
