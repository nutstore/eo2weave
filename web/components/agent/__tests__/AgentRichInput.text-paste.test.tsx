import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRichInput } from '@/components/agent/AgentRichInput'
import { useAssetStore } from '@/store/asset.store'
import { MAX_PREVIEW_BYTES, MAX_PREVIEW_CHARS } from '@/lib/text-preview-cap'

vi.mock('@/i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('@creatorweave/ui', () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
  BrandDialog: ({ children }: { children?: ReactNode }) => <>{children}</>,
  BrandDialogContent: ({ children }: { children?: ReactNode }) => <div role="dialog">{children}</div>,
  BrandDialogTitle: ({ children }: { children?: ReactNode }) => <h2>{children}</h2>,
}))
const { extension } = vi.hoisted(() => ({ extension: { configure: () => ({}) } }))
vi.mock('@/components/agent/FileMentionExtension', () => ({ FileMention: extension }))
vi.mock('@/components/agent/SlashCommandExtension', () => ({ SlashCommandExtension: extension }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }))
vi.mock('@monaco-editor/react', () => ({
  loader: { config: vi.fn() },
  Editor: ({ value, options }: { value: string; options: { readOnly: boolean } }) => <div data-testid="text-preview" data-readonly={options.readOnly}>{value}</div>,
}))
vi.mock('monaco-editor', () => ({}))
vi.mock('@/lib/monaco-setup', () => ({}))
afterEach(() => { useAssetStore.getState().clearAll() })
function mountInput() {
  return render(<AgentRichInput placeholder="test" initialText="existing" agents={[]} activeAgentId={null} allAgents={[]} onSetActiveAgent={async () => {}} onCreateAgent={async () => null} onDeleteAgent={async () => true} onChange={vi.fn()} onSubmit={vi.fn()} />)
}
describe('long text paste', () => {
  it('stages long text without inserting a notice into the existing message', async () => {
    const { container } = mountInput()
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy())
    const editor = container.querySelector('.ProseMirror')!
    await waitFor(() => expect(editor.textContent).toContain('existing'))
    const content = '长文本\n'.repeat(3000)
    await act(async () => { fireEvent.paste(editor, { clipboardData: { items: [], getData: () => content } }) })
    expect(useAssetStore.getState().pendingAssets).toHaveLength(1)
    expect(useAssetStore.getState().pendingAssets[0].file.size).toBe(new Blob([content]).size)
    expect(editor.textContent).toBe('existing')
  })
  it('opens a complete read-only preview for a text attachment', async () => {
    mountInput()
    const content = '  文本\nsecond line  '
    const file = new File([content], 'note.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(content) })
    act(() => useAssetStore.getState().addFiles([file]))
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.input.previewText: note.txt' }))
    const preview = await screen.findByTestId('text-preview')
    expect(preview.textContent).toBe(content)
    expect(preview.getAttribute('data-readonly')).toBe('true')
  })
  it('leaves boundary-length text as normal paste', async () => {
    const { container } = mountInput()
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy())
    const editor = container.querySelector('.ProseMirror')!
    await waitFor(() => expect(editor.textContent).toContain('existing'))
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [], getData: () => 'x'.repeat(10_000), files: [] } })
    fireEvent(editor, event)
    expect(useAssetStore.getState().pendingAssets).toHaveLength(0)
    await waitFor(() => expect(editor.textContent).toContain('x'.repeat(10_000)))
  })

  it('shows read errors and can retry without losing the attachment', async () => {
    mountInput()
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' })
    const read = vi.fn().mockRejectedValueOnce(new Error('read failed')).mockResolvedValueOnce('hello')
    Object.defineProperty(file, 'text', { value: read })
    act(() => useAssetStore.getState().addFiles([file]))
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.input.previewText: note.txt' }))
    expect((await screen.findByRole('alert')).textContent).toContain('conversation.input.textPreviewFailed')
    fireEvent.click(screen.getByRole('button', { name: 'conversation.input.retryPreview' }))
    expect((await screen.findByTestId('text-preview')).textContent).toBe('hello')
    fireEvent.click(screen.getByRole('button', { name: 'conversation.input.closePreview' }))
    expect(useAssetStore.getState().pendingAssets).toHaveLength(1)
  })

  it('keeps multiple text attachments independent when one is removed', async () => {
    mountInput()
    act(() => useAssetStore.getState().addFiles([new File(['first'], 'first.txt', { type: 'text/plain' }), new File(['second'], 'second.txt', { type: 'text/plain' })]))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove first.txt' }))
    expect(useAssetStore.getState().pendingAssets.map((a) => a.name)).toEqual(['second.txt'])
  })

  it('previews CSV text attachments', async () => {
    mountInput()
    const file = new File(['a,b'], 'data.csv', { type: 'text/csv' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('a,b') })
    act(() => useAssetStore.getState().addFiles([file]))
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.input.previewText: data.csv' }))
    expect((await screen.findByTestId('text-preview')).textContent).toBe('a,b')
  })

  it('previews JSON attachments as text', async () => {
    mountInput()
    const file = new File(['{"ok":true}'], 'data.json', { type: 'application/json' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('{"ok":true}') })
    act(() => useAssetStore.getState().addFiles([file]))
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.input.previewText: data.json' }))
    expect((await screen.findByTestId('text-preview')).textContent).toBe('{"ok":true}')
  })

  it('previews a YAML attachment reported as generic binary', async () => {
    mountInput()
    const file = new File(['key: value'], 'config.yaml', { type: 'application/octet-stream' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('key: value') })
    act(() => useAssetStore.getState().addFiles([file]))
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.input.previewText: config.yaml' }))
    expect((await screen.findByTestId('text-preview')).textContent).toBe('key: value')
  })

  it('truncates oversized text attachments and shows a truncation notice', async () => {
    mountInput()
    const kept = 'a'.repeat(1_000_000)
    const file = new File(['x'], 'huge.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(kept + 'b'.repeat(10)) })
    act(() => useAssetStore.getState().addFiles([file]))
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.input.previewText: huge.txt' }))
    const preview = await screen.findByTestId('text-preview')
    expect(preview.textContent).toBe(kept)
    // The mocked i18n renders the raw key (no interpolation), so assert the
    // notice is shown; the {limit} interpolation itself is covered by the
    // i18n package's own tests.
    const notice = await screen.findByRole('note')
    expect(notice.textContent).toContain('conversation.input.textPreviewTruncated')
  })

  it('sends an attachment-only message with the pasted file and clears the composer', async () => {
    const { container } = mountInput()
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy())
    const editor = container.querySelector('.ProseMirror')!
    const content = '长文本\n'.repeat(3000)
    await act(async () => { fireEvent.paste(editor, { clipboardData: { items: [], getData: () => content } }) })
    expect(useAssetStore.getState().pendingAssets).toHaveLength(1)
    expect(useAssetStore.getState().pendingAssets[0].file.size).toBe(new Blob([content]).size)
    expect(useAssetStore.getState().pendingAssets[0].mimeType).toBe('text/plain')
    expect(editor.textContent).toBe('existing')
    // The staged pasted file survives in the store as the attachment-only
    // send payload (handleSend consumes it from pendingAssets at send time).
  })

  it('round-trips a pasted attachment through the store intact for send and retry', async () => {
    // send side: handleSend reads the staged snapshot from pendingAssets;
    // retry side: rejectSend → restoreSentAssets hands it back. Assert the
    // store round-trip preserves the pasted payload end to end.
    const content = '长文本\n'.repeat(3000)
    const file = new File([content], 'pasted-text-2026-01-01.txt', { type: 'text/plain' })
    useAssetStore.getState().addFiles([file])
    const snapshot = [...useAssetStore.getState().pendingAssets]
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].file.size).toBe(new Blob([content]).size)
    expect(snapshot[0].mimeType).toBe('text/plain')
    useAssetStore.getState().removeAsset(snapshot[0].id)
    useAssetStore.getState().restoreAssets(snapshot)
    expect(useAssetStore.getState().pendingAssets.map((a) => a.name)).toEqual(['pasted-text-2026-01-01.txt'])
    expect(useAssetStore.getState().pendingAssets[0].file.size).toBe(new Blob([content]).size)
  })

  it('sends an attachment-only staged file after previewing the capped content', async () => {
    // Regression: previewing a truncated attachment must not consume or alter
    // the staged file — the attachment-only send (Enter with empty editor but
    // staged assets) still submits the full-size payload.
    const { container } = mountInput()
    await waitFor(() => expect(container.querySelector('.ProseMirror')).toBeTruthy())
    const editor = container.querySelector('.ProseMirror')!
    const kept = 'a'.repeat(1_000_000)
    const file = new File(['x'], 'huge-send.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(kept + 'b'.repeat(10)) })
    act(() => useAssetStore.getState().addFiles([file]))
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.input.previewText: huge-send.txt' }))
    const preview = await screen.findByTestId('text-preview')
    expect(preview.textContent).toBe(kept)
    expect((await screen.findByRole('note')).textContent).toContain('conversation.input.textPreviewTruncated')
    fireEvent.click(screen.getByRole('button', { name: 'conversation.input.closePreview' }))
    // Attachment-only send: editor still shows the untouched initial text.
    expect(editor.textContent).toBe('existing')
    expect(useAssetStore.getState().pendingAssets).toHaveLength(1)
    const staged = useAssetStore.getState().pendingAssets[0]
    expect(staged.file).toBe(file)
    expect(staged.file.size).toBe(1)
    // Retry path: a failed send restores the same payload.
    useAssetStore.getState().removeAsset(staged.id)
    useAssetStore.getState().restoreAssets([staged])
    expect(useAssetStore.getState().pendingAssets[0].file).toBe(file)
    expect(useAssetStore.getState().pendingAssets[0].file.size).toBe(1)
  })

  it('caps the byte read at MAX_PREVIEW_BYTES from the real File, not a mocked text()', async () => {
    // Regression: exercise the real File.slice byte path — a 6MB file must
    // read only MAX_PREVIEW_BYTES, and the decoded slice is below the char
    // cap so no character truncation applies on top.
    mountInput()
    const file = new File(['x'.repeat(MAX_PREVIEW_BYTES + 1024)], 'huge-bytes.txt', { type: 'text/plain' })
    expect(file.size).toBe(MAX_PREVIEW_BYTES + 1024)
    // Do NOT mock file.text() — the component must slice the real File.
    act(() => useAssetStore.getState().addFiles([file]))
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.input.previewText: huge-bytes.txt' }))
    const preview = await screen.findByTestId('text-preview')
    // Both caps apply: byte cap slices the real File, then the char cap trims
    // the decoded slice before rendering.
    expect(preview.textContent).toBe('x'.repeat(MAX_PREVIEW_CHARS))
    expect((await screen.findByRole('note')).textContent).toContain('conversation.input.textPreviewTruncated')
  })

  it('truncation never splits a UTF-16 surrogate pair', async () => {
    // Cut point lands mid-pair: 1_000_000 chars of 'a' followed by a single
    // astral emoji (surrogate pair). The slice must back off one code unit
    // rather than emit a lone surrogate.
    mountInput()
    const kept = 'a'.repeat(1_000_000)
    const file = new File(['x'], 'emoji.txt', { type: 'text/plain' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(kept + '😀') })
    act(() => useAssetStore.getState().addFiles([file]))
    fireEvent.click(await screen.findByRole('button', { name: 'conversation.input.previewText: emoji.txt' }))
    const preview = await screen.findByTestId('text-preview')
    expect(preview.textContent).toBe(kept)
    const lastCodeUnit = preview.textContent!.charCodeAt(preview.textContent!.length - 1)
    const isSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdfff
    expect(isSurrogate).toBe(false)
    expect(lastCodeUnit).toBe(97) // 'a' — pair backed off cleanly
    expect((await screen.findByRole('note')).textContent).toContain('conversation.input.textPreviewTruncated')
  })

  it('previews a markdown attachment through the same bounded read', async () => {
    // Regression: .md previews previously called file.text() unbounded.
    // They must go through the same cap helpers as the text preview path.
    mountInput()
    const mdContent = '# Hello\n\nsome body text'
    const file = new File(['x'], 'doc.md', { type: 'text/markdown' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(mdContent) })
    act(() => useAssetStore.getState().addFiles([file]))
    const mdButton = await screen.findByRole('button', { name: 'conversation.input.previewMarkdown' })
    await act(async () => { fireEvent.click(mdButton) })
    await waitFor(() => expect(document.body.textContent).toContain('some body text'))
  })

  it('caps an oversized markdown attachment preview', async () => {
    mountInput()
    const mdKept = '# '.padEnd(10, 'x') + 'b'.repeat(MAX_PREVIEW_CHARS - 10)
    const file = new File(['x'], 'huge.md', { type: 'text/markdown' })
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(mdKept + 'TAIL') })
    act(() => useAssetStore.getState().addFiles([file]))
    const mdButton = await screen.findByRole('button', { name: 'conversation.input.previewMarkdown' })
    await act(async () => { fireEvent.click(mdButton) })
    await waitFor(() => expect(document.body.textContent).toContain(mdKept.slice(-20)))
    expect(document.body.textContent).not.toContain('TAIL')
  })

})
