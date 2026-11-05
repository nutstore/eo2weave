/**
 * Slash-command description localization.
 *
 * The `/` dropdown shows a skill's description; when the skill ships
 * `description.<locale>:` frontmatter (e.g. `cw-legal-evidence-chain`), the
 * dropdown must show the translation for the ACTIVE UI locale. Resolution
 * happens at render time from the registry item, so switching language does
 * not require re-registering commands.
 */

import { describe, expect, it } from 'vitest'
import { resolveSlashCommandDescription } from '@/skills/slash-command-registry'

const item = {
  description: 'Use for lawyers evidence-chain work.',
  descriptionI18n: {
    'zh-CN': '面向律师的证据链工作技能。',
    ja: '弁護士向けの証拠チェーン作業スキル。',
  },
}

describe('resolveSlashCommandDescription', () => {
  it('uses the exact locale translation', () => {
    expect(resolveSlashCommandDescription(item, 'zh-CN')).toBe('面向律师的证据链工作技能。')
  })

  it('falls back to the language prefix when the region differs', () => {
    // Only `ja` is shipped; `ja-JP` must still localize.
    expect(resolveSlashCommandDescription(item, 'ja-JP')).toBe(
      '弁護士向けの証拠チェーン作業スキル。',
    )
  })

  it('falls back to the base description for untranslated locales', () => {
    expect(resolveSlashCommandDescription(item, 'ko-KR')).toBe(
      'Use for lawyers evidence-chain work.',
    )
    expect(resolveSlashCommandDescription(item, 'en-US')).toBe(
      'Use for lawyers evidence-chain work.',
    )
  })

  it('returns the base description for commands without translations', () => {
    expect(resolveSlashCommandDescription({ description: 'Compact the conversation.' }, 'zh-CN')).toBe(
      'Compact the conversation.',
    )
  })
})
