/**
 * Bounded section loads (issue #208).
 *
 * A packages-page list request that never settles used to leave its section
 * blank forever: no failure, no error box, no retry. `withTimeout` converts a
 * hang into an ordinary rejection the sections already render.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// t() falls back to the key when chrome.i18n has no message for it.
const chromeStub = { i18n: { getMessage: () => '' } }

import { SECTION_LOAD_TIMEOUT_MS, withTimeout } from '../shared'

describe('withTimeout', () => {
  beforeEach(() => {
    vi.stubGlobal('chrome', chromeStub)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes a settled value through and clears its timer', async () => {
    const result = withTimeout(Promise.resolve('ok'), 1000, 'webmcpPackagesLoadTimeout')

    await expect(result).resolves.toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('forwards a real failure unchanged and clears its timer', async () => {
    const result = withTimeout(Promise.reject(new Error('boom')), 1000, 'webmcpPackagesLoadTimeout')

    await expect(result).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects with the localized message when the request never settles', async () => {
    const result = withTimeout(new Promise<string>(() => {}), 1000, 'webmcpPackagesLoadTimeout')
    const assertion = expect(result).rejects.toThrow('webmcpPackagesLoadTimeout')

    await vi.advanceTimersByTimeAsync(1000)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not fire before the deadline', async () => {
    let settled = false
    const result = withTimeout(new Promise<string>(() => {}), SECTION_LOAD_TIMEOUT_MS, 'key')
    result.catch(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(SECTION_LOAD_TIMEOUT_MS - 1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(settled).toBe(true)
  })
})
