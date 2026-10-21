/**
 * Conversation Title Generator
 *
 * Generates a concise topic title for a conversation using the CURRENT
 * conversation's model (not a flash/cheap model like follow-up-generator).
 *
 * Context strategy (avoids blowing up the context window):
 * - If the conversation has been compressed (compressedContextSummary exists),
 *   feed the summary + the most recent few messages.
 * - If not compressed, the message volume is still small — feed all messages,
 *   but with a hard token budget guard that falls back to first user message
 *   + recent messages when the transcript is unexpectedly large.
 */

import { isHumanUserMessage } from '@/agent/message-types'
import { selectConversationTranscript } from '@/agent/message-projections'
import { createLLMProvider } from './llm/provider-factory'
import type { Message } from './message-types'
import type { LLMProviderType } from '@/agent/providers/types'

/** Rough char→token estimate (1 token ≈ 3 chars for mixed CJK/Latin). */
const CHARS_PER_TOKEN = 3
/** When not compressed and transcript exceeds this, switch to head+tail mode. */
const NO_COMPRESS_TOKEN_BUDGET = 4000
/** Number of recent messages to keep when in head+tail mode. */
const RECENT_MESSAGE_COUNT = 6

export interface TitleGeneratorModelConfig {
  /** Optional: custom providers may run keyless (e.g. Ollama). */
  apiKey: string
  providerType: LLMProviderType
  baseUrl: string
  model: string
  /** API mode for custom providers. */
  apiMode?: 'chat-completions' | 'responses'
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Build the chat messages for title generation.
 *
 * Returns a compact representation that respects the context budget.
 */
function buildTitleMessages(
  messages: Message[],
  compressedContextSummary: string | null
): Array<{ role: 'system' | 'user'; content: string }> {
  messages = selectConversationTranscript(messages)
  // Bilingual prompt so the model reliably follows instructions for both
  // Chinese and English (and other Latin-script) conversations. We let the
  // model infer the user's language from the user messages themselves —
  // this avoids a client-side language detector that would need its own
  // coverage for ja/ko/emoji-only/rare languages.
  const systemPrompt =
    '根据以下对话内容生成一个简短的标题（中文 3-15 字 / English 3-10 words），' +
    '使用与用户消息相同的语言，直接输出标题文字，不要加引号、不要加标点符号结尾、不要加前缀。\n' +
    'Generate a short topic title for the conversation (Chinese 3-15 chars / English 3-10 words). ' +
    'Match the language of the user messages. Output the title text directly, ' +
    'without quotes, trailing punctuation, or any prefix like "Title:".'

  // --- Branch 1: compressed conversation ---
  if (compressedContextSummary && compressedContextSummary.trim()) {
    const recent = messages.slice(-RECENT_MESSAGE_COUNT)
    const recentText = recent
      .map((m) => {
        const role = isHumanUserMessage(m) ? '用户' : '助手'
        const content = (m.content || '').trim()
        return content ? `${role}: ${content}` : ''
      })
      .filter(Boolean)
      .join('\n')

    const userContent =
      `【对话历史摘要】\n${compressedContextSummary.trim()}\n\n` +
      `【最近对话】\n${recentText}\n\n` +
      `请生成话题标题：`

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ]
  }

  // --- Branch 2: not compressed ---
  // First try feeding all messages (volume is small at this point).
  const allText = messages
    .map((m) => {
      const role = isHumanUserMessage(m) ? '用户' : '助手'
      const content = (m.content || '').trim()
      return content ? `${role}: ${content}` : ''
    })
    .filter(Boolean)

  const fullTranscript = allText.join('\n')

  if (approxTokens(fullTranscript) <= NO_COMPRESS_TOKEN_BUDGET) {
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `【对话内容】\n${fullTranscript}\n\n请生成话题标题：` },
    ]
  }

  // Hard budget guard: keep first user message + recent messages.
  const firstUser = messages.find((m) => isHumanUserMessage(m) && (m.content || '').trim())
  const headText = firstUser
    ? `用户: ${(firstUser.content || '').trim()}`
    : ''
  const tail = messages.slice(-RECENT_MESSAGE_COUNT)
  const tailText = tail
    .map((m) => {
      const role = isHumanUserMessage(m) ? '用户' : '助手'
      const content = (m.content || '').trim()
      return content ? `${role}: ${content}` : ''
    })
    .filter(Boolean)
    .join('\n')

  const truncated = [headText, tailText].filter(Boolean).join('\n...\n')
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `【对话内容（节选）】\n${truncated}\n\n请生成话题标题：` },
  ]
}

/**
 * Clean up the raw model output into a presentable title.
 */
function cleanTitle(raw: string): string {
  let t = raw.trim()

  // Strip reasoning/think blocks entirely. Some models (minimax, qwen, etc.)
  // emit `<think>...</think>` either at the start of the response or inline
  // before the actual answer. We don't want the chain-of-thought to leak into
  // the conversation title.
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  // Also drop a stray unclosed `<think>` block in case the model truncated.
  t = t.replace(/<think>[\s\S]*$/gi, '').trim()

  // Strip code fences if the model wrapped output in ```...```
  const fenceMatch = t.match(/^```[a-zA-Z]*\n?([\s\S]*?)```$/)
  if (fenceMatch) {
    t = fenceMatch[1].trim()
  }

  // Remove common prefixes
  const prefixes = [
    '标题：', '标题:', '话题：', '话题:',
    'Title:', 'title:', 'Topic:', 'topic:',
  ]
  for (const prefix of prefixes) {
    if (t.toLowerCase().startsWith(prefix.toLowerCase())) {
      t = t.slice(prefix.length).trim()
    }
  }

  // Remove surrounding quotes (Chinese or English)
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'")) ||
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith('「') && t.endsWith('」'))
  ) {
    t = t.slice(1, -1).trim()
  }

  // Remove trailing punctuation
  t = t.replace(/[。，,；;！!？?.]+$/, '')

  // Collapse internal newlines/extra whitespace into single spaces
  t = t.replace(/\s+/g, ' ').trim()

  // Enforce a reasonable max length. CJK prompt says 3-15 chars (fits 40
  // chars). English prompt says 3-10 words (up to ~60 chars), so 60 covers
  // both languages without truncating well-formed titles.
  const MAX = 60
  if (t.length > MAX) {
    t = t.slice(0, MAX - 1) + '…'
  }

  return t
}

/**
 * Generate a conversation title using the current conversation's model.
 *
 * @returns A cleaned title string, or null if generation failed / no content.
 */
export async function generateConversationTitle(
  messages: Message[],
  compressedContextSummary: string | null,
  config: TitleGeneratorModelConfig
): Promise<string | null> {
  try {
    // Need at least one user message with content to generate a meaningful title.
    const hasUserContent = messages.some(
      (m) => isHumanUserMessage(m) && (m.content || '').trim().length > 0
    )
    if (!hasUserContent) return null

    const chatMessages = buildTitleMessages(messages, compressedContextSummary)

    const provider = createLLMProvider({
      apiKey: config.apiKey || '',
      providerType: config.providerType,
      baseUrl: config.baseUrl,
      model: config.model,
      apiMode: config.apiMode,
    })

    // We intentionally do NOT pass maxTokens. Sending a low value risks
    // `finish_reason: "length"` truncation (minimax/qwen burn 50-100 tokens
    // on a <think>...</think> block before the actual answer), and sending
    // a high value is wasteful. Letting the model self-regulate via the
    // system prompt ("3-15 chars / 3-10 words") is more robust; cleanTitle()
    // enforces a 60-char hard cap as a safety net.
    const response = await provider.chat({
      messages: chatMessages,
    })

    const content = response.choices[0]?.message?.content
    if (!content) return null

    const cleaned = cleanTitle(content)
    return cleaned || null
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') console.error('[title-generator] Failed to generate title:', error)
    return null
  }
}

// Exported for testing
export { buildTitleMessages, cleanTitle, approxTokens }
