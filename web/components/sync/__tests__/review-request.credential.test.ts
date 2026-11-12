import { afterEach, describe, expect, it, vi } from 'vitest'
import { credentialRegistry } from '@/agent/providers/credential-state'

vi.mock('@/store/settings.store', () => ({ useSettingsStore: { getState: () => ({
  providerType: 'llm-gateway', hasApiKey: false, hasApiKeyLoaded: true,
}) } }))
vi.mock('@/store/agent.store', () => ({ useAgentStore: { getState: () => ({ directoryHandle: null }) } }))
vi.mock('@/store/conversation.store', () => ({ useConversationStore: { getState: () => ({
  activeConversationId: 'conversation', isConversationRunning: () => false,
}) } }))
vi.mock('@/store/conversation-context.store', () => ({ getActiveConversation: async () => null }))
vi.mock('@/opfs', () => ({ isImageFile: () => false }))
vi.mock('@/workers/commit-summary-worker-manager', () => ({ buildCommitSummaryDiffSections: vi.fn() }))

import { ReviewErrorKey, sendChangeReviewToConversation } from '../review-request'

describe('change review credential checks', () => {
  afterEach(() => credentialRegistry.reset())
  it.each(['unknown', 'temporary'] as const)('passes a %s verdict through to the normal dispatch path', async (kind) => {
    credentialRegistry.commit('llm-gateway', { kind })
    await expect(sendChangeReviewToConversation([{ path: 'test' } as any]))
      .rejects.toThrow(ReviewErrorKey.NO_ACTIVE_WORKSPACE)
  })
  it('still rejects a confirmed missing credential', async () => {
    credentialRegistry.commit('llm-gateway', { kind: 'missing' })
    await expect(sendChangeReviewToConversation([{ path: 'test' } as any]))
      .rejects.toThrow(ReviewErrorKey.PLEASE_CONFIGURE_API_KEY)
  })
})
