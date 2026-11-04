import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRichInput } from '@/components/agent/AgentRichInput'
import { useAssetStore } from '@/store/asset.store'

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

})
