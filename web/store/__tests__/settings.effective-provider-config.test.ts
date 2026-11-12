import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useSettingsStore } from '@/store/settings.store'
import {
  getProviderConfig,
  registerDynamicProvider,
  unregisterDynamicProvider,
} from '@/agent/providers/types'

const initialState = useSettingsStore.getState()
const providerIds = ['custom-schedule-a', 'custom-selected-b', 'llm-gateway']

beforeEach(() => {
  localStorage.clear()
  for (const id of providerIds) {
    registerDynamicProvider(id, {
      baseURL: `https://${id}.example/v1`, modelName: `${id}-default`,
    }, {
      category: 'custom', displayName: id, models: [],
    })
  }
  useSettingsStore.setState({ providerType: 'custom-selected-b', modelName: 'b-selected-model' })
})

afterEach(() => {
  for (const id of providerIds) unregisterDynamicProvider(id)
  useSettingsStore.setState(initialState, true)
  localStorage.clear()
})

describe('effective provider configuration', () => {
  it('resolves an explicit custom provider without using the selected provider model', () => {
    expect(useSettingsStore.getState().getEffectiveProviderConfig('custom-schedule-a')).toEqual({
      apiKeyProviderKey: 'custom-schedule-a',
      baseUrl: 'https://custom-schedule-a.example/v1',
      modelName: 'custom-schedule-a-default',
    })
  })

  it('resolves an explicit built-in provider using its own default model', () => {
    const config = getProviderConfig('openai')!
    expect(useSettingsStore.getState().getEffectiveProviderConfig('openai')).toEqual({
      apiKeyProviderKey: 'openai', baseUrl: config.baseURL, modelName: config.modelName,
    })
  })

  it('uses the gateway credential sentinel for an explicit gateway target', () => {
    expect(useSettingsStore.getState().getEffectiveProviderConfig('llm-gateway')).toEqual({
      apiKeyProviderKey: '__llm_gateway_token__',
      baseUrl: 'https://llm-gateway.example/v1', modelName: 'llm-gateway-default',
    })
  })

  it('uses an ordinary credential key when the gateway is selected but is not the target', () => {
    useSettingsStore.setState({ providerType: 'llm-gateway', modelName: 'gateway-selected-model' })
    expect(useSettingsStore.getState().getEffectiveProviderConfig('custom-schedule-a')).toEqual({
      apiKeyProviderKey: 'custom-schedule-a',
      baseUrl: 'https://custom-schedule-a.example/v1', modelName: 'custom-schedule-a-default',
    })
  })

  it.each(['custom-missing', 'custom-schedule-a'])('returns null for an unavailable target %s', (id) => {
    unregisterDynamicProvider(id)
    expect(useSettingsStore.getState().getEffectiveProviderConfig(id)).toBeNull()
  })

  it('keeps the selected model for implicit and explicit current-provider resolution', () => {
    const state = useSettingsStore.getState()
    const expected = {
      apiKeyProviderKey: 'custom-selected-b', baseUrl: 'https://custom-selected-b.example/v1',
      modelName: 'b-selected-model',
    }
    expect(state.getEffectiveProviderConfig()).toEqual(expected)
    expect(state.getEffectiveProviderConfig('custom-selected-b')).toEqual(expected)
  })

  it('keeps the current provider default fallback when no selected model is set', () => {
    useSettingsStore.setState({ modelName: '' })
    expect(useSettingsStore.getState().getEffectiveProviderConfig()?.modelName).toBe('custom-selected-b-default')
  })
})
