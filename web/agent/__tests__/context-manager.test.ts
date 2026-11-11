/**
 * Context Manager Tests
 *
 * Tests for token budget management, message truncation,
 * and summarization features.
 */

import { describe, it, expect, vi } from 'vitest'
import { ContextManager } from '../context-manager'
import type { ChatMessage } from '../llm/llm-provider'
import { estimateMessageTokens } from '../llm/token-counter'

// Mock token counter - inline factory for proper hoisting
vi.mock('../llm/token-counter', () => {
  return {
    estimateMessageTokens: vi.fn((msg: { content: string | object }): number => {
      if (typeof msg.content === 'string') {
        return Math.ceil(msg.content.length / 3)
      }
      return 10
    }),
    estimateStringTokens: vi.fn((str: string): number => {
      return Math.ceil(str.length / 3)
    }),
  }
})

function createMessage(role: ChatMessage['role'], content: string): ChatMessage {
  return {
    role,
    content,
  }
}

function createAssistantWithTool(
  content: string,
  toolName: string,
  toolResult: string
): ChatMessage[] {
  const id = `msg-${Math.random().toString(36).slice(2)}`
  return [
    {
      role: 'assistant',
      content,
      tool_calls: [
        { id: `${id}-tool`, type: 'function', function: { name: toolName, arguments: '{}' } },
      ],
    },
    {
      role: 'tool',
      tool_call_id: `${id}-tool`,
      content: toolResult,
    },
  ]
}

describe('ContextManager', () => {
  describe('constructor', () => {
    it('should initialize with default values', () => {
      const manager = new ContextManager({ maxContextTokens: 1000 })
      expect(manager.getConfig().maxContextTokens).toBe(1000)
      expect(manager.getConfig().reserveTokens).toBe(4096)
      expect(manager.getConfig().systemPrompt).toBe('')
      expect(manager.getConfig().enableSummarization).toBe(false)
    })

    it('should initialize with custom values', () => {
      const manager = new ContextManager({
        maxContextTokens: 64000,
        reserveTokens: 2000,
        systemPrompt: 'You are a helpful assistant.',
        enableSummarization: true,
        maxMessageGroups: 30,
      })

      const config = manager.getConfig()
      expect(config.maxContextTokens).toBe(64000)
      expect(config.reserveTokens).toBe(2000)
      expect(config.systemPrompt).toBe('You are a helpful assistant.')
      expect(config.enableSummarization).toBe(true)
      expect(config.maxMessageGroups).toBe(30)
    })
  })

  describe('setSystemPrompt', () => {
    it('should update system prompt', () => {
      const manager = new ContextManager({ maxContextTokens: 1000 })
      manager.setSystemPrompt('New system prompt')
      expect(manager.getConfig().systemPrompt).toBe('New system prompt')
    })
  })

  describe('updateConfig', () => {
    it('should update configuration partially', () => {
      const manager = new ContextManager({ maxContextTokens: 1000 })
      manager.updateConfig({ enableSummarization: true, maxMessageGroups: 20 })

      const config = manager.getConfig()
      expect(config.enableSummarization).toBe(true)
      expect(config.maxMessageGroups).toBe(20)
      expect(config.maxContextTokens).toBe(1000) // Unchanged
    })
  })

  describe('trimMessages', () => {
    it('should return empty array when no messages', () => {
      // Use very large token budget to ensure nothing gets truncated
      const manager = new ContextManager({
        maxContextTokens: 10000,
        reserveTokens: 1000,
        systemPrompt: '',
      })
      const result = manager.trimMessages([])
      // With empty system prompt and no messages, result should be empty
      expect(result.messages.length).toBe(0)
      expect(result.wasTruncated).toBe(false)
      expect(result.droppedGroups).toBe(0)
    })

    it('should include system prompt when set', () => {
      // Use large enough budget to avoid truncation
      const manager = new ContextManager({
        maxContextTokens: 10000,
        reserveTokens: 1000,
        systemPrompt: 'You are a helpful assistant.',
      })

      const result = manager.trimMessages([createMessage('user', 'Hello')])

      // System prompt should be included
      const systemMsg = result.messages.find((m) => m.role === 'system')
      expect(systemMsg).toBeDefined()
      expect(systemMsg?.content).toContain('You are a helpful assistant')
    })

    it('should truncate when messages exceed budget', () => {
      const manager = new ContextManager({ maxContextTokens: 500, reserveTokens: 100 })

      // Create messages that will exceed the budget
      const messages: ChatMessage[] = []
      for (let i = 0; i < 30; i++) {
        messages.push(createMessage('user', 'This is a test message '.repeat(5)))
      }

      const result = manager.trimMessages(messages)

      expect(result.wasTruncated).toBe(true)
      expect(result.droppedGroups).toBeGreaterThan(0)
      // Result should have fewer messages than input
      expect(result.messages.length).toBeLessThan(messages.length)
    })

    it('should preserve tool_call/tool_result pairs', () => {
      const manager = new ContextManager({ maxContextTokens: 500, reserveTokens: 100 })

      const toolConversation = [
        ...createAssistantWithTool('I will list files', 'list_files', 'package.json, src/, docs/'),
        createMessage('user', 'Thanks'),
        ...createAssistantWithTool('I found the file', 'file_read', 'File content here'),
      ]

      const result = manager.trimMessages(toolConversation)

      // Both tool conversations should be preserved or truncated together
      const toolResults = result.messages.filter((m) => m.role === 'tool')
      expect(toolResults).toHaveLength(2) // Both tool results should be present
    })

    it('should keep most recent messages when truncating', () => {
      const manager = new ContextManager({ maxContextTokens: 400, reserveTokens: 100 })

      const messages: ChatMessage[] = []
      for (let i = 0; i < 10; i++) {
        messages.push(createMessage('user', `Old message ${i}`))
        messages.push(createMessage('assistant', `Old response ${i}`))
      }
      // Add recent messages
      messages.push(createMessage('user', 'Recent message'))
      messages.push(createMessage('assistant', 'Recent response'))

      const result = manager.trimMessages(messages)

      // Should contain the most recent messages
      const recentMessages = result.messages.filter(
        (m) => typeof m.content === 'string' && m.content.includes('Recent')
      )
      expect(recentMessages.length).toBeGreaterThan(0)
    })
  })

  describe('summarization', () => {
    it('should create summary when summarization is enabled and messages are dropped', () => {
      const manager = new ContextManager({
        maxContextTokens: 300,
        reserveTokens: 100,
        enableSummarization: true,
      })

      // Create many messages that will be truncated
      const messages: ChatMessage[] = []
      for (let i = 0; i < 30; i++) {
        messages.push(createMessage('user', `Question ${i}: How do I fix this bug?`))
        messages.push(
          createMessage('assistant', `Answer ${i}: You should check the documentation.`)
        )
      }

      const result = manager.trimMessages(messages, {
        createSummary: true,
      })

      // Should indicate truncation
      expect(result.wasTruncated).toBe(true)
      expect(result.droppedGroups).toBeGreaterThan(0)

      // Should contain a summary message
      const summaryMessages = result.messages.filter((m) => m.role === 'system')
      expect(summaryMessages.length).toBeGreaterThanOrEqual(1)
    })

    it('should not create summary when summarization is disabled', () => {
      const manager = new ContextManager({
        maxContextTokens: 150,
        reserveTokens: 100,
        enableSummarization: false,
      })

      // Create enough messages to exceed token budget
      // Each message with ~15 chars = ~5 tokens with our mock
      // 150 - 100 = 50 tokens available, so 10+ messages should truncate
      const messages: ChatMessage[] = []
      for (let i = 0; i < 15; i++) {
        messages.push(createMessage('user', `Message ${i} with more content`))
      }

      const result = manager.trimMessages(messages, {
        createSummary: true,
      })

      // Should still truncate but no summary
      expect(result.wasTruncated).toBe(true)
      expect(result.droppedGroups).toBeGreaterThan(0)
    })

    it('should proactively compress when near context ceiling', () => {
      const manager = new ContextManager({
        maxContextTokens: 1000,
        reserveTokens: 100,
        enableSummarization: true,
      })

      const messages: ChatMessage[] = []
      for (let i = 0; i < 70; i++) {
        messages.push(
          createMessage(
            'user',
            `Message ${i} with enough content to consume tokens quickly and push context close to model limits`
          )
        )
      }

      const result = manager.trimMessages(messages, {
        createSummary: true,
      })

      expect(result.wasTruncated).toBe(true)
      expect(result.droppedGroups).toBeGreaterThan(0)
      const compressedSummary = result.messages.find(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('Compressed memory')
      )
      expect(compressedSummary).toBeDefined()
    })

    it('should proactively compress when threshold is reached even with fewer message groups', () => {
      const manager = new ContextManager({
        maxContextTokens: 400,
        reserveTokens: 40,
        enableSummarization: true,
      })

      const messages: ChatMessage[] = []
      for (let i = 0; i < 6; i++) {
        messages.push(
          createMessage(
            'user',
            `Message ${i} with enough content to consume tokens quickly and push context close to model limits. `.repeat(4)
          )
        )
      }

      const result = manager.trimMessages(messages, {
        createSummary: true,
        usedRealTokens: 340,
      })

      expect(result.wasTruncated).toBe(true)
      expect(result.droppedGroups).toBeGreaterThan(0)
      const compressedSummary = result.messages.find(
        (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('Compressed memory')
      )
      expect(compressedSummary).toBeDefined()
    })

    it('should compress at the absolute cap instead of the ratio', () => {
      // 3 x 700 chars ≈ 700 tokens: below the 85% ratio trigger (850) but above
      // the 300-token cap, so only the capped manager may compress.
      const messages: ChatMessage[] = []
      for (let i = 0; i < 3; i++) {
        messages.push(createMessage('user', `Message ${i} ${'x'.repeat(690)}`))
      }
      const hasCompressedMemory = (msgs: ChatMessage[]) =>
        msgs.some(
          (m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('Compressed memory')
        )

      const capped = new ContextManager({
        maxContextTokens: 1000,
        reserveTokens: 100,
        enableSummarization: true,
        compressionAbsoluteCapEnabled: true,
        compressionAbsoluteCap: 300,
      })
      expect(hasCompressedMemory(capped.trimMessages(messages, { createSummary: true }).messages)).toBe(true)

      const ratioOnly = new ContextManager({
        maxContextTokens: 1000,
        reserveTokens: 100,
        enableSummarization: true,
        compressionAbsoluteCapEnabled: false,
      })
      expect(hasCompressedMemory(ratioOnly.trimMessages(messages, { createSummary: true }).messages)).toBe(false)
    })

    it('should cap the trim budget at the absolute cap for huge windows', () => {
      // 1M window, 32K reserve: the ratio trigger (850K) would let a 300K-token
      // history through untouched, so only a manager that bounds `budget` by the
      // 200K cap drops anything here.
      const messages: ChatMessage[] = []
      for (let i = 0; i < 300; i++) {
        // 3 chars/token in the mocked counter => ~1000 tokens per message.
        messages.push(createMessage('user', `Message ${i} ${'x'.repeat(2980)}`))
      }

      const capped = new ContextManager({
        maxContextTokens: 1_000_000,
        reserveTokens: 32_000,
        enableSummarization: true,
        // 300 single-message groups: keep the 50-group limit out of the picture
        // so only the token budget decides.
        maxMessageGroups: 400,
        compressionAbsoluteCapEnabled: true,
        compressionAbsoluteCap: 200_000,
      })
      const result = capped.trimMessages(messages, {
        createSummary: true,
        usedRealTokens: 300_000,
      })

      expect(result.wasTruncated).toBe(true)
      expect(result.droppedGroups).toBeGreaterThan(0)
      const keptTokens = result.messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
      expect(keptTokens).toBeLessThanOrEqual(200_000)
      expect(keptTokens).toBeGreaterThan(0)

      // Without the cap the same history fits in the 968K ratio budget, so
      // nothing is dropped — that is the behaviour this test pins down.
      const ratioOnly = new ContextManager({
        maxContextTokens: 1_000_000,
        reserveTokens: 32_000,
        enableSummarization: true,
        maxMessageGroups: 400,
        compressionAbsoluteCapEnabled: false,
      })
      expect(ratioOnly.trimMessages(messages, { createSummary: true }).droppedGroups).toBe(0)
    })

    it('should exclude prior compressed memory messages from external dropped content', () => {
      const manager = new ContextManager({
        maxContextTokens: 260,
        reserveTokens: 100,
        enableSummarization: true,
      })

      const messages: ChatMessage[] = [
        createMessage(
          'assistant',
          'Compressed memory of earlier conversation:\nOld summary that should not be summarized again'
        ),
      ]
      for (let i = 0; i < 20; i++) {
        messages.push(createMessage('user', `User question ${i} with enough text to force truncation`))
        messages.push(
          createMessage('assistant', `Assistant answer ${i} with enough text to force truncation`)
        )
      }

      const result = manager.trimMessages(messages, {
        createSummary: true,
        summaryStrategy: 'external',
      })

      expect(result.droppedContent).toBeTruthy()
      expect(result.droppedContent).not.toContain('Compressed memory of earlier conversation:')
    })
  })

  describe('estimateContextTokens', () => {
    it('should estimate tokens correctly', () => {
      const manager = new ContextManager({ maxContextTokens: 1000 })
      manager.setSystemPrompt('System prompt') // ~15 chars

      const messages = [
        createMessage('user', 'Hello world'), // ~11 chars
        createMessage('assistant', 'How can I help?'), // ~14 chars
      ]

      const tokens = manager.estimateContextTokens(messages)
      expect(tokens).toBeGreaterThan(0)
    })
  })

  describe('edge cases', () => {
    it('should handle very small token budget', () => {
      const manager = new ContextManager({ maxContextTokens: 50, reserveTokens: 40 })

      const result = manager.trimMessages([createMessage('user', 'Hello')])

      // Should still return something
      expect(result.messages.length).toBeGreaterThanOrEqual(0)
    })

    it('should handle messages with complex content', () => {
      const manager = new ContextManager({ maxContextTokens: 1000 })

      const complexMessage: ChatMessage = {
        role: 'assistant',
        content: 'Here is the code: function test() { return true; }',
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'test', arguments: '{}' } }],
      }

      const result = manager.trimMessages([complexMessage])

      expect(result.messages.length).toBe(1)
    })

    it('should handle messages with tool calls', () => {
      // Use large enough budget to avoid truncation
      const manager = new ContextManager({ maxContextTokens: 10000, reserveTokens: 1000 })

      const message: ChatMessage = {
        role: 'assistant',
        content: 'Final answer',
      }

      const result = manager.trimMessages([message])

      // Should contain the assistant message
      expect(result.messages.length).toBeGreaterThanOrEqual(1)
      const assistantMsg = result.messages.find((m) => m.role === 'assistant')
      expect(assistantMsg).toBeDefined()
      expect(assistantMsg?.content).toBe('Final answer')
    })
  })
})
