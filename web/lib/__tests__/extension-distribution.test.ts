import { describe, expect, it } from 'vitest'
import type { GuideMethod } from '../extension-distribution'
import { CHROME_WEB_STORE_URL } from '../extension-distribution'

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

  it('exposes the GuideMethod union used by the install guide', () => {
    // The guide's two methods — kept as a canary so a rename here forces a
    // conscious update of the guide's method-switching logic.
    const methods: GuideMethod[] = ['store', 'zip']
    expect(methods).toHaveLength(2)
  })
})
