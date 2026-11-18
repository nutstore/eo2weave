/**
 * App-tools handler unit tests.
 *
 * handlers.ts is fully dependency-injected (initAppToolDeps) so these tests
 * exercise the real handler logic against mock stores/repositories.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createConversation, createUserMessage } from '@/agent/message-types'
import type { Workspace } from '@/sqlite/repositories/workspace.repository'
import { handlers, initAppToolDeps, type AppToolDeps } from '../handlers'

type RuntimeStoreDep = ReturnType<AppToolDeps['getRuntimeStore']>

// Controlled model cache: the handler imports the store dynamically, so this
// mock decides exactly which entry (keyed / unkeyed / failed) it observes.
const modelCache = vi.hoisted(() => new Map<string, unknown>())
vi.mock('@/agent/providers/model-store', () => ({
  getCachedModelsResult: (providerType: string, providerKey?: string) =>
    modelCache.get(providerKey ? `${providerType}:${providerKey}` : providerType) ?? null,
}))

/** Full Workspace row — the repository returns real rows, not partial ones. */
function makeWorkspace(overrides: Partial<Workspace> & { id: string }): Workspace {
  return {
    rootDirectory: '/tmp',
    name: overrides.id,
    status: 'active',
    cacheSize: 0,
    pendingCount: 0,
    modifiedFiles: 0,
    createdAt: 0,
    lastAccessedAt: 0,
    ...overrides,
  }
}

function makeRuntimeStore(overrides: Partial<RuntimeStoreDep> = {}): RuntimeStoreDep {
  return {
    runtimes: new Map(),
    pendingMessageQueues: new Map(),
    enqueueMessage: vi.fn(() => ({ enqueued: true, position: 1 })),
    getQueuedMessage: vi.fn(() => undefined),
    removeQueuedMessage: vi.fn(),
    ...overrides,
  }
}

function makeDeps(overrides: Partial<AppToolDeps> = {}): AppToolDeps {
  const conversation = createConversation('Fix login timeout', { kind: 'project' })
  conversation.id = 'c_1'
  conversation.updatedAt = 100
  conversation.messages = [
    createUserMessage('fix it'),
    { role: 'assistant', content: 'done, changed src/a.ts', id: 'm2', timestamp: 95 } as never,
  ]
  conversation.activeToolCalls = [{ id: 't1', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
  conversation.currentToolCall = { id: 't2', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/b.ts"}' } }
  conversation.streamingContent = 'partial output...'
  const conversations = [conversation]
  const settings = {
    hasApiKey: true,
    hasApiKeyLoaded: true,
    customProviders: [],
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
    deleteConversation: vi.fn(async () => {}),
    setActive: vi.fn(),
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
      findWorkspacesByProject: async () => [makeWorkspace({ id: 'c_1', projectId: 'p_1' })],
      findAllWorkspaces: async () => [makeWorkspace({ id: 'c_1', projectId: 'p_1' })],
    }),
    getMessageRepository: () => ({
      findByConversation: async () => conversations[0].messages,
      insert: vi.fn(async () => {}),
    }),
    searchConversations: async (args) => JSON.stringify({ results: [{ conversationId: 'c_1', title: 'Fix login timeout' }], args }),
    getRuntimeStore: () => makeRuntimeStore(),
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

  it('creates projects through the app store so they are initialized and visible', async () => {
    const createProject = vi.fn(async (name: string) => ({ id: 'p_new', name }))
    initAppToolDeps({ ...deps, createProject } )
    const result = JSON.parse((await handlers.create_project({ name: ' X ' })).content)
    expect(createProject).toHaveBeenCalledWith('X')
    expect(result.project).toEqual({ id: 'p_new', name: 'X' })
  })

  it('does not report a successful project when initialization fails', async () => {
    initAppToolDeps({ ...deps, createProject: vi.fn(async () => null) } )
    const result = JSON.parse((await handlers.create_project({ name: 'X' })).content)
    expect(result.error).toBeTruthy()
    expect(result.project).toBeUndefined()
  })

  it('create_conversation waits for workspace readiness without activating the conversation', async () => {
    let resolve!: (value: { projectId: string }) => void
    const ready = new Promise<{ projectId: string }>((r) => { resolve = r })
    const ensure = vi.fn(() => ready)
    initAppToolDeps({ ...deps, ensureConversationWorkspace: ensure })
    let finished = false
    const creating = handlers.create_conversation({ title: 'Portal task' }).then((r) => {
      finished = true
      return JSON.parse(r.content)
    })
    await Promise.resolve()
    expect(finished).toBe(false)
    expect(deps.getConversationStore().createNew).toHaveBeenCalledWith('Portal task', { activate: false })
    expect(ensure).toHaveBeenCalledWith('c_new', 't', 'p_1')
    resolve({ projectId: 'p_1' })
    expect(await creating).toEqual({ conversation: { id: 'c_new', title: 't', workspaceId: 'c_new', projectId: 'p_1', agentId: 'default' } })
    expect(deps.setConversationAgent).toHaveBeenCalledWith('c_new', 'default')
  })

  it('create_conversation does not report success when workspace initialization fails', async () => {
    initAppToolDeps({
      ...deps,
      ensureConversationWorkspace: vi.fn(async () => { throw new Error('No open project') }),
    })
    await expect(handlers.create_conversation({})).rejects.toThrow('No open project')
  })

  it('create_conversation rolls back the orphan conversation when setup fails', async () => {
    initAppToolDeps({
      ...deps,
      ensureConversationWorkspace: vi.fn(async () => { throw new Error('workspace setup exploded') }),
    })
    await expect(handlers.create_conversation({ title: 'Doomed' })).rejects.toThrow('workspace setup exploded')
    expect(deps.getConversationStore().createNew).toHaveBeenCalledTimes(1)
    expect(deps.getConversationStore().deleteConversation).toHaveBeenCalledWith('c_new')
  })

  it('create_conversation still surfaces the original error when the rollback itself fails', async () => {
    initAppToolDeps({
      ...deps,
      ensureConversationWorkspace: vi.fn(async () => { throw new Error('setup failed first') }),
    })
    deps.getConversationStore().deleteConversation = vi.fn(async () => { throw new Error('rollback failed too') })
    await expect(handlers.create_conversation({})).rejects.toThrow('setup failed first')
    expect(deps.getConversationStore().deleteConversation).toHaveBeenCalledWith('c_new')
  })

  it('get_workspace_context queries the source without creating or activating a conversation', async () => {
    const result = JSON.parse((await handlers.get_workspace_context({ workspaceId: 'c_1' })).content)
    expect(deps.resolveConversationTarget).toHaveBeenCalledWith({ workspaceId: 'c_1' })
    expect(result.agents.map((a: { id: string }) => a.id)).toContain('resource-loop')
    expect(deps.getConversationStore().createNew).not.toHaveBeenCalled()
  })

  it('create_conversation accepts explicit context and remembers the canonical Agent ID', async () => {
    const result = JSON.parse((await handlers.create_conversation({ workspaceId: 'c_1', projectId: 'p_1', agentId: 'RESOURCE-LOOP' })).content)
    expect(deps.resolveConversationTarget).toHaveBeenCalledWith({ workspaceId: 'c_1', projectId: 'p_1' })
    expect(result.conversation).toMatchObject({ projectId: 'p_1', agentId: 'resource-loop' })
    expect(deps.setConversationAgent).toHaveBeenCalledWith('c_new', 'resource-loop')
  })

  it('rejects unknown Agents and invalid contexts before creating an orphan conversation', async () => {
    const result = JSON.parse((await handlers.create_conversation({ agentId: 'other-project-agent' })).content)
    expect(result.error).toMatch(/Agent not found/)
    expect(deps.getConversationStore().createNew).not.toHaveBeenCalled()
    await expect(handlers.create_conversation({ workspaceId: '  ' })).rejects.toThrow('workspaceId')
    expect(deps.getConversationStore().createNew).not.toHaveBeenCalled()
  })

  it('list_conversations filters by folderId via workspace lookup', async () => {
    vi.doMock('@/store/folder-access.store', () => ({
      useFolderAccessStore: { getState: () => ({ records: { 'p_1:p_1': { projectId: 'p_1', rootName: 'p_1' } } }) },
    }))
    const r = JSON.parse((await handlers.list_conversations({ folderId: 'p_1:p_1' })).content)
    expect(r.conversations.map((c: any) => c.id)).toContain('c_1')
    vi.doUnmock('@/store/folder-access.store')
  })

  it('filters conversations by project ID, excluding standalone chats and other projects', async () => {
    const store = deps.getConversationStore()
    const other = createConversation('Other project', { kind: 'project' })
    other.id = 'c_2'
    other.updatedAt = 200
    const direct = createConversation('Standalone', { kind: 'direct' })
    direct.id = 'c_direct'
    direct.updatedAt = 300
    store.conversations.push(other, direct)
    initAppToolDeps({ ...deps, getWorkspaceRepository: () => ({
      findWorkspacesByProject: vi.fn(async () => [makeWorkspace({ id: 'c_1' }), makeWorkspace({ id: 'c_direct' })]),
      findAllWorkspaces: vi.fn(async () => []),
    }) })
    const result = JSON.parse((await handlers.list_conversations({ projectId: 'p_1' })).content)
    expect(result.conversations.map((c: any) => c.id)).toEqual(['c_1'])
  })

  it('returns conversation kind and project ID without exposing standalone host projects', async () => {
    const direct = createConversation('Standalone', { kind: 'direct' })
    direct.id = 'c_direct'
    direct.updatedAt = 300
    deps.getConversationStore().conversations.push(direct)
    initAppToolDeps({ ...deps, getWorkspaceRepository: () => ({
      findAllWorkspaces: async () => [
        makeWorkspace({ id: 'c_1', projectId: 'p_1' }),
        makeWorkspace({ id: 'c_direct', projectId: 'p_1' }),
      ],
      findWorkspacesByProject: async () => [],
    }) })
    const result = JSON.parse((await handlers.list_conversations({})).content)
    expect(result.conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'c_1', kind: 'project', projectId: 'p_1' }),
      expect.objectContaining({ id: 'c_direct', kind: 'direct', projectId: null }),
    ]))
  })

  it('passes project ID to the search executor as an ID filter', async () => {
    const search = vi.fn(async () => '{}')
    initAppToolDeps({ ...deps, searchConversations: search })
    await handlers.search_conversations({ query: 'login', projectId: 'p_1' })
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: 'login', project_id: 'p_1' }))
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
      { id: 'm3', role: 'user', content: 'PRIVATE_STATE', kind: 'context_update', timestamp: 96 },
      { id: 'm4', role: 'user', content: 'delegated task', delegationNote: { fromAgentId: 'a', task: 'task' }, timestamp: 97 },
      { id: 'm5', role: 'assistant', content: 'change card', kind: 'run_changes', timestamp: 98 },
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

  it.each(['unknown', 'temporary'] as const)('lets a %s gateway credential reach dispatch for retry', async (kind) => {
    const { credentialRegistry } = await import('@/agent/providers/credential-state')
    credentialRegistry.commit('llm-gateway', { kind })
    try {
      initAppToolDeps({ ...deps, getSettingsStore: () => ({
        ...deps.getSettingsStore(), providerType: 'llm-gateway', hasApiKey: false, hasApiKeyLoaded: true,
      }) })
      const result = JSON.parse((await handlers.send_message({ conversationId: 'c_1', content: 'retry' })).content)
      expect(result.status).toBe('started')
    } finally { credentialRegistry.reset() }
  })

  it('send_message errors without api key', async () => {
    const { credentialRegistry } = await import('@/agent/providers/credential-state')
    credentialRegistry.commit('codex-oauth', { kind: 'missing' })
    try {
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
    } finally { credentialRegistry.reset() }
  })

  it('send_message queues when conversation is running', async () => {
    const d2 = makeDeps()
    initAppToolDeps({
      ...d2,
      getRuntimeStore: () => makeRuntimeStore(),
      getConversationStore: () => {
        const s = d2.getConversationStore()
        s.isConversationRunning = () => true
        return s
      },
    })
    const r = JSON.parse((await handlers.send_message({ conversationId: 'c_1', content: 'x' })).content)
    expect(r.status).toBe('queued')
  })

  it('send_message does not finalize a claim-overlap run while its trigger is queued (#170 round 2)', async () => {
    // Claim-overlap: the conversation is NOT yet running when send_message
    // enters (the owning dispatch is still inside its start claim), runAgent
    // resolves immediately (it queued a rerun trigger and returned), and the
    // owner's follow-up keeps the conversation running afterwards.
    let pendingTrigger = true
    let runningNow = false
    const d2 = makeDeps()
    initAppToolDeps({
      ...d2,
      getRuntimeStore: () => makeRuntimeStore({
        pendingMessageQueues: new Map([['c_1', [{ rerunOnly: true, text: '', enqueuedAt: 0 }].filter(() => pendingTrigger)]]),
        getQueuedMessage: vi.fn(() => (pendingTrigger ? { rerunOnly: true, text: '', enqueuedAt: 0 } : undefined)),
      }),
      getConversationStore: () => {
        const s = d2.getConversationStore()
        s.isConversationRunning = () => runningNow
        s.runAgent = vi.fn(async () => {
          // Claim-overlap shape: the overlap resolution is not terminal —
          // flip the conversation to "the owner's follow-up is running".
          runningNow = true
        })
        return s
      },
    })
    const r = JSON.parse(
      (await handlers.send_message({ conversationId: 'c_1', content: 'overlap' })).content,
    )
    expect(r.status).toBe('started')

    // The runAgent promise resolved (not terminal for the overlap) — the
    // record must NOT read completed while the follow-up has not run.
    const status = JSON.parse((await handlers.get_run_status({ runId: r.runId })).content)
    expect(['queued', 'running']).toContain(status.status)
    expect(status.status).not.toBe('completed')

    // Once the trigger is dequeued and the conversation goes idle, the record
    // finalizes from the store.
    pendingTrigger = false
    runningNow = false
    const done = JSON.parse((await handlers.get_run_status({ runId: r.runId })).content)
    expect(done.status).toBe('completed')
  })

  it('wait=true returns queued for a parked claim-overlap run instead of spinning to timeout (#170 round 2)', async () => {
    let runningNow = false
    const d2 = makeDeps()
    initAppToolDeps({
      ...d2,
      getRuntimeStore: () => makeRuntimeStore({
        pendingMessageQueues: new Map([['c_1', [{ rerunOnly: true, text: '', enqueuedAt: 0 }]]]),
        getQueuedMessage: vi.fn(() => ({ rerunOnly: true, text: '', enqueuedAt: 0 })),
      }),
      getConversationStore: () => {
        const s = d2.getConversationStore()
        s.isConversationRunning = () => runningNow
        s.runAgent = vi.fn(async () => {
          runningNow = true
        })
        return s
      },
      wait: vi.fn(async () => {}),
    })
    const r = JSON.parse(
      (await handlers.send_message({ conversationId: 'c_1', content: 'overlap-wait', wait: true })).content,
    )
    expect(r.status).toBe('queued')
    expect(r.error).toBeUndefined()
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
      getRuntimeStore: () => makeRuntimeStore(),
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


  it('does not overwrite messages appended while a queued message is being persisted', async () => {
    const d2 = makeDeps()
    let releaseInsert!: () => void
    const pendingInsert = new Promise<void>((resolve) => {
      releaseInsert = resolve
    })
    const store = d2.getConversationStore()
    store.isConversationRunning = () => true
    const updateMessages = vi.fn()
    store.updateMessages = updateMessages

    initAppToolDeps({
      ...d2,
      getMessageRepository: () => ({
        findByConversation: async () => [],
        insert: vi.fn(async () => pendingInsert),
      }),
    })

    const sending = handlers.send_message({ conversationId: 'c_1', content: 'queued text' })
    // The active run finishes and dequeues this message before SQLite resolves,
    // appending to the live conversation (the stale-snapshot hazard).
    // The store replaces the conversation object (immutable update), so the
    // record this handler captured before the await keeps the old messages.
    const live = store.conversations[0]
    store.conversations[0] = {
      ...live,
      messages: [
        ...live.messages,
        { id: 'm-followup', role: 'assistant', content: 'follow-up answer', timestamp: 200 },
      ],
    }
    releaseInsert()
    const r = JSON.parse((await sending).content)
    expect(r.status).toBe('queued')

    const written = updateMessages.mock.calls.at(-1)?.[1] as Array<{ id: string; role: string }>
    expect(written.map((m) => m.id)).toContain('m-followup')
    expect(written.at(-1)).toMatchObject({ role: 'user' })
    expect(written).toHaveLength(store.conversations[0].messages.length + 1)
  })

describe('list_models cache handling', () => {
  const entry = (models: Array<{ id: string }>, source: 'dynamic' | 'static', error?: string) => ({
    models: models.map((m) => ({ id: m.id, name: m.id, capabilities: [] })),
    source,
    fetchedAt: 1,
    ...(error ? { error } : {}),
  })

  beforeEach(() => modelCache.clear())

  it('uses the keyed catalog the UI writes', async () => {
    modelCache.set('codex-oauth:codex-oauth', entry([{ id: 'cached-model' }], 'dynamic'))
    const r = JSON.parse((await handlers.list_models({ providerId: 'codex-oauth' })).content)
    expect(r.models.map((m: { id: string }) => m.id)).toEqual(['cached-model'])
    expect(r.source).toBe('dynamic')
  })

  it('falls back to an older unkeyed catalog when the keyed refresh failed', async () => {
    modelCache.set('codex-oauth:codex-oauth', entry([], 'dynamic', 'catalog refresh failed'))
    modelCache.set('codex-oauth', entry([{ id: 'older-model' }], 'dynamic'))
    const r = JSON.parse((await handlers.list_models({ providerId: 'codex-oauth' })).content)
    expect(r.models.map((m: { id: string }) => m.id)).toEqual(['older-model'])
    expect(r.source).toBe('dynamic')
  })

  it('reports static models as static when no cache entry holds any', async () => {
    const r = JSON.parse((await handlers.list_models({ providerId: 'deepseek' })).content)
    expect(r.source).toBe('static')
    expect(r.models.length).toBeGreaterThan(0)
  })
})
})
