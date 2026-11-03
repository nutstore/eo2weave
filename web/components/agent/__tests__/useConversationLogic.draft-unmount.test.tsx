/**
 * Regression tests — unmount draft persistence (PR #142 review round 5,
 * Sourcery Medium "Pending drafts are lost").
 *
 * The unmount cleanup must persist live input content even while a
 * draft-restoration marker (draftConvIdRef) is still set:
 * - Rejected send: restoreDraftIntoInput set the marker while the stored
 *   draft was already cleared — the typed text lives only in inputRef, so
 *   skipping the save loses it.
 * - Intact pending restoration: the marker set by the switch-path restore
 *   effect means the editor has NOT consumed the stored draft yet — inputRef
 *   still holds the pre-restore EMPTY value, and saving here would erase the
 *   stored draft. The save must stay skipped in this window.
 *
 * The marker itself is component-private, so the tests exercise the
 * observable contract through the real hook: re-mount on the same convId and
 * assert exactly one of "draft survives" / "live text persisted".
 */

import { renderHook, act } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useConversationLogic } from '@/components/agent/useConversationLogic'
import { useInputDraftStore } from '@/store/input-draft.store'
import { useConversationStore as conversationStoreModule } from '@/store/conversation.store'

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    loading: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  }),
}))

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('@/skills/builtin-slash-exec', () => ({
  assembleBuiltinCommandPrompt: vi.fn(async () => ''),
  matchesBuiltinCommand: vi.fn(() => false),
}))

vi.mock('@/services/asset.service', () => ({
  removeAssetsFromOPFS: vi.fn(async () => undefined),
  writePendingAssetsToOPFS: vi.fn(async () => []),
}))

vi.mock('@/services/ocr.service', () => ({
  performOcr: vi.fn(async () => ''),
  isOcrCompatibleImage: vi.fn(() => false),
}))

vi.mock('@/agent/llm/pi-ai-model-resolver', () => ({
  supportsImageInput: vi.fn(() => false),
}))

vi.mock('@/agent/message-types', () => ({
  createUserMessage: vi.fn(() => ({ id: 'm', role: 'user', content: '', timestamp: 0 })),
}))

vi.mock('@/store/asset.store', () => ({
  useAssetStore: Object.assign(
    (selector?: (s: unknown) => unknown) => selector?.({ pendingAssets: [] }) ?? { pendingAssets: [] },
    { getState: () => ({ pendingAssets: [], clearAll: vi.fn(), addFiles: vi.fn() }) },
  ),
}))

vi.mock('@/store/conversation.store', () => {
  const state = {
    activeConversationId: null as string | null,
    conversations: [] as Array<{ id: string; messages: unknown[]; lastContextWindowUsage: null }>,
    createNew: vi.fn(),
    setActive: vi.fn(),
    updateMessages: vi.fn(),
    runAgent: vi.fn(),
    deleteAgentLoop: vi.fn(),
    editAndResendUserMessage: vi.fn(),
    regenerateUserMessage: vi.fn(),
    compactConversation: vi.fn(),
    cancelAgent: vi.fn(),
  }
  const useConversationStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state
  ;(useConversationStore as unknown as { getState: () => typeof state }).getState = () => state
  ;(useConversationStore as unknown as { subscribe: ReturnType<typeof vi.fn> }).subscribe = vi.fn()
  return { useConversationStore }
})

vi.mock('@/store/conversation-runtime.store', () => {
  const state = {
    runtimes: new Map(),
    pendingMessageQueues: new Map(),
    isConversationRunning: vi.fn(() => false),
    getSuggestedFollowUp: vi.fn(() => ''),
    clearSuggestedFollowUp: vi.fn(),
    mountConversation: vi.fn(),
    unmountConversation: vi.fn(),
    getQueueDepth: vi.fn(() => 0),
    enqueueMessage: vi.fn(),
  }
  const useConversationRuntimeStore = (selector?: (s: typeof state) => unknown) =>
    selector ? selector(state) : state
  ;(useConversationRuntimeStore as unknown as { getState: () => typeof state }).getState = () => state
  return { useConversationRuntimeStore }
})

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector?.({ hasApiKey: true, hasApiKeyLoaded: true, enableThinking: false, thinkingLevel: 'medium' }) ?? {},
    {
      getState: () => ({
        hasApiKey: true,
        hasApiKeyLoaded: true,
        enableThinking: false,
        thinkingLevel: 'medium',
        modelName: 'gpt-5.4',
        providerType: 'openai',
        setEnableThinking: vi.fn(),
        setThinkingLevel: vi.fn(),
      }),
      subscribe: vi.fn(),
    },
  ),
}))

vi.mock('@/store/workspace-preferences.store', () => ({
  useWorkspacePreferencesStore: Object.assign(
    (selector?: (s: Record<string, unknown>) => unknown) =>
      selector?.({ agentMode: 'act', setAgentMode: vi.fn() }) ?? {},
    { getState: () => ({ agentMode: 'act', setAgentMode: vi.fn() }) },
  ),
}))

vi.mock('@/store/agents.store', () => ({
  useAgentsStore: (selector?: (s: Record<string, unknown>) => unknown) =>
    selector?.({
      agents: [],
      activeAgentId: 'default',
      setActiveAgent: vi.fn(),
      createAgent: vi.fn(),
      deleteAgent: vi.fn(),
    }) ?? {},
}))

vi.mock('@/hooks/useProjectAgentsInit', () => ({
  useProjectAgentsInit: () => undefined,
}))

const CONV_ID = 'conv-draft-unmount'

/**
 * Point the mocked conversation store at an active empty conversation so the
 * hook's convId is defined (the draft effects are keyed on it).
 */
function seedActiveConversation() {
  const store = conversationStoreModule as unknown as {
    getState: () => {
      activeConversationId: string | null
      conversations: Array<{ id: string; messages: unknown[]; lastContextWindowUsage: null }>
    }
  }
  store.getState().activeConversationId = CONV_ID
  store.getState().conversations = [
    { id: CONV_ID, messages: [], lastContextWindowUsage: null },
  ]
}

/** Fresh draft store per test (module state is shared across tests in a file). */
function resetDraftStore() {
  useInputDraftStore.setState({ drafts: {} })
}

describe('useConversationLogic unmount draft persistence (PR #142 round 5)', () => {
  beforeEach(() => {
    resetDraftStore()
  })

  it('saves live input on unmount while a rejected-send restoration marker is set', async () => {
    // Rejected send with a restored draft: a stored draft existed at mount
    // (its restoration was pending → marker set), the send attempt cleared
    // it, the send was rejected, and restoreDraftIntoInput re-injected the
    // text into the input while the marker stays set.
    useInputDraftStore.getState().saveDraft(CONV_ID, {
      text: 'draft being sent',
      mentionedAgentIds: [],
      selectedFiles: [],
    })
    seedActiveConversation()

    const { result, unmount } = renderHook(() => useConversationLogic())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(result.current.convId).toBe(CONV_ID)
    // The pending restoration set the marker the unmount cleanup consults.
    expect(result.current.draftTextToRestore).toBe('draft being sent')

    // Rejected send: the send path cleared the stored draft and the
    // rejection re-injected the text into the input (live content now).
    act(() => {
      useInputDraftStore.getState().clearDraft(CONV_ID)
      result.current.setInput('typed after rejection')
    })

    unmount()

    // The typed text must have been persisted — not silently dropped
    // behind the still-set restoration marker.
    expect(useInputDraftStore.getState().peekDraft(CONV_ID)).toEqual({
      text: 'typed after rejection',
      mentionedAgentIds: [],
      selectedFiles: [],
    })
  })

  it('keeps the stored draft when unmounting before the editor consumed the restoration', async () => {
    // Switch-path restoration pending: the stored draft is intact and the
    // marker set — inputRef holds the pre-restore EMPTY value. Saving here
    // would erase the stored draft before the editor's restore effect runs
    // (round-2 invariant that must keep holding).
    useInputDraftStore.getState().saveDraft(CONV_ID, {
      text: 'stored draft',
      mentionedAgentIds: ['agent-1'],
      selectedFiles: [],
    })
    seedActiveConversation()

    const { result, unmount } = renderHook(() => useConversationLogic())
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
    // The hook surfaced the pending restoration; the marker is set.
    expect(result.current.draftTextToRestore).toBe('stored draft')
    // inputRef still EMPTY (the editor has not consumed the draft).
    act(() => {
      result.current.setInput('')
    })

    unmount()

    // The intact stored draft must survive the empty-input save skip.
    expect(useInputDraftStore.getState().peekDraft(CONV_ID)).toEqual({
      text: 'stored draft',
      mentionedAgentIds: ['agent-1'],
      selectedFiles: [],
    })
  })
})
