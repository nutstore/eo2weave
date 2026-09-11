import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { captureTabMock, addFilesMock, addNativeHostRootMock, conversationState, pageActionAvailable, folderAccessState } = vi.hoisted(() => ({
  captureTabMock: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==' })),
  addFilesMock: vi.fn(),
  addNativeHostRootMock: vi.fn(async () => true),
  conversationState: { conversations: [] as unknown[] },
  pageActionAvailable: { value: true },
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
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: (selector: (state: {
    hasApiKey: boolean
    hasApiKeyLoaded: boolean
    checkHasApiKey: () => Promise<void>
    providerType: string
    modelName: string
  }) => unknown) => selector({
    hasApiKey: true,
    hasApiKeyLoaded: true,
    checkHasApiKey: async () => {},
    // Readiness gate (commit 24bd878) requires BOTH providerType and
    // modelName; without it the screen lands on select-model, not mount-folder.
    providerType: 'openai',
    modelName: 'vision-model',
  }),
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

vi.mock('@/hooks/useGatewayLogin', () => ({
  isLLMGatewayConfigured: () => false,
  useGatewayLogin: () => ({ authState: null, isRunning: false, login: async () => false, reset: vi.fn() }),
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

vi.mock('../agent/AgentRichInput', () => ({
  AgentRichInput: ({ leadingAccessory }: { leadingAccessory?: ReactNode }) => (
    <div data-testid="agent-rich-input">{leadingAccessory}</div>
  ),
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
    localStorage.setItem('creatorweave:onboarding:welcome-seen', 'true')
    // The mount-folder skip persists across remounts by design; clear it so
    // tests below still see the mount-folder step from a clean baseline.
    localStorage.removeItem('creatorweave:onboarding:folder-mount-skipped')
    // Reset mock state so each test starts from a deterministic baseline.
    // The hydration test flips `rootsHydrated` explicitly.
    folderAccessState.roots = []
    folderAccessState.rootsHydrated = true
    folderAccessState.addNativeHostRoot = addNativeHostRootMock
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
})
