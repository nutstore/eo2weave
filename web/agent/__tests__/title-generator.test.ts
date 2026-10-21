/**
 * Tests for title-generator pure helpers: buildTitleMessages and cleanTitle.
 *
 * The actual generateConversationTitle() needs a live LLM provider and is
 * covered by integration/E2E tests. Here we focus on the deterministic
 * context-window strategy and output cleanup.
 */

import { describe, it, expect } from 'vitest'
import type { Message } from '../message-types'
import { buildTitleMessages, cleanTitle, approxTokens } from '../title-generator'

function userMsg(content: string, id = String(Math.random())): Message {
  return { role: 'user', id, content, timestamp: 0 } as unknown as Message
}
function assistantMsg(content: string, id = String(Math.random())): Message {
  return { role: 'assistant', id, content, timestamp: 0 } as unknown as Message
}

describe('approxTokens', () => {
  it('builds titles only from dialogue, not tool payloads or synthetic user roles', () => {
    const messages: Message[] = [
      userMsg('Plan a trip'),
      { ...userMsg('private state'), kind: 'context_update' },
      { ...userMsg('private delegation'), delegationNote: { fromAgentId: 'a', task: 'task' } },
      { ...assistantMsg('private tool output'), role: 'tool' },
      { ...assistantMsg('private change'), kind: 'run_changes' },
      assistantMsg('Visit Kyoto'),
    ]
    for (const summary of [null, 'Earlier conversation']) {
      const output = JSON.stringify(buildTitleMessages(messages, summary))
      expect(output).toContain('Plan a trip')
      expect(output).toContain('Visit Kyoto')
      expect(output).not.toContain('private')
    }
  })

  it('estimates ~tokens using char length / 3', () => {
    expect(approxTokens('')).toBe(0)
    expect(approxTokens('abc')).toBe(1)
    expect(approxTokens('a'.repeat(60))).toBe(20)
  })
})

describe('cleanTitle', () => {
  it('strips common Chinese prefixes', () => {
    expect(cleanTitle('标题：项目计划讨论')).toBe('项目计划讨论')
    expect(cleanTitle('话题:数据库优化')).toBe('数据库优化')
  })

  it('strips common English prefixes case-insensitively', () => {
    expect(cleanTitle('Title: Refactor the auth flow')).toBe('Refactor the auth flow')
    expect(cleanTitle('topic: design review')).toBe('design review')
  })

  it('removes surrounding double/single/CJK quotes', () => {
    expect(cleanTitle('"数据库优化"')).toBe('数据库优化')
    expect(cleanTitle("'auth'")).toBe('auth')
    expect(cleanTitle('「前端性能」')).toBe('前端性能')
  })

  it('removes trailing Chinese and English punctuation', () => {
    expect(cleanTitle('数据库优化！')).toBe('数据库优化')
    expect(cleanTitle('What is this?')).toBe('What is this')
    expect(cleanTitle('Some title...')).toBe('Some title')
  })

  it('strips code fences', () => {
    expect(cleanTitle('```\n项目计划\n```')).toBe('项目计划')
    expect(cleanTitle('```text\nRefactor\n```')).toBe('Refactor')
  })

  it('collapses internal whitespace', () => {
    expect(cleanTitle('foo\n\n  bar   baz')).toBe('foo bar baz')
  })

  it('truncates long output with ellipsis', () => {
    const long = 'a'.repeat(80)
    expect(cleanTitle(long)).toMatch(/^a{59}…$/)
  })

  it('returns empty string for whitespace-only input', () => {
    expect(cleanTitle('   \n  ')).toBe('')
  })

  it('strips <think>...</think> blocks (minimax / qwen reasoning style)', () => {
    // Properly closed block followed by content
    expect(
      cleanTitle('<think>The user is asking about database optimization.</think>数据库优化')
    ).toBe('数据库优化')
    // Multi-line reasoning inside the block
    expect(
      cleanTitle('<think>Let me think...\nThis is about caching.</think>数据库缓存方案')
    ).toBe('数据库缓存方案')
    // Case-insensitive tag
    expect(cleanTitle('<THINK>foo</THINK>项目计划')).toBe('项目计划')
  })

  it('drops an unclosed <think> block at the end (truncated stream)', () => {
    expect(cleanTitle('数据库优化<think>still reasoning about...')).toBe('数据库优化')
  })
})

describe('buildTitleMessages', () => {
  it('uses a bilingual system prompt (zh + en) so the model can match either language', () => {
    const out = buildTitleMessages(
      [userMsg('any message', '1'), assistantMsg('any reply', '2')],
      null
    )
    expect(out[0].role).toBe('system')
    expect(out[0].content).toMatch(/根据以下对话内容/)
    expect(out[0].content).toMatch(/Match the language of the user messages/)
  })

  it('returns compressed-branch payload when summary is present', () => {
    const messages = [
      userMsg('第一条消息', '1'),
      assistantMsg('第一条回复', '2'),
      userMsg('第二条消息', '3'),
      assistantMsg('第二条回复', '4'),
    ]
    const out = buildTitleMessages(messages, '压缩摘要：用户在讨论数据库优化')

    expect(out).toHaveLength(2)
    expect(out[0].role).toBe('system')
    expect(out[1].role).toBe('user')

    // The user content should include both the summary and the recent tail.
    const user = out[1].content
    expect(user).toContain('压缩摘要')
    expect(user).toContain('数据库优化')
    expect(user).toContain('最近对话')
    expect(user).toContain('第一条消息') // present in the recent window
    expect(user).toContain('第二条回复')
  })

  it('only keeps the last 6 messages in compressed mode', () => {
    const messages: Message[] = []
    for (let i = 0; i < 20; i++) {
      messages.push(userMsg(`msg-${i}`, String(i)))
      messages.push(assistantMsg(`reply-${i}`, String(i + 100)))
    }
    const out = buildTitleMessages(messages, 'summary')
    const user = out[1].content

    // The very first message should NOT be in the recent window.
    expect(user).not.toContain('msg-0')
    // The most recent messages SHOULD be present.
    expect(user).toContain('msg-19')
    expect(user).toContain('reply-19')
  })

  it('feeds all messages when no summary and transcript fits budget', () => {
    const messages = [
      userMsg('hi', '1'),
      assistantMsg('hello', '2'),
      userMsg('how are you?', '3'),
    ]
    const out = buildTitleMessages(messages, null)
    expect(out).toHaveLength(2)

    const user = out[1].content
    expect(user).toContain('hi')
    expect(user).toContain('hello')
    expect(user).toContain('how are you?')
    expect(user).not.toContain('对话内容（节选）')
  })

  it('falls back to head+tail when transcript exceeds budget without summary', () => {
    // Build a huge transcript that blows past NO_COMPRESS_TOKEN_BUDGET (4000)
    const hugeUser = 'x'.repeat(15000) // ~5000 tokens
    const messages = [
      userMsg('first important user message', '1'),
      assistantMsg('reply to first', '2'),
      userMsg(hugeUser, '3'),
      assistantMsg('reply to huge', '4'),
      userMsg('last user message', '5'),
      assistantMsg('last reply', '6'),
    ]
    const out = buildTitleMessages(messages, null)
    const user = out[1].content

    // Head+tail mode marker
    expect(user).toContain('对话内容（节选）')
    // First user message preserved
    expect(user).toContain('first important user message')
    // Recent messages preserved
    expect(user).toContain('last user message')
    expect(user).toContain('last reply')
  })
})
