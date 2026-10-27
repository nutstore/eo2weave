import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { captureTabMock, addFilesMock, addNativeHostRootMock, toastWarningMock, toastErrorMock, conversationState, pageActionAvailable, folderAccessState, settingsState, inputDraftState, projectState, workspacePreferencesState, agentsState } = vi.hoisted(() => ({
  captureTabMock: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==' })),
  addFilesMock: vi.fn(),
  addNativeHostRootMock: vi.fn(async () => true),
  toastWarningMock: vi.fn(),
  toastErrorMock: vi.fn(),
  conversationState: { conversations: [] as unknown[] },
  pageActionAvailable: { value: true },
  // Mutable settings state so readiness-flip tests can flip hasApiKey.
  settingsState: {
    hasApiKey: true,
    hasApiKeyLoaded: true,
    checkHasApiKey: async () => {},
    providerType: 'openai',
    modelName: 'vision-model',
        modelCredentialStatus: 'unknown' as 'unknown' | 'valid' | 'expired' | 'unauthorized' | 'missing', enableThinking: false,
    thinkingLevel: 'medium',
    setEnableThinking: vi.fn(),
    setThinkingLevel: vi.fn(),
  },
  // Mock state for folder-access store. `rootsHydrated` defaults to true so
  // existing tests (which expect the mount-folder step to render on first
  // paint) keep working; the dedicated hydration test below flips it to
  // false to verify the loading gate.
  folderAccessState: {
    roots: [] as unknown[],
    rootsHydrated: true,
    addRoot: async () => {},
    addNativeHostRoot: async () => true,
  },
  // In-memory draft store mock mirroring useInputDraftStore's contract
  // (saveDraft drops empty drafts, peekDraft is non-destructive).
  inputDraftState: {
    drafts: new Map<string, { text: string; mentionedAgentIds: string[]; selectedFiles: string[] }>(),
  },
  // Mutable so the empty-string fallback test can simulate pre-hydration.
  projectState: { activeProjectId: 'proj-1' },
  // Workspace-preferences store: covers the toolbar (agentMode + auto-apply).
  workspacePreferencesState: {
    agentMode: 'act' as 'plan' | 'act',
    setAgentMode: vi.fn(),
    autoApplyOnRunComplete: false,
    setAutoApplyOnRunComplete: vi.fn(),
  },
  // Agents store: WelcomeScreen never initializes ProjectManager on a bare
  // URL, so the toolbar's AgentDropdown receives [] / null and degrades to
  // showing "default". No action mocks needed beyond the no-op stubs.
  agentsState: {
    agents: [] as unknown[],
    activeAgentId: null as string | null,
    setActiveAgent: vi.fn(async () => {}),
    deleteAgent: vi.fn(async () => false),
  },
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: (selector: (state: {
    hasApiKey: boolean
    hasApiKeyLoaded: boolean
    checkHasApiKey: () => Promise<void>
    providerType: string
    modelName: string
    modelCredentialStatus: 'unknown' | 'valid' | 'expired' | 'unauthorized' | 'missing'
    enableThinking: boolean
    thinkingLevel: string
    setEnableThinking: (v: boolean) => void
    setThinkingLevel: (v: string) => void
  }) => unknown) => selector(settingsState),
}))

vi.mock('@/store/workspace-preferences.store', () => ({
  useWorkspacePreferencesStore: (selector: (state: {
    agentMode: 'plan' | 'act'
    setAgentMode: (m: 'plan' | 'act') => void
    autoApplyOnRunComplete: boolean
    setAutoApplyOnRunComplete: (v: boolean) => void
  }) => unknown) => selector(workspacePreferencesState),
}))

vi.mock('@/store/agents.store', () => ({
  useAgentsStore: (selector: (state: {
    agents: unknown[]
    activeAgentId: string | null
    setActiveAgent: (id: string) => Promise<void>
    deleteAgent: (id: string) => Promise<boolean>
  }) => unknown) => selector(agentsState),
}))

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: (selector: (state: { conversations: unknown[] }) => unknown) => selector(conversationState),
}))

vi.mock('@/store/folder-access.store', () => ({
  useFolderAccessStore: (selector: (state: {
    roots: unknown[]
    rootsHydrated: boolean
    addRoot: () => Promise<void>
    addNativeHostRoot: () => Promise<boolean>
  }) => unknown) => selector(folderAccessState),
}))

vi.mock('@/store/project.store', () => ({
  useProjectStore: (selector: (state: { activeProjectId: string }) => unknown) =>
    selector(projectState),
}))

vi.mock('@/store/input-draft.store', () => ({
  useInputDraftStore: {
    getState: () => ({
      saveDraft: (convId: string, draft: { text: string; mentionedAgentIds: string[]; selectedFiles: string[] }) => {
        const hasContent = draft.text
          || (draft.mentionedAgentIds?.length ?? 0) > 0
          || (draft.selectedFiles?.length ?? 0) > 0
        if (!hasContent) {
          inputDraftState.drafts.delete(convId)
          return
        }
        inputDraftState.drafts.set(convId, { ...draft })
      },
      peekDraft: (convId: string) => {
        const draft = inputDraftState.drafts.get(convId)
        if (!draft) return null
        return {
          text: draft.text,
          mentionedAgentIds: [...draft.mentionedAgentIds],
          selectedFiles: [...draft.selectedFiles],
        }
      },
      clearDraft: (convId: string) => {
        inputDraftState.drafts.delete(convId)
      },
    }),
  },
}))

vi.mock('sonner', () => ({
  toast: {
    warning: toastWarningMock,
    error: toastErrorMock,
    success: vi.fn(),
    info: vi.fn(),
  },
}))

// #87: the dynamic-provider registry is NOT mocked away wholesale — the
// component under test must observe the real isPotentiallyDynamicProviderType
// / getProviderConfig pair against an empty registry (the unregistered
// codex-oauth state). Only the static model-list surface is stubbed.
vi.mock('@/agent/providers/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/types')>()
  return { ...actual }
})

vi.mock('@/hooks/useGatewayLogin', () => ({
  isLLMGatewayConfigured: () => false,
  useGatewayLogin: () => ({ authState: null, isRunning: false, login: async () => false, reset: vi.fn() }),
}))

vi.mock('@/store/extension.store', () => ({
  useExtensionStore: (selector: (state: { status: string }) => unknown) =>
    selector({ status: 'not_installed' }),
}))

vi.mock('@/lib/deploy-region', () => ({
  ENABLE_LLM_GATEWAY: false,
}))

vi.mock('@/agent/llm/pi-ai-model-resolver', () => ({
  supportsImageInput: () => true,
}))

vi.mock('@/agent/tools/page-action-bridge', () => ({
  captureTab: captureTabMock,
  isPageActionAvailable: () => pageActionAvailable.value,
}))

vi.mock('@/store/asset.store', () => {
  const useAssetStore = (selector?: (s: { pendingAssets: unknown[] }) => unknown) =>
    selector ? selector({ pendingAssets: [] }) : { pendingAssets: [] }
  useAssetStore.getState = () => ({ addFiles: addFilesMock, pendingAssets: [] })
  return { useAssetStore }
})

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => ({
    'agent.vision.capture': 'Capture screenshot',
    'agent.vision.supported': 'Current model supports image input',
    'agent.vision.unsupported': 'Vision unavailable',
    'agent.vision.screenshotUnavailable': 'Screenshot unavailable',
    'agent.pageScreenshot.captureFailed': 'Could not capture screenshot',
    'welcome.setupLocalFirstHint': 'Your data stays in this browser.',
    'welcome.skipButton': 'Skip for now',
    'welcome.placeholder': 'Type a message to start...',
    'conversation.input.placeholderNoModel': 'Pick a usable model in the model selector below first',
    'conversation.toast.providerReauthRequired': 'The selected provider is unavailable — sign in again to use it.',
  })[key] ?? key,
}))

// SetupGuideLink uses next/navigation's useRouter; jsdom/happy-dom has no
// app router context, so provide a stub (pre-existing failure unblocked).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}))

vi.mock('@/hooks/useNativeHostPing', () => ({
  useNativeHostPing: () => {
    const w = window as unknown as { __agentWeb?: { nativeHostCall?: (p: { action: string }) => Promise<{ ok?: boolean }> } }
    const fn = w.__agentWeb?.nativeHostCall
    if (typeof fn !== 'function') return 'unavailable'
    // The test's fake bridge answers ping with { ok: true } synchronously
    // enough for the synchronous render pass; treat presence as available.
    return 'available'
  },
}))

vi.mock('../agent/AgentRichInput', async () => {
  const { useState, useEffect } = await import('react')
  // Mimics the real editor's draft contract: initialText is written into the
  // (local) document once, then onDraftRestored consumes the pending prop —
  // the consumed text STAYS in the editor, exactly like tiptap setContent.
  const MockAgentRichInput = ({
    leadingAccessory,
    beforeSendAccessory,
    initialText,
    onDraftRestored,
    onChange,
    sendState,
    disabled,
    placeholder,
  }: {
    leadingAccessory?: ReactNode
    beforeSendAccessory?: ReactNode
    initialText?: string
    onDraftRestored?: () => void
    onChange?: (value: { text: string; mentionedAgentIds: string[] }) => void
    sendState?: {
      isSendDisabled: boolean
      onSend: () => void
      sendTitle: string
    }
    disabled?: boolean
    placeholder?: string
  }) => {
    const [consumedText, setConsumedText] = useState<string | null>(null)
    useEffect(() => {
      if (initialText && !consumedText) {
        setConsumedText(initialText)
        onDraftRestored?.()
      }
    }, [initialText, consumedText, onDraftRestored])
    const [typingAccepted, setTypingAccepted] = useState<boolean | null>(null)
    return (
      <div
        data-testid="agent-rich-input"
        aria-disabled={disabled || undefined}
        data-typing-accepted={typingAccepted == null ? undefined : String(typingAccepted)}
      >
        {consumedText ? <div data-testid="draft-restored">{consumedText}</div> : null}
        {placeholder != null && (
          <div data-testid="mock-placeholder">{placeholder}</div>
        )}
        <button
          type="button"
          data-testid="mock-input-type"
          data-typing-accepted={typingAccepted ? 'true' : 'false'}
          onClick={() => {
            // Respect the real editor's `disabled` contract (#84 review
            // round 2): a disabled editor must not accept typing, so
            // onChange never fires and the attempt is recorded so tests
            // can assert the keystroke was actually swallowed.
            if (disabled) {
              setTypingAccepted(false)
              return
            }
            setTypingAccepted(true)
            onChange?.({ text: 'typed text', mentionedAgentIds: [] })
          }}
        >
          type
        </button>
        {sendState && (
          <button
            type="button"
            data-testid="mock-send"
            onClick={sendState.onSend}
            disabled={sendState.isSendDisabled}
            title={sendState.sendTitle}
          >
            send
          </button>
        )}
        {beforeSendAccessory}
        {leadingAccessory}
      </div>
    )
  }
  return { AgentRichInput: MockAgentRichInput }
})

// ── Toolbar sub-component mocks ──
// Each toolbar dropdown is exercised in isolation by its own test suite
// (AgentModeSelect.test.tsx etc.). Here we only need them to render so the
// WelcomeScreen test can assert the toolbar mounts. Stubs double as
// data-testid hooks for the new toolbar-presence test below.
vi.mock('../agent/AgentDropdown', () => ({
  AgentDropdown: () => <div data-testid="toolbar-agent-dropdown" />,
}))

// The init hook is also mounted by ConversationView; stub it here so the
// WelcomeScreen test can stay focused on the toolbar wiring.
vi.mock('@/hooks/useProjectAgentsInit', () => ({
  useProjectAgentsInit: () => {},
}))
vi.mock('../agent/ThinkingDropdown', () => ({
  ThinkingDropdown: () => <div data-testid="toolbar-thinking-dropdown" />,
}))
// The thinking toggle lives in the input's accessory bar (same as the
// conversation view), so it is asserted there rather than in the toolbar.
vi.mock('../agent/ModelThinkingControls', () => ({
  ModelThinkingControls: () => <div data-testid="inline-thinking-controls" />,
}))
vi.mock('../agent/AgentModeSelect', () => ({
  AgentModeSelect: () => <div data-testid="toolbar-agent-mode" />,
}))
vi.mock('../agent/RunEndPolicySelect', () => ({
  RunEndPolicySelect: () => <div data-testid="toolbar-run-end-policy" />,
}))

vi.mock('../agent/PageScreenshotCropDialog', () => ({
  PageScreenshotCropDialog: ({ onConfirm }: { onConfirm: (file: File) => void }) => (
    <button type="button" onClick={() => onConfirm(new File(['screenshot'], 'page-screenshot.png', { type: 'image/png' }))}>
      Insert screenshot
    </button>
  ),
}))

import { WelcomeScreen } from '../WelcomeScreen'

describe('WelcomeScreen', () => {
  beforeEach(() => {
    pageActionAvailable.value = true
    delete (window as unknown as { __agentWeb?: unknown }).__agentWeb
    addNativeHostRootMock.mockClear()
    toastWarningMock.mockClear()
    toastErrorMock.mockClear()
    projectState.activeProjectId = 'proj-1'
    localStorage.setItem('creatorweave:onboarding:welcome-seen', 'true')
    // The mount-folder skip persists across remounts by design; clear it so
    // tests below still see the mount-folder step from a clean baseline.
    localStorage.removeItem('creatorweave:onboarding:folder-mount-skipped')
    // Same for the AI-setup skip (persists across refreshes by design).
    localStorage.removeItem('creatorweave:onboarding:ai-setup-skipped')
    // Reset mock state so each test starts from a deterministic baseline.
    // The hydration test flips `rootsHydrated` explicitly.
    folderAccessState.roots = []
    folderAccessState.rootsHydrated = true
    folderAccessState.addNativeHostRoot = addNativeHostRootMock
    // Restore the default readiness baseline (readiness-flip tests mutate it).
    settingsState.hasApiKey = true
    settingsState.hasApiKeyLoaded = true
    settingsState.providerType = 'openai'
    settingsState.modelName = 'vision-model'
    settingsState.modelCredentialStatus = 'unknown'
    settingsState.enableThinking = false
    settingsState.thinkingLevel = 'medium'
    settingsState.setEnableThinking.mockClear()
    settingsState.setThinkingLevel.mockClear()
    // Fresh draft store per test — draft persistence is per project, so a
    // stale entry from a previous test would leak into the restore test.
    inputDraftState.drafts.clear()
    // Reset workspace-preferences + agents mocks to their default baseline.
    workspacePreferencesState.agentMode = 'act'
    workspacePreferencesState.autoApplyOnRunComplete = false
    workspacePreferencesState.setAgentMode.mockClear()
    workspacePreferencesState.setAutoApplyOnRunComplete.mockClear()
    agentsState.agents = []
    agentsState.activeAgentId = null
    agentsState.setActiveAgent.mockClear()
    agentsState.deleteAgent.mockClear()
  })

  // Baseline readiness (key + provider/model configured) + welcome-seen →
  // ready directly (#82: mount-folder left the machine — no skip needed).
  function advanceToReady() {
    // no-op: the baseline state already renders the ready step
  }

  // #82: the mount-folder step left the state machine. With the model
  // configured, the screen lands on ready directly — no skip detour — and
  // folder mounting lives in the topbar FolderSelector / sidebar button.
  it('lands on ready directly when the model is configured, with no folder step', () => {
    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Choose a folder' })).not.toBeInTheDocument()
    expect(screen.queryByText('Choose a folder and AI can read and edit its files.')).not.toBeInTheDocument()
  })

  it('still lands on ready when no folder is mounted and the skip flag was never set', () => {
    localStorage.removeItem('creatorweave:onboarding:folder-mount-skipped')
    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument()
  })

  it('captures a screenshot and stages it for the first conversation message', async () => {
    render(<WelcomeScreen onStartConversation={vi.fn()} />)
    advanceToReady()

    fireEvent.click(screen.getByRole('button', { name: 'Capture screenshot' }))

    await waitFor(() => expect(captureTabMock).toHaveBeenCalledWith('png'))
    fireEvent.click(screen.getByRole('button', { name: 'Insert screenshot' }))

    expect(addFilesMock).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'page-screenshot.png', type: 'image/png' }),
    ])
  })

  it('shows model vision capability rather than a side-panel instruction outside side-panel mode', () => {
    pageActionAvailable.value = false
    render(<WelcomeScreen onStartConversation={vi.fn()} />)
    advanceToReady()

    const indicator = screen.getByRole('button', { name: 'Current model supports image input' })
    expect(indicator).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Screenshot unavailable' })).not.toBeInTheDocument()
  })

  // Regression for the cold-start flash: we still wait for `rootsHydrated`
  // before rendering any step (the loading gate itself is orthogonal to the
  // removed mount-folder card — the sidebar tree reads the same store).
  it('does not render any step while roots are still hydrating', () => {
    folderAccessState.rootsHydrated = false
    folderAccessState.roots = []

    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByTestId('agent-rich-input')).not.toBeInTheDocument()
  })

  // ── Draft persistence & persistent-input regressions ──
  // Bug: the rich input only rendered on the 'ready' step, so any transient
  // readiness flip (e.g. clearing an API key while replacing it in Settings)
  // unmounted the editor and silently discarded the user's unsent text.

  // ── AI-setup skip persistence ──
  // Bug: "Skip for now" on the api-key card only mutated local state, so a
  // page refresh recomputed the provider gate and resurrected the setup card
  // the user had just dismissed.

  it('persists the AI-setup skip so a remount does not resurrect the card', () => {
    // Unconfigured baseline: no key, no provider/model chosen (empty string
    // is falsy — same gate the component uses).
    settingsState.hasApiKey = false
    settingsState.providerType = ''
    settingsState.modelName = ''
    const first = render(<WelcomeScreen onStartConversation={vi.fn()} />)
    expect(screen.getByText('welcome.apiKeyLabel')).toBeInTheDocument()

    // Skip → flag written + card dismissed (mount-folder is gone, #82 → ready)
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(localStorage.getItem('creatorweave:onboarding:ai-setup-skipped')).toBe('true')
    expect(screen.queryByText('welcome.apiKeyLabel')).not.toBeInTheDocument()

    // Simulate a refresh: full unmount + fresh mount against the same
    // localStorage (getInitialStep reads the persisted flag).
    first.unmount()
    const second = render(<WelcomeScreen onStartConversation={vi.fn()} />)
    expect(screen.queryByText('welcome.apiKeyLabel')).not.toBeInTheDocument()
    second.unmount()
  })

  it('clears the AI-setup skip once onboarding completes', () => {
    localStorage.setItem('creatorweave:onboarding:ai-setup-skipped', 'true')
    // Skipped + unconfigured: initial render must NOT show the setup card
    settingsState.hasApiKey = false
    settingsState.providerType = ''
    settingsState.modelName = ''
    const { rerender } = render(<WelcomeScreen onStartConversation={vi.fn()} />)
    expect(screen.queryByText('welcome.apiKeyLabel')).not.toBeInTheDocument()

    // User configures key + default model (e.g. via top-bar switcher)
    settingsState.hasApiKey = true
    settingsState.providerType = 'openai'
    settingsState.modelName = 'vision-model'
    rerender(<WelcomeScreen onStartConversation={vi.fn()} />)

    // Completion consumed the skip: a later deliberate unconfigure re-prompts
    expect(localStorage.getItem('creatorweave:onboarding:ai-setup-skipped')).toBeNull()
    settingsState.hasApiKey = false
    settingsState.providerType = ''
    settingsState.modelName = ''
    rerender(<WelcomeScreen onStartConversation={vi.fn()} />)
    expect(screen.getByText('welcome.apiKeyLabel')).toBeInTheDocument()
  })

  it('keeps the rich input mounted when the readiness gate temporarily leaves ready', () => {
    const { rerender } = render(<WelcomeScreen onStartConversation={vi.fn()} />)
    advanceToReady()
    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()

    // Simulate the Settings key-replacement window: hasApiKey flips false
    // (clear key), then true again (new key saved). Rerender picks up the
    // mutated mock store — mutating it alone does not notify subscribers.
    settingsState.hasApiKey = false
    rerender(<WelcomeScreen onStartConversation={vi.fn()} />)
    // Auto-advance pulled the step back to api-key, but the input survives.
    // (Minimal-list card header renders the 'Connect AI' label.)
    expect(screen.getByText('welcome.apiKeyLabel')).toBeInTheDocument()
    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()

    settingsState.hasApiKey = true
    rerender(<WelcomeScreen onStartConversation={vi.fn()} />)
    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()
  })

  it('persists typed text to the draft store and clears it on send', () => {
    const onStart = vi.fn()
    render(<WelcomeScreen onStartConversation={onStart} />)
    advanceToReady()

    fireEvent.click(screen.getByTestId('mock-input-type'))
    expect(inputDraftState.drafts.get('proj-1')?.text).toBe('typed text')

    // Send lives inside AgentRichInput's toolbar — the mock renders it as
    // data-testid="mock-send" wired to the sendState.onSend callback.
    fireEvent.click(screen.getByTestId('mock-send'))
    expect(onStart).toHaveBeenCalledWith('typed text')
    expect(inputDraftState.drafts.has('proj-1')).toBe(false)
  })

  it('restores the persisted draft into the editor on remount', () => {
    inputDraftState.drafts.set('proj-1', {
      text: 'unsent draft from before the remount',
      mentionedAgentIds: [],
      selectedFiles: [],
    })

    render(<WelcomeScreen onStartConversation={vi.fn()} />)
    advanceToReady()

    expect(screen.getByTestId('draft-restored')).toHaveTextContent(
      'unsent draft from before the remount'
    )
    // Consumed after restore — a manual clear must stick (no re-injection).
    expect(inputDraftState.drafts.has('proj-1')).toBe(false)
  })

  it('shows the rich input on the api-key step when a draft exists', () => {
    inputDraftState.drafts.set('proj-1', {
      text: 'typed before readiness flipped',
      mentionedAgentIds: [],
      selectedFiles: [],
    })

    settingsState.hasApiKey = false
    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    // Setup card + input side by side; the unsent text survives the flip.
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()
  })

  // (#84 review): with no API key the composer is fully disabled now (the
  // send button included), so the setup-step gate inside handleSubmit is no
  // longer the first line of defense — the disabled button is. The gate
  // itself stays as a backstop for steps where the input is still editable
  // (expired credential keeps the selection), verified in the test below.
  it('keeps the editor editable but blocks sending when no API key is configured', () => {
    const onStart = vi.fn()
    const onOpenSettings = vi.fn()
    settingsState.hasApiKey = false
    render(<WelcomeScreen onStartConversation={onStart} onOpenSettings={onOpenSettings} />)

    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
    // A missing key is a CREDENTIAL state, not an editor-lock (#84 review
    // round 2): typing is accepted so the user can compose/copy, but the
    // send path stays blocked (setup card, not a dead input).
    fireEvent.click(screen.getByTestId('mock-input-type'))
    expect(screen.getByTestId('agent-rich-input')).toHaveAttribute('data-typing-accepted', 'true')
    const send = screen.getByTestId('mock-send')
    fireEvent.click(send)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('keeps an expired-credential selection on the ready step and defers blocking to the send path', () => {
    const onStart = vi.fn()
    const onOpenSettings = vi.fn()
    // Expired gateway credential WITH a real selection (provider + model
    // both present). Fixture is expired-SPECIFIC (Sourcery round 4): the
    // key is VALID and a non-gateway provider (anthropic) is selected, so
    // neither the api-key step nor the select-model step can account for
    // the outcome — this test pins WHERE the expired state is handled.
    //
    // Division of responsibility: WelcomeScreen keeps an expired selection
    // on the READY step (the selection exists — the user must be able to
    // compose/copy the error, and blocking them here would strand the
    // draft). The actual send rejection lives in
    // useConversationLogic.sendMessage, which toasts
    // conversation.toast.gatewayReauthRequired — a downstream contract,
    // covered by the conversation-logic layer, not by this component.
    settingsState.hasApiKey = true
    settingsState.providerType = 'anthropic'
    settingsState.modelName = 'claude-test'
    settingsState.modelCredentialStatus = 'expired'
    render(<WelcomeScreen onStartConversation={onStart} onOpenSettings={onOpenSettings} />)

    // Expired selection still counts as usable → the ready step (no
    // 'Skip for now' escape hatch — that only renders on setup cards).
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mock-input-type'))
    // The mock now ENFORCES `disabled` (#84 review round 2): the keystroke
    // landing in the draft proves the editor truly accepted typing.
    expect(screen.getByTestId('agent-rich-input')).toHaveAttribute('data-typing-accepted', 'true')
    expect(inputDraftState.drafts.get('proj-1')?.text).toBe('typed text')
    const send = screen.getByTestId('mock-send')
    fireEvent.click(send)

    // WelcomeScreen does NOT gate on the expired credential — the send
    // reaches onStartConversation, and the gateway re-auth toast fires
    // downstream in sendMessage (see useConversationLogic).
    expect(onStart).toHaveBeenCalledWith('typed text')
  })

  it('does NOT treat an expired credential as a selection when provider/model are empty', () => {
    // Regression for the Sourcery round-3 finding: the expired-credential
    // grace must only apply when BOTH providerType and modelName exist.
    // With no selection at all there is nothing to preserve — the composer
    // must stay disabled and the user must land on the select-model card,
    // not on ready where handleSubmit would start a model-less conversation.
    const onStart = vi.fn()
    settingsState.hasApiKey = false
    settingsState.modelCredentialStatus = 'expired'
    settingsState.providerType = ''
    settingsState.modelName = ''
    render(<WelcomeScreen onStartConversation={onStart} onOpenSettings={vi.fn()} />)

    // The select-model setup card is showing (NOT ready): 'Skip for now'
    // is the setup card's escape hatch.
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
    // The composer is disabled — no selection means nothing to type into.
    fireEvent.click(screen.getByTestId('mock-input-type'))
    expect(screen.getByTestId('agent-rich-input')).toHaveAttribute('data-typing-accepted', 'false')
    expect(inputDraftState.drafts.get('proj-1')?.text).toBeUndefined()
    // And the send path cannot start a conversation either.
    const send = screen.getByTestId('mock-send')
    fireEvent.click(send)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('allows send on the ready step (regression guard for the setup-step gate)', () => {
    const onStart = vi.fn()
    render(<WelcomeScreen onStartConversation={onStart} />)
    advanceToReady()

    fireEvent.click(screen.getByTestId('mock-input-type'))
    fireEvent.click(screen.getByTestId('mock-send'))

    expect(onStart).toHaveBeenCalledWith('typed text')
    expect(toastWarningMock).not.toHaveBeenCalled()
  })

  it('migrates a draft saved under the welcome fallback key once the project id arrives', () => {
    // Draft typed before the project id was hydrated lives under 'welcome'.
    inputDraftState.drafts.set('welcome', {
      text: 'orphaned pre-hydration draft',
      mentionedAgentIds: [],
      selectedFiles: [],
    })

    render(<WelcomeScreen onStartConversation={vi.fn()} />)
    advanceToReady()

    // The migrated draft landed in the editor (proof the carry-over worked);
    // the restore contract consumes it (clearDraft on restore, same as the
    // direct-restore test above), so only the orphaned 'welcome' entry must
    // be gone from the store afterwards.
    expect(screen.getByTestId('draft-restored')).toHaveTextContent('orphaned pre-hydration draft')
    expect(inputDraftState.drafts.has('welcome')).toBe(false)
  })

  // activeProjectId is '' (not null) before the project store hydrates — the
  // fallback must catch the empty string too, or pre-hydration drafts land
  // under a key nothing can ever migrate.
  it('uses the welcome fallback when activeProjectId is the empty string', () => {
    projectState.activeProjectId = ''
    const { rerender } = render(<WelcomeScreen onStartConversation={vi.fn()} />)
    advanceToReady()

    // Typing routes the draft to 'welcome' (NOT to '').
    fireEvent.click(screen.getByTestId('mock-input-type'))
    expect(inputDraftState.drafts.has('')).toBe(false)
    expect(inputDraftState.drafts.get('welcome')?.text).toBe('typed text')

    // And when the project id arrives afterwards, the migration effect
    // carries the transient draft over (rerender picks up the mutated mock).
    projectState.activeProjectId = 'proj-2'
    rerender(<WelcomeScreen onStartConversation={vi.fn()} />)
    expect(screen.getByTestId('draft-restored')).toHaveTextContent('typed text')
    expect(inputDraftState.drafts.has('welcome')).toBe(false)
  })

  // ── Toolbar (pre-conversation configuration) ──
  // The toolbar (Agent / Mode / Completion policy) lets users configure
  // per-run knobs BEFORE the first message, so settings flow into the new
  // conversation at send time. Rendered on every non-welcome step (input
  // already renders there too). The thinking toggle is part of the input's
  // accessory bar, not the toolbar.
  it('renders the toolbar dropdowns and the inline thinking controls on the ready step', () => {
    render(<WelcomeScreen onStartConversation={vi.fn()} />)
    advanceToReady()

    expect(screen.getByTestId('toolbar-agent-dropdown')).toBeInTheDocument()
    expect(screen.getByTestId('toolbar-agent-mode')).toBeInTheDocument()
    expect(screen.getByTestId('toolbar-run-end-policy')).toBeInTheDocument()
    expect(screen.getByTestId('inline-thinking-controls')).toBeInTheDocument()
  })

  it('renders the toolbar on the api-key setup step too', () => {
    // Unconfigured baseline lands on the api-key step (still renders input
    // + toolbar per the persistent-rendering pattern).
    settingsState.hasApiKey = false
    settingsState.providerType = ''
    settingsState.modelName = ''
    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()
    expect(screen.getByTestId('toolbar-agent-dropdown')).toBeInTheDocument()
    expect(screen.getByTestId('toolbar-agent-mode')).toBeInTheDocument()
    expect(screen.getByTestId('toolbar-run-end-policy')).toBeInTheDocument()
    expect(screen.getByTestId('inline-thinking-controls')).toBeInTheDocument()
  })

  // ── #82: no usable model → input disabled, placeholder points at the chip ──
  it('disables the input and points at the model chip when no model is selected', () => {
    // Key configured but no provider/model chosen (skip flag set → ready step)
    localStorage.setItem('creatorweave:onboarding:ai-setup-skipped', 'true')
    settingsState.hasApiKey = true
    settingsState.providerType = ''
    settingsState.modelName = ''
    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    expect(screen.queryByText('welcome.apiKeyLabel')).not.toBeInTheDocument()
    const input = screen.getByTestId('agent-rich-input')
    expect(input).toBeInTheDocument()
    // Forward through the mock (#84 review): the disabled wiring and the
    // placeholder hint must both actually reach the editor — and the mock
    // now ENFORCES disabled (#84 review round 2): typing is swallowed.
    expect(input).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('mock-placeholder')).toHaveTextContent(
      'Pick a usable model in the model selector below first'
    )
    fireEvent.click(screen.getByTestId('mock-input-type'))
    expect(input).toHaveAttribute('data-typing-accepted', 'false')
    expect(inputDraftState.drafts.has('proj-1')).toBe(false)
    const send = screen.getByTestId('mock-send')
    expect(send).toBeDisabled()
  })

  // ── #87: unregistered dynamic provider keeps the selection editable but blocks sending ──
  it('keeps the editor editable but blocks sending when the selected provider never registered (#87)', () => {
    // Persisted codex-oauth selection with the stale virtual key still
    // satisfying hasApiKey, but the extension is gone so the dynamic
    // provider never registered this session. The selection must stay on
    // the READY step (nothing to re-pick) with an EDITABLE input, and the
    // send must be blocked — the persisted selection itself stays intact
    // so a re-login seamlessly restores it.
    const onStart = vi.fn()
    settingsState.hasApiKey = true
    settingsState.providerType = 'codex-oauth'
    settingsState.modelName = 'gpt-6-luna'
    settingsState.modelCredentialStatus = 'unknown'
    render(<WelcomeScreen onStartConversation={onStart} onOpenSettings={vi.fn()} />)

    // Ready step, not a setup card ('Skip for now' only renders there).
    expect(screen.queryByRole('button', { name: 'Skip for now' })).not.toBeInTheDocument()
    // Input stays editable — the user may need to compose/copy while
    // recovering the Codex login.
    fireEvent.click(screen.getByTestId('mock-input-type'))
    expect(screen.getByTestId('agent-rich-input')).toHaveAttribute('data-typing-accepted', 'true')
    expect(inputDraftState.drafts.get('proj-1')?.text).toBe('typed text')
    // Send path is blocked: handleSubmit rejects with the re-login toast.
    fireEvent.click(screen.getByTestId('mock-send'))
    expect(onStart).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith(
      'The selected provider is unavailable — sign in again to use it.',
    )
    // The persisted selection was NOT cleared.
    expect(settingsState.providerType).toBe('codex-oauth')
    expect(settingsState.modelName).toBe('gpt-6-luna')
  })

  it('blocks sending when the model becomes unconfigured mid-session', () => {
    const onStart = vi.fn()
    const { rerender } = render(<WelcomeScreen onStartConversation={onStart} />)
    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()

    // Enter the payload WHILE the model is still configured (Sourcery
    // round 4): once the model is cleared the composer disables itself, so
    // typing afterwards would be swallowed by the editor and handleSubmit
    // would bail on the empty-text guard before ever reaching the
    // readiness gate — the test would pass even with the gate removed.
    fireEvent.click(screen.getByTestId('mock-input-type'))
    expect(inputDraftState.drafts.get('proj-1')?.text).toBe('typed text')

    settingsState.providerType = ''
    settingsState.modelName = ''
    rerender(<WelcomeScreen onStartConversation={onStart} />)

    // The send is blocked by the model-readiness gate with a real payload
    // staged (input is non-empty; the readiness gate is the only blocker).
    fireEvent.click(screen.getByTestId('mock-send'))
    expect(onStart).not.toHaveBeenCalled()
  })

  // ── Sourcery round 5 (High #1): the registry must be a REACTIVE
  // dependency — a provider registering while the screen stays mounted
  // (extension installed / gateway logged in) must unblock the send
  // without any selection change, and unregistering must re-block it. ──
  it('unblocks sending once a previously-unregistered provider registers mid-session', async () => {
    const onStart = vi.fn()
    const { registerDynamicProvider, unregisterDynamicProvider } = await import('@/agent/providers/types')

    // Start unregistered (empty registry → #87 state).
    settingsState.hasApiKey = true
    settingsState.providerType = 'codex-oauth'
    settingsState.modelName = 'gpt-6-luna'
    render(<WelcomeScreen onStartConversation={onStart} />)

    fireEvent.click(screen.getByTestId('mock-input-type'))
    fireEvent.click(screen.getByTestId('mock-send'))
    expect(onStart).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith(
      'The selected provider is unavailable — sign in again to use it.',
    )

    // The extension registers codex-oauth while the screen stays mounted.
    // act() flushes the useSyncExternalStore subscriber re-render that the
    // registry change triggers — it must reach the component WITHOUT any
    // manual rerender call (Sourcery round 2).
    act(() => {
      registerDynamicProvider(
        'codex-oauth',
        { baseURL: 'https://chatgpt.com/backend-api/codex', modelName: 'gpt-6-luna', headers: {} },
        {
          category: 'custom',
          displayName: 'Codex (Browser OAuth)',
          models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', capabilities: ['code', 'reasoning'] }],
        },
      )
    })
    try {
      // The useSyncExternalStore subscription must fire the re-render by
      // itself (Sourcery round 2): attempt the send WITHOUT calling
      // rerender, so a component that only recomputes on unrelated renders
      // cannot pass.
      fireEvent.click(screen.getByTestId('mock-send'))
      // Exactly one NEW toast allowed: the pre-gate rejection above. A
      // second provider toast would mean the mid-session registration did
      // NOT unblock the send through the component's own subscription.
      expect(toastErrorMock).toHaveBeenCalledTimes(1)
      expect(onStart).toHaveBeenCalledTimes(1)
      expect(onStart).toHaveBeenCalledWith('typed text')
    } finally {
      unregisterDynamicProvider('codex-oauth')
    }
  })

  it('re-blocks sending when the selected provider unregisters mid-session', async () => {
    const onStart = vi.fn()
    const types = await import('@/agent/providers/types')
    const { registerDynamicProvider, unregisterDynamicProvider } = types

    // Start registered: codex-oauth is live this session.
    settingsState.hasApiKey = true
    settingsState.providerType = 'codex-oauth'
    settingsState.modelName = 'gpt-6-luna'
    registerDynamicProvider(
      'codex-oauth',
      { baseURL: 'https://chatgpt.com/backend-api/codex', modelName: 'gpt-6-luna', headers: {} },
      {
        category: 'custom',
        displayName: 'Codex (Browser OAuth)',
        models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', capabilities: ['code', 'reasoning'] }],
      },
    )
    render(<WelcomeScreen onStartConversation={onStart} />)

    // Send works while the provider is live.
    fireEvent.click(screen.getByTestId('mock-input-type'))
    fireEvent.click(screen.getByTestId('mock-send'))
    expect(onStart).toHaveBeenCalledTimes(1)

    // Extension removed / auth revoked → unregisters while mounted.
    // (Sourcery round 2) No manual rerender: the send below must observe
    // the registry change through the component's own subscription.
    // (Sourcery round 3) Re-type BEFORE unregistering (the send consumed
    // the input, and an empty input would early-return before the guard),
    // then attempt the send IMMEDIATELY after the unregister — the ONLY
    // render between the unregister and the send is the
    // useSyncExternalStore one. `mock-input-type` after unregistering
    // would cause an ordinary onChange rerender that recomputes the memo
    // and lets a broken subscription still pass.
    fireEvent.click(screen.getByTestId('mock-input-type'))
    act(() => {
      unregisterDynamicProvider('codex-oauth')
    })
    fireEvent.click(screen.getByTestId('mock-send'))

    expect(onStart).toHaveBeenCalledTimes(1) // no new conversation started
    expect(toastErrorMock).toHaveBeenCalledWith(
      'The selected provider is unavailable — sign in again to use it.',
    )
    // Selection preserved for recovery.
    expect(settingsState.providerType).toBe('codex-oauth')
  })

  // ── Sourcery round 5 (Medium #7): the unregistered-provider toast must
  // win over the generic not-ready guidance when both apply. ──
  it('shows the provider re-login toast instead of the not-ready guidance when unregistered on a setup step', () => {
    const onStart = vi.fn()
    const onOpenSettings = vi.fn()
    // Expired credential dropped hasApiKey → api-key setup step, while the
    // dynamic provider selection is unregistered.
    settingsState.hasApiKey = false
    settingsState.providerType = 'codex-oauth'
    settingsState.modelName = 'gpt-6-luna'
    render(<WelcomeScreen onStartConversation={onStart} onOpenSettings={onOpenSettings} />)

    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('mock-input-type'))
    fireEvent.click(screen.getByTestId('mock-send'))

    expect(onStart).not.toHaveBeenCalled()
    // Provider-specific toast wins; the generic warning / settings redirect
    // from the not-ready branch must NOT fire.
    expect(toastErrorMock).toHaveBeenCalledWith(
      'The selected provider is unavailable — sign in again to use it.',
    )
    expect(toastWarningMock).not.toHaveBeenCalled()
    expect(onOpenSettings).not.toHaveBeenCalled()
  })
})
