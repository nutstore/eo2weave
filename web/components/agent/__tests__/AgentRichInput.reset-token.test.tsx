/**
 * Regression tests for the welcome-input attachment loss bug (first send
 * right after the WelcomeScreen → conversation transition).
 *
 * Root cause being guarded: AgentRichInput's reset effect used to run its
 * "clear editor + useAssetStore.clearAll()" body on the render where the
 * tiptap editor instance FIRST becomes available (`immediatelyRender: false`
 * → editor is null on mount, instance arrives on a later render). Because
 * ConversationView remounts AgentRichInput under key={convId} during the
 * WelcomeScreen → conversation transition, that first run wiped the GLOBAL
 * pending asset store before sendMessage could read the staged attachments.
 *
 * Contract under test: the reset body (clearAll) must only run when
 * `resetToken` actually changes after the editor instance exists.
 */
import { act, render } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { AgentRichInput } from '../AgentRichInput'

const clearAllSpy = vi.hoisted(() => vi.fn())

vi.mock('@/store/asset.store', () => ({
  useAssetStore: Object.assign((selector?: (s: unknown) => unknown) => selector?.({}) ?? {}, {
    getState: () => ({ clearAll: clearAllSpy }),
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

/** Minimal tiptap-Extension-shaped mock — only needs `.configure()` on the class. */
// vi.hoisted because vi.mock factories are hoisted above plain top-level consts.
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

/** Harness: renders AgentRichInput with a remount key driven by the same counter that bumps resetToken. */
function Harness({ remountKey, resetToken }: { remountKey: string; resetToken: number }) {
  const noop = useRef(vi.fn())
  // Agent selector props became required; stub them minimally — this test
  // only exercises reset-token / remount behavior, never the selector UI.
  return (
    <AgentRichInput
      key={remountKey}
      resetToken={resetToken}
      placeholder="test"
      agents={[]}
      activeAgentId={null}
      allAgents={[]}
      onSetActiveAgent={async () => {}}
      onCreateAgent={async () => null}
      onDeleteAgent={async () => true}
      onChange={noop.current}
      onSubmit={noop.current}
    />
  )
}

describe('AgentRichInput reset effect does not clear pending assets on editor mount', () => {
  it('does not clearAll when the editor instance first becomes available', async () => {
    const { rerender } = render(<Harness remountKey="draft" resetToken={0} />)

    // Editor instance creation with immediatelyRender:false happens after
    // the first paint; flush timers/microtasks so the editor arrives.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    // Simulate the WelcomeScreen → conversation transition: the component is
    // remounted (key change) while resetToken is still the initial value.
    rerender(<Harness remountKey="conv-1" resetToken={0} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(clearAllSpy).not.toHaveBeenCalled()
  })

  it('does not clear staged assets when resetToken bumps', async () => {
    const { rerender } = render(<Harness remountKey="conv-1" resetToken={0} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(clearAllSpy).not.toHaveBeenCalled()

    // Real send: the parent bumps resetToken.
    rerender(<Harness remountKey="conv-1" resetToken={1} />)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })

    expect(clearAllSpy).not.toHaveBeenCalled()
  })
})
