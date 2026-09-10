/**
 * Contract tests for AgentRichInputHandle.setText — the programmatic
 * text-injection API used by ImageGenQuickChip (R2.1 quick-chip prefill).
 *
 * Contract under test: setText replaces the editor content, focuses the
 * editor, and emits the new value through onChange so the logic layer's
 * hasInput/send-button state stays in sync (same channel as user typing).
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
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

/** Harness exposing a trigger button so tests can invoke the imperative handle. */
function Harness({ onChange }: { onChange: (value: { text: string; mentionedAgentIds: string[] }) => void }) {
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
      <button type="button" onClick={() => ref.current?.setText('Draw an orange cat')}>inject</button>
    </>
  )
}

describe('AgentRichInputHandle.setText', () => {
  it('injects text and emits it through onChange (send-button state syncs)', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)

    // immediatelyRender:false — the editor instance arrives after first paint.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    fireEvent.click(screen.getByText('inject'))

    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ text: 'Draw an orange cat', mentionedAgentIds: [] })
    })
  })

  it('is a no-op before the editor instance exists (no throw)', async () => {
    const onChange = vi.fn()
    let capturedRef: AgentRichInputHandle | null = null
    function EarlyHarness() {
      const ref = useRef<AgentRichInputHandle>(null)
      capturedRef = ref.current
      return (
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
          onSubmit={vi.fn()}
        />
      )
    }
    // During the first render pass the editor is still null; calling setText
    // through the handle must not throw. Mount itself emits one empty-text
    // onChange (onCreate → emitValue) — that's pre-existing editor-init
    // behavior; the no-op contract is that 'early' is never injected.
    render(<EarlyHarness />)
    expect(() => capturedRef?.setText?.('early')).not.toThrow()
    expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'early' }))
  })
})
