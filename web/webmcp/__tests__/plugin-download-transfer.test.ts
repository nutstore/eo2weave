import { describe, expect, it, vi } from 'vitest'
import {
  assertPublicHttpsDownloadUrl,
  streamPluginDownload,
} from '../../../browser-extension/entrypoints/webmcp/plugin-download-transfer'

// The plugin-download plan's URL comes from an untrusted page tool result and
// is fetched by the extension with background privileges. The contract: only
// public HTTPS hosts are fetched; anything that could aim the privileged
// fetch at loopback / private-network endpoints is refused BEFORE the fetch
// (#139 review round 6: untrusted URLs reach privileged fetch).
describe('plugin download URL validation', () => {
  it('refuses private / loopback / non-https download hosts', () => {
    for (const url of [
      'http://cdn.example.com/a.pdf',
      'file:///etc/passwd',
      'https://localhost/a.pdf',
      'https://printer.local/a.pdf',
      'https://vault.internal/a.pdf',
      'https://127.0.0.1/a.pdf',
      'https://10.0.0.5/a.pdf',
      'https://172.16.4.4/a.pdf',
      'https://192.168.1.1/a.pdf',
      'https://169.254.169.254/a.pdf',
      'https://[::1]/a.pdf',
      'https://[fe80::1]/a.pdf',
      'https://user:pass@cdn.example.com/a.pdf',
    ]) {
      expect(() => assertPublicHttpsDownloadUrl(url)).toThrow()
    }
    // Public hosts still pass.
    expect(() => assertPublicHttpsDownloadUrl('https://cdn.example.com/a.pdf')).not.toThrow()
  })

  it('rejects the full IPv6 private/reserved families and IPv4 oddities (#148 round 7: some link-local addresses pass validation)', () => {
    const blocked = [
      // IPv6 loopback / unspecified, expanded and mapped forms.
      'https://[::1]/a.pdf',
      'https://[0:0:0:0:0:0:0:1]/a.pdf',
      'https://[::]/a.pdf',
      // IPv4-mapped IPv6 carrying private IPv4 addresses. NOTE: the URL
      // parser canonicalizes the dotted form to hex groups, so the runtime
      // sees ::ffff:7f00:1 — both spellings are asserted via the hex form.
      'https://[::ffff:7f00:1]/a.pdf',       // → 127.0.0.1
      'https://[::ffff:a00:1]/a.pdf',        // → 10.0.0.1
      'https://[::ffff:c0a8:109]/a.pdf',     // → 192.168.1.9
      'https://[::ffff:a9fe:a9fe]/a.pdf',    // → 169.254.169.254
      'https://[::ffff:6464:1]/a.pdf',       // → 100.64.0.1 (CGNAT)
      'https://[::ffff:0.1.2.3]/a.pdf',      // → 0.1.2.3 (0/8; dotted survives parsing)
      // Link-local fe80::/10 (not just textual fe80 prefix).
      'https://[fe80::]/a.pdf',
      'https://[febf::1]/a.pdf',
      // Unique-local fc00::/7 (fd00::/8 included).
      'https://[fc00::1]/a.pdf',
      'https://[fd12:3456:789a::1]/a.pdf',
      // NAT64 well-known prefix embedding a loopback IPv4.
      'https://[64:ff9b::127.0.0.1]/a.pdf',
      // IPv4 reserved families.
      'https://0.1.2.3/a.pdf',            // 0.0.0.0/8
      'https://100.64.0.1/a.pdf',         // CGNAT 100.64/10
      'https://100.127.255.255/a.pdf',    // CGNAT upper bound
      'https://192.0.0.1/a.pdf',          // 192.0.0/24
      'https://192.0.2.9/a.pdf',          // TEST-NET-1
      'https://198.18.0.1/a.pdf',         // benchmarking 198.18/15
      'https://198.19.255.255/a.pdf',     // benchmarking upper bound
      'https://198.51.100.7/a.pdf',       // TEST-NET-2
      'https://203.0.113.9/a.pdf',        // TEST-NET-3
      'https://224.0.0.1/a.pdf',          // multicast 224/4
      'https://240.0.0.1/a.pdf',          // reserved 240/4
      'https://255.255.255.255/a.pdf',    // broadcast
      // Single-label / bare hostname (resolves via local search domains).
      'https://intranet/a.pdf',
      // Malformed IPv6-ish literal.
      'https://[gg::1]/a.pdf',
    ]
    for (const url of blocked) {
      expect(() => assertPublicHttpsDownloadUrl(url), url).toThrow()
    }
    // Public addresses still pass.
    for (const ok of [
      'https://[2606:4700::6810:85e5]/a.pdf', // public IPv6 (Cloudflare)
      'https://8.8.8.8/a.pdf',
      'https://100.200.1.1/a.pdf',            // above CGNAT range
      'https://198.20.0.1/a.pdf',             // outside 198.18/15
    ]) {
      expect(() => assertPublicHttpsDownloadUrl(ok), ok).not.toThrow()
    }
  })

  it('re-validates every redirect target before following it (#148 round 7: redirects reach private endpoints)', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => ({
      ok: false,
      status: 302,
      url: String(url),
      headers: new Headers({ location: 'https://169.254.169.254/latest/meta-data/' }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const frames: Array<{ type?: string; errorCode?: string; message?: string }> = []
      await streamPluginDownload(
        {
          transferId: 't1',
          downloadUrl: 'https://cdn.example.com/asset.pdf',
          savePath: '/',
          fileName: 'asset.pdf',
        } as never,
        (frame) => { frames.push(frame as { type?: string; errorCode?: string; message?: string }) },
      )
      // Only ONE privileged request goes out — to the public URL. The private
      // redirect target is validated and refused BEFORE the second fetch.
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://cdn.example.com/asset.pdf')
      expect(frames[0]!.type).toBe('error')
      expect(frames[0]!.errorCode).toBe('WEBMCP_PLUGIN_DOWNLOAD_STREAM_FAILED')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('follows public redirect chains and caps the hop count', async () => {
    const fetched: string[] = []
    const fetchSpy = vi.fn(async (url: string | URL) => {
      fetched.push(String(url))
      const hop = fetched.length
      if (hop <= 2) {
        return {
          ok: true,
          status: 302,
          url: String(url),
          headers: new Headers({ location: `https://mirror${hop}.example.com/a.pdf` }),
          arrayBuffer: async () => new ArrayBuffer(0),
        }
      }
      return {
        ok: true,
        status: 200,
        url: String(url),
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(4),
      }
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const frames: Array<{ type?: string }> = []
      await streamPluginDownload(
        {
          transferId: 't1',
          downloadUrl: 'https://cdn.example.com/a.pdf',
          savePath: '/',
          fileName: 'a.pdf',
        } as never,
        (frame) => { frames.push(frame as { type?: string }) },
      )
      // 2 redirects followed (each Location validated first), then the 200.
      expect(fetched).toEqual([
        'https://cdn.example.com/a.pdf',
        'https://mirror1.example.com/a.pdf',
        'https://mirror2.example.com/a.pdf',
      ])
      expect(frames.map((f) => f.type)).toEqual(['start', 'chunk', 'end'])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('refuses a redirect chain longer than 5 hops', async () => {
    const fetchSpy = vi.fn(async (url: string | URL) => ({
      ok: true,
      status: 302,
      url: String(url),
      headers: new Headers({ location: `https://hop.example.com/${Math.random()}` }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const frames: Array<{ type?: string; message?: string }> = []
      await streamPluginDownload(
        {
          transferId: 't1',
          downloadUrl: 'https://cdn.example.com/a.pdf',
          savePath: '/',
          fileName: 'a.pdf',
        } as never,
        (frame) => { frames.push(frame as { type?: string; message?: string }) },
      )
      expect(fetchSpy).toHaveBeenCalledTimes(6) // initial + 5 hops, then refused
      expect(frames[0]!.type).toBe('error')
      expect(frames[0]!.message).toContain('redirect')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('never fetches a blocked download URL (#139 review round 6: untrusted URLs reach privileged fetch)', async () => {
    const fetchSpy = vi.fn()
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    try {
      const frames: Array<{ type?: string; message?: string }> = []
      await streamPluginDownload(
        {
          transferId: 't1',
          downloadUrl: 'https://127.0.0.1/internal',
          savePath: '/',
          fileName: 'payload.bin',
        } as never,
        (frame) => { frames.push(frame as { type?: string; message?: string }) },
      )
      expect(fetchSpy).not.toHaveBeenCalled()
      expect(frames[0]!.type).toBe('error')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
