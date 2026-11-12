import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ generateTitle: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { loading: () => 'title-toast', error: mocks.error } }))
vi.mock('@/store/conversation.store', () => ({ useConversationStore: (select: (state: unknown) => unknown) => select({ generateTitle: mocks.generateTitle }) }))
vi.mock('@/store/workspace.store', () => ({ useWorkspaceStore: (select: (state: unknown) => unknown) => select({ togglePin: vi.fn() }) }))
vi.mock('@/store/conversation-context.store', () => ({ useConversationContextStore: {} }))

import { useConversationActions } from '../useConversationActions'

beforeEach(() => { vi.resetAllMocks() })

it.each([
  'Credentials are temporarily unavailable. Please retry.',
  'Your sign-in has expired. Please sign in again.',
  'You are not signed in. Please sign in first.',
])('shows the title generation recovery instruction: %s', async (message) => {
  mocks.generateTitle.mockResolvedValue({
    ok: false, reason: 'credential_unavailable', failure: { message },
  })
  const { result } = renderHook(() => useConversationActions({
    t: (key) => key, router: {} as Parameters<typeof useConversationActions>[0]['router'],
    activeProjectId: 'project-1', scopedConversations: [], scopedConversationIds: [], closeMobileSidebar: vi.fn(),
  }))

  await act(async () => { await result.current.handleItemGenerateTitle('chat-1') })

  expect(mocks.error).toHaveBeenCalledWith(message, { id: 'title-toast' })
})
