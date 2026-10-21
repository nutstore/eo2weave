import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createUserMessage, createAssistantMessage } from '@/agent/message-types'

const createLLMProviderMock = vi.hoisted(() => vi.fn())
const chatMock = vi.hoisted(() => vi.fn())

vi.mock('../llm/provider-factory', () => ({
  createLLMProvider: createLLMProviderMock,
}))

import { generateFollowUp } from '../follow-up-generator'

describe('follow-up-generator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatMock.mockResolvedValue({
      choices: [{ message: { content: '继续' } }],
    })
    createLLMProviderMock.mockReturnValue({
      chat: chatMock,
    })
  })

  it('uses real dialogue despite trailing internal records and unordered IDs', async () => {
    const question = { ...createUserMessage('Explain storage'), id: 'z-question' }
    const answer = { ...createAssistantMessage('Use SQLite'), id: 'a-answer' }
    await generateFollowUp([
      question,
      { ...createUserMessage('private runtime state'), kind: 'context_update' },
      { ...createUserMessage('internal task'), delegationNote: { fromAgentId: 'a', task: 'task' } },
      { ...createUserMessage('image payload'), readImageHandoff: { path: '/x.png', mimeType: 'image/png', ocrStatus: 'done' } },
      answer,
      { ...createAssistantMessage('private changes'), kind: 'run_changes' },
      { ...createUserMessage('private memory'), kind: 'context_summary' },
      { ...createUserMessage('private final state'), kind: 'context_update' },
    ], 'glm', 'test-key')
    const request = chatMock.mock.calls[0][0]
    expect(request.messages.slice(0, 2)).toEqual([
      { role: 'user', content: 'Explain storage' },
      { role: 'assistant', content: 'Use SQLite' },
    ])
    expect(JSON.stringify(request)).not.toContain('private')
    expect(JSON.stringify(request)).not.toContain('internal task')
    expect(JSON.stringify(request)).not.toContain('image payload')
  })

  it('does not invent user intent from synthetic input alone', async () => {
    expect(await generateFollowUp([
      { ...createUserMessage('state'), kind: 'context_update' },
      createAssistantMessage('answer'),
    ], 'glm', 'test-key')).toBeNull()
    expect(createLLMProviderMock).not.toHaveBeenCalled()
  })

  it('uses glm-4.7-flash for glm provider', async () => {
    const messages = [createUserMessage('你好'), createAssistantMessage('你好，有什么可以帮你？')]

    await generateFollowUp(messages, 'glm', 'test-key')

    expect(createLLMProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'glm',
        model: 'glm-4.7-flash',
      })
    )
  })

  it('uses glm-4.7-flash for glm-coding provider', async () => {
    const messages = [createUserMessage('帮我写代码'), createAssistantMessage('好的，我来帮你。')]

    await generateFollowUp(messages, 'glm-coding', 'test-key')

    expect(createLLMProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerType: 'glm-coding',
        model: 'glm-4.7-flash',
      })
    )
  })
})

