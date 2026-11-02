/**
 * Contract test — declined draft restoration (PR #142 review round 3,
 * Sourcery Medium "New input is not saved").
 *
 * When a pending draft restoration finds the editor ALREADY holding content
 * (text the user typed before the pending restoration was consumed), the
 * restoration must be declined — typed text wins — but the pending marker
 * must still be consumed: the current editor value is emitted through
 * onChange (so the logic layer's inputRef matches the screen) and
 * onDraftRestored fires (clearing draftConvIdRef so the unmount cleanup
 * persists the typed text instead of skipping the save).
 */
import { act, render, waitFor } from '@testing-library/react'
import { type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AgentRichInput } from '@/components/agent/AgentRichInput'

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

vi.mock('@/components/agent/FileMentionExtension', () => ({
  FileMention: tiptapExtensionStub(),
}))
vi.mock('@/components/agent/SlashCommandExtension', () => ({
  SlashCommandExtension: tiptapExtensionStub(),
}))

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), dismiss: vi.fn() }) }))

function Harness({
  draftText,
  onChange,
  onDraftRestored,
}: {
  draftText?: string
  onChange: (value: { text: string; mentionedAgentIds: string[] }) => void
  onDraftRestored: () => void
}) {
  return (
    <AgentRichInput
      placeholder="test"
      agents={[]}
      activeAgentId={null}
      allAgents={[]}
      onSetActiveAgent={async () => {}}
      onCreateAgent={async () => null}
      onDeleteAgent={async () => true}
      initialText={draftText}
      onDraftRestored={onDraftRestored}
      onChange={onChange}
      onSubmit={vi.fn()}
    />
  )
}

describe('AgentRichInput declined draft restoration', () => {
  it('restores into an empty editor and calls onDraftRestored once (consumed marker)', async () => {
    const onChange = vi.fn()
    const onDraftRestored = vi.fn()
    const { rerender } = render(
      <Harness draftText="stored draft" onChange={onChange} onDraftRestored={onDraftRestored} />,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Restore path: draft injected into the empty editor and emitted.
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ text: 'stored draft', mentionedAgentIds: [] })
    })
    expect(onDraftRestored).toHaveBeenCalledTimes(1)

    // Decline path: the editor now holds content; a NEW pending restoration
    // arrives (e.g. restoreDraftIntoInput raced with typing) — the typed
    // text must NOT be overwritten, the current value must be re-emitted,
    // and the pending marker consumed again.
    // PR #142 review round 5 (Sourcery): record the call count BEFORE the
    // rerender, then assert the decline ADDED exactly one call — comparing
    // only the last call's value would still pass if the decline path fired
    // onDraftRestored but emitted nothing, because .at(-1) would return the
    // initial-restoration call.
    const onChangeCallsBeforeDecline = onChange.mock.calls.length
    rerender(
      <Harness draftText="different draft" onChange={onChange} onDraftRestored={onDraftRestored} />,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // The DECLINE path must emit the CURRENT editor value ('stored draft' —
    // typed text wins over the incoming 'different draft'). Match on the LAST
    // call, not any earlier one: `toHaveBeenCalledWith` would otherwise match
    // the initial-restoration call and pass even if the decline stopped
    // emitting entirely.
    expect(onChange.mock.calls.length).toBe(onChangeCallsBeforeDecline + 1)
    expect(onChange.mock.calls.at(-1)).toEqual([
      { text: 'stored draft', mentionedAgentIds: [] },
    ])
    // Typed content survives: the editor never receives 'different draft'.
    expect(onChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: 'different draft' }),
    )
    expect(onDraftRestored).toHaveBeenCalledTimes(2)
  })
})
