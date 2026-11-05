import { describe, expect, it } from 'vitest'
import { t, translations, SUPPORTED_LOCALES, type Locale } from '@creatorweave/i18n'

describe('skills discovery translations', () => {
  it.each([
    ['zh-CN', '管理'],
    ['en-US', 'Manage'],
    ['ja-JP', '管理'],
    ['ko-KR', '관리'],
  ] satisfies Array<[Locale, string]>)('resolves tabManage for %s', (locale, expected) => {
    expect(t(locale, 'skills.discover.tabManage')).toBe(expected)
  })
})

/**
 * The skill-store install/update outcomes are rendered straight from
 * InstallProgress.message — they must exist in every locale, otherwise the
 * flow shows a raw key instead of a translated sentence (#154 review).
 */
const STORE_OUTCOME_KEYS = [
  'alreadyInstalled',
  'installedFiles',
  'alreadyInstalledVersion',
  'skippedUpdate',
  'updatedVersion',
  'progressPreparing',
  'progressDownloading',
  'progressDownloadingBytes',
  'progressValidating',
  'progressInstalling',
  'update',
  'updating',
  'updateDone',
] as const

describe('skill-store install outcome translations (#154)', () => {
  it.each(SUPPORTED_LOCALES)('resolves every store outcome key for %s', (locale) => {
    for (const key of STORE_OUTCOME_KEYS) {
      const value = t(locale, `skills.discover.${key}`)
      expect(value, `skills.discover.${key} missing for ${locale}`).not.toBe(`skills.discover.${key}`)
      expect(value.length).toBeGreaterThan(0)
    }
  })

  it.each(SUPPORTED_LOCALES)('resolves the skill-install update button for %s', (locale) => {
    const value = t(locale, 'skillInstall.updateButton', { version: '1.2.3' })
    expect(value).not.toBe('skillInstall.updateButton')
    expect(value).toContain('1.2.3')
  })

  it('keeps the four locales in sync for the new keys', () => {
    const keySets = SUPPORTED_LOCALES.map((locale) => {
      const discover = (translations[locale] as Record<string, any>).skills?.discover
      expect(discover, `skills.discover missing for ${locale}`).toBeTruthy()
      return new Set(Object.keys(discover))
    })
    const [first, ...rest] = keySets
    for (const other of rest) {
      // Same key sets across locales — no key added to one locale only.
      expect([...other].sort()).toEqual([...first].sort())
    }
  })
})
