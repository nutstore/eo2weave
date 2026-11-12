import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DispatchApiKey } from '@/agent/providers/gateway-dispatch-key'
import type { Schedule } from '@/services/schedule-storage'

const mocks = vi.hoisted(() => ({
  provider: 'llm-gateway',
  resolve: vi.fn<() => Promise<DispatchApiKey>>(),
  loadSchedule: vi.fn(),
  saveSchedule: vi.fn(),
  notify: vi.fn(),
  log: vi.fn(),
  addMessage: vi.fn(),
  createProvider: vi.fn(),
}))

vi.mock('@/agent/agent-loop', () => ({ AgentLoop: vi.fn() }))
vi.mock('@/agent/context-manager', () => ({ ContextManager: vi.fn() }))
vi.mock('@/agent/llm/provider-factory', () => ({ createLLMProvider: mocks.createProvider }))
vi.mock('@/agent/tool-registry', () => ({ getToolRegistry: vi.fn() }))
vi.mock('@/services/schedule-storage', () => ({
  loadSchedule: mocks.loadSchedule, saveSchedule: mocks.saveSchedule, showScheduleNotification: mocks.notify,
}))
vi.mock('@/services/schedule-run-logger', () => ({ writeRunLog: mocks.log, truncateForLog: vi.fn() }))
vi.mock('@/store/settings.store', () => ({ useSettingsStore: { getState: () => ({
  providerType: mocks.provider,
  getEffectiveProviderConfig: () => ({
    apiKeyProviderKey: mocks.provider === 'llm-gateway' ? '__llm_gateway_token__' : mocks.provider,
    baseUrl: 'https://provider.example/v1', modelName: 'chat-model',
  }),
}) } }))
vi.mock('@/store/folder-access.store', () => ({ useFolderAccessStore: { getState: () => ({ records: {} }) } }))
vi.mock('@/sqlite', () => ({ getApiKeyRepository: () => ({ load: vi.fn() }) }))
vi.mock('@/agent/providers/gateway-dispatch-key', () => ({ resolveDispatchApiKey: mocks.resolve }))
vi.mock('@/store/conversation.store', () => ({ useConversationStore: { getState: () => ({
  conversations: [{ id: 'chat-1' }], addMessage: mocks.addMessage,
}) } }))

import { runSchedule } from '@/services/schedule-runner'
import { useI18nStore } from '@/i18n/store'
import { registerDynamicProvider } from '@/agent/providers/types'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.provider = 'llm-gateway'
  registerDynamicProvider('llm-gateway', {
    baseURL: 'https://provider.example/v1', modelName: 'chat-model', headers: {},
  }, {
    category: 'custom', displayName: 'Nutstore AI', catalogStatus: 'ready',
    models: [{ id: 'chat-model', name: 'chat-model', capabilities: ['code'] }],
  })
  useI18nStore.setState({ locale: 'en-US' })
  mocks.loadSchedule.mockResolvedValue({
    id: 'schedule-1', projectId: 'project-1', workspaceId: 'chat-1',
    name: 'Daily task', prompt: 'Write a report', enabled: true,
    schedule: { type: 'cron', expression: '* * * * *' },
    lastRunNumber: 0, lastRunAt: null, error: null, createdAt: 0, updatedAt: 0,
    notification: { onFailure: true, onSuccess: false },
  } satisfies Schedule)
  mocks.log.mockResolvedValue('schedule.log')
})

async function expectFailure(kind: string, message: string) {
  await runSchedule('schedule-1', { force: true })

  const error = `LLM_NOT_AVAILABLE: [credential_${kind}] ${message}`
  expect(mocks.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ error, enabled: true }))
  expect(mocks.log).toHaveBeenCalledWith(expect.objectContaining({ error, status: 'FAILED' }))
  expect(mocks.notify).toHaveBeenCalledWith(expect.any(String), expect.stringContaining(message))
  expect(mocks.addMessage).toHaveBeenCalledWith('chat-1', expect.objectContaining({
    content: expect.stringContaining(message),
  }))
  expect(mocks.createProvider).not.toHaveBeenCalled()
}

describe('scheduled task credential failures', () => {
  it.each([
    ['temporary', 'Credentials are temporarily unavailable. Please retry.'],
    ['expired', 'Your sign-in has expired. Please sign in again.'],
    ['missing', 'You are not signed in. Please sign in first.'],
  ] as const)('persists the %s verdict with its recovery instruction', async (kind, message) => {
    mocks.resolve.mockResolvedValue({ ok: false, kind })
    await expectFailure(kind, message)
  })

  it('offers key setup only for an ordinary provider with a confirmed missing key', async () => {
    mocks.provider = 'openai'
    mocks.resolve.mockResolvedValue({ ok: false, kind: 'missing' })
    await expectFailure('missing', 'No API key is configured. Please configure one in settings.')
  })

  it('reports a credential read exception as temporary', async () => {
    mocks.resolve.mockRejectedValue(new Error('SQLite temporarily unavailable'))
    await expectFailure('temporary', 'Credentials are temporarily unavailable. Please retry.')
  })

  it('uses the current language in the persisted error, notification, and summary', async () => {
    useI18nStore.setState({ locale: 'zh-CN' })
    mocks.resolve.mockResolvedValue({ ok: false, kind: 'temporary' })
    await expectFailure('temporary', '暂时无法获取凭证，请稍后重试。')
  })
})
