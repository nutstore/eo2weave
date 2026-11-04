import { describe, expect, it } from 'vitest'
import { t, translations } from '@creatorweave/i18n'
import type { Locale } from '@creatorweave/i18n/types'

const LOCALES: Locale[] = ['zh-CN', 'en-US', 'ja-JP', 'ko-KR']

/**
 * conversation.toast.workspaceSetupTimeout is read by the agent-run store's
 * workspace-setup timeout failure path (i18nText with an English fallback).
 * A missing key is invisible in the default locale but renders untranslated
 * English copy for every other locale, so all four must carry it.
 */
describe('workspaceSetupTimeout toast key', () => {
  it('exists in all four locales and never falls back to the raw key', () => {
    for (const locale of LOCALES) {
      const translated = t(locale, 'conversation.toast.workspaceSetupTimeout')
      expect(translated, `locale ${locale} is missing the key`).not.toBe(
        'conversation.toast.workspaceSetupTimeout'
      )
      expect(translated.length).toBeGreaterThan(0)
    }
  })

  it('keeps the en-US string identical to the code-side fallback', () => {
    // The run store passes this exact fallback; en-US must match it so the
    // copy stays stable regardless of which path produced the message.
    expect(t('en-US', 'conversation.toast.workspaceSetupTimeout')).toBe(
      'Preparing the workspace timed out — the run was stopped. Try again.'
    )
  })

  it('translates (rather than copies) the message in non-English locales', () => {
    const en = translations['en-US'].conversation.toast.workspaceSetupTimeout
    for (const locale of ['zh-CN', 'ja-JP', 'ko-KR'] as const) {
      expect(translations[locale].conversation.toast.workspaceSetupTimeout).not.toBe(en)
    }
  })
})
