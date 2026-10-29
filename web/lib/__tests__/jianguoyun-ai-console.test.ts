// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { getNutstoreAIConsoleURL } from '../jianguoyun-ai-console'

/**
 * The Nutstore AI console (login / credit balance / top-up) lives at the
 * root of the SAME host that serves the gateway API under `{base}/v1`.
 * The recharge entries must therefore resolve the host from the
 * deployment's configured base URL — a demo deployment pointing at
 * ai-demo.jianguoyun.com must not send the user to production.
 */
describe('getNutstoreAIConsoleURL', () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL
    else process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL = ORIGINAL
  })

  it('follows the configured base URL (demo deployment stays on demo)', () => {
    process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL = 'https://ai-demo.jianguoyun.com'
    expect(getNutstoreAIConsoleURL()).toBe('https://ai-demo.jianguoyun.com')
  })

  it('falls back to the production host when unset', () => {
    delete process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL
    expect(getNutstoreAIConsoleURL()).toBe('https://ai.jianguoyun.com')
  })

  it('strips a trailing slash so the URL is usable as a base', () => {
    process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL = 'https://ai.jianguoyun.com/'
    expect(getNutstoreAIConsoleURL()).toBe('https://ai.jianguoyun.com')
    process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL = 'https://ai.jianguoyun.com///'
    expect(getNutstoreAIConsoleURL()).toBe('https://ai.jianguoyun.com')
  })

  it('never returns an empty string (a blank base URL would break the entry)', () => {
    process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL = '   '
    expect(getNutstoreAIConsoleURL()).not.toBe('')
    expect(getNutstoreAIConsoleURL()).toContain('http')
  })
})
