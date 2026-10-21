/**
 * App-tools handler unit tests.
 *
 * handlers.ts is fully dependency-injected (initAppToolDeps) so these tests
 * exercise the real handler logic against mock stores/repositories.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handlers, initAppToolDeps, type AppToolDeps } from '../handlers'

function makeDeps(overrides: Partial<AppToolDeps> = {}): AppToolDeps {
  const conversations: any[] = [
    {
      id: 'c_1',
      title: 'Fix login timeout',
      projectId: 'p_1',
      status: 'idle',
      updatedAt: 100,
      messages: [
        { role: 'user', content: 'fix it', messageId: 'm1', timestamp: 90 },
        { role: 'assistant', content: 'done, changed src/a.ts', messageId: 'm2', timestamp: 95 },
      ],
      activeToolCalls: [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      currentToolCall: { id: 't2', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/b.ts"}' } },
      streamingContent: 'partial output...',
      runChangesMeta: { snapshotId: 'snap_1' },
    },
  ]
  const settings = {
    hasApiKey: true,
    providerType: 'codex-oauth',
    modelName: 'gpt-5.4',
    maxTokens: 32000,
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
    getAllWorkspaces: () => [{ workspaceId: 'c_1', projectId: 'p_1' }],
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
      const c = conversations.find((x: any) => x.id === id)
      if (c) c.title = title
    }),
    isConversationRunning: () => false,
    enqueueMessage: vi.fn(() => ({ enqueued: true })),
    updateMessages: vi.fn(),
    runAgent: vi.fn(async () => {}),
    cancelAgent: vi.fn(),
    createNew: vi.fn(() => ({ id: 'c_new', title: 't' })),
    setActive: vi.fn(),
  }
  return {
    getConversationStore: () => conversationStore,
    getSettingsStore: () => ({ ...settings }),
    getAgentStore: () => agentStore,
    getWorkspaceManager: async () => manager,
    getProjectRepository: () => ({
      findAllProjects: async () => [{ id: 'p_1', name: 'P1' }],
      findProjectStats: async () => [{ projectId: 'p_1', workspaceCount: 1, lastWorkspaceAccessAt: 100 }],
      createProject: async (input: any) => ({ id: 'p_new', name: input.name }),
    }),
    getMessageRepository: () => ({
      findByConversation: async () => conversations[0].messages,
    }),
    searchConversations: async (args) => JSON.stringify({ results: [{ conversationId: 'c_1', title: 'Fix login timeout' }], args }),
    getRuntimeStore: () => ({ runtimes: new Map() }),
    getFSOverlayRepository: () => ({
      listSnapshotFiles: async () => [{ path: 'src/a.ts', opType: 'upsert', createdAt: 1 }],
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

describe('app-tools handlers', () => {
  let deps: AppToolDeps
  beforeEach(() => {
    deps = makeDeps()
    initAppToolDeps(deps)
  })

  it('list_projects merges projects with stats', async () => {
    const r = JSON.parse((await handlers.list_projects({})).content)
    expect(r.projects).toHaveLength(1)
    expect(r.projects[0]).toMatchObject({ id: 'p_1', workspaceCount: 1 })
  })

  it('create_project rejects empty name', async () => {
    const r = JSON.parse((await handlers.create_project({ name: '  ' })).content)
    expect(r.error).toMatch(/name is required/)
  })

  it('create_project creates', async () => {
    const r = JSON.parse((await handlers.create_project({ name: 'X' })).content)
    expect(r.project.name).toBe('X')
  })

  it('list_conversations filters by folderId via workspace lookup', async () => {
    vi.doMock('@/store/folder-access.store', () => ({
      useFolderAccessStore: { getState: () => ({ records: { 'p_1:p_1': { projectId: 'p_1', rootName: 'p_1' } } }) },
    }))
    const r = JSON.parse((await handlers.list_conversations({ folderId: 'p_1:p_1' })).content)
    expect(r.conversations.map((c: any) => c.id)).toContain('c_1')
    vi.doUnmock('@/store/folder-access.store')
  })

  it('rename_conversation validates and renames', async () => {
    const bad = JSON.parse((await handlers.rename_conversation({ conversationId: 'c_1', title: '  ' })).content)
    expect(bad.error).toMatch(/title is required/)
    const missing = JSON.parse((await handlers.rename_conversation({ conversationId: 'c_x', title: 'T' })).content)
    expect(missing.error).toMatch(/not found/)
    const r = JSON.parse((await handlers.rename_conversation({ conversationId: 'c_1', title: '  New title  ' })).content)
    expect(r).toMatchObject({ conversationId: 'c_1', title: 'New title' })
  })

  it('get_messages paginates newest-first', async () => {
    const r = JSON.parse((await handlers.get_messages({ conversationId: 'c_1' })).content)
    expect(r.messages).toHaveLength(2)
    // page 1 = the newest slice; within the slice order is chronological
    expect(r.messages[r.messages.length - 1].role).toBe('assistant')
    expect(r.hasMore).toBe(false)
  })

  it('get_messages filters internal records before pagination and preserves synthetic identity', async () => {
    deps.getConversationStore().conversations[0].messages.push(
      { role: 'user', content: 'PRIVATE_STATE', kind: 'context_update', timestamp: 96 },
      { role: 'user', content: 'delegated task', delegationNote: { fromAgentId: 'a', task: 'task' }, timestamp: 97 },
      { role: 'assistant', content: 'change card', kind: 'run_changes', timestamp: 98 },
    )
    const r = JSON.parse((await handlers.get_messages({ conversationId: 'c_1', pageSize: 1 })).content)
    expect(r.totalMessages).toBe(3)
    expect(r.messages).toHaveLength(1)
    expect(r.messages[0]).toMatchObject({ recordType: 'agent_input', content: 'delegated task' })
    expect(r.hasMore).toBe(true)
    expect(JSON.stringify(r)).not.toContain('PRIVATE_STATE')
  })

  it('send_message returns started and fires runAgent', async () => {
    const r = JSON.parse(
      (await handlers.send_message({ conversationId: 'c_1', content: 'do it' })).content,
    )
    expect(r.status).toBe('started')
    expect(deps.getConversationStore().runAgent).toHaveBeenCalled()
  })

  it('send_message errors without api key', async () => {
    initAppToolDeps({
      ...deps,
      getSettingsStore: () => ({
        ...deps.getSettingsStore(),
        hasApiKey: false,
        hasApiKeyLoaded: true,
      }),
    })
    const r = JSON.parse((await handlers.send_message({ conversationId: 'c_1', content: 'x' })).content)
    expect(r.error).toMatch(/No API key/)
  })

  it('send_message queues when conversation is running', async () => {
    const d2 = makeDeps()
    initAppToolDeps({
      ...d2,
      getRuntimeStore: () => ({
        runtimes: new Map(),
        enqueueMessage: vi.fn(() => ({ enqueued: true, position: 1 })),
      }),
      getConversationStore: () => {
        const s = d2.getConversationStore()
        s.isConversationRunning = () => true
        return s
      },
    })
    const r = JSON.parse((await handlers.send_message({ conversationId: 'c_1', content: 'x' })).content)
    expect(r.status).toBe('queued')
  })

  it('send_message unknown conversation errors', async () => {
    const r = JSON.parse((await handlers.send_message({ conversationId: 'nope', content: 'x' })).content)
    expect(r.error).toMatch(/not found/i)
  })

  it('get_run_status errors on unknown run id', async () => {
    const r = JSON.parse((await handlers.get_run_status({ runId: 'ghost' })).content)
    // unregistered runId → error
    expect(r.error).toMatch(/Unknown runId/)
  })

  it('get_run_progress errors on unknown run id', async () => {
    const r = JSON.parse((await handlers.get_run_progress({ runId: 'ghost' })).content)
    expect(r.error).toMatch(/Unknown runId/)
  })

  it('cancel_run errors on unknown run id', async () => {
    const r = JSON.parse((await handlers.cancel_run({ runId: 'ghost' })).content)
    expect(r.error).toMatch(/Unknown runId/)
  })

  it('read_folder_file reads through workspace runtime', async () => {
    const r = JSON.parse((await handlers.read_folder_file({ conversationId: 'c_1', path: 'src/a.ts' })).content)
    expect(r.content).toBe('file content')
  })

  it('read_folder_file errors when no workspace', async () => {
    initAppToolDeps({
      ...deps,
      getRuntimeStore: () => ({ runtimes: new Map() }),
      getWorkspaceManager: async () => ({ getWorkspace: async () => undefined }),
    })
    const r = JSON.parse((await handlers.read_folder_file({ conversationId: 'ghost', path: 'x' })).content)
    expect(r.error).toMatch(/No workspace/)
  })

  it('write_folder_file writes', async () => {
    const r = JSON.parse((await handlers.write_folder_file({ conversationId: 'c_1', path: 'out.md', content: 'hi' })).content)
    expect(r.written).toBe(true)
  })

  it('list_folder_files walks scan results', async () => {
    const r = JSON.parse((await handlers.list_folder_files({ conversationId: 'c_1', depth: 3 })).content)
    expect(r.files).toEqual([{ path: 'src/a.ts', type: 'file', size: 5 }])
  })

  it('list_providers returns providers + current', async () => {
    const r = JSON.parse((await handlers.list_providers({})).content)
    expect(r.current).toEqual({ providerId: 'codex-oauth', model: 'gpt-5.4' })
    expect(r.providers.length).toBeGreaterThan(0)
  })

  it('list_models returns catalog with pinned flags', async () => {
    const r = JSON.parse((await handlers.list_models({ providerId: 'codex-oauth' })).content)
    expect(Array.isArray(r.models)).toBe(true)
    const pinnedModel = r.models.find((m: any) => m.id === 'gpt-5.4')
    if (pinnedModel) expect(pinnedModel.pinned).toBe(true)
    expect(['dynamic', 'static']).toContain(r.source)
  })

  it('add/remove pinned model delegates to settings', async () => {
    const a = JSON.parse((await handlers.add_pinned_model({ providerId: 'codex-oauth', modelId: 'm2' })).content)
    expect(a.pinned).toContain('m2')
    const rm = JSON.parse((await handlers.remove_pinned_model({ providerId: 'codex-oauth', modelId: 'm2' })).content)
    expect(rm.pinned).not.toContain('m2')
  })

  it('set_default_model delegates to switchProviderAndModel', async () => {
    const r = JSON.parse((await handlers.set_default_model({ providerId: 'deepseek', modelId: 'deepseek-chat' })).content)
    expect(r).toEqual({ providerId: 'deepseek', modelId: 'deepseek-chat' })
  })
})
