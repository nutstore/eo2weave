import { describe, expect, it, vi } from 'vitest'
import {
  assertPublicWebUrl,
  fetchPublicWebUrl,
  PublicUrlRefusedError,
} from '../../../browser-extension/entrypoints/webmcp/public-http-guard'
import {
  assertPublicHttpsDownloadUrl,
  streamPluginDownload,
} from '../../../browser-extension/entrypoints/webmcp/plugin-download-transfer'

/**
 * web_fetch / web_fetch_render hand an agent-supplied URL to the extension's
 * background worker, which has host permissions the page does not. #157: the
 * initial URL was parsed but the fetch used the default `redirect: 'follow'`,
 * so a public URL answering 302 with `Location: http://169.254.169.254/...`
 * (or 127.0.0.1:port, or an intranet host) was followed and the private
 * response returned to the agent context — the same hole #148 closed for
 * plugin downloads.
 *
 * The background handlers themselves need heavy chrome.* mocks to unit-test
 * (same as the MCP proxy note in plugin-download-transfer.test.ts), so this
 * file pins the contract they now delegate to: the shared address-space guard
 * and the redirect-revalidating fetch in public-http-guard.ts.
 */

/** Mock a single redirect response (Location is readable only when the engine
 * exposes it with redirect: 'manual'; the loop must validate it either way). */
const redirect = (status: number, location: string) => ({
  ok: false,
  status,
  type: 'basic' as const,
  url: '',
  headers: new Headers({ location }),
  text: async () => '',
  arrayBuffer: async () => new ArrayBuffer(0),
})

const ok = (body = 'ok') => ({
  ok: true,
  status: 200,
  type: 'basic' as const,
  url: '',
  headers: new Headers({ 'content-type': 'text/plain' }),
  text: async () => body,
  arrayBuffer: async () => new ArrayBuffer(body.length),
})

/** Swap globalThis.fetch for one test and always restore it. */
async function withFetch(
  impl: (url: string, init?: RequestInit) => unknown,
  run: (spy: ReturnType<typeof vi.fn>) => Promise<void>,
) {
  const calls: string[] = []
  const spy = vi.fn(async (input: string | URL, init?: RequestInit) => {
    calls.push(String(input))
    return impl(String(input), init)
  })
  const original = globalThis.fetch
  globalThis.fetch = spy as unknown as typeof fetch
  try {
    await run(spy as unknown as ReturnType<typeof vi.fn>)
  } finally {
    globalThis.fetch = original
  }
  return calls
}

const requestedUrls = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map(call => String(call[0]))

describe('web_fetch URL validation (#157)', () => {
  it('refuses private / loopback / metadata targets BEFORE any request is made', async () => {
    const blocked = [
      'http://127.0.0.1:8080/admin',
      'http://localhost:3000/',
      'http://localhost./',
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://[::1]:9000/metrics',
      'http://[::ffff:127.0.0.1]/',
      'http://10.0.0.5/',
      'http://172.16.4.4/',
      'http://192.168.1.10/',
      'http://100.64.0.1/',
      'http://0.0.0.0/',
      'http://metadata.google.internal/computeMetadata/v1/',
      'http://printer.local/status',
      'http://intranet/',
      // Non-http(s) schemes reached the same privileged fetch before.
      'file:///etc/passwd',
    ]
    const calls = await withFetch(
      () => ok(),
      async (spy) => {
        for (const url of blocked) {
          await expect(fetchPublicWebUrl(url)).rejects.toThrow(/not allowed|must use/)
          // Structural refusal marker: callers map this to a NON-retryable
          // tool error instead of a generic fetch failure.
          await expect(fetchPublicWebUrl(url)).rejects.toBeInstanceOf(PublicUrlRefusedError)
        }
        expect(spy).not.toHaveBeenCalled()
      },
    )
    expect(calls).toEqual([])
  })

  it('refuses 6to4 literals that embed a forbidden IPv4 address (#157 round 2)', () => {
    // 2002::/16 carries the IPv4 target in bits 16-47 (RFC 3056), so these
    // literals route to the embedded address through a 6to4 gateway.
    for (const url of [
      'http://[2002:0a00:0001::1]/',        // 10.0.0.1
      'http://[2002:c0a8:0101::]/',         // 192.168.1.1
      'http://[2002:7f00:0001::]/',         // 127.0.0.1
      'http://[2002:a9fe:a9fe::]/',         // 169.254.169.254
    ]) {
      expect(() => assertPublicWebUrl(url)).toThrow(/not allowed/)
    }
    // A 6to4 literal embedding a public IPv4 address stays fetchable.
    expect(() => assertPublicWebUrl('http://[2002:0808:0808::]/')).not.toThrow()
  })

  it('refuses local-DNS hostnames such as router.lan (#157 round 2)', () => {
    // These suffixes are never delegated publicly: they resolve only through
    // the host's search domains / mDNS, i.e. to intranet addresses.
    for (const url of ['http://router.lan/', 'http://nas.lan:5000/api', 'http://printer.home/']) {
      expect(() => assertPublicWebUrl(url)).toThrow(/not allowed/)
    }
    expect(() => assertPublicWebUrl('https://example.com/')).not.toThrow()
  })

  it('accepts ordinary public http(s) URLs', () => {
    expect(() => assertPublicWebUrl('https://example.com/article')).not.toThrow()
    expect(() => assertPublicWebUrl('http://example.com/legacy')).not.toThrow()
    expect(() => assertPublicWebUrl('https://8.8.8.8/')).not.toThrow()
    expect(assertPublicWebUrl('https://example.com/a?b=1#c').href).toBe('https://example.com/a?b=1#c')
  })
})

describe('web_fetch redirect discipline (#157, same pattern as #148)', () => {
  it('refuses a public URL that redirects to the cloud metadata endpoint and never contacts it', async () => {
    const calls = await withFetch(
      () => redirect(302, 'http://169.254.169.254/latest/meta-data/iam/security-credentials/'),
      async (spy) => {
        await expect(fetchPublicWebUrl('https://example.com/redirect-me')).rejects.toThrow(/host is not allowed: 169\.254\.169\.254/)
        // Exactly one request — the public first hop. The redirect target is
        // validated before it is fetched, so no request ever reaches 169.254.
        expect(requestedUrls(spy)).toEqual(['https://example.com/redirect-me'])
        expect(requestedUrls(spy).some(url => url.includes('169.254.169.254'))).toBe(false)
        // The privileged fetch must never let the browser follow on its own.
        expect(spy.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' })
      },
    )
    expect(calls).toHaveLength(1)
  })

  it('refuses a redirect into loopback / intranet just like a direct target', async () => {
    for (const target of ['http://127.0.0.1:11434/api/tags', 'http://192.168.1.1/', 'http://[::1]/']) {
      await withFetch(
        () => redirect(301, target),
        async (spy) => {
          await expect(fetchPublicWebUrl('https://example.com/x')).rejects.toBeInstanceOf(PublicUrlRefusedError)
          expect(requestedUrls(spy)).toEqual(['https://example.com/x'])
        },
      )
    }
  })

  it('follows public→public redirect chains, revalidating every hop, and caps the hop count', async () => {
    // Two hops, each relative-or-absolute, then a 200.
    let hop = 0
    await withFetch(
      () => (hop++ < 2 ? redirect(302, `/hop-${hop}`) : ok('final')),
      async (spy) => {
        const response = await fetchPublicWebUrl('https://example.com/start')
        expect(await response.text()).toBe('final')
        expect(requestedUrls(spy)).toEqual([
          'https://example.com/start',
          'https://example.com/hop-1',
          'https://example.com/hop-2',
        ])
      },
    )

    // Endless chain: initial request + 5 followed hops, then refused.
    await withFetch(
      () => redirect(302, 'https://example.com/again'),
      async (spy) => {
        await expect(fetchPublicWebUrl('https://example.com/start')).rejects.toThrow(/exceeded 5 redirects/)
        expect(spy).toHaveBeenCalledTimes(6)
      },
    )
  })

  it('refuses an opaque-redirect response instead of returning a misleading status 0', async () => {
    // In Chrome a 3xx met with redirect: 'manual' is filtered to an
    // opaque-redirect response (status 0, empty header list): the Location is
    // unreadable, so the hop loop cannot run and the fetch must refuse.
    await withFetch(
      () => ({
        ok: false,
        status: 0,
        type: 'opaqueredirect' as const,
        url: '',
        headers: new Headers(),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
      async (spy) => {
        await expect(fetchPublicWebUrl('https://example.com/start')).rejects.toThrow(/redirected; redirects are not followed/)
        // No blind follow: exactly one request, no attempt at an unknown target.
        expect(spy).toHaveBeenCalledTimes(1)
      },
    )
  })

  it('drops caller credentials and the request body on a cross-origin redirect hop', async () => {
    // A 307 asks for the method + body to be replayed — the cross-origin rule
    // still must not forward the caller's secrets or payload to the host the
    // server chose.
    const seen: Array<RequestInit | undefined> = []
    await withFetch(
      (_url, init) => {
        seen.push(init)
        return seen.length === 1 ? redirect(307, 'https://cdn.example-cdn.net/collect') : ok('final')
      },
      async () => {
        const response = await fetchPublicWebUrl('https://example.com/api', {
          method: 'POST',
          headers: {
            authorization: 'Bearer sk-live-secret',
            'x-api-key': 'key-123',
            'content-type': 'application/json',
            'x-trace-id': 'abc',
          },
          body: '{"secret":"value"}',
        })
        expect(response.status).toBe(200)
      },
    )
    expect(seen).toHaveLength(2)
    const hop = seen[1]!
    const headers = new Headers(hop.headers)
    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('content-type')).toBeNull()
    // Non-credential headers still ride along.
    expect(headers.get('x-trace-id')).toBe('abc')
    expect(hop.method).toBe('GET')
    expect(hop.body).toBeUndefined()
    expect(hop.redirect).toBe('manual')
  })

  it('applies the Fetch method rules: 302 POST→GET, 307 keeps method and body', async () => {
    const seen302: Array<RequestInit | undefined> = []
    await withFetch(
      (_url, init) => {
        seen302.push(init)
        return seen302.length === 1 ? redirect(302, '/next') : ok()
      },
      async () => {
        await fetchPublicWebUrl('https://example.com/form', {
          method: 'POST',
          headers: { 'content-type': 'text/plain', 'x-trace-id': 'abc' },
          body: 'a=1',
        })
      },
    )
    expect(seen302).toHaveLength(2)
    expect(seen302[1]!.method).toBe('GET')
    expect(seen302[1]!.body).toBeUndefined()
    expect(new Headers(seen302[1]!.headers).get('content-type')).toBeNull()
    // Same-origin hop: ordinary headers survive.
    expect(new Headers(seen302[1]!.headers).get('x-trace-id')).toBe('abc')

    const seen307: Array<RequestInit | undefined> = []
    await withFetch(
      (_url, init) => {
        seen307.push(init)
        return seen307.length === 1 ? redirect(307, '/next') : ok()
      },
      async () => {
        await fetchPublicWebUrl('https://example.com/form', {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'a=1',
        })
      },
    )
    expect(seen307[1]!.method).toBe('POST')
    expect(seen307[1]!.body).toBe('a=1')
    expect(new Headers(seen307[1]!.headers).get('content-type')).toBe('text/plain')
  })

  it('returns non-redirect 3xx responses (304, 300) instead of refusing them', async () => {
    const notModified = {
      ok: false,
      status: 304,
      type: 'basic' as const,
      url: '',
      headers: new Headers({ etag: '"v1"' }),
      text: async () => '',
      arrayBuffer: async () => new ArrayBuffer(0),
    }
    await withFetch(
      () => notModified,
      async (spy) => {
        const response = await fetchPublicWebUrl('https://example.com/cache')
        expect(response.status).toBe(304)
        expect(response.headers.get('etag')).toBe('"v1"')
        // 304 carries no Location and is not a hop: one request, no refusal.
        expect(spy).toHaveBeenCalledTimes(1)
      },
    )

    const multipleChoices = { ...notModified, status: 300 }
    await withFetch(
      () => multipleChoices,
      async () => {
        await expect(fetchPublicWebUrl('https://example.com/choices')).resolves.toMatchObject({ status: 300 })
      },
    )
  })

  it('returns a redirect status that carries no Location instead of refusing it', async () => {
    // No Location means no next hop exists: the server's response is the
    // answer, and a policy refusal would misreport it.
    await withFetch(
      () => ({
        ok: false,
        status: 302,
        type: 'basic' as const,
        url: '',
        headers: new Headers(),
        text: async () => '',
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
      async (spy) => {
        const response = await fetchPublicWebUrl('https://example.com/start')
        expect(response.status).toBe(302)
        expect(spy).toHaveBeenCalledTimes(1)
      },
    )
  })

  it('passes a successful public response through untouched', async () => {
    await withFetch(
      () => ok('hello world'),
      async (spy) => {
        const response = await fetchPublicWebUrl('https://example.com/data', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{"a":1}',
        })
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('text/plain')
        expect(await response.text()).toBe('hello world')
        // The caller's request actually reaches the first hop: guards against
        // the init being silently dropped on the way to fetch.
        const init = spy.mock.calls[0]![1] as RequestInit
        expect(init).toMatchObject({ method: 'POST', body: '{"a":1}', redirect: 'manual' })
        expect(new Headers(init.headers).get('content-type')).toBe('application/json')
      },
    )
  })
})

describe('plugin download guard regression (#198: host allowlist still enforced)', () => {
  it('still refuses an off-list public host before fetching', async () => {
    expect(() => assertPublicHttpsDownloadUrl('https://cdn.example.com/a.pdf')).toThrow(/host is not allowed/)
    expect(() => assertPublicHttpsDownloadUrl('https://example.com/a.pdf')).toThrow(/host is not allowed/)
    // The two registry transports stay allowed.
    expect(() => assertPublicHttpsDownloadUrl('https://raw.githubusercontent.com/nutstore/eo2weave/main/a.zip')).not.toThrow()
    expect(() => assertPublicHttpsDownloadUrl('https://cdn.jsdelivr.net/gh/nutstore/eo2weave@main/a.zip')).not.toThrow()

    await withFetch(
      () => ok(),
      async (spy) => {
        const frames: Array<{ type?: string; message?: string }> = []
        await streamPluginDownload(
          {
            transferId: 't1',
            downloadUrl: 'https://evil.example.com/payload.zip',
            savePath: '/',
            fileName: 'payload.zip',
          } as never,
          (frame) => { frames.push(frame as { type?: string; message?: string }) },
        )
        expect(spy).not.toHaveBeenCalled()
        expect(frames[0]!.type).toBe('error')
        expect(frames[0]!.message).toContain('not allowed')
      },
    )
  })

  it('still refuses a redirect from an allowlisted host into the metadata endpoint', async () => {
    await withFetch(
      () => redirect(302, 'https://169.254.169.254/latest/meta-data/'),
      async (spy) => {
        const frames: Array<{ type?: string }> = []
        await streamPluginDownload(
          {
            transferId: 't1',
            downloadUrl: 'https://raw.githubusercontent.com/nutstore/eo2weave/main/a.zip',
            savePath: '/',
            fileName: 'a.zip',
          } as never,
          (frame) => { frames.push(frame as { type?: string }) },
        )
        expect(requestedUrls(spy).some(url => url.includes('169.254.169.254'))).toBe(false)
        expect(frames[0]!.type).toBe('error')
      },
    )
  })
})
