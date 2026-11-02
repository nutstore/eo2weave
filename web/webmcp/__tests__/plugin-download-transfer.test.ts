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
