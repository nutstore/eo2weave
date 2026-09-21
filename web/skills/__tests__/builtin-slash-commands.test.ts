import { describe, it, expect } from 'vitest'
import {
  BUILTIN_SLASH_COMMANDS,
  normalizeLang,
  truncatePageText,
  PAGE_TEXT_MAX_CHARS,
} from '../builtin-slash-commands'
import { matchesBuiltinCommand } from '../builtin-slash-exec'

const tr = (key: string) => {
  const map: Record<string, string> = {
    summary: '请总结以下内容：回复语言与内容语言一致。',
    translate: '请将以下内容翻译为{lang}。只输出译文。',
    explain: '请解释以下内容：回复语言与内容语言一致。',
    polish: '请润色以下文字：回复语言与内容语言一致。',
    titles: '基于以下内容生成 5 个备选标题。标题语言与内容语言一致。',
    subjectInline: '输入的文字',
    subjectSelection: '选中的文本',
    subjectPage: '页面内容',
    truncated: '[...内容过长已截断]',
  }
  return map[key] ?? key
}

describe('builtin slash command pack', () => {
  it('contains the P0 commands in dropdown order', () => {
    expect(BUILTIN_SLASH_COMMANDS.map((c) => c.id)).toEqual([
      'summary',
      'translate',
      'explain',
      'polish',
      'titles',
    ])
  })

  it('every command produces a non-empty prompt for a selection', () => {
    const ctx = {
      selection: '被选中的文本内容',
      pageText: null,
      pageTitle: '示例页面',
      pageUrl: 'https://example.com',
    }
    for (const def of BUILTIN_SLASH_COMMANDS) {
      const prompt = def.buildPrompt({ ...ctx, langArg: 'en' }, tr)
      expect(prompt).toContain('被选中的文本内容')
      expect(prompt).toContain('示例页面')
      expect(prompt).toContain('选中的文本')
    }
  })

  it('translate builds a language-specific prompt', () => {
    const ctx = {
      selection: 'hello world',
      pageText: null,
      pageTitle: null,
      pageUrl: null,
    }
    const en = BUILTIN_SLASH_COMMANDS.find((c) => c.id === 'translate')!
    expect(en.buildPrompt({ ...ctx, langArg: 'en' }, tr)).toContain('英文')
    expect(en.buildPrompt({ ...ctx, langArg: undefined }, tr)).toContain('中文')
    expect(en.buildPrompt({ ...ctx, langArg: '法语' }, tr)).toContain('法语')
  })

  it('falls back to page text only when no selection', () => {
    const def = BUILTIN_SLASH_COMMANDS.find((c) => c.id === 'summary')!
    const pageOnly = def.buildPrompt(
      {
        selection: null,
        pageText: '页面正文',
        pageTitle: 'T',
        pageUrl: null,
      },
      tr,
    )
    expect(pageOnly).toContain('页面正文')
    expect(pageOnly).toContain('页面内容')
    const selectionWins = def.buildPrompt(
      {
        selection: '选中的',
        pageText: '页面正文',
        pageTitle: 'T',
        pageUrl: null,
      },
      tr,
    )
    expect(selectionWins).toContain('选中的')
    expect(selectionWins).not.toContain('页面正文')
  })

  it('inline subject without page meta uses neutral header', () => {
    const def = BUILTIN_SLASH_COMMANDS.find((c) => c.id === 'polish')!
    const prompt = def.buildPrompt(
      {
        selection: '我的文字',
        pageText: null,
        pageTitle: null,
        pageUrl: null,
      },
      tr,
    )
    expect(prompt).toContain('【输入的文字】')
    expect(prompt).toContain('我的文字')
  })

  it('normalizeLang maps codes and passes through unknowns', () => {
    expect(normalizeLang('en')).toBe('英文')
    expect(normalizeLang('ZH')).toBe('中文')
    expect(normalizeLang()).toBe('中文')
    expect(normalizeLang(' Klingon ')).toBe('Klingon')
  })

  it('truncatePageText marks truncation', () => {
    expect(truncatePageText('short')).toBe('short')
    const long = truncatePageText('x'.repeat(PAGE_TEXT_MAX_CHARS + 10))
    expect(long).toContain('内容过长已截断')
    expect(long.length).toBeLessThan(PAGE_TEXT_MAX_CHARS + 50)
  })
})

describe('matchesBuiltinCommand', () => {
  it('matches exact and arg-bearing invocations', () => {
    expect(matchesBuiltinCommand('/summary')).toBe(true)
    expect(matchesBuiltinCommand('/translate en')).toBe(true)
    expect(matchesBuiltinCommand('/translate  Japanese  ')).toBe(true)
  })

  it('rejects non-builtin or non-command inputs', () => {
    expect(matchesBuiltinCommand('/unknowncmd')).toBe(false)
    expect(matchesBuiltinCommand('/compact')).toBe(false) // legacy, handled separately
    expect(matchesBuiltinCommand('hello /summary')).toBe(false)
    expect(matchesBuiltinCommand('')).toBe(false)
    expect(matchesBuiltinCommand('/translate')).toBe(true) // arg optional
  })
})
