import { describe, expect, it } from 'vitest'
import type { Message } from '../message-types'
import {
  extractTextContent,
  internalToPiMessages,
  parseToolArgs,
  piToInternalMessage,
} from '../loop/message-mappers'

describe('message-mappers', () => {
  it('parseToolArgs returns invalid marker for malformed JSON', () => {
    expect(parseToolArgs('{bad-json')).toEqual({ __invalid_arguments: true })
  })

  it('internalToPiMessages preserves context summary and maps tool call args safely', () => {
    const messages: Message[] = [
      {
        id: 'm1',
        role: 'user',
        content: 'old user message',
        timestamp: 1,
      },
      {
        id: 'm2',
        role: 'assistant',
        kind: 'context_summary',
        content: 'summary body',
        timestamp: 2,
      },
      {
        id: 'm3',
        role: 'assistant',
        content: 'run tool',
        toolCalls: [
          {
            id: 'tc1',
            type: 'function',
            function: {
              name: 'read',
              arguments: '{not-json',
            },
          },
        ],
        timestamp: 3,
      },
    ]

    const mapped = internalToPiMessages(
      messages,
      { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      'Earlier conversation summary:'
    )

    expect(mapped).toHaveLength(3)
    expect(mapped[0]).toMatchObject({
      role: 'user',
      content: 'Earlier conversation summary:\nsummary body',
    })

    const assistant = mapped[1] as { role: string; content: Array<{ type: string; arguments?: unknown }> }
    expect(assistant.role).toBe('assistant')
    expect(assistant.content.find((item) => item.type === 'toolCall')).toMatchObject({
      type: 'toolCall',
      arguments: { __invalid_arguments: true },
    })
    expect(mapped[2]).toMatchObject({ role: 'toolResult', toolCallId: 'tc1' })
  })

  it('adds a synthetic tool result for an interrupted tool call before sending context', () => {
    const mapped = internalToPiMessages(
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call-interrupted',
              type: 'function',
              function: { name: 'page_click', arguments: '{"selector":"#save"}' },
            },
          ],
          timestamp: 1,
        },
      ],
      { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      'Earlier conversation summary:'
    )

    expect(mapped).toHaveLength(2)
    expect(mapped[1]).toMatchObject({
      role: 'toolResult',
      toolCallId: 'call-interrupted',
      toolName: 'page_click',
    })
  })

  it('moves a delayed tool result directly after its tool call', () => {
    const mapped = internalToPiMessages(
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call-delayed',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"README.md"}' },
            },
          ],
          timestamp: 1,
        },
        { id: 'user-2', role: 'user', content: 'continue', timestamp: 2 },
        {
          id: 'tool-3',
          role: 'tool',
          toolCallId: 'call-delayed',
          name: 'read',
          content: 'README contents',
          timestamp: 3,
        },
      ],
      { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      'Earlier conversation summary:'
    )

    expect(mapped.map((message) => message.role)).toEqual(['assistant', 'toolResult', 'user'])
    expect(mapped[1]).toMatchObject({ toolCallId: 'call-delayed', content: [{ text: 'README contents' }] })
  })

  it('preserves screenshot image parts when replaying a persisted tool result', () => {
    const mapped = internalToPiMessages(
      [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: null,
          toolCalls: [
            {
              id: 'call-screenshot',
              type: 'function',
              function: { name: 'page_screenshot', arguments: '{}' },
            },
          ],
          timestamp: 1,
        },
        {
          id: 'tool-1',
          role: 'tool',
          toolCallId: 'call-screenshot',
          name: 'page_screenshot',
          content: 'Screenshot captured.',
          contentParts: [
            { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' },
            { type: 'text', text: 'Screenshot captured.' },
          ],
          timestamp: 2,
        },
      ],
      { api: 'openai', provider: 'openai', id: 'test-model' } as never,
      'Earlier conversation summary:'
    )

    expect(mapped[1]).toMatchObject({
      role: 'toolResult',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png' }),
      ]),
    })
  })

  it('extractTextContent and piToInternalMessage map tool results correctly', () => {
    expect(
      extractTextContent([
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: ' world' },
      ])
    ).toBe('hello world')

    const internal = piToInternalMessage({
      role: 'toolResult',
      toolCallId: 'tc2',
      toolName: 'search',
      content: [{ type: 'text', text: 'ok' }],
      isError: false,
      timestamp: 10,
    } as never)

    expect(internal).toMatchObject({
      role: 'tool',
      toolCallId: 'tc2',
      name: 'search',
      content: 'ok',
    })
    expect(internal?.timestamp).toBe(10)
  })

  it('piToInternalMessage preserves upstream timestamps for assistant and toolResult', () => {
    const assistant = piToInternalMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      provider: 'openai',
      model: 'gpt-4o',
      usage: { input: 1, output: 2, totalTokens: 3 },
      timestamp: 123456,
    } as never)
    expect(assistant).toMatchObject({
      role: 'assistant',
      content: 'done',
      timestamp: 123456,
      usage: { provider: 'openai', model: 'gpt-4o' },
    })

    const tool = piToInternalMessage({
      role: 'toolResult',
      toolCallId: 'tc3',
      toolName: 'read',
      content: [{ type: 'text', text: 'file' }],
      isError: false,
      timestamp: 789012,
    } as never)
    expect(tool).toMatchObject({ role: 'tool', content: 'file', timestamp: 789012 })
  })
})
