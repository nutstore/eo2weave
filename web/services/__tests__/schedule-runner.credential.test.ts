import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DispatchApiKey } from '@/agent/providers/gateway-dispatch-key'
import type { Schedule } from '@/services/schedule-storage'

const mocks = vi.hoisted(() => ({
  resolve: vi.fn<() => Promise<DispatchApiKey>>(),
  loadSchedule: vi.fn(),
  saveSchedule: vi.fn(),
  notify: vi.fn(),
  log: vi.fn(),
  addMessage: vi.fn(),
  createProvider: vi.fn(),
  run: vi.fn(),
}))

vi.mock('@/agent/agent-loop', () => ({ AgentLoop: class { run = mocks.run } }))
vi.mock('@/agent/context-manager', () => ({ ContextManager: vi.fn() }))
vi.mock('@/agent/llm/provider-factory', () => ({ createLLMProvider: mocks.createProvider }))
vi.mock('@/agent/tool-registry', () => ({ getToolRegistry: vi.fn() }))
vi.mock('@/services/schedule-storage', () => ({
  loadSchedule: mocks.loadSchedule, saveSchedule: mocks.saveSchedule, showScheduleNotification: mocks.notify,
}))
vi.mock('@/services/schedule-run-logger', () => ({ writeRunLog: mocks.log, truncateForLog: vi.fn() }))
vi.mock('@/store/folder-access.store', () => ({ useFolderAccessStore: { getState: () => ({ records: {} }) } }))
vi.mock('@/opfs', () => ({ getWorkspaceManager: async () => ({ getWorkspace: async () => null }) }))
vi.mock('@/store/conversation.store.sqlite', () => ({ isDirectConversation: () => false }))
vi.mock('@/sqlite', () => ({ getApiKeyRepository: () => ({ load: vi.fn() }) }))
vi.mock('@/agent/providers/gateway-dispatch-key', () => ({ resolveDispatchApiKey: mocks.resolve }))
vi.mock('@/store/conversation.store', () => ({ useConversationStore: { getState: () => ({
  conversations: [{ id: 'chat-1' }], addMessage: mocks.addMessage,
}) } }))

import { runSchedule } from '@/services/schedule-runner'
import { useI18nStore } from '@/i18n/store'
import { useSettingsStore } from '@/store/settings.store'
import { getProviderConfig, registerDynamicProvider, unregisterDynamicProvider } from '@/agent/providers/types'

const initialSettings = useSettingsStore.getState()
const initialLocale = useI18nStore.getState().locale

function registerCustomProvider(id: string, modelName: string) {
  registerDynamicProvider(id, { baseURL: `https://${id}.example/v1`, modelName }, {
    category: 'custom', displayName: id, models: [],
  })
  useSettingsStore.setState({ customProviders: [
    ...useSettingsStore.getState().customProviders.filter(p => p.id !== id),
    { id, name: id, baseUrl: `https://${id}.example/v1`, models: modelName ? [modelName] : [],
      apiMode: 'responses', createdAt: 0, updatedAt: 0 },
  ] })
}

async function setScheduleLLM(llm: Schedule['llm']) {
  const schedule = await mocks.loadSchedule()
  mocks.loadSchedule.mockResolvedValue({ ...schedule, llm })
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  useSettingsStore.setState({ providerType: 'llm-gateway', modelName: 'chat-model', customProviders: [] })
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
  mocks.resolve.mockResolvedValue({ ok: true, apiKey: 'resolved-key' })
  mocks.createProvider.mockReturnValue({ maxContextTokens: 16000 })
  mocks.run.mockResolvedValue([])
})

afterEach(() => {
  for (const id of ['llm-gateway', 'custom-schedule-a', 'custom-selected-b']) unregisterDynamicProvider(id)
  useSettingsStore.setState(initialSettings, true)
  useI18nStore.setState({ locale: initialLocale })
  localStorage.clear()
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
    useSettingsStore.setState({ providerType: 'openai', modelName: 'gpt-4o' })
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

describe('scheduled task provider configuration', () => {
  it('uses the scheduled custom provider URL, credential identity, model, and API mode', async () => {
    registerCustomProvider('custom-schedule-a', 'a-default')
    registerCustomProvider('custom-selected-b', 'b-default')
    useSettingsStore.setState({ providerType: 'custom-selected-b', modelName: 'b-selected' })
    await setScheduleLLM({ provider: 'custom-schedule-a', model: 'a-scheduled' })

    await runSchedule('schedule-1', { force: true })

    expect(mocks.resolve).toHaveBeenCalledWith('custom-schedule-a', expect.any(Function))
    expect(mocks.createProvider).toHaveBeenCalledWith({
      apiKey: 'resolved-key', providerType: 'custom-schedule-a',
      baseUrl: 'https://custom-schedule-a.example/v1', model: 'a-scheduled', apiMode: 'responses',
    })
    expect(mocks.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ error: null }))
  })

  it('dispatches the gateway credential sentinel when another provider is selected', async () => {
    useSettingsStore.setState({ providerType: 'openai', modelName: 'selected-openai-model' })
    await setScheduleLLM({ provider: 'llm-gateway', model: 'scheduled-gateway-model' })

    await runSchedule('schedule-1', { force: true })

    expect(mocks.resolve).toHaveBeenCalledWith('__llm_gateway_token__', expect.any(Function))
    expect(mocks.createProvider).toHaveBeenCalledWith({
      apiKey: 'resolved-key', providerType: 'llm-gateway', baseUrl: 'https://provider.example/v1',
      model: 'scheduled-gateway-model', apiMode: 'chat-completions',
    })
  })

  it('uses an ordinary key for a scheduled custom provider while the gateway is selected', async () => {
    registerCustomProvider('custom-schedule-a', 'a-default')
    await setScheduleLLM({ provider: 'custom-schedule-a', model: 'a-scheduled' })

    await runSchedule('schedule-1', { force: true })

    expect(mocks.resolve).toHaveBeenCalledWith('custom-schedule-a', expect.any(Function))
    expect(mocks.createProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerType: 'custom-schedule-a', baseUrl: 'https://custom-schedule-a.example/v1',
    }))
  })

  it.each(['custom-missing', 'custom-schedule-a'])('rejects unavailable scheduled provider %s before credential dispatch', async (id) => {
    registerCustomProvider('custom-schedule-a', 'a-default')
    unregisterDynamicProvider(id)
    await setScheduleLLM({ provider: id, model: 'scheduled-model' })

    await runSchedule('schedule-1', { force: true })

    expect(mocks.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('LLM_NOT_AVAILABLE'),
    }))
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(mocks.createProvider).not.toHaveBeenCalled()
  })

  it('keeps the selected provider and current model for schedules without an override', async () => {
    useSettingsStore.setState({ providerType: 'openai', modelName: 'selected-openai-model' })

    await runSchedule('schedule-1', { force: true })

    expect(mocks.resolve).toHaveBeenCalledWith('openai', expect.any(Function))
    expect(mocks.createProvider).toHaveBeenCalledWith({
      apiKey: 'resolved-key', providerType: 'openai', baseUrl: getProviderConfig('openai')!.baseURL,
      model: 'selected-openai-model', apiMode: undefined,
    })
  })

  it('accepts a scheduled model when the custom provider has no default model', async () => {
    registerCustomProvider('custom-schedule-a', '')
    useSettingsStore.setState({ providerType: 'custom-schedule-a', modelName: '' })
    await setScheduleLLM({ provider: 'custom-schedule-a', model: 'a-scheduled' })

    await runSchedule('schedule-1', { force: true })

    expect(mocks.resolve).toHaveBeenCalledWith('custom-schedule-a', expect.any(Function))
    expect(mocks.createProvider).toHaveBeenCalledWith(expect.objectContaining({ model: 'a-scheduled' }))
    expect(mocks.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({ error: null }))
  })
})
