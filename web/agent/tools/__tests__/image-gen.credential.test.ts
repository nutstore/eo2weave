import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Locale } from '@creatorweave/i18n'
import type { ToolContext } from '../tool-types'
import type { DispatchApiKey } from '@/agent/providers/gateway-dispatch-key'

const mocks = vi.hoisted(() => ({
  providerKey: '__llm_gateway_token__',
  resolve: vi.fn<() => Promise<DispatchApiKey>>(),
  generate: vi.fn(),
  writeFile: vi.fn(),
}))

vi.mock('@/store/settings.store', () => ({ useSettingsStore: { getState: () => ({
  imageGenModel: 'image-model',
  getEffectiveProviderConfig: () => ({
    apiKeyProviderKey: mocks.providerKey,
    baseUrl: 'https://provider.example/v1',
    modelName: 'chat-model',
  }),
}) } }))
vi.mock('@/sqlite', () => ({ getApiKeyRepository: () => ({ load: vi.fn() }) }))
vi.mock('@/agent/providers/gateway-dispatch-key', () => ({ resolveDispatchApiKey: mocks.resolve }))
vi.mock('@/agent/providers/model-store', () => ({ getCachedModels: vi.fn() }))
vi.mock('@/agent/llm/image-gen', () => ({
  CODEX_IMAGE_MODEL_ID: 'codex-image-model',
  generateImage: mocks.generate,
  hasCodexImageBridge: () => false,
}))
vi.mock('../vfs-resolver', () => ({
  resolveVfsTarget: async () => ({ path: 'image.png', backend: { writeFile: mocks.writeFile } }),
}))

import { imageGenExecutor } from '../image-gen.tool'
import { useI18nStore } from '@/i18n/store'

async function generate() {
  return JSON.parse(await imageGenExecutor({ prompt: 'A green tree' }, {} as ToolContext))
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.providerKey = '__llm_gateway_token__'
  useI18nStore.setState({ locale: 'en-US' })
})

describe('image generation credential failures', () => {
  it.each([
    ['temporary', 'credential_temporary', 'Credentials are temporarily unavailable. Please retry.', true],
    ['expired', 'credential_expired', 'Your sign-in has expired. Please sign in again.', false],
    ['missing', 'credential_missing', 'You are not signed in. Please sign in first.', false],
  ] as const)('preserves the %s verdict and recovery action', async (kind, code, message, retryable) => {
    mocks.resolve.mockResolvedValue({ ok: false, kind })

    expect(await generate()).toMatchObject({ ok: false, error: { code, message, retryable } })
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(mocks.writeFile).not.toHaveBeenCalled()
  })

  it('offers API key setup for a missing ordinary provider key', async () => {
    mocks.providerKey = 'openai'
    mocks.resolve.mockResolvedValue({ ok: false, kind: 'missing' })

    expect(await generate()).toMatchObject({ error: {
      code: 'credential_missing',
      message: 'No API key is configured. Please configure one in settings.',
      retryable: false,
    } })
  })

  it('treats a credential read exception as retryable rather than unconfigured', async () => {
    mocks.resolve.mockRejectedValue(new Error('SQLite temporarily unavailable'))

    expect(await generate()).toMatchObject({ error: {
      code: 'credential_temporary',
      message: 'Credentials are temporarily unavailable. Please retry.',
      retryable: true,
    } })
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it.each([
    ['zh-CN', '暂时无法获取凭证，请稍后重试。'],
    ['ja-JP', '認証情報を一時的に取得できません。もう一度お試しください。'],
    ['ko-KR', '인증 정보를 일시적으로 가져올 수 없습니다. 다시 시도해 주세요.'],
  ] satisfies [Locale, string][])('localizes the retry instruction for %s', async (locale, message) => {
    useI18nStore.setState({ locale })
    mocks.resolve.mockResolvedValue({ ok: false, kind: 'temporary' })

    expect(await generate()).toMatchObject({ error: { message, retryable: true } })
  })

  it('continues image generation with a successfully resolved credential', async () => {
    mocks.resolve.mockResolvedValue({ ok: true, apiKey: 'current-key' })
    mocks.generate.mockResolvedValue({
      stopReason: 'stop', output: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
    })

    expect(await generate()).toMatchObject({ ok: true })
    expect(mocks.generate).toHaveBeenCalledWith('A green tree', expect.objectContaining({
      apiKey: 'current-key', modelId: 'image-model',
    }), undefined)
    expect(mocks.writeFile).toHaveBeenCalledOnce()
  })
})
