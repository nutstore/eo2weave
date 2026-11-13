/**
 * Contract tests for AgentRichInputHandle.insertQuote — the selection-quote
 * API used by TextSelectionToolbar (issue #276).
 *
 * Contract under test: insertQuote merges the selection into the composer as a
 * quote block, leaves the user's existing draft intact, and emits the value
 * through onChange as plain markdown blockquote text — the exact text the model
 * receives, so the quote survives composer → message serialization.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import type { Editor } from '@tiptap/core'
import ReactMarkdown from 'react-markdown'
import { describe, expect, it, vi } from 'vitest'
import { AgentRichInput, type AgentRichInputHandle } from '../AgentRichInput'

vi.mock('@/store/asset.store', () => ({
  useAssetStore: Object.assign((selector?: (s: unknown) => unknown) => selector?.({}) ?? {}, {
    getState: () => ({ clearAll: vi.fn() }),
  }),
}))

vi.mock('@/services/ocr.service', () => ({
  isOcrCompatibleImage: () => false,
  fileToBase64: vi.fn(async () => ''),
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('@creatorweave/ui', () => ({
  TooltipProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children?: ReactNode }) => <>{children}</>,
}))

const { tiptapExtensionStub } = vi.hoisted(() => ({
  tiptapExtensionStub: () => ({ configure: () => ({}) }),
}))

vi.mock('../FileMentionExtension', () => ({
  FileMention: tiptapExtensionStub(),
}))
vi.mock('../SlashCommandExtension', () => ({
  SlashCommandExtension: tiptapExtensionStub(),
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }))

type ChangeHandler = (value: { text: string; mentionedAgentIds: string[] }) => void

/** Harness exposing trigger buttons so tests can drive the imperative handle. */
function Harness({ onChange }: { onChange: ChangeHandler }) {
  const ref = useRef<AgentRichInputHandle>(null)
  const noop = useRef(vi.fn())
  return (
    <>
      <AgentRichInput
        ref={ref}
        placeholder="test"
        agents={[]}
        activeAgentId={null}
        allAgents={[]}
        onSetActiveAgent={async () => {}}
        onCreateAgent={async () => null}
        onDeleteAgent={async () => true}
        onChange={onChange}
        onSubmit={noop.current}
      />
      <button type="button" onClick={() => ref.current?.setText('My take:')}>seed</button>
      <button
        type="button"
        onClick={() => ref.current?.insertQuote(['first line', 'second line'])}
      >
        quote
      </button>
    </>
  )
}

async function mountHarness(onChange: ChangeHandler) {
  const { container } = render(<Harness onChange={onChange} />)
  // immediatelyRender:false — the editor instance arrives after first paint.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
  return container
}

describe('AgentRichInputHandle.insertQuote', () => {
  it('inserts a quote block and emits it as markdown blockquote text', async () => {
    const onChange = vi.fn()
    const container = await mountHarness(onChange)

    fireEvent.click(screen.getByText('quote'))

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({
        text: '> first line\n> second line',
        mentionedAgentIds: [],
      })
    })
    // Tier B: the quote is a real node in the editor, not raw "> " text.
    expect(container.querySelector('blockquote[data-quote-block]')).not.toBeNull()
  })

  it('keeps the existing draft and appends the quote below it', async () => {
    const onChange = vi.fn()
    await mountHarness(onChange)

    fireEvent.click(screen.getByText('seed'))
    fireEvent.click(screen.getByText('quote'))

    await waitFor(() => {
      const calls = onChange.mock.calls
      const last = calls[calls.length - 1][0] as { text: string }
      expect(last.text).toContain('My take:')
      expect(last.text).toContain('> first line\n> second line')
    })
  })

  it.each([
    { name: 'selected draft', from: 1, to: 9 },
    { name: 'caret inside the draft', from: 4, to: 4 },
  ])('appends after the draft when the editor remembers a $name', async ({ from, to }) => {
    const onChange = vi.fn()
    const container = await mountHarness(onChange)
    fireEvent.click(screen.getByText('seed'))
    const editor = (container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
    act(() => { editor.commands.setTextSelection({ from, to }) })

    fireEvent.click(screen.getByText('quote'))

    expect(onChange.mock.lastCall?.[0].text).toBe('My take:\n\n> first line\n> second line')
  })

  it('keeps a follow-up question outside the quote in the sent markdown', async () => {
    const onChange = vi.fn()
    const container = await mountHarness(onChange)
    fireEvent.click(screen.getByText('quote'))
    const editor = (container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor
    act(() => { editor.commands.insertContent('What does this mean?') })

    const text = onChange.mock.lastCall?.[0].text as string
    const preview = render(<ReactMarkdown>{text}</ReactMarkdown>).container
    expect(preview.querySelector('blockquote')?.textContent).not.toContain('What does this mean?')
    expect(preview.lastElementChild?.tagName).toBe('P')
    expect(preview.lastElementChild?.textContent).toBe('What does this mean?')
  })
})
