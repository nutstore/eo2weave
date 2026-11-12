import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DispatchApiKey } from '@/agent/providers/gateway-dispatch-key'

const mocks = vi.hoisted(() => ({
  provider: 'llm-gateway',
  resolve: vi.fn<() => Promise<DispatchApiKey>>(),
  run: vi.fn(),
  error: vi.fn(),
  handle: {},
  flow: { activeInstance: {
    conversationId: 'chat-1', nodes: [{ id: 'output', kind: 'output', config: {} }], edges: [],
  }, nodeResults: [] },
}))

vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('@/store/flow.store', () => ({ useFlowStore: (select: (state: unknown) => unknown) => select(mocks.flow) }))
vi.mock('@/store/settings.store', () => ({ useSettingsStore: (select: (state: unknown) => unknown) => select({
  providerType: mocks.provider,
  getEffectiveProviderConfig: () => ({
    apiKeyProviderKey: mocks.provider === 'llm-gateway' ? '__llm_gateway_token__' : mocks.provider,
    baseUrl: 'https://provider.example/v1', modelName: 'model',
  }),
}) }))
vi.mock('@/store/agent.store', () => ({ useAgentStore: (select: (state: unknown) => unknown) => select({ directoryHandle: mocks.handle }) }))
vi.mock('@/store/conversation.store', () => ({ useConversationStore: (select: (state: unknown) => unknown) => select({ activeConversationId: null }) }))
vi.mock('@/sqlite/repositories/api-key.repository', () => ({ getApiKeyRepository: () => ({ load: vi.fn() }) }))
vi.mock('@/agent/providers/gateway-dispatch-key', () => ({ resolveDispatchApiKey: mocks.resolve }))
vi.mock('../FlowCanvas', () => ({ FlowCanvas: () => null }))
vi.mock('../NodePropertiesPanel', () => ({ NodePropertiesPanel: () => null }))
vi.mock('../FlowTemplateManager', () => ({ FlowTemplateManager: () => null }))
vi.mock('../FlowStepBar', () => ({ FlowStepBar: () => null }))
vi.mock('../flow-converter', () => ({ flowToReactFlow: () => ({ nodes: [], edges: [] }) }))
vi.mock('../FlowRunOverlay', () => ({
  FlowRunResultPanel: () => null,
  useFlowRun: () => ({ isRunning: false, result: null, runWithConfig: mocks.run }),
}))

import { FlowEditor } from '../FlowEditor'
import { useI18nStore } from '@/i18n/store'
import { registerDynamicProvider } from '@/agent/providers/types'

beforeEach(() => {
  vi.resetAllMocks()
  mocks.provider = 'llm-gateway'
  registerDynamicProvider('custom-local', {
    baseURL: 'http://localhost:11434/v1', modelName: 'model', headers: {},
  }, {
    category: 'custom', displayName: 'Local', models: [], catalogStatus: 'ready',
  })
  useI18nStore.setState({ locale: 'en-US' })
})

describe('flow editor credential failures', () => {
  it.each([
    ['temporary', 'Credentials are temporarily unavailable. Please retry.'],
    ['expired', 'Your sign-in has expired. Please sign in again.'],
    ['missing', 'You are not signed in. Please sign in first.'],
  ] as const)('shows the recovery action for %s', async (kind, message) => {
    mocks.resolve.mockResolvedValue({ ok: false, kind })
    render(<FlowEditor />)
    fireEvent.click(screen.getByRole('button', { name: '运行' }))

    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(message))
    expect(mocks.run).not.toHaveBeenCalled()
  })

  it('continues allowing a local custom provider to run without a key', async () => {
    mocks.provider = 'custom-local'
    mocks.resolve.mockResolvedValue({ ok: false, kind: 'missing' })
    render(<FlowEditor />)
    fireEvent.click(screen.getByRole('button', { name: '运行' }))

    await waitFor(() => expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      llm: expect.objectContaining({ apiKey: '' }),
    })))
    expect(mocks.error).not.toHaveBeenCalled()
  })
})
