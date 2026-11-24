/**
 * Registration-path wiring for app-tool arguments (issue #247).
 *
 * `buildToolExecutors()` is covered in tool-arguments.test.ts; this file proves
 * the OTHER half of the wiring: register.ts hands each registered executor the
 * raw payload it received from `document.modelContext`, so nothing can reach a
 * handler without going through the validation boundary.
 *
 * Every module register.ts loads is mocked — the point here is the wrapper,
 * not the stores.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_TOOLS } from '../schemas'

interface RegisteredTool {
  name: string
  execute: (args?: unknown) => Promise<string>
}

const harness = vi.hoisted(() => ({
  registered: [] as RegisteredTool[],
  registerTool: vi.fn(),
}))

const noStore = () => ({ getState: () => ({}) })

vi.mock('@w3c/webmcp-polyfill', () => ({ installWebMCP: vi.fn() }))
vi.mock('@/store/conversation.store', () => ({ useConversationStore: noStore() }))
vi.mock('@/store/settings.store', () => ({ useSettingsStore: noStore() }))
vi.mock('@/store/agent.store', () => ({ useAgentStore: noStore() }))
vi.mock('@/store/project.store', () => ({ useProjectStore: noStore() }))
vi.mock('@/store/conversation-context.store', () => ({ useConversationContextStore: noStore() }))
vi.mock('@/store/conversation-persist', () => ({ waitForConversationMetaPersist: async () => {} }))
vi.mock('@/store/workspace-preferences.store', () => ({ useWorkspacePreferencesStore: noStore() }))
vi.mock('@/store/conversation-runtime.store', () => ({ useConversationRuntimeStore: noStore() }))
vi.mock('@/services/conversation-target', () => ({ resolveConversationTarget: async () => ({}) }))
vi.mock('@/opfs', () => ({ getWorkspaceManager: async () => ({}) }))
vi.mock('@/sqlite/repositories/project.repository', () => ({
  getProjectRepository: () => ({
    findAllProjects: async () => [],
    findProjectStats: async () => [],
  }),
}))
vi.mock('@/sqlite/repositories/workspace.repository', () => ({
  getWorkspaceRepository: () => ({ findAllWorkspaces: async () => [], findWorkspacesByProject: async () => [] }),
}))
vi.mock('@/sqlite/repositories/message.repository', () => ({
  getMessageRepository: () => ({ findByConversation: async () => [], insert: async () => {} }),
}))
vi.mock('@/sqlite/repositories/fs-overlay.repository', () => ({
  getFSOverlayRepository: () => ({ listSnapshotFiles: async () => [] }),
}))
vi.mock('@/agent/tools/search-conversations.tool', () => ({
  searchConversationsExecutor: async () => '{}',
}))
vi.mock('@/opfs/workspace/workspace-file-ops', () => ({
  validatePathImpl: (_rt: unknown, path: string) => path,
}))
vi.mock('@/webmcp/app-tools/workspace-setup', () => ({
  ensureConversationWorkspaceWithMeta: async () => ({ projectId: 'p_1' }),
}))

function registered(name: string): RegisteredTool {
  const tool = harness.registered.find((t) => t.name === name)
  if (!tool) throw new Error(`tool was not registered: ${name}`)
  return tool
}

describe('registerAppTools argument wiring', () => {
  beforeEach(() => {
    vi.resetModules()
    harness.registered = []
    harness.registerTool = vi.fn(async (def: RegisteredTool) => {
      harness.registered.push(def)
      return def
    })
    vi.stubGlobal('document', { modelContext: { registerTool: harness.registerTool } })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('registers every declared tool', async () => {
    const { registerAppTools } = await import('../register')
    await registerAppTools()
    expect(harness.registered.map((t) => t.name)).toEqual(APP_TOOLS.map((t) => t.name))
  })

  it('passes the raw payload through the validating executor', async () => {
    const { registerAppTools } = await import('../register')
    await registerAppTools()

    // An array never reaches the handler, whatever the caller sends.
    const arrayOut = JSON.parse(await registered('send_message').execute([1, 2, 3]))
    expect(arrayOut.error).toContain('send_message')
    expect(arrayOut.error).toMatch(/array/)

    // The raw object is forwarded as-is (not replaced by {}), so required-field
    // validation still fires.
    const missingOut = JSON.parse(await registered('send_message').execute({ content: 'x' }))
    expect(missingOut.error).toMatch(/missing required field "conversationId"/)

    // Wrong declared primitive type is rejected before the handler runs.
    const waitOut = JSON.parse(
      await registered('send_message').execute({ conversationId: 'c_1', content: 'x', wait: 'false' }),
    )
    expect(waitOut.error).toMatch(/"wait"/)
  })

  it('lets omitted arguments and valid calls through to the handler', async () => {
    const { registerAppTools } = await import('../register')
    await registerAppTools()

    const projects = JSON.parse(await registered('list_projects').execute())
    expect(projects.projects).toEqual([])

    const messages = JSON.parse(await registered('get_messages').execute({ conversationId: 'c_1' }))
    expect(messages.messages).toEqual([])
  })
})
