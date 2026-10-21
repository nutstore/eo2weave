/**
 * Follow-up Question Generator
 *
 * Generates follow-up question suggestions using a lightweight model.
 * Reuses the user's API key but with an internal flash model config.
 */

import { createLLMProvider } from './llm/provider-factory'
import type { Message } from './message-types'
import { isHumanUserMessage } from '@/agent/message-types'
import { selectConversationTranscript } from '@/agent/message-projections'
import type { LLMProviderType } from '@/agent/providers/types'

/** Flash model configs for each provider type */
const FLASH_MODEL_CONFIGS: Partial<Record<LLMProviderType, { model: string; baseURL: string }>> = {
  glm: {
    model: 'glm-4.7-flash',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4/',
  },
  'glm-coding': {
    model: 'glm-4.7-flash',
    baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4/',
  },
  kimi: {
    model: 'moonshot-v1-8k',
    baseURL: 'https://api.moonshot.cn/v1',
  },
  minimax: {
    model: 'MiniMax-M2.7',
    baseURL: 'https://api.minimax.io/v1',
  },
  'minimax-cn': {
    model: 'MiniMax-M2.7',
    baseURL: 'https://api.minimaxi.com/v1',
  },
  qwen: {
    model: 'qwen-turbo',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  openai: {
    model: 'gpt-4o-mini',
    baseURL: 'https://api.openai.com/v1',
  },
  anthropic: {
    model: 'claude-3-5-haiku-20241022',
    baseURL: 'https://api.anthropic.com/v1',
  },
  google: {
    model: 'gemini-2.0-flash',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
  },
  groq: {
    model: 'llama-3.3-70b-versatile',
    baseURL: 'https://api.groq.com/openai/v1',
  },
  mistral: {
    model: 'mistral-medium-latest',
    baseURL: 'https://api.mistral.ai/v1',
  },
}

/**
 * Build messages for follow-up generation
 * Uses only the last turn (user message + assistant response)
 */
function buildFollowUpMessages(messages: Message[]): Array<{
  role: 'user' | 'assistant'
  content: string
}> {
  const chatMessages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  // Find last user message
  let lastUserIndex = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isHumanUserMessage(messages[i])) {
      lastUserIndex = i
      break
    }
  }
  const lastUserMessage = messages[lastUserIndex]

  // Find last assistant message (after the last user message) with actual content
  let lastAssistantMessage: Message | null = null
  if (lastUserMessage) {
    for (let i = messages.length - 1; i > lastUserIndex; i--) {
      const msg = messages[i]
      if (
        msg.role === 'assistant' &&
        msg.content &&
        msg.content.trim().length > 0
      ) {
        lastAssistantMessage = msg
        break
      }
    }
  }

  // Add user message
  if (lastUserMessage) {
    chatMessages.push({
      role: 'user',
      content: lastUserMessage.content || '...',
    })
  }

  // Add assistant response (only if it has content, validated above)
  if (lastAssistantMessage) {
    chatMessages.push({
      role: 'assistant',
      content: lastAssistantMessage.content!,
    })
  }

  // Add system prompt as last message
  chatMessages.push({
    role: 'user',
    content:
      'Generate what the user might say next (no more than 15 characters). Can be a question, request, or instruction, like "continue writing", "explain in detail", "change to Chinese", "why is it like this". Output directly, no prefix.',
  })

  return chatMessages
}

/**
 * Generate follow-up suggestion
 *
 * @param messages - Conversation messages
 * @param providerType - User's selected provider type
 * @param apiKey - User's API key
 * @returns Follow-up suggestion or null if failed
 */
export async function generateFollowUp(
  messages: Message[],
  providerType: LLMProviderType,
  apiKey: string
): Promise<string | null> {
  try {
    messages = selectConversationTranscript(messages)
    // Skip if no messages or last message is from user
    if (messages.length === 0) return null
    if (!messages.some(isHumanUserMessage)) return null
    const lastMessage = messages[messages.length - 1]
    if (lastMessage.role === 'user') return null

    const config = FLASH_MODEL_CONFIGS[providerType]
    if (!config) {
      console.warn(`[follow-up-generator] No flash model config for provider: ${providerType}`)
      return null
    }

    // Create provider with flash model config
    const provider = createLLMProvider({
      apiKey,
      providerType,
      baseUrl: config.baseURL,
      model: config.model,
      // apiMode not needed for built-in flash models
    })

    const chatMessages = buildFollowUpMessages(messages)

    // Call with low maxTokens for efficiency
    const response = await provider.chat({
      messages: chatMessages,
      maxTokens: 20,
    })

    const content = response.choices[0]?.message?.content
    if (!content) return null

    // Clean up response
    let cleaned = content.trim()

    // Remove common prefixes if AI added them
    const prefixes = ['follow-up:', 'question:', 'suggestion:', 'Q:', 'Q.', 'Q：']
    for (const prefix of prefixes) {
      if (cleaned.startsWith(prefix)) {
        cleaned = cleaned.slice(prefix.length).trim()
      }
    }

    // Remove trailing punctuation that's not part of the question
    cleaned = cleaned.replace(/[。，,；;!?！？]$/, '')

    // Validate length
    if (cleaned.length > 30) {
      cleaned = cleaned.slice(0, 30)
    }

    return cleaned || null
  } catch (error) {
    console.error('[follow-up-generator] Failed to generate follow-up:', error)
    return null
  }
}
