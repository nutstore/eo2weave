import { afterEach, expect, it, vi } from 'vitest'
import { credentialRegistry } from '@/agent/providers/credential-state'

const task = vi.hoisted(() => ({
  id: 'task1', context: { projectId: 'p1', conversationId: 'c1' },
  remoteStatus: 'completed', settledAt: 123, result: { content: 'done' },
}))
const manager = vi.hoisted(() => ({
  initialize: vi.fn(async () => {}), reload: vi.fn(async () => task), updateComposer: vi.fn(async () => {}),
}))
vi.mock('../task-manager', () => ({ getMCPTaskManager: () => manager }))
vi.mock('@/store/conversation.store', () => ({ useConversationStore: { getState: () => ({}) } }))
vi.mock('@/store/conversation-runtime.store', () => ({ useConversationRuntimeStore: { getState: () => ({
  isConversationRunning: () => true, enqueueMessage: () => ({ enqueued: true }),
}) } }))
vi.mock('@/store/project.store', () => ({ useProjectStore: { getState: () => ({ activeProjectId: 'p1' }) } }))
vi.mock('@/sqlite/repositories/conversation.repository', () => ({ getConversationRepository: () => ({ findById: async () => ({ id: 'c1' }) }) }))
vi.mock('@/sqlite/repositories/workspace.repository', () => ({ getWorkspaceRepository: () => ({ findWorkspaceById: async () => ({ projectId: 'p1' }) }) }))
vi.mock('@/sqlite/repositories/message.repository', () => ({ getMessageRepository: () => ({ hasMessage: async () => false }) }))
vi.mock('../task-queue', () => ({ ownMCPTaskQueue: async () => () => {}, removeMCPTaskFromQueue: () => {} }))

import { continueMCPTask } from '../continue-task'
import { useSettingsStore } from '@/store/settings.store'

afterEach(() => credentialRegistry.reset())

it.each(['unknown', 'temporary'] as const)('queues an MCP continuation while credentials are %s', async (kind) => {
  useSettingsStore.setState({ providerType: 'openai', modelName: 'model' })
  credentialRegistry.commit('openai', { kind })
  await expect(continueMCPTask(task as any, 'continue')).resolves.toMatchObject({ kind: 'queued' })
})

it.each(['missing', 'expired'] as const)('rejects an MCP continuation when credentials are %s', async (kind) => {
  useSettingsStore.setState({ providerType: 'openai', modelName: 'model' })
  credentialRegistry.commit('openai', { kind })
  await expect(continueMCPTask(task as any, 'continue')).rejects.toThrow('Configure a model before continuing')
})
