import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GuideMethod } from '../extension-distribution'
import {
  CHROME_WEB_STORE_URL,
  EDGE_ADDONS_URL,
  getPreferredStoreUrl,
  isEdgeBrowser,
  isMobileDeviceForExtension,
} from '../extension-distribution'

/**
 * Pure-constants module: both install options ship in EVERY build (users
 * behind mainland-China networks may still reach the store via VPN, and
 * store-blocked users fall back to the zip). The only contract worth
 * locking is the store listing URL format — a typo here would send every
 * store-flow user to a 404.
 */
describe('lib/extension-distribution', () => {
  it('exposes a well-formed Chrome Web Store listing URL', () => {
    expect(CHROME_WEB_STORE_URL).toMatch(
      /^https:\/\/chromewebstore\.google\.com\/detail\/eo2weave\/[a-p]{32}$/,
    )
  })

  it('exposes a well-formed Edge Add-ons listing URL', () => {
    expect(EDGE_ADDONS_URL).toMatch(
      /^https:\/\/microsoftedge\.microsoft\.com\/addons\/detail\/eo2weave\/[a-p]{32}$/,
    )
  })

  it('prefers Edge Add-ons on Edge and Chrome Web Store elsewhere', () => {
    // getPreferredStoreUrl reads navigator.userAgent; stub it for both cases.
    const realNavigator = globalThis.navigator
    const withUa = (ua: string) =>
      Object.defineProperty(globalThis, 'navigator', {
        value: { userAgent: ua },
        configurable: true,
        writable: true,
      })
    try {
      withUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0')
      expect(isEdgeBrowser()).toBe(true)
      expect(getPreferredStoreUrl()).toBe(EDGE_ADDONS_URL)
      withUa('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
      expect(isEdgeBrowser()).toBe(false)
      expect(getPreferredStoreUrl()).toBe(CHROME_WEB_STORE_URL)
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: realNavigator,
        configurable: true,
        writable: true,
      })
    }
  })

  it('exposes the GuideMethod union used by the install guide', () => {
    // The guide's two methods — kept as a canary so a rename here forces a
    // conscious update of the guide's method-switching logic.
    const methods: GuideMethod[] = ['store', 'zip']
    expect(methods).toHaveLength(2)
  })
})

/**
 * `isMobileDeviceForExtension` decides whether the web tools are registered at
 * all: mobile devices cannot install an extension, so an install prompt there
 * is advice the user cannot act on.
 */
describe('isMobileDeviceForExtension', () => {
  afterEach(() => vi.unstubAllGlobals())

  const IPHONE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const LEGACY_IPAD_UA =
    'Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/12.0 Mobile/15E148 Safari/604.1'
  /** iPadOS 13+ reports a desktop Safari UA — the case a UA string alone cannot answer. */
  const IPAD_DESKTOP_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
  const MAC_UA =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  const ANDROID_UA =
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'

  const withPlatform = (userAgent: string, maxTouchPoints: number) =>
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints })

  it('is SSR-safe', () => {
    vi.stubGlobal('navigator', undefined)
    expect(isMobileDeviceForExtension()).toBe(false)
  })

  it.each([
    ['iPhone', IPHONE_UA, 5],
    ['pre-iPadOS-13 iPad', LEGACY_IPAD_UA, 5],
    ['Android', ANDROID_UA, 5],
    ['iPadOS 13+ reporting a desktop UA', IPAD_DESKTOP_UA, 5],
  ])('treats %s as mobile', (_label, userAgent, maxTouchPoints) => {
    withPlatform(userAgent, maxTouchPoints as number)
    expect(isMobileDeviceForExtension()).toBe(true)
  })

  it('keeps a real Mac on the desktop path', () => {
    withPlatform(MAC_UA, 0)
    expect(isMobileDeviceForExtension()).toBe(false)
  })
})
