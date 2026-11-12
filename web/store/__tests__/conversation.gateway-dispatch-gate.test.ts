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
const loadCredentialMock = vi.hoisted(() => vi.fn<(provider: string) => Promise<string | null>>())
const setFaviconStateMock = vi.hoisted(() => vi.fn())
const gatewayRegistered = vi.hoisted(() => ({ value: true }))
// Access token the credential store currently holds ('validated-token' by
// default). A test simulating a logout / newer login during resolution
// mutates this.
const storedAccessToken = vi.hoisted(() => ({ value: 'validated-token' as string | null }))
const findHistoryMock = vi.hoisted(() => vi.fn(async () => [] as import('@/agent/message-types').Message[]))
const replaceAllMock = vi.hoisted(() => vi.fn(() => Promise.resolve()))

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
      ensureWorkspace: vi.fn(() => Promise.resolve()),
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
  getEffectiveProviderConfig: vi.fn((_providerTypeOverride?: string) => ({
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
    load: loadCredentialMock,
  })),
  getConversationRepository: vi.fn(() => ({
    findAll: vi.fn(() => Promise.resolve([])),
    save: vi.fn(() => Promise.resolve()),
    saveMeta: vi.fn(() => Promise.resolve()),
    touch: vi.fn(() => Promise.resolve()),
    delete: vi.fn(() => Promise.resolve()),
  })),
  getMessageRepository: vi.fn(() => ({
    findByConversation: findHistoryMock,
    insert: vi.fn(() => Promise.resolve()),
    replaceAll: replaceAllMock,
    applyDiff: vi.fn(async () => {}),
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

const isTokenCurrentMock = vi.hoisted(() =>
  vi.fn(async (accessToken: string) => accessToken === storedAccessToken.value),
)

vi.mock('@/agent/providers/llm-gateway-auth', () => ({
  resolveGatewayDispatchCredential: resolveCredentialMock,
  // Mirrors the real helper: the validated token counts as current while the
  // store still holds it. A logout or newer login replaces/clears it (#180).
  isGatewayAccessTokenCurrent: isTokenCurrentMock,
}))
const registerProviderMock = vi.hoisted(() =>
  vi.fn(() => {
    gatewayRegistered.value = true
  }),
)

vi.mock('@/agent/providers/llm-gateway-provider', () => ({
  getLLMGatewayBaseURL: vi.fn(() => 'https://ai.jianguoyun.com'),
  getLLMGatewayClientId: vi.fn(() => 'test-client-id'),
  registerLLMGatewayProvider: registerProviderMock,
}))

const loopRunMock = vi.hoisted(() => vi.fn(async (_messages: unknown, _callbacks?: any) => []))
const agentLoopConstructed = vi.hoisted(() => vi.fn())
vi.mock('@/agent/agent-loop', () => ({
  AgentLoop: vi.fn().mockImplementation((...args: unknown[]) => {
    agentLoopConstructed(...args)
    return {
      cancel: () => {},
      run: loopRunMock,
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
  peekSubagentRuntime: () => undefined,
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
    loadCredentialMock.mockReset().mockResolvedValue(null)
    gatewayRegistered.value = true
    storedAccessToken.value = 'validated-token'
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

  it('does not overwrite unloaded conversation history when credentials are missing', async () => {
    const store = useConversationStore.getState()
    const conv = store.createNew('unloaded')
    useConversationStore.setState((state) => {
      const current = state.conversations.find((item) => item.id === conv.id)!
      current.messagesLoaded = false
      current.messages = []
    })
    resolveCredentialMock.mockResolvedValue({ ok: false, kind: 'missing' })
    await store.runAgent(conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replaceAllMock).not.toHaveBeenCalled()
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

  it('registers the gateway and dispatches when the session is usable but this tab has no registry entry (#180)', async () => {
    // Tab B whose reconciler has not run yet: the shared token pair resolves,
    // but this tab's DYNAMIC_PROVIDER_CONFIGS has no llm-gateway entry.
    gatewayRegistered.value = false
    resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })

    await startRun()

    expect(registerProviderMock).toHaveBeenCalledTimes(1)
    expect(agentLoopConstructed).toHaveBeenCalledTimes(1)
    const conv = useConversationStore.getState().conversations[0]
    expect(conv.error ?? '').not.toContain('provider is unavailable')
  })

  it('registers the gateway when the resolution refreshed an expired token itself (#214 review)', async () => {
    // Provider missing + expired access token with a live refresh token: the
    // resolver refreshes and commits the new pair, which advances the auth
    // generation. That bump is the resolution's OWN work — it must not read
    // as "the session moved", or a healthy session is told to sign in again.
    gatewayRegistered.value = false
    resolveCredentialMock.mockImplementation(async () => {
      storedAccessToken.value = 'refreshed-token'
      return { ok: true, accessToken: 'refreshed-token' }
    })

    await startRun()

    expect(registerProviderMock).toHaveBeenCalledTimes(1)
    expect(agentLoopConstructed).toHaveBeenCalledTimes(1)
    expect(useConversationStore.getState().conversations[0].error ?? '').not.toContain(
      'unavailable',
    )
  })

  it('does not re-register the gateway when a logout lands during resolution (#180 review)', async () => {
    gatewayRegistered.value = false
    resolveCredentialMock.mockImplementation(async () => {
      // The session ended while the credential read was in flight, so the
      // resolver's verdict describes a credential set that no longer exists.
      storedAccessToken.value = null
      return { ok: true, accessToken: 'token-from-a-dead-session' }
    })

    await startRun()

    expect(registerProviderMock).not.toHaveBeenCalled()
    const conv = useConversationStore.getState().conversations[0]
    expect(conv.status).toBe('error')
    // The run must stop with the re-login guidance, not a generic failure and
    // not the retryable temporary message.
    expect(conv.error).toContain('sign in again')
    expect(conv.error).not.toContain('temporarily unavailable')
  })

  it('re-resolves once and dispatches when another tab refreshed the credential (#215)', async () => {
    gatewayRegistered.value = false
    // Rotation, not a session change: the first resolution validated the
    // token this tab saw, then another tab's refresh committed its successor
    // before the currentness re-read (a refresh starts as soon as the access
    // token enters its 60s expiry buffer). The stored access token no longer
    // matches, but the session is alive — the gate must resolve again instead
    // of showing a re-login card to a signed-in user.
    let resolution = 0
    // Count only the resolutions the GATE takes: the downstream api-key
    // resolution runs after the provider is registered.
    let gateResolutions = 0
    resolveCredentialMock.mockImplementation(async () => {
      resolution += 1
      if (!gatewayRegistered.value) gateResolutions += 1
      if (resolution === 1) {
        storedAccessToken.value = 'rotated-token'
        return { ok: true, accessToken: 'superseded-token' }
      }
      return { ok: true, accessToken: 'rotated-token' }
    })

    await startRun()

    expect(gateResolutions).toBe(2)
    expect(registerProviderMock).toHaveBeenCalledTimes(1)
    expect(agentLoopConstructed).toHaveBeenCalledTimes(1)
    // The rerun must actually dispatch WITH the rotated credential: the
    // custom-provider path tolerates a missing api-key and would still build
    // an AgentLoop, so construction alone cannot prove the token was used.
    const providerCall = createLLMProviderMock.mock.calls.find(
      (call) => (call[0] as { providerType?: string })?.providerType === 'llm-gateway',
    )
    expect(providerCall).toBeDefined()
    expect(providerCall![0]).toMatchObject({ apiKey: 'rotated-token' })
    const conv = useConversationStore.getState().conversations[0]
    expect(conv.error ?? '').not.toContain('sign in again')
  })

  it('offers the login card when the credential is cleared before the currentness re-read (#215)', async () => {
    gatewayRegistered.value = false
    // The session really ended: the re-resolution finds no credential, so the
    // retry must land on the missing-credential card and dispatch nothing.
    let resolution = 0
    resolveCredentialMock.mockImplementation(async () => {
      resolution += 1
      if (resolution === 1) {
        storedAccessToken.value = null
        return { ok: true, accessToken: 'token-from-a-dead-session' }
      }
      return { ok: false, kind: 'missing' }
    })

    await startRun()

    expect(resolveCredentialMock).toHaveBeenCalledTimes(2)
    expect(registerProviderMock).not.toHaveBeenCalled()
    expect(agentLoopConstructed).not.toHaveBeenCalled()
    const conv = useConversationStore.getState().conversations[0]
    expect(conv.status).toBe('error')
    expect(conv.error).toContain('[GATEWAY_CREDENTIALS_MISSING]')
  })

  it('reports the retryable temporary error when the currentness check hits a storage failure (#214 Sourcery round 4)', async () => {
    gatewayRegistered.value = false
    resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })
    // The currentness re-read fails transiently: NOT evidence of logout.
    storedAccessToken.value = null
    isTokenCurrentMock.mockRejectedValueOnce(new Error('storage hiccup'))

    await startRun()

    expect(registerProviderMock).not.toHaveBeenCalled()
    const conv = useConversationStore.getState().conversations[0]
    expect(conv.status).toBe('error')
    expect(conv.error).not.toContain('[GATEWAY_CREDENTIALS_MISSING]')
    expect(conv.error).not.toContain('[GATEWAY_CREDENTIALS_EXPIRED]')
    // A storage hiccup is retryable — it must NOT read as "sign in again".
    expect(conv.error).toContain('temporarily unavailable')
    expect(conv.error).not.toContain('sign in again')
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

  it('builds the follow-up suggestion from the session credential, not a store key (#280)', async () => {
    // The gateway's api-key shadow is gone, so the sqlite mock's
    // `load()` returns null for `__llm_gateway_token__` exactly like a real
    // post-#280 install. Gating the follow-up on that load would silently
    // stop suggestions for every Nutstore AI user.
    resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })
    const { generateFollowUp } = await import('@/agent/follow-up-generator')

    await startRun()

    await vi.waitFor(() =>
      expect(generateFollowUp).toHaveBeenCalledWith(
        expect.any(Array),
        'llm-gateway',
        'validated-token',
      ),
    )
  })
  it('dispatches a valid gateway session without reading its obsolete key', async () => {
    loadCredentialMock.mockRejectedValue(new Error('obsolete key unreadable'))
    resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })
    await startRun()
    expect(loadCredentialMock).not.toHaveBeenCalledWith('__llm_gateway_token__')
    expect(agentLoopConstructed).toHaveBeenCalled()
  })

})

// These exercise the actual store dispatch, including Promise<void> early exits.
describe('subagent notification owning-run receipts', () => {
  async function setupNotification(isBusy: (id: string) => boolean = () => false) {
    const { CompletionDeliveryCoordinator } = await import('@/agent/subagent/completion-delivery')
    const bridge = await import('@/store/subagent-continuation')
    const row = { id: 'child:attempt', agentId: 'child', executionId: 'attempt', conversationId: '', notificationMessageId: 'notice', deliveryReserved: true, status: 'delivered', taskStatus: 'completed', description: 'Research', result: 'done', messages: [], changedPaths: [], createdAt: 1, updatedAt: 1 } as import('@/agent/subagent/async-types').SubagentCompletion
    let readyRow: typeof row | undefined
    const claim = vi.fn(async (_id: string, runId: string) => { row.status = 'processing'; row.parentRunId = runId; return true })
    const handled = vi.fn(async (_id: string, runId?: string) => { if (row.status !== 'processing' || row.parentRunId !== runId) return false; row.status = 'handled'; return true })
    const dispatch = vi.fn(async () => {})
    const coordinator = new CompletionDeliveryCoordinator({ repository: {
      listRecoverable: async () => [row, ...(readyRow ? [readyRow] : [])].filter(item => ['pending', 'delivered', 'blocked', 'error'].includes(item.status)),
      listProcessing: async () => row.status === 'processing' ? [row] : [], reserveDelivery: async () => [],
      claim, markHandled: handled, markDelivered: async (id) => { (id === row.id ? row : readyRow!).status = 'delivered'; return true }, markError: async () => { row.status = 'error'; return true }, markBlocked: async () => { row.status = 'blocked'; return true }, suppress: async () => { row.status = 'suppressed'; return true },
    }, isBusy, validateOrigin: async () => true, appendNotification: async () => true, dispatch, withLock: async (_key, fn) => fn(), onError: vi.fn() })
    const spy = vi.spyOn(bridge, 'getSubagentContinuation').mockReturnValue(coordinator)
    const store = useConversationStore.getState()
    const conv = store.createNew('notification')
    row.conversationId = conv.id
    store.addMessage(conv.id, { id: 'notice', role: 'user', content: 'Child done', timestamp: 1, subagentCompletion: { eventIds: [row.id] } })
    return { row, claim, handled, spy, conv, store, coordinator, dispatch, queueReady: () => { readyRow = { ...row, id: 'next:attempt', agentId: 'next', notificationMessageId: 'next-notice', status: 'pending', continuation: { parentRunId: 'origin', providerType: 'llm-gateway', modelName: 'gateway-model', maxTokens: 1024 } } } }
  }

  it('reloads complete offscreen history before idempotent notification acceptance', async () => {
    const f = await setupNotification()
    try {
      const original = createUserMessage('Full original history')
      findHistoryMock.mockResolvedValueOnce([original])
      useConversationStore.setState(state => ({ conversations: state.conversations.map(c => c.id === f.conv.id ? { ...c, messages: [], messagesLoaded: false } : c) }))
      const { appendSubagentNotification } = await import('@/store/conversation.store.sqlite')
      const notification = { id: 'durable', role: 'user' as const, content: 'Done', timestamp: 2, subagentCompletion: { eventIds: ['child:attempt'] } }
      await appendSubagentNotification(f.conv.id, notification, () => true)
      await appendSubagentNotification(f.conv.id, notification, () => true)
      expect(useConversationStore.getState().conversations.find(c => c.id === f.conv.id)?.messages.map(m => m.id)).toEqual([original.id, 'durable'])
    } finally { f.spy.mockRestore() }
  })

  it('stop while offscreen history reloads preserves history without accepting the notification', async () => {
    const f = await setupNotification()
    try {
      const original = createUserMessage('Full original history')
      let resolve!: (messages: import('@/agent/message-types').Message[]) => void
      findHistoryMock.mockImplementationOnce(() => new Promise(done => { resolve = done }))
      useConversationStore.setState(state => ({ conversations: state.conversations.map(c => c.id === f.conv.id ? { ...c, messages: [], messagesLoaded: false } : c) }))
      const { appendSubagentNotification } = await import('@/store/conversation.store.sqlite')
      let eligible = true
      const accepting = appendSubagentNotification(f.conv.id, { id: 'cancelled', role: 'user', content: 'Done', timestamp: 2 }, () => eligible)
      await vi.waitFor(() => expect(resolve).toBeDefined())
      eligible = false; resolve([original])
      expect(await accepting).toBe(false)
      expect(useConversationStore.getState().conversations.find(c => c.id === f.conv.id)?.messages.map(m => m.id)).toEqual([original.id])
    } finally { f.spy.mockRestore() }
  })

  it('an already running conversation queues without claiming or handling the notification', async () => {
    const f = await setupNotification()
    try {
      useConversationStore.setState(state => ({ conversations: state.conversations.map(c => c.id === f.conv.id ? { ...c, status: 'running' as const, activeRunId: 'owner' } : c) }))
      await f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
      expect(f.claim).not.toHaveBeenCalled(); expect(f.handled).not.toHaveBeenCalled(); expect(f.row.status).toBe('delivered')
    } finally { f.spy.mockRestore() }
  })

  it('automatic dispatch racing a parent parks without creating a continuation queue trigger', async () => {
    const f = await setupNotification()
    try {
      const deferred = vi.spyOn(f.coordinator, 'deferDispatch')
      useConversationStore.setState(state => ({ conversations: state.conversations.map(c => c.id === f.conv.id ? { ...c, status: 'running' as const, activeRunId: 'owner' } : c) }))
      const depth = useConversationRuntimeStore.getState().getQueueDepth(f.conv.id)
      await f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null, null, { background: true, subagentContinuation: true })
      expect(f.claim).not.toHaveBeenCalled()
      expect(deferred).toHaveBeenCalledWith(f.conv.id)
      expect(useConversationRuntimeStore.getState().getQueueDepth(f.conv.id)).toBe(depth)
    } finally { f.spy.mockRestore() }
  })

  it('provider onError followed by a resolved loop promise leaves the notification failed', async () => {
    const f = await setupNotification()
    try {
      resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })
      loopRunMock.mockImplementationOnce(async (_messages, callbacks) => { callbacks.onError(new Error('Provider failed')); return [] })
      await f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
      expect(f.claim).toHaveBeenCalledTimes(1); expect(f.handled).not.toHaveBeenCalled(); expect(f.row.status).toBe('error')
    } finally { f.spy.mockRestore() }
  })

  it('joins fire-and-forget onComplete finalization before releasing dispatch or acknowledging input', async () => {
    const { isConversationDispatchBusy } = await import('@/store/conversation-agent-run')
    const f = await setupNotification(isConversationDispatchBusy)
    try {
      resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })
      const { generateFollowUp } = await import('@/agent/follow-up-generator')
      let release!: (text: string) => void
      vi.mocked(generateFollowUp).mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
      loopRunMock.mockImplementationOnce(async (_messages, callbacks) => {
        void callbacks.onComplete([])
        return []
      })
      const loopCount = loopRunMock.mock.calls.length
      let settled = false
      const run = f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
      void run.then(() => { settled = true })
      await vi.waitFor(() => expect(release).toBeDefined())
      expect(useConversationStore.getState().conversations.find(c => c.id === f.conv.id)?.status).toBe('idle')
      expect(isConversationDispatchBusy(f.conv.id)).toBe(true)
      expect(settled).toBe(false)
      expect(f.handled).not.toHaveBeenCalled()
      f.queueReady(); await f.coordinator.flush(f.conv.id)
      expect(f.dispatch).not.toHaveBeenCalled()
      expect(loopRunMock.mock.calls.length).toBe(loopCount + 1)
      release(''); await run
      expect(isConversationDispatchBusy(f.conv.id)).toBe(false)
      await f.coordinator.flush(f.conv.id)
      expect(f.dispatch).toHaveBeenCalledTimes(1)
    } finally { f.spy.mockRestore() }
  })

  it('automatic dispatch does not run a model when another owner already claimed its notification', async () => {
    const f = await setupNotification()
    try {
      f.row.status = 'handled'
      const before = createLLMProviderMock.mock.calls.length
      await f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null, null, { background: true, subagentContinuation: true })
      expect(createLLMProviderMock.mock.calls.length).toBe(before)
      expect(useConversationStore.getState().conversations.find(c => c.id === f.conv.id)?.status).toBe('idle')
    } finally { f.spy.mockRestore() }
  })

  it('a stopped loop resolving late cannot unregister the newer owning loop', async () => {
    const f = await setupNotification()
    try {
      resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })
      let finishOld!: (messages: never[]) => void, finishNew!: (messages: never[]) => void
      loopRunMock.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      const oldRun = f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
      await vi.waitFor(() => expect(finishOld).toBeDefined())
      f.store.cancelAgent(f.conv.id)
      loopRunMock.mockImplementationOnce(() => new Promise(resolve => { finishNew = resolve }))
      const newRun = f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
      await vi.waitFor(() => expect(finishNew).toBeDefined())
      const { getAgentLoop } = await import('@/store/agent-loop-registry')
      const newLoop = getAgentLoop(f.conv.id)
      finishOld([]); await oldRun
      expect(getAgentLoop(f.conv.id)).toBe(newLoop)
      finishNew([]); await newRun
    } finally { f.spy.mockRestore() }
  })

  it('a stopped provider failing after a newer run completes cannot replace its success state', async () => {
    const f = await setupNotification()
    try {
      resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })
      let failOld!: (error: Error) => void
      loopRunMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { failOld = reject }))
      const oldRun = f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
      await vi.waitFor(() => expect(failOld).toBeDefined())
      f.store.cancelAgent(f.conv.id)
      await f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
      failOld(new Error('Late stopped provider failure')); await oldRun
      expect(useConversationStore.getState().conversations.find(c => c.id === f.conv.id)?.status).toBe('idle')
    } finally { f.spy.mockRestore() }
  })

  it('keeps a saved provider and model when global settings change before automatic continuation', async () => {
    const f = await setupNotification()
    const previousConfig = mockSettingsState.getEffectiveProviderConfig.getMockImplementation()!
    const previousProvider = mockSettingsState.providerType, previousModel = mockSettingsState.modelName
    try {
      resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })
      mockSettingsState.providerType = 'openai'; mockSettingsState.modelName = 'new-model'
      mockSettingsState.getEffectiveProviderConfig.mockImplementation((override) => override === 'llm-gateway'
        ? { apiKeyProviderKey: '__llm_gateway_token__', baseUrl: 'https://original.example/v1', modelName: 'gateway-default' }
        : { apiKeyProviderKey: 'openai', baseUrl: 'https://new.example/v1', modelName: 'new-model' })
      await f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'saved-model', 1024, null, null, { background: true, subagentContinuation: true })
      expect(createLLMProviderMock).toHaveBeenLastCalledWith(expect.objectContaining({ providerType: 'llm-gateway', model: 'saved-model', baseUrl: 'https://original.example/v1', apiKey: 'validated-token' }))
      expect(mockSettingsState.getEffectiveProviderConfig).toHaveBeenCalledWith('llm-gateway')
    } finally {
      mockSettingsState.providerType = previousProvider; mockSettingsState.modelName = previousModel
      mockSettingsState.getEffectiveProviderConfig.mockImplementation(previousConfig); f.spy.mockRestore()
    }
  })

  it('settles a claimed missing-key failure and accepts immediate explicit retry without reload', async () => {
    const f = await setupNotification()
    try {
      f.row.continuation = { parentRunId: 'origin', providerType: 'openai', modelName: 'saved-model', maxTokens: 1024 }
      loadCredentialMock.mockResolvedValue(null)
      await f.store.runAgent(f.conv.id, 'openai', 'saved-model', 1024, null, null, { background: true, subagentContinuation: true })
      expect(f.claim).toHaveBeenCalledTimes(1); expect(f.row.status).toBe('error')
      await f.coordinator.retry(f.conv.id)
      expect(f.dispatch).toHaveBeenCalledTimes(1); expect(f.row.status).toBe('delivered')
    } finally { f.spy.mockRestore() }
  })

  it('an internally caught authentication failure never handles accepted input', async () => {
    const f = await setupNotification()
    try {
      resolveCredentialMock.mockResolvedValue({ ok: false, kind: 'missing' })
      await f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
      expect(f.claim).toHaveBeenCalledTimes(1); expect(f.handled).not.toHaveBeenCalled(); expect(f.row.status).toBe('error')
    } finally { f.spy.mockRestore() }
  })

  it('ordinary manual retry claims accepted input and acknowledges its actual successful run', async () => {
    const f = await setupNotification()
    try {
      f.row.status = 'error'
      resolveCredentialMock.mockResolvedValue({ ok: true, accessToken: 'validated-token' })
      await f.store.runAgent(f.conv.id, 'llm-gateway' as never, 'gateway-model', 1024, null)
      expect(f.claim).toHaveBeenCalledTimes(1); expect(f.handled).toHaveBeenCalledWith(f.row.id, f.row.parentRunId); expect(f.row.status).toBe('handled')
    } finally { f.spy.mockRestore() }
  })
})
