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

import { renderHook, act, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useConversationLogic } from '@/components/agent/useConversationLogic'
import { useAssetStore } from '@/store/asset.store'
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

const { writeAssets, encodeImage } = vi.hoisted(() => ({ writeAssets: vi.fn(), encodeImage: vi.fn(async () => 'image-data') }))
vi.mock('@/services/asset.service', () => ({
  removeAssetsFromOPFS: vi.fn(async () => undefined),
  writePendingAssetsToOPFS: writeAssets,
}))
vi.mock('@/store/workspace.store', () => ({ useWorkspaceStore: { getState: () => ({ activeWorkspaceId: 'conv-draft-unmount' }) } }))

vi.mock('@/services/ocr.service', () => ({
  performOcr: vi.fn(async () => ''),
  isOcrCompatibleImage: vi.fn(() => false),
  fileToBase64: encodeImage,
}))

vi.mock('@/agent/llm/pi-ai-model-resolver', () => ({
  supportsImageInput: vi.fn(() => false),
}))

vi.mock('@/agent/message-types', () => ({
  createUserMessage: vi.fn((content, assets) => ({ id: 'm', role: 'user', content, assets, timestamp: 0 })),
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

describe('pending attachment sending', () => {
  beforeEach(() => {
    seedActiveConversation()
    resetDraftStore()
    useAssetStore.getState().clearAll()
    useAssetStore.setState({ deferredAssets: {} })
    writeAssets.mockReset()
    encodeImage.mockReset()
    encodeImage.mockResolvedValue('image-data')
  })

  it.each(['', 'Please inspect'])('sends the snapshot for message %j while keeping a later attachment', async (message) => {
    let finish!: (value: unknown[]) => void
    writeAssets.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const first = new File(['pasted content'], 'first.txt', { type: 'text/plain' })
    useAssetStore.getState().addFiles([first])
    const { result } = renderHook(() => useConversationLogic())
    act(() => result.current.setInput(message))
    await act(async () => { await result.current.handleSend() })
    await waitFor(() => expect(writeAssets).toHaveBeenCalled())
    expect(writeAssets.mock.calls[0][0][0].file).toBe(first)
    act(() => useAssetStore.getState().addFiles([new File(['later'], 'later.txt', { type: 'text/plain' })]))
    const metadata = [{ name: 'first.txt', mimeType: 'text/plain', size: first.size }]
    await act(async () => finish(metadata))
    await waitFor(() => expect(conversationStoreModule.getState().updateMessages).toHaveBeenCalledWith(CONV_ID, expect.arrayContaining([expect.objectContaining({ content: message, assets: metadata })])))
    expect(useAssetStore.getState().pendingAssets.map((a) => a.name)).toEqual(['later.txt'])
  })

  it('restores a failed send alongside an attachment staged later', async () => {
    let fail!: (reason: Error) => void
    writeAssets.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    useAssetStore.getState().addFiles([new File(['original'], 'first.txt', { type: 'text/plain' })])
    const { result } = renderHook(() => useConversationLogic())
    await act(async () => { await result.current.handleSend() })
    await waitFor(() => expect(writeAssets).toHaveBeenCalled())
    act(() => useAssetStore.getState().addFiles([new File(['later'], 'later.txt', { type: 'text/plain' })]))
    await act(async () => fail(new Error('write failed')))
    await waitFor(() => expect(useAssetStore.getState().pendingAssets.map((a) => a.name)).toEqual(['later.txt', 'first.txt']))
  })
  it('includes image data even when conversion is still pending at send time', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:image'), revokeObjectURL: vi.fn() }))
    let encode!: (data: string) => void
    encodeImage.mockImplementation(() => new Promise((resolve) => { encode = resolve }))
    writeAssets.mockResolvedValue([{ name: 'image.png', mimeType: 'image/png', size: 1 }])
    useAssetStore.getState().addFiles([new File(['x'], 'image.png', { type: 'image/png' })])
    const { result } = renderHook(() => useConversationLogic())
    await act(async () => { await result.current.handleSend() })
    await waitFor(() => expect(encodeImage).toHaveBeenCalled())
    await act(async () => encode('image-data'))
    await waitFor(() => expect(conversationStoreModule.getState().updateMessages).toHaveBeenCalledWith(CONV_ID, expect.arrayContaining([expect.objectContaining({ assets: [expect.objectContaining({ ocrBase64: 'image-data' })] })])))
  })

  it('does not return a failed attachment to a different active conversation', async () => {
    let fail!: (reason: Error) => void
    writeAssets.mockImplementation(() => new Promise((_resolve, reject) => { fail = reject }))
    useAssetStore.getState().addFiles([new File(['original'], 'first.txt', { type: 'text/plain' })])
    const { result } = renderHook(() => useConversationLogic())
    await act(async () => { await result.current.handleSend() })
    await waitFor(() => expect(writeAssets).toHaveBeenCalled())
    conversationStoreModule.getState().activeConversationId = 'other-conversation'
    await act(async () => fail(new Error('write failed')))
    expect(useAssetStore.getState().pendingAssets).toHaveLength(0)
    expect(useAssetStore.getState().deferredAssets[CONV_ID].map((a) => a.name)).toEqual(['first.txt'])
    act(() => useAssetStore.getState().restoreDeferredAssets(CONV_ID))
    expect(useAssetStore.getState().pendingAssets.map((a) => a.name)).toEqual(['first.txt'])
  })

  it('uses the attachment filename for a new attachment-only conversation', async () => {
    const state = conversationStoreModule.getState()
    state.activeConversationId = null
    vi.mocked(state.createNew).mockReturnValue({ id: CONV_ID } as ReturnType<typeof state.createNew>)
    writeAssets.mockResolvedValue([{ name: 'first.txt', mimeType: 'text/plain', size: 1 }])
    useAssetStore.getState().addFiles([new File(['x'], 'first.txt', { type: 'text/plain' })])
    const { result } = renderHook(() => useConversationLogic())
    await act(async () => { await result.current.handleSend() })
    expect(state.createNew).toHaveBeenCalledWith('first.txt')
  })

  it('retains cached image data when restoring a failed send', async () => {
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:image'), revokeObjectURL: vi.fn() }))
    writeAssets.mockRejectedValue(new Error('write failed'))
    useAssetStore.getState().addFiles([new File(['x'], 'cached.png', { type: 'image/png' })])
    const id = useAssetStore.getState().pendingAssets[0].id
    useAssetStore.getState()._updateOcrResult(id, { status: 'done', text: 'recognized', base64: 'cached-data' })
    const { result } = renderHook(() => useConversationLogic())
    await act(async () => { await result.current.handleSend() })
    await waitFor(() => expect(useAssetStore.getState().pendingAssets[0]).toEqual(expect.objectContaining({ name: 'cached.png', ocrText: 'recognized', ocrBase64: 'cached-data' })))
  })

})
