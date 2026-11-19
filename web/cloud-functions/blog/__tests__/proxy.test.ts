import { describe, expect, it } from 'vitest'
import { isCallerForwardingHeader, isSafeOriginPath, rewriteLocation } from '../proxy.js'

describe('isSafeOriginPath', () => {
  it('accepts ordinary blog paths', () => {
    expect(isSafeOriginPath('/blog')).toBe(true)
    expect(isSafeOriginPath('/blog/2026/11/hello-world')).toBe(true)
    expect(isSafeOriginPath('/blog/a%20b')).toBe(true)
  })

  it('rejects paths that leave the /blog prefix', () => {
    expect(isSafeOriginPath('/admin')).toBe(false)
    expect(isSafeOriginPath('/blog/%2e%2e/admin')).toBe(false)
    expect(isSafeOriginPath('/blog/%2f%2e%2e%2fadmin')).toBe(false)
    expect(isSafeOriginPath('/blog/%5c..%5cadmin')).toBe(false)
  })

  // #318: a malformed escape used to end the whole decode chain, so the
  // traversal segment behind it was never decoded or inspected.
  it('keeps validating other segments when one escape is undecodable', () => {
    expect(isSafeOriginPath('/blog/x%zz/%252e%252e/%252e%252e/wp-admin')).toBe(false)
    expect(isSafeOriginPath('/blog/x%zz/ok')).toBe(true)
    // A segment that is itself undecodable must not skip its own escapes:
    // `%2f` here would decode to a separator and expose the `..` segments.
    expect(isSafeOriginPath('/blog/x%zz..%2f..%2f')).toBe(false)
    expect(isSafeOriginPath('/blog/x%zz..%5c..%5c')).toBe(false)
  })

  // Regression for the literal-percent slug that a whole-path decoder 404'd.
  it('accepts a literal percent in a slug', () => {
    expect(isSafeOriginPath('/blog/100%25-coverage')).toBe(true)
  })
})

describe('isCallerForwardingHeader', () => {
  it('strips every client-address header a caller can invent', () => {
    for (const name of [
      'forwarded',
      'x-real-ip',
      'x-client-ip',
      'true-client-ip',
      'cf-connecting-ip',
      'x-forwarded-for',
      'x-forwarded-host',
    ]) {
      expect(isCallerForwardingHeader(name)).toBe(true)
    }
  })

  it('leaves ordinary headers alone', () => {
    expect(isCallerForwardingHeader('host')).toBe(false)
    expect(isCallerForwardingHeader('cookie')).toBe(false)
  })
})

describe('rewriteLocation', () => {
  const requestUrl = new URL('https://weave.eo2suite.cn/blog/sub/page')

  it('maps a root-relative origin redirect back under /blog', () => {
    expect(rewriteLocation('/wp-login.php', requestUrl, 'origin.local')).toBe('/blog/wp-login.php')
  })

  it('keeps nested relative redirects inside the prefix', () => {
    expect(rewriteLocation('wp-login.php', requestUrl, 'origin.local')).toBe(
      '/blog/sub/wp-login.php',
    )
  })

  // #318: the URL parser lowercases `target.host`, so a configured host with
  // uppercase characters used to fail the comparison and leak the origin host.
  it('matches a configured origin host case-insensitively', () => {
    expect(rewriteLocation('https://ORIGIN.Example/wp-admin', requestUrl, 'origin.example')).toBe(
      '/blog/wp-admin',
    )
    expect(rewriteLocation('https://origin.example/wp-admin', requestUrl, 'ORIGIN.EXAMPLE')).toBe(
      '/blog/wp-admin',
    )
  })

  it('leaves unrelated origins untouched', () => {
    expect(rewriteLocation('https://example.com/x', requestUrl, 'origin.local')).toBe(
      'https://example.com/x',
    )
  })
})
