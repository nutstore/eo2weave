import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { captureTabMock, addFilesMock, addNativeHostRootMock, toastWarningMock, conversationState, pageActionAvailable, folderAccessState, settingsState, inputDraftState, projectState } = vi.hoisted(() => ({
  captureTabMock: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==' })),
  addFilesMock: vi.fn(),
  addNativeHostRootMock: vi.fn(async () => true),
  toastWarningMock: vi.fn(),
  conversationState: { conversations: [] as unknown[] },
  pageActionAvailable: { value: true },
  // Mutable settings state so readiness-flip tests can flip hasApiKey.
  settingsState: {
    hasApiKey: true,
    hasApiKeyLoaded: true,
    checkHasApiKey: async () => {},
    providerType: 'openai',
    modelName: 'vision-model',
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
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: (selector: (state: {
    hasApiKey: boolean
    hasApiKeyLoaded: boolean
    checkHasApiKey: () => Promise<void>
    providerType: string
    modelName: string
  }) => unknown) => selector(settingsState),
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
    error: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
  },
}))

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

vi.mock('@/store/asset.store', () => ({
  useAssetStore: { getState: () => ({ addFiles: addFilesMock }) },
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => ({
    'agent.vision.capture': 'Capture screenshot',
    'agent.vision.supported': 'Current model supports image input',
    'agent.vision.unsupported': 'Vision unavailable',
    'agent.vision.screenshotUnavailable': 'Screenshot unavailable',
    'agent.pageScreenshot.captureFailed': 'Could not capture screenshot',
    'onboarding.steps.files.title': 'Let AI read your files',
    'welcome.setupLocalFirstHint': 'Your data stays in this browser.',
    'welcome.mountFolderButton': 'Choose a folder',
    'welcome.mountFolderDesc': 'Choose a folder and AI can read and edit its files.',
    'welcome.skipButton': 'Skip for now',
    'welcome.mountFolderBack': 'Back',
    'folderSelector.localConnection': 'Connect locally',
    'folderSelector.localConnectionDescription': 'Connect a folder through the local connection.',
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
    initialText,
    onDraftRestored,
    onChange,
  }: {
    leadingAccessory?: ReactNode
    initialText?: string
    onDraftRestored?: () => void
    onChange?: (value: { text: string; mentionedAgentIds: string[] }) => void
  }) => {
    const [consumedText, setConsumedText] = useState<string | null>(null)
    useEffect(() => {
      if (initialText && !consumedText) {
        setConsumedText(initialText)
        onDraftRestored?.()
      }
    }, [initialText, consumedText, onDraftRestored])
    return (
      <div data-testid="agent-rich-input">
        {consumedText ? <div data-testid="draft-restored">{consumedText}</div> : null}
        <button
          type="button"
          data-testid="mock-input-type"
          onClick={() => onChange?.({ text: 'typed text', mentionedAgentIds: [] })}
        >
          type
        </button>
        {leadingAccessory}
      </div>
    )
  }
  return { AgentRichInput: MockAgentRichInput }
})

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
    // Fresh draft store per test — draft persistence is per project, so a
    // stale entry from a previous test would leak into the restore test.
    inputDraftState.drafts.clear()
  })

  // hasApiKey=true + roots=[] (store mocks) + welcome-seen → mount-folder
  // step; skipping it lands on ready where the rich input renders.
  function advanceToReady() {
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
  }

  it('explains why selecting a folder grants AI file access', () => {
    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Choose a folder' })).toBeInTheDocument()
    expect(screen.getByText('Choose a folder and AI can read and edit its files.')).toBeInTheDocument()
  })

  it('places the folder action before the privacy note', () => {
    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    const folderAction = screen.getByRole('button', { name: 'Choose a folder' })
    const privacyNote = screen.getByText('Your data stays in this browser.')

    expect(folderAction.compareDocumentPosition(privacyNote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('persists the skip and does not show the mount-folder step again in a new conversation', () => {
    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    // First conversation: user skips the folder-mount step.
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()

    // Remount = switching to a new conversation: the mount-folder step
    // must stay gone even though no folder was ever mounted.
    cleanup()
    render(<WelcomeScreen onStartConversation={vi.fn()} />)
    expect(screen.getByTestId('agent-rich-input')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Choose a folder' })).not.toBeInTheDocument()
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

  it('offers a local connection when the native-host bridge is available', async () => {
    localStorage.setItem('creatorweave:onboarding:welcome-seen', 'true')
    ;(window as unknown as { __agentWeb: { nativeHostCall: () => Promise<unknown> } }).__agentWeb = {
      nativeHostCall: async () => ({ ok: true }),
    }

    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: 'Connect locally' }))
    await waitFor(() => expect(addNativeHostRootMock).toHaveBeenCalledTimes(1))
  })

  // Regression for the cold-start flash where users who already had a folder
  // mounted briefly saw the "select a folder" step on entry. We now wait
  // for `rootsHydrated` before rendering any step.
  it('does not flash the mount-folder step while roots are still hydrating', () => {
    folderAccessState.rootsHydrated = false
    folderAccessState.roots = []

    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    // While hydration is in flight we render a loading placeholder, NOT the
    // mount-folder step — the user might already have a folder mounted
    // (just not yet read from IndexedDB/SQLite).
    expect(screen.queryByRole('button', { name: 'Choose a folder' })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toBeInTheDocument()
  })

  it('renders the mount-folder step once hydration completes and no roots exist', () => {
    folderAccessState.rootsHydrated = true
    folderAccessState.roots = []

    render(<WelcomeScreen onStartConversation={vi.fn()} />)

    expect(screen.getByRole('button', { name: 'Choose a folder' })).toBeInTheDocument()
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

    // Skip → flag written + card dismissed (folder roots empty → mount-folder)
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

    // i18n mock returns the raw key — the send button's title is 'welcome.send'
    fireEvent.click(screen.getByTitle('welcome.send'))
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

  it('blocks send on a setup step: warns, opens Settings, keeps the draft', () => {
    const onStart = vi.fn()
    const onOpenSettings = vi.fn()
    settingsState.hasApiKey = false
    render(<WelcomeScreen onStartConversation={onStart} onOpenSettings={onOpenSettings} />)

    // On the api-key step, type and hit send.
    fireEvent.click(screen.getByTestId('mock-input-type'))
    expect(inputDraftState.drafts.get('proj-1')?.text).toBe('typed text')
    fireEvent.click(screen.getByTitle('welcome.send'))

    // No conversation starts; the user is pointed at the setup card instead.
    expect(onStart).not.toHaveBeenCalled()
    expect(toastWarningMock).toHaveBeenCalledWith('welcome.sendBlockedNotReady')
    expect(onOpenSettings).toHaveBeenCalledWith('llm')
    // The draft is preserved — nothing the user typed is lost.
    expect(inputDraftState.drafts.get('proj-1')?.text).toBe('typed text')
  })

  it('allows send on the ready step (regression guard for the setup-step gate)', () => {
    const onStart = vi.fn()
    render(<WelcomeScreen onStartConversation={onStart} />)
    advanceToReady()

    fireEvent.click(screen.getByTestId('mock-input-type'))
    fireEvent.click(screen.getByTitle('welcome.send'))

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
})