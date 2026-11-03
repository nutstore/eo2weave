/**
 * Extension locale key parity (issue #143).
 *
 * `chrome.i18n` resolves a missing key by returning an EMPTY STRING — the
 * page then renders a blank label with no error anywhere. The extension
 * ships two locales (`en` and `zh_CN`), and a key present in one but not
 * the other means one of the two languages silently loses that string.
 *
 * The check also asserts the placeholder parity: a `$PARAM$` placeholder
 * declared in one locale but not in the other breaks the substitution for
 * that locale only.
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const LOCALES_DIR = path.resolve(__dirname, '../../../public/_locales')
const LOCALES = ['en', 'zh_CN'] as const

interface MessageEntry {
  message: string
  placeholders?: Record<string, { content: string }>
}

function readMessages(locale: string): Record<string, MessageEntry> {
  const file = path.join(LOCALES_DIR, locale, 'messages.json')
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, MessageEntry>
}

describe('extension locale parity', () => {
  const locales = Object.fromEntries(LOCALES.map(locale => [locale, readMessages(locale)])) as Record<(typeof LOCALES)[number], Record<string, MessageEntry>>

  it('ships the same key set in every locale', () => {
    const reference = new Set(Object.keys(locales.en))
    for (const locale of LOCALES) {
      const keys = new Set(Object.keys(locales[locale]))
      const missing = [...reference].filter(key => !keys.has(key))
      const extra = [...keys].filter(key => !reference.has(key))
      expect({ locale, missing, extra }).toEqual({ locale, missing: [], extra: [] })
    }
  })

  it('declares the same placeholders in every locale', () => {
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(locales[locale])) {
        const reference = locales.en[key]!
        expect({ locale, key, placeholders: Object.keys(entry.placeholders ?? {}).sort() })
          .toEqual({ locale, key, placeholders: Object.keys(reference.placeholders ?? {}).sort() })
      }
    }
  })

  it('uses only $PARAM$ placeholders (never the web app\'s {param} form)', () => {
    for (const locale of LOCALES) {
      for (const [key, entry] of Object.entries(locales[locale])) {
        expect({ locale, key, braces: /\{(\w+)\}/.test(entry.message) }).toEqual({ locale, key, braces: false })
        // Every `$NAME$` in the message must be declared as a placeholder.
        const used = [...entry.message.matchAll(/\$([A-Z_]+)\$/g)].map(match => match[1]!.toLowerCase())
        const declared = Object.keys(entry.placeholders ?? {})
        expect({ locale, key, undeclared: used.filter(name => !declared.includes(name)) })
          .toEqual({ locale, key, undeclared: [] })
      }
    }
  })

  it('carries the ported webmcpPackages strings in both locales', () => {
    const ported = Object.keys(locales.en).filter(key => key.startsWith('webmcpPackages'))
    // The 48 ported web-app strings + the page-level keys of the packages
    // management page + the registry-page extras.
    expect(ported.length).toBeGreaterThanOrEqual(48)
    for (const key of ported) expect(Object.keys(locales.zh_CN)).toContain(key)
  })

  it('defines EVERY key the extension pages use (a missing key renders blank)', () => {
    // The count/parity check above permits a REMOVED key: dropping the same
    // page-used key from BOTH locales keeps the parity and the count (finding:
    // "Locale test permits missing labels") while chrome.i18n resolves the key
    // to an EMPTY STRING and the page renders a blank label. This test pins
    // the exact key set the pages reference (registry page, popup, recipes
    // page; `webmcpPackagesRegistryChanged` is a runtime MESSAGE type, not a
    // locale key, and is deliberately absent).
    const REQUIRED_KEYS = [
      'webmcpPackagesAddRegistryButton',
      'webmcpPackagesAddRegistryHint',
      'webmcpPackagesAddRegistryInputPlaceholder',
      'webmcpPackagesAdding',
      'webmcpPackagesDescription',
      'webmcpPackagesInstall',
      'webmcpPackagesInstallSuccess',
      'webmcpPackagesInstalledActive',
      'webmcpPackagesInstalledInactive',
      'webmcpPackagesInstalledInactiveHint',
      'webmcpPackagesInstalledTitle',
      'webmcpPackagesInstalling',
      'webmcpPackagesMirrorNote',
      'webmcpPackagesNoPackages',
      'webmcpPackagesNoRegistries',
      'webmcpPackagesNotPersisted',
      'webmcpPackagesPageNote',
      'webmcpPackagesPageSubtitle',
      'webmcpPackagesPageTabTitle',
      'webmcpPackagesPageTitle',
      'webmcpPackagesPopupSummary',
      'webmcpPackagesRefresh',
      'webmcpPackagesRefreshing',
      'webmcpPackagesRegistryLabel',
      'webmcpPackagesRemoveRegistry',
      'webmcpPackagesTitle',
      'webmcpPackagesToolsCount',
      'webmcpPackagesToolsCountUnverified',
      'webmcpPackagesUninstall',
      'webmcpPackagesUninstalling',
      'webmcpPackagesVersion',
    ] as const
    for (const locale of LOCALES) {
      const keys = Object.keys(locales[locale])
      const missing = REQUIRED_KEYS.filter(key => !keys.includes(key))
      expect({ locale, missing }).toEqual({ locale, missing: [] })
    }
  })
})
