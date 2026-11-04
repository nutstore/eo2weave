/**
 * Dispatch-time gateway credential gate (issue #172 findings 3+4+5).
 *
 * runAgent is the shared dispatch boundary for every AI action. The
 * keyless-custom-provider exception used to apply to the dynamically
 * registered llm-gateway, so an EMPTY credential passed the send gate and
 * the request layer sent WITHOUT Authorization. The gate now resolves the
 * credential AUTHORITATIVELY via resolveGatewayDispatchCredential:
 *  - confirmed missing/expired → the run fails BEFORE provider construction
 *    (no AgentLoop, no chat request) with a structured [CODE] error;
 *  - temporary storage/refresh failures → retryable error, no login card;
 *  - a usable session → the run proceeds with the validated current token.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@/agent/message-types'
import { useConversationRuntimeStore } from '@/store/conversation-runtime.store'

const resolveCredentialMock = vi.hoisted(() => vi.fn())
const setFaviconStateMock = vi.hoisted(() => vi.fn())
const gatewayRegistered = vi.hoisted(() => ({ value: true }))

vi.mock('@/services/favicon-indicator', () => ({ setFaviconState: setFaviconStateMock }))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}))

vi.mock('@/streaming-bus', () => ({
  emitThinkingStart: vi.fn(),
  emitThinkingDelta: vi.fn(),
  emitCompressionEvent: vi.fn(),
  emitToolStart: vi.fn(),
  emitComplete: vi.fn(),
  emitError: vi.fn(),
}))

vi.mock('@/store/conversation-context.store', () => ({
  getActiveConversation: vi.fn(() => null),
  useConversationContextStore: {
    getState: vi.fn(() => ({
      activeWorkspaceId: null,
      workspaces: [],
      createWorkspace: vi.fn(() => Promise.resolve()),
      switchWorkspace: vi.fn(() => Promise.resolve()),
      refreshWorkspaces: vi.fn(() => Promise.resolve()),
      refreshPendingChanges: vi.fn(() => Promise.resolve()),
      deleteWorkspace: vi.fn(() => Promise.resolve()),
    })),
  },
}))

const mockSettingsState = vi.hoisted(() => ({
  providerType: 'llm-gateway',
  modelName: 'gateway-model',
  maxIterations: 20,
  customProviders: [],
  getEffectiveProviderConfig: vi.fn(() => ({
    apiKeyProviderKey: '__llm_gateway_token__',
    baseUrl: 'https://ai.jianguoyun.com/v1',
    modelName: 'gateway-model',
  })),
}))

vi.mock('@/store/settings.store', () => ({
  useSettingsStore: {
    getState: vi.fn(() => mockSettingsState),
  },
  __mockSettingsState: mockSettingsState,
}))

vi.mock('@/sqlite', () => ({
  initSQLiteDB: vi.fn(() => Promise.resolve()),
  getApiKeyRepository: vi.fn(() => ({
    load: vi.fn(() => Promise.resolve(null)),
  })),
  getConversationRepository: vi.fn(() => ({
    findAll: vi.fn(() => Promise.resolve([])),
    save: vi.fn(() => Promise.resolve()),
    saveMeta: vi.fn(() => Promise.resolve()),
    touch: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  })),
  getMessageRepository: vi.fn(() => ({
    findByConversation: vi.fn(() => Promise.resolve([])),
    insert: vi.fn(() => Promise.resolve()),
    replaceAll: vi.fn(() => Promise.resolve()),
    migrateFromJsonBlob: vi.fn(() => Promise.resolve({ conversations: 0, messages: 0 })),
    recoverFromAppSessions: vi.fn(() =>
      Promise.resolve({ sessions: 0, conversations: 0, messages: 0 })
    ),
  })),
  getSQLiteDB: vi.fn(() => ({
    queryFirst: vi.fn(() => Promise.resolve({ count: 0 })),
  })),
}))

// llm-gateway IS a registered dynamic provider in these tests.
vi.mock('@/agent/providers/types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/agent/providers/types')>()
  return {
    ...actual,
    isCustomProviderType: vi.fn((type: string) => type === 'llm-gateway'),
    // The gateway provider is REGISTERED in these tests (the reconciler /
    // startup path would have done it): without a registry config the
    // providerMissing guard rejects before the credential gate runs.
    getProviderConfig: vi.fn((type: string) =>
      type === 'llm-gateway'
        ? (gatewayRegistered.value ? { baseURL: 'https://ai.jianguoyun.com/v1', modelName: '', headers: {}, apiMode: 'chat-completions' as const } : undefined)
        : actual.getProviderConfig(type as never)
    ),
  }
})

vi.mock('@/agent/providers/llm-gateway-auth', () => ({
  resolveGatewayDispatchCredential: resolveCredentialMock,
}))
vi.mock('@/agent/providers/llm-gateway-provider', () => ({
  getLLMGatewayBaseURL: vi.fn(() => 'https://ai.jianguoyun.com'),
  getLLMGatewayClientId: vi.fn(() => 'test-client-id'),
}))

const agentLoopConstructed = vi.hoisted(() => vi.fn())
vi.mock('@/agent/agent-loop', () => ({
  AgentLoop: vi.fn().mockImplementation((...args: unknown[]) => {
    agentLoopConstructed(...args)
    return {
      cancel: () => {},
      run: vi.fn(() => Promise.resolve([])),
    }
  }),
}))

const createLLMProviderMock = vi.hoisted(() => vi.fn())
vi.mock('@/agent/llm/provider-factory', () => ({
  createLLMProvider: createLLMProviderMock.mockImplementation(() => ({
    maxContextTokens: 128000,
  })),
}))

vi.mock('@/agent/conversation-agent-routing', () => ({
  resolveConversationAgentId: vi.fn(async () => 'default'),
}))

vi.mock('@/agent/context-manager', () => ({
  ContextManager: vi.fn().mockImplementation(() => ({})),
}))

vi.mock('@/agent/tool-registry', () => ({
  getToolRegistry: vi.fn(() => ({})),
}))

vi.mock('@/agent/follow-up-generator', () => ({
  generateFollowUp: vi.fn(() => Promise.resolve('')),
}))

vi.mock('@/mcp/elicitation-handler.tsx', () => ({
  getElicitationHandler: vi.fn(() => ({
    handleBinaryElicitation: vi.fn(() => Promise.resolve({})),
  })),
}))

vi.mock('@/agent/subagent/runtime', () => ({
  getOrCreateSubagentRuntime: vi.fn(() => ({})),
}))

vi.mock('@/store/workspace-preferences.store', () => ({
  getCurrentWorkspaceAgentMode: vi.fn(() => 'yolo'),
}))

import { useConversationStore } from '@/store/conversation.store'

async function startRun(): Promise<void> {
  const store = useConversationStore.getState()
  const conv = store.createNew('gateway-gate')
  store.addMessage(conv.id, createUserMessage('hello'))
  await store.runAgent(conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
}

describe('llm-gateway dispatch credential gate (issue #172)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gatewayRegistered.value = true
    useConversationRuntimeStore.setState({ runtimes: new Map() })
    useConversationStore.setState({
      conversations: [],
      activeConversationId: null,
      loaded: true,
      suggestedFollowUps: new Map(),
      cancelledRunIds: new Set(),
      mountedConversations: new Map(),
    } as never)
    mockSettingsState.getEffectiveProviderConfig.mockReturnValue({
      apiKeyProviderKey: '__llm_gateway_token__',
      baseUrl: 'https://ai.jianguoyun.com/v1',
      modelName: 'gateway-model',
    })
  })

  it('stops BEFORE dispatch with a missing-credential card when no usable session exists', async () => {
    resolveCredentialMock.mockResolvedValue({ ok: false, kind: 'missing' })

    await startRun()

    // No AgentLoop constructed → no chat request can be sent.
    expect(agentLoopConstructed).not.toHaveBeenCalled()
    const conv = useConversationStore.getState().conversations[0]
    expect(conv.status).toBe('error')
    expect(conv.error).toContain('[GATEWAY_CREDENTIALS_MISSING]')
    await vi.waitFor(() => expect(setFaviconStateMock).toHaveBeenLastCalledWith('idle'))
    // The user message is retained.
    expect(conv.messages.some((m) => m.role === 'user')).toBe(true)
  })

  it('shows login guidance when a logged-out gateway is not registered', async () => {
    gatewayRegistered.value = false
    resolveCredentialMock.mockResolvedValue({ ok: false, kind: 'missing' })
    await startRun()
    expect(useConversationStore.getState().conversations[0].error).toContain('[GATEWAY_CREDENTIALS_MISSING]')
  })

  it('stops BEFORE dispatch with the expired card when the session is irrecoverably expired', async () => {
    resolveCredentialMock.mockResolvedValue({ ok: false, kind: 'expired' })

    await startRun()

    expect(agentLoopConstructed).not.toHaveBeenCalled()
    const conv = useConversationStore.getState().conversations[0]
    expect(conv.status).toBe('error')
    expect(conv.error).toContain('[GATEWAY_CREDENTIALS_EXPIRED]')
  })

  it('surfaces a retryable error (no login card) for a transient credential failure', async () => {
    resolveCredentialMock.mockResolvedValue({
      ok: false,
      kind: 'temporary',
      error: new Error('network down'),
    })

    await startRun()

    expect(agentLoopConstructed).not.toHaveBeenCalled()
    const conv = useConversationStore.getState().conversations[0]
    expect(conv.status).toBe('error')
    expect(conv.error).not.toContain('[GATEWAY_CREDENTIALS_MISSING]')
    expect(conv.error).not.toContain('[GATEWAY_CREDENTIALS_EXPIRED]')
  })

  it('dispatches with the validated current token when a usable session exists', async () => {
    resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })

    await startRun()

    expect(agentLoopConstructed).toHaveBeenCalledTimes(1)
    // #175 review: the resolver's token must actually reach the provider —
    // dropping `apiKey = resolved.accessToken` previously passed this test
    // because the mocked custom-provider path tolerated an empty key.
    const providerCall = createLLMProviderMock.mock.calls.find(
      (call) => (call[0] as { providerType?: string })?.providerType === 'llm-gateway',
    )
    expect(providerCall).toBeDefined()
    expect(providerCall![0]).toMatchObject({ apiKey: 'validated-token' })
  })
})
