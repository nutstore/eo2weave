import { beforeEach, describe, expect, it } from 'vitest'
import {
  fetchRegistryManifest,
  parseRegistryInput,
  registryFileUrl,
  registryFromManifestUrl,
  validateRegistryManifest,
  MAX_PACKAGE_FILES,
  MAX_REGISTRY_PACKAGES,
  RegistryError,
  type RegistryManifest,
} from '@/webmcp/package-registry-client'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

const VALID_MANIFEST: RegistryManifest = {
  generatedAt: '2026-10-29T00:00:00Z',
  packages: [
    {
      id: 'com.discord.main',
      version: '0.1.0',
      description: 'Discord tools.',
      toolCount: 2,
      files: [
        { path: 'packages/com.discord.main/manifest.json', sha256: 'a'.repeat(64) },
        { path: 'packages/com.discord.main/config.json', sha256: 'b'.repeat(64) },
        { path: 'packages/com.discord.main/workflows/read.js', sha256: 'c'.repeat(64) },
      ],
    },
  ],
}

describe('parseRegistryInput — loose URL forms', () => {
  it('accepts a full GitHub URL and derives the raw base on main', () => {
    const registry = parseRegistryInput('https://github.com/kanweiwei/eo2weave-webmcp-packages')
    expect(registry.rawBase).toBe('https://raw.githubusercontent.com/kanweiwei/eo2weave-webmcp-packages/main')
    expect(registry.manifestUrl).toBe('https://raw.githubusercontent.com/kanweiwei/eo2weave-webmcp-packages/main/manifest.json')
    expect(registry.label).toBe('kanweiwei/eo2weave-webmcp-packages')
  })

  it('accepts owner/repo shorthand', () => {
    const registry = parseRegistryInput('kanweiwei/eo2weave-webmcp-packages')
    expect(registry.rawBase).toBe('https://raw.githubusercontent.com/kanweiwei/eo2weave-webmcp-packages/main')
    expect(registry.manifestUrl).toBe('https://raw.githubusercontent.com/kanweiwei/eo2weave-webmcp-packages/main/manifest.json')
  })

  it('accepts a direct raw manifest URL as-is', () => {
    const url = 'https://raw.githubusercontent.com/owner/repo/main/manifest.json'
    const registry = parseRegistryInput(url)
    expect(registry.manifestUrl).toBe(url)
    expect(registry.rawBase).toBe('https://raw.githubusercontent.com/owner/repo/main')
  })

  it('accepts a deep raw URL and anchors the base at the file directory', () => {
    const registry = parseRegistryInput('https://raw.githubusercontent.com/owner/repo/dev/manifest.json')
    expect(registry.rawBase).toBe('https://raw.githubusercontent.com/owner/repo/dev')
    expect(registry.manifestUrl).toBe('https://raw.githubusercontent.com/owner/repo/dev/manifest.json')
  })

  it('honors a github.com/tree/<branch> URL including subdirectory (manifest URL only)', () => {
    const registry = parseRegistryInput('https://github.com/owner/repo/tree/nightly/sub/dir')
    // Package file paths are repo-relative, so the file base stays at the
    // repo root while the manifest URL keeps the subdirectory.
    expect(registry.rawBase).toBe('https://raw.githubusercontent.com/owner/repo/nightly')
    expect(registry.manifestUrl).toBe('https://raw.githubusercontent.com/owner/repo/nightly/sub/dir/manifest.json')
  })

  it('parses a SLASHED branch so the manifest and file URLs resolve (raw-host ref resolution)', () => {
    // A branch `feature/registry` is indistinguishable from branch `feature`
    // + directory `registry` by URL shape (finding: "Slash in branch breaks
    // registry URL"). The manifest URL keeps the FULL tail - identical under
    // either split - and raw.githubusercontent.com resolves ref-paths
    // greedily against existing refs, so catalog AND repo-relative file
    // URLs stay valid for slashed branches.
    const tree = parseRegistryInput('https://github.com/owner/repo/tree/feature/registry')
    expect(tree.manifestUrl).toBe('https://raw.githubusercontent.com/owner/repo/feature/registry/manifest.json')
    expect(registryFileUrl(tree, 'packages/com.x/f.js'))
      .toBe('https://raw.githubusercontent.com/owner/repo/feature/packages/com.x/f.js')

    const raw = parseRegistryInput('https://raw.githubusercontent.com/owner/repo/feature/registry/manifest.json')
    expect(raw.manifestUrl).toBe('https://raw.githubusercontent.com/owner/repo/feature/registry/manifest.json')
  })

  it('anchors a deep raw URL at the repo root for files, subdirectory for the manifest', () => {
    const registry = parseRegistryInput('https://raw.githubusercontent.com/owner/repo/dev/packages/manifest.json')
    expect(registry.rawBase).toBe('https://raw.githubusercontent.com/owner/repo/dev')
    expect(registry.manifestUrl).toBe('https://raw.githubusercontent.com/owner/repo/dev/packages/manifest.json')
  })

  it('rejects plain-http registry URLs', () => {
    expect(() => parseRegistryInput('http://github.com/owner/repo')).toThrow(RegistryError)
    expect(() => parseRegistryInput('http://raw.githubusercontent.com/owner/repo/main/manifest.json')).toThrow(RegistryError)
  })

  it('rejects an empty input explicitly', () => {
    expect(() => parseRegistryInput('   ')).toThrow(RegistryError)
  })

  it('rejects a bare owner without repo', () => {
    expect(() => parseRegistryInput('kanweiwei')).toThrow(RegistryError)
  })

  it('rejects unsupported GitHub paths', () => {
    expect(() => parseRegistryInput('https://github.com/owner/repo/blob/main/manifest.json')).toThrow(RegistryError)
  })

  it('rejects non-GitHub hosts explicitly', () => {
    expect(() => parseRegistryInput('https://gitlab.com/owner/repo')).toThrow(RegistryError)
  })
})

describe('fetchRegistryManifest — resource limits', () => {
  it('rejects a manifest listing more files than the per-package cap', () => {
    const bad = {
      packages: [{
        id: 'com.x', version: '1.0.0', description: '', toolCount: 1,
        files: Array.from({ length: MAX_PACKAGE_FILES + 1 }, (_, i) => ({
          path: `packages/com.x/f${i}.js`, sha256: 'a'.repeat(64),
        })),
      }],
    }
    expect(() => validateRegistryManifest(bad)).toThrow(/too many files/i)
  })

  it('aborts a manifest request that never completes (bounded timeout)', async () => {
    const registry = registryFromManifestUrl('https://raw.githubusercontent.com/o/hang/main/manifest.json')
    const hanging: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }) as typeof fetch
    await expect(fetchRegistryManifest(registry, { fetchImpl: hanging, timeoutMs: 25 }))
      .rejects.toThrow(/timed out/i)
  })

  it('rejects a manifest body larger than the byte cap WHILE streaming', async () => {
    const registry = registryFromManifestUrl('https://raw.githubusercontent.com/o/big/main/manifest.json')
    // A server that sends a body far beyond the cap: the streamed read must
    // abort early instead of buffering it all.
    const huge: typeof fetch = (async () => ({
      ok: true,
      status: 200,
      body: {
        getReader: () => {
          let sent = 0
          return {
            read: async () => {
              if (sent >= 8) return { done: true, value: undefined }
              sent += 1
              return { done: false, value: new Uint8Array(1024 * 1024).fill(0x61) }
            },
            cancel: async () => {},
          }
        },
      },
    } as unknown as Response))
    await expect(fetchRegistryManifest(registry, { fetchImpl: huge }))
      .rejects.toThrow(/size limit/i)
  })

  it('aborts a server that stalls AFTER the headers (deadline covers the body)', async () => {
    const registry = registryFromManifestUrl('https://raw.githubusercontent.com/o/stall/main/manifest.json')
    const stallAfterHeaders: typeof fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal
      return {
        ok: true,
        status: 200,
        body: { getReader: () => ({ read: () => new Promise<{ done: boolean; value?: Uint8Array }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        }) }) },
      } as unknown as Response
    }) as typeof fetch
    await expect(fetchRegistryManifest(registry, { fetchImpl: stallAfterHeaders, timeoutMs: 25 }))
      .rejects.toThrow(/timed out/i)
  })
})

describe('registryFileUrl', () => {
  it('joins package paths onto the raw base', () => {
    const registry = parseRegistryInput('kanweiwei/eo2weave-webmcp-packages')
    expect(registryFileUrl(registry, 'packages/com.discord.main/manifest.json'))
      .toBe('https://raw.githubusercontent.com/kanweiwei/eo2weave-webmcp-packages/main/packages/com.discord.main/manifest.json')
  })

  it('rejects traversal paths', () => {
    const registry = parseRegistryInput('owner/repo')
    expect(() => registryFileUrl(registry, '../secret')).toThrow(RegistryError)
  })
})

describe('validateRegistryManifest', () => {
  it('accepts the registry-side format', () => {
    expect(validateRegistryManifest(VALID_MANIFEST).packages[0].id).toBe('com.discord.main')
  })

  it('rejects non-objects and missing packages', () => {
    expect(() => validateRegistryManifest(null)).toThrow(RegistryError)
    expect(() => validateRegistryManifest([])).toThrow(RegistryError)
    expect(() => validateRegistryManifest({})).toThrow(RegistryError)
  })

  it('rejects a file escaping the package directory', () => {
    const bad = {
      packages: [{
        id: 'com.x', version: '1.0.0', description: '', toolCount: 1,
        files: [{ path: 'packages/com.other/a.js', sha256: 'a'.repeat(64) }],
      }],
    }
    expect(() => validateRegistryManifest(bad)).toThrow(RegistryError)
  })

  it('rejects a missing per-package manifest.json entry', () => {
    const bad = {
      packages: [{
        id: 'com.x', version: '1.0.0', description: '', toolCount: 1,
        files: [{ path: 'packages/com.x/a.js', sha256: 'a'.repeat(64) }],
      }],
    }
    expect(() => validateRegistryManifest(bad)).toThrow(RegistryError)
  })

  it('rejects malformed sha256 values', () => {
    const bad = {
      packages: [{
        id: 'com.x', version: '1.0.0', description: '', toolCount: 1,
        files: [{ path: 'packages/com.x/manifest.json', sha256: 'not-a-hash' }],
      }],
    }
    expect(() => validateRegistryManifest(bad)).toThrow(RegistryError)
  })

  it('rejects duplicate package ids', () => {
    const bad = {
      packages: [VALID_MANIFEST.packages[0], { ...VALID_MANIFEST.packages[0] }],
    }
    expect(() => validateRegistryManifest(bad)).toThrow(RegistryError)
  })

  it('rejects IDs the package manifest validator would refuse (round 3)', () => {
    // Finding: "Catalog accepts un-installable IDs" — validateManifest
    // requires a lowercase reverse-domain id, so a registry entry with an
    // uppercase or flat id would appear in the catalog but could never
    // install. The catalog must reject it at load time instead.
    for (const id of ['Com.Example.Main', 'com.example', 'flatname', 'com.example..main', '-com.example']) {
      const bad = {
        packages: [{ ...VALID_MANIFEST.packages[0], id }],
      }
      expect(() => validateRegistryManifest(bad)).toThrow(RegistryError)
    }
  })

  it('rejects non-semver version claims (round 3)', () => {
    // The downloaded manifest's version must pass validateManifest's semver
    // rule; a registry version that would guarantee an install failure is
    // rejected at catalog time.
    const bad = {
      packages: [{ ...VALID_MANIFEST.packages[0], version: 'not-semver' }],
    }
    expect(() => validateRegistryManifest(bad)).toThrow(RegistryError)
  })

  it('rejects catalogs exceeding the package-count cap (round 3)', () => {
    // Finding: "Large catalogs overwhelm settings page" — the section
    // fetches one manifest preview per entry, so an unbounded catalog
    // would launch unbounded requests and rendering work.
    const bad = {
      packages: Array.from({ length: MAX_REGISTRY_PACKAGES + 1 }, (_, i) => ({
        ...VALID_MANIFEST.packages[0],
        id: `com.example.pkg${i}`,
        files: [{ path: `packages/com.example.pkg${i}/manifest.json`, sha256: 'a'.repeat(64) }],
      })),
    }
    expect(() => validateRegistryManifest(bad)).toThrow(/too many packages/)
  })
})

describe('fetchRegistryManifest', () => {
  beforeEach(() => {
    // Isolate the module-level cache between tests via unique manifest URLs.
  })

  it('fetches, validates and caches a manifest (5-min session cache)', async () => {
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return jsonResponse(VALID_MANIFEST) }) as typeof fetch
    const registry = registryFromManifestUrl('https://raw.githubusercontent.com/o/r/main/manifest.json')
    const first = await fetchRegistryManifest(registry, { fetchImpl })
    const second = await fetchRegistryManifest(registry, { fetchImpl })
    expect(first.packages).toHaveLength(1)
    expect(second).toBe(first)
    expect(calls).toBe(1)
  })

  it('re-fetches on force', async () => {
    let calls = 0
    const fetchImpl = (async () => { calls += 1; return jsonResponse(VALID_MANIFEST) }) as typeof fetch
    const registry = registryFromManifestUrl('https://raw.githubusercontent.com/o/r2/main/manifest.json')
    await fetchRegistryManifest(registry, { fetchImpl })
    await fetchRegistryManifest(registry, { fetchImpl, force: true })
    expect(calls).toBe(2)
  })

  it('surfaces 404 as a registry error with the manifest URL', async () => {
    const fetchImpl = (async () => jsonResponse({ message: 'Not Found' }, 404)) as unknown as typeof fetch
    const registry = registryFromManifestUrl('https://raw.githubusercontent.com/o/missing/main/manifest.json')
    await expect(fetchRegistryManifest(registry, { fetchImpl })).rejects.toThrow(/manifest\.json/)
  })

  it('rejects structurally invalid manifests', async () => {
    const fetchImpl = (async () => jsonResponse({ packages: 'nope' })) as unknown as typeof fetch
    const registry = registryFromManifestUrl('https://raw.githubusercontent.com/o/bad/main/manifest.json')
    await expect(fetchRegistryManifest(registry, { fetchImpl })).rejects.toThrow(RegistryError)
  })

  it('wraps network failures', async () => {
    const fetchImpl = (async () => { throw new TypeError('network down') }) as unknown as typeof fetch
    const registry = registryFromManifestUrl('https://raw.githubusercontent.com/o/net/main/manifest.json')
    await expect(fetchRegistryManifest(registry, { fetchImpl })).rejects.toThrow(/unreachable/i)
  })
})
