import { describe, expect, it } from 'vitest'
import { translations } from '@creatorweave/i18n'
import { SUPPORTED_LOCALES } from '@creatorweave/i18n'

// Issue: webmcpPackages was registered at the locale root instead of under
// settings, so every `settings.webmcpPackages.*` key fell through to the
// raw-key fallback on the WebMCP packages settings section (#140 follow-up).
const KEYS = ['title', 'description', 'noRegistries', 'addRegistryTitle', 'addRegistryButton', 'install', 'refresh', 'removeRegistry']

describe('settings.webmcpPackages i18n registration', () => {
  it.each(SUPPORTED_LOCALES)('resolves all core keys under settings.webmcpPackages for %s', (locale) => {
    const dict = translations[locale] as Record<string, any>
    const section = dict.settings?.webmcpPackages
    expect(section, `settings.webmcpPackages missing for ${locale}`).toBeTruthy()
    for (const key of KEYS) {
      expect(typeof section[key]).toBe('string')
      expect((section[key] as string).length).toBeGreaterThan(0)
    }
    // Must NOT be double-registered at the root (would silently drift).
    expect((dict as Record<string, any>).webmcpPackages).toBeUndefined()
  })
})
