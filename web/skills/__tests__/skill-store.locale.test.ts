import { describe, expect, it } from 'vitest'
import { selectLocalizedDescription, SKILL_STORE_UI_LOCALES } from '@/skills/skill-store'

describe('selectLocalizedDescription', () => {
  const entry = {
    description: 'Base English description',
    description_i18n: {
      'zh-CN': '中文描述',
      'ja-JP': '日本語の説明',
      'ko-KR': '한국어 설명',
    },
  }

  it('returns the base description for en-US even when translations exist', () => {
    expect(selectLocalizedDescription(entry, 'en-US')).toBe('Base English description')
  })

  it('returns the translation for an exact locale match (#139 review: store ignores translated descriptions)', () => {
    expect(selectLocalizedDescription(entry, 'zh-CN')).toBe('中文描述')
    expect(selectLocalizedDescription(entry, 'ja-JP')).toBe('日本語の説明')
    expect(selectLocalizedDescription(entry, 'ko-KR')).toBe('한국어 설명')
  })

  it('falls back to the language prefix when only `ja`/`ko` style keys exist', () => {
    const partial = {
      description: 'Base English description',
      description_i18n: { ja: '日本語の説明 (ja)' },
    }
    expect(selectLocalizedDescription(partial, 'ja-JP')).toBe('日本語の説明 (ja)')
  })

  it('falls back to the base description when the locale has no translation', () => {
    const noKo = {
      description: 'Base English description',
      description_i18n: { 'zh-CN': '中文描述' },
    }
    expect(selectLocalizedDescription(noKo, 'ko-KR')).toBe('Base English description')
  })

  it('falls back to the base description when description_i18n is absent', () => {
    expect(selectLocalizedDescription({ description: 'Only base' }, 'zh-CN')).toBe('Only base')
  })

  it('covers all four UI locales (#139 review: skill descriptions miss two locales)', () => {
    expect([...SKILL_STORE_UI_LOCALES].sort()).toEqual(['en-US', 'ja-JP', 'ko-KR', 'zh-CN'])
  })
})
