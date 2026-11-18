/**
 * Shared doubles for the app-tools tests.
 *
 * The deps are narrow projections of the real contracts (`Pick<>` of store
 * state, projections of the repository/runtime members app-tools reads), so
 * each double only supplies what app-tools actually uses — with the real
 * shape, so a contract change fails typecheck here instead of silently
 * drifting from the app.
 */

import { vi } from 'vitest'
import type {
  AppToolDeps,
  AppToolRuntimeStore,
  AppToolSettingsStore,
} from '../handlers'
import type { Conversation } from '@/agent/message-types'

/** Runtime-store double: the queue/progress members app-tools reads. */
export function makeRuntimeStore(overrides: Partial<AppToolRuntimeStore> = {}): AppToolRuntimeStore {
  return {
    runtimes: new Map(),
    pendingMessageQueues: new Map(),
    enqueueMessage: vi.fn(() => ({ enqueued: true, position: 1 })),
    removeQueuedMessage: vi.fn(),
    getQueuedMessage: vi.fn(() => undefined),
    ...overrides,
  }
}

/** Minimal complete Conversation — the store contract requires every field. */
export function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c_1',
    title: 'Fix login timeout',
    messages: [
      { id: 'm1', role: 'user', content: 'fix it', timestamp: 90 },
      { id: 'm2', role: 'assistant', content: 'done, changed src/a.ts', timestamp: 95 },
    ],
    createdAt: 1,
    updatedAt: 100,
    status: 'idle',
    agentMode: 'act',
    streamingContent: 'partial output...',
    streamingReasoning: '',
    isReasoningStreaming: false,
    completedReasoning: null,
    isContentStreaming: false,
    completedContent: null,
    currentToolCall: { id: 't2', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/b.ts"}' } },
    activeToolCalls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
    streamingToolArgs: '',
    error: null,
    ...overrides,
  }
}

export function makeDeps(overrides: Partial<AppToolDeps> = {}): AppToolDeps {
  const conversations: Conversation[] = [makeConversation()]
  const settings: AppToolSettingsStore = {
    hasApiKey: true,
    hasApiKeyLoaded: false,
    providerType: 'codex-oauth',
    modelName: 'gpt-5.4',
    maxTokens: 32000,
    customProviders: [],
    pinnedModelsByProvider: { 'codex-oauth': ['gpt-5.4'] } as Record<string, string[]>,
    switchProviderAndModel: vi.fn(),
    pinModel: vi.fn((provider: string, model: string) => {
      const list = settings.pinnedModelsByProvider[provider] ?? (settings.pinnedModelsByProvider[provider] = [])
      if (!list.includes(model)) list.push(model)
    }),
    unpinModel: vi.fn((provider: string, model: string) => {
      const list = settings.pinnedModelsByProvider[provider] ?? []
      settings.pinnedModelsByProvider[provider] = list.filter((m: string) => m !== model)
    }),
  }
  const agentStore = { directoryHandle: null }
  const manager = {
    getWorkspace: async () => ({
      readFile: async () => ({ content: 'file content', metadata: { size: 12 } }),
      writeFile: async () => {},
      scanFiles: async () => new Map([['src/a.ts', { path: 'src/a.ts', mtime: 1, size: 5 }]]),
    }),
  }
  const conversationStore = {
    conversations,
    loaded: true,
    updateTitle: vi.fn((id: string, title: string) => {
      const c = conversations.find((x) => x.id === id)
      if (c) c.title = title
    }),
    isConversationRunning: () => false,
    updateMessages: vi.fn(),
    runAgent: vi.fn(async () => {}),
    cancelAgent: vi.fn(),
    createNew: vi.fn(() => makeConversation({ id: 'c_new', title: 't', messages: [] })),
    deleteConversation: vi.fn(async () => {}),
  }
  return {
    getConversationStore: () => conversationStore,
    getSettingsStore: () => ({ ...settings }),
    getAgentStore: () => agentStore,
    createProject: async (name) => ({ id: 'p_new', name }),
    getWorkspaceManager: async () => manager,
    ensureConversationWorkspace: vi.fn(async () => ({ projectId: 'p_1' })),
    resolveConversationTarget: vi.fn(async () => ({
      projectId: 'p_1', projectName: 'P1', workspaceId: 'c_1', agentId: 'default',
      agents: [{ id: 'default', name: 'Default' }, { id: 'resource-loop', name: 'Resource Loop' }],
    })),
    setConversationAgent: vi.fn(),
    getProjectRepository: () => ({
      findAllProjects: async () => [{ id: 'p_1', name: 'P1' }],
      findProjectStats: async () => [{ projectId: 'p_1', workspaceCount: 1, lastWorkspaceAccessAt: 100 }],
    }),
    getWorkspaceRepository: () => ({
      findWorkspacesByProject: async () => [{ id: 'c_1', projectId: 'p_1' }],
      findAllWorkspaces: async () => [{ id: 'c_1', projectId: 'p_1' }],
    }),
    getMessageRepository: () => ({
      findByConversation: async () => conversations[0].messages,
      insert: vi.fn(async () => {}),
    }),
    searchConversations: async (args) => JSON.stringify({ results: [{ conversationId: 'c_1', title: 'Fix login timeout' }], args }),
    getRuntimeStore: () => makeRuntimeStore(),
    getFSOverlayRepository: () => ({
      listSnapshotFiles: async () => [{ path: 'src/a.ts' }],
    }),
    validatePath: (path: string) => {
      if (!path || !path.trim()) throw new Error('empty path')
      if (path.split('/').some((seg) => seg === '..' || seg === '.')) {
        throw new Error(`Invalid path: ${path}`)
      }
      // mirror real contract: requires leading '/' then strips it
      if (!path.startsWith('/')) throw new Error('must start with /')
      return path.replace(/^\/+/, '')
    },
    wait: async () => {},
    ...overrides,
  }
}
