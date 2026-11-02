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
import { useInputDraftStore } from '@/store/input-draft.store'

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

  it('decline path keeps the typed text in the draft store when the consumer mirrors onChange into the store (round 5)', async () => {
    // Reproduces Sourcery round 5 "Declined draft deletes typed input":
    // WelcomeScreen's handleInputChange saves EVERY emission into the draft
    // store under the same key its restoreDraft (the onDraftRestored
    // callback) clears. With the old decline order (emit → onDraftRestored)
    // the clear deleted the just-saved typed text, so leaving the input
    // before another edit lost it. With the fixed order
    // (onDraftRestored → emit) the clear can only remove a stale pending
    // draft and the emission afterwards re-persists the typed text.
    const draftKey = 'conv-decline-order'
    // Consumer contract = WelcomeScreen.handleInputChange: mirror every
    // emission into the draft store.
    const onChange = vi.fn(({ text }: { text: string; mentionedAgentIds: string[] }) => {
      useInputDraftStore.getState().saveDraft(draftKey, {
        text,
        mentionedAgentIds: [],
        selectedFiles: [],
      })
    })
    // Consuming callback contract = WelcomeScreen.restoreDraft: clear the
    // draft-store entry.
    const onDraftRestored = vi.fn(() => {
      useInputDraftStore.getState().clearDraft(draftKey)
    })

    const { rerender } = render(
      <Harness draftText="stored draft" onChange={onChange} onDraftRestored={onDraftRestored} />,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    await waitFor(() => {
      expect(onChange).toHaveBeenCalledWith({ text: 'stored draft', mentionedAgentIds: [] })
    })
    expect(onDraftRestored).toHaveBeenCalledTimes(1)

    // Editor now holds 'stored draft' (non-empty) — the second pending
    // restoration is DECLINED. Under the old order the emission mirrored
    // 'stored draft' into the store first and onDraftRestored then cleared
    // it, losing the unsent text.
    rerender(
      <Harness draftText="different draft" onChange={onChange} onDraftRestored={onDraftRestored} />,
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(onDraftRestored).toHaveBeenCalledTimes(2)
    // The typed text must survive in the draft store after the declined
    // restoration — the user can leave the input and still get it back.
    expect(useInputDraftStore.getState().peekDraft(draftKey)?.text).toBe('stored draft')
  })
})
