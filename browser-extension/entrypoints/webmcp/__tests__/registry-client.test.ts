/**
 * Registry URL derivation + mirror fallback (issue #143).
 *
 * The URL derivation is the extension-side port of the web app's
 * `package-registry-client.ts`; the mirror fallback is NEW (the web client
 * had none).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  fetchWithMirrorFallback,
  fetchRegistryManifest,
  isNotFoundError,
  parseRegistryInput,
  RegistryError,
  registryAltFileUrls,
  registryFileUrl,
  registryFromManifestUrl,
  validateRegistryManifest,
} from '../registry-client'
import {
  JSDELIVR_HOST,
  jsdelivrUrl,
  mirrorCandidates,
  parseRawGithubUrl,
  RAW_GITHUB_HOST,
  rawGithubUrl,
  resolveMirrorPreference,
} from '../registry-mirrors'

describe('parseRegistryInput', () => {
  it('accepts the owner/repo shorthand and defaults the branch to main', () => {
    const registry = parseRegistryInput('nutstore/eo2weave-webmcp-packages')
    expect(registry.rawBase).toBe(`https://${RAW_GITHUB_HOST}/nutstore/eo2weave-webmcp-packages/main`)
    expect(registry.manifestUrl).toBe(`https://${RAW_GITHUB_HOST}/nutstore/eo2weave-webmcp-packages/main/manifest.json`)
    expect(registry.label).toBe('nutstore/eo2weave-webmcp-packages')
  })

  it('accepts a full GitHub URL', () => {
    const registry = parseRegistryInput('https://github.com/nutstore/eo2weave-webmcp-packages')
    expect(registry.rawBase).toBe(`https://${RAW_GITHUB_HOST}/nutstore/eo2weave-webmcp-packages/main`)
    expect(registry.manifestUrl).toBe(`${registry.rawBase}/manifest.json`)
    expect(registry.label).toBe('nutstore/eo2weave-webmcp-packages')
  })

  it('keeps the branch and the subdirectory of a /tree/ URL', () => {
    const registry = parseRegistryInput('https://github.com/nutstore/eo2weave-webmcp-packages/tree/dev/catalog')
    // rawBase is the REPO ROOT; the ref+directory tail lives in the
    // manifest URL, so repo-relative package files stay correct even when
    // the branch itself contains slashes.
    expect(registry.rawBase).toBe(`https://${RAW_GITHUB_HOST}/nutstore/eo2weave-webmcp-packages`)
    expect(registry.manifestUrl).toBe(`https://${RAW_GITHUB_HOST}/nutstore/eo2weave-webmcp-packages/dev/catalog/manifest.json`)
  })

  it('accepts a raw.githubusercontent URL and keeps its directory', () => {
    const registry = parseRegistryInput(`https://${RAW_GITHUB_HOST}/nutstore/eo2weave-webmcp-packages/main/catalog/manifest.json`)
    expect(registry.rawBase).toBe(`https://${RAW_GITHUB_HOST}/nutstore/eo2weave-webmcp-packages`)
    expect(registry.manifestUrl).toBe(`https://${RAW_GITHUB_HOST}/nutstore/eo2weave-webmcp-packages/main/catalog/manifest.json`)
    expect(registry.label).toBe('nutstore/eo2weave-webmcp-packages')
  })

  it('keeps the full ref tail of a raw URL whose branch contains a slash', () => {
    const registry = parseRegistryInput(`https://${RAW_GITHUB_HOST}/nutstore/pkg/feature/registry/manifest.json`)
    // The manifest URL is the FULL tail (identical under either branch/dir
    // split) and repo-relative package files derive from it — a file URL
    // built from a first-segment rawBase addressed the wrong ref.
    expect(registry.manifestUrl).toBe(`https://${RAW_GITHUB_HOST}/nutstore/pkg/feature/registry/manifest.json`)
    expect(registryFileUrl(registry, 'packages/com.example.tools/manifest.json'))
      .toBe(`https://${RAW_GITHUB_HOST}/nutstore/pkg/feature/registry/packages/com.example.tools/manifest.json`)
    // rawBase is the repo root; the ref lives only in the manifest URL tail.
    expect(registry.rawBase).toBe(`https://${RAW_GITHUB_HOST}/nutstore/pkg`)
  })

  it('derives the manifest URL from a raw BRANCH-ROOT URL with no file segment', () => {
    // MEDIUM ("Raw branch URLs fail to load"): `.../owner/repo/main` has no
    // file segment — treating the branch as the manifest filename produced
    // a URL ending in `/main`, and the catalog fetch failed for input the
    // parser accepted.
    const registry = parseRegistryInput(`https://${RAW_GITHUB_HOST}/owner/repo/main`)
    expect(registry.manifestUrl).toBe(`https://${RAW_GITHUB_HOST}/owner/repo/main/manifest.json`)
    expect(registry.rawBase).toBe(`https://${RAW_GITHUB_HOST}/owner/repo`)
    // Package-file URLs stay consistent with the derived manifest URL.
    expect(registryFileUrl(registry, 'packages/com.example.tools/manifest.json'))
      .toBe(`https://${RAW_GITHUB_HOST}/owner/repo/main/packages/com.example.tools/manifest.json`)
  })

  it('derives working package-file URLs for a slashed /tree/ branch', () => {
    const registry = parseRegistryInput('https://github.com/nutstore/pkg/tree/feature/registry')
    expect(registry.manifestUrl).toBe(`https://${RAW_GITHUB_HOST}/nutstore/pkg/feature/registry/manifest.json`)
    expect(registryFileUrl(registry, 'packages/com.example.tools/manifest.json'))
      .toBe(`https://${RAW_GITHUB_HOST}/nutstore/pkg/feature/registry/packages/com.example.tools/manifest.json`)
  })

  it('rejects plain HTTP (an interceptor could swap the manifest and its checksums)', () => {
    expect(() => parseRegistryInput('http://github.com/nutstore/eo2weave-webmcp-packages')).toThrow(RegistryError)
  })

  it('rejects an unsupported host', () => {
    expect(() => parseRegistryInput('https://example.com/owner/repo')).toThrow(/Unsupported registry host/)
  })

  it('rejects an empty input', () => {
    expect(() => parseRegistryInput('   ')).toThrow(/required/)
  })

  it('derives repo-relative file URLs', () => {
    const registry = parseRegistryInput('nutstore/eo2weave-webmcp-packages')
    expect(registryFileUrl(registry, 'packages/com.example.tools/manifest.json'))
      .toBe(`${registry.rawBase}/packages/com.example.tools/manifest.json`)
  })

  it('refuses a file path that escapes the repo', () => {
    const registry = parseRegistryInput('nutstore/eo2weave-webmcp-packages')
    expect(() => registryFileUrl(registry, '../../etc/passwd')).toThrow(RegistryError)
    expect(() => registryAltFileUrls(registry, '../../etc/passwd')).toThrow(RegistryError)
  })

  it('derives REF-ROOT alternatives for a subdirectory manifest (HIGH "Subdirectory registries cannot load packages")', () => {
    // The manifest format stores REPO-relative package paths (the packages
    // repo's CI generator hashes files with path.relative(repoRoot, …)), so
    // a manifest hosted in a repo SUBDIRECTORY must load its packages from
    // the ref root — the beside-the-manifest form 404s. The ref/dir split
    // is unknowable by URL shape, so every tail prefix is offered.
    const registry = parseRegistryInput(`https://${RAW_GITHUB_HOST}/nutstore/pkg/main/registry/manifest.json`)
    const path = 'packages/com.example.tools/manifest.json'
    // Primary: beside the manifest (unchanged behavior).
    expect(registryFileUrl(registry, path))
      .toBe(`https://${RAW_GITHUB_HOST}/nutstore/pkg/main/registry/${path}`)
    // Alternatives: re-anchored at each ref-root candidate, same origin.
    expect(registryAltFileUrls(registry, path))
      .toEqual([`https://${RAW_GITHUB_HOST}/nutstore/pkg/main/${path}`])
  })

  it('returns NO alternatives when the manifest already sits at the ref root', () => {
    const registry = parseRegistryInput('nutstore/eo2weave-webmcp-packages')
    const path = 'packages/com.example.tools/manifest.json'
    // Beside-the-manifest IS the ref-root form here — both derivations
    // agree, so the candidate list must not gain duplicates.
    expect(registryAltFileUrls(registry, path)).toEqual([])
  })

  it('offers both prefix splits for a slashed-branch subdirectory manifest', () => {
    const registry = parseRegistryInput(`https://${RAW_GITHUB_HOST}/nutstore/pkg/feature/registry/manifest.json`)
    expect(registryAltFileUrls(registry, 'packages/com.example.tools/manifest.json'))
      .toEqual([
        // ref = `feature`, dir = `registry` (ref-root form).
        `https://${RAW_GITHUB_HOST}/nutstore/pkg/feature/packages/com.example.tools/manifest.json`,
      ])
  })

  it('returns no alternatives for a non-GitHub manifest URL', () => {
    const registry = registryFromManifestUrl('https://example.com/owner/repo/main/manifest.json')
    expect(registryAltFileUrls(registry, 'packages/com.example.tools/manifest.json')).toEqual([])
  })

  it('builds a registry from an explicit manifest URL', () => {
    const registry = registryFromManifestUrl(`https://${RAW_GITHUB_HOST}/nutstore/pkg/main/manifest.json`)
    expect(registry.rawBase).toBe(`https://${RAW_GITHUB_HOST}/nutstore/pkg`)
    expect(registry.label).toBe('nutstore/pkg')
    expect(registryFileUrl(registry, 'packages/com.example.tools/manifest.json'))
      .toBe(`https://${RAW_GITHUB_HOST}/nutstore/pkg/main/packages/com.example.tools/manifest.json`)
  })
})

describe('parseRawGithubUrl', () => {
  it('splits a raw URL into owner/repo/ref/path', () => {
    const parsed = parseRawGithubUrl(`https://${RAW_GITHUB_HOST}/nutstore/pkg/main/packages/com.example.tools/manifest.json`)
    // The ref is the GREEDY middle: raw.githubusercontent resolves ref
    // paths against the repo's existing refs, so the URL shape alone cannot
    // split `main` from `packages/com.example.tools` — the whole middle is
    // kept as the ref and the LAST segment as the file.
    expect(parsed).toEqual({
      owner: 'nutstore',
      repo: 'pkg',
      ref: 'main/packages/com.example.tools',
      path: 'manifest.json',
    })
  })

  it('returns null for a non-GitHub URL', () => {
    expect(parseRawGithubUrl('https://example.com/a/b/c/d')).toBeNull()
    expect(parseRawGithubUrl('not a url')).toBeNull()
  })

  it('returns null when the URL has no file segment', () => {
    expect(parseRawGithubUrl(`https://${RAW_GITHUB_HOST}/nutstore/pkg/main`)).toBeNull()
  })

  it('keeps the whole middle as the ref when it contains slashes', () => {
    // The FIRST-segment split made the jsDelivr mirror address the shorter
    // ref `feature` and read the rest of the branch as a file path. The
    // greedy split keeps the full middle as the ref (the same split
    // raw.githubusercontent applies) and only the LAST segment as the file.
    const parsed = parseRawGithubUrl(`https://${RAW_GITHUB_HOST}/nutstore/pkg/feature/registry/packages/com.example.tools/manifest.json`)
    expect(parsed).toEqual({
      owner: 'nutstore',
      repo: 'pkg',
      ref: 'feature/registry/packages/com.example.tools',
      path: 'manifest.json',
    })
    expect(jsdelivrUrl(parsed!)).toBe(`https://${JSDELIVR_HOST}/gh/nutstore/pkg@feature/registry/packages/com.example.tools/manifest.json`)
    // Round-trips: the direct raw URL is rebuilt unchanged.
    expect(rawGithubUrl(parsed!)).toBe(`https://${RAW_GITHUB_HOST}/nutstore/pkg/feature/registry/packages/com.example.tools/manifest.json`)
  })
})

describe('mirror candidates', () => {
  const url = `https://${RAW_GITHUB_HOST}/nutstore/pkg/main/manifest.json`
  const mirror = `https://${JSDELIVR_HOST}/gh/nutstore/pkg@main/manifest.json`

  it('derives the jsDelivr mirror from the raw URL shape', () => {
    expect(jsdelivrUrl({ owner: 'nutstore', repo: 'pkg', ref: 'main', path: 'manifest.json' })).toBe(mirror)
  })

  it('prefers the direct host for the global build', () => {
    expect(mirrorCandidates(url, 'global')).toEqual([url, mirror])
  })

  it('prefers the mirror for the CN build', () => {
    expect(mirrorCandidates(url, 'cn')).toEqual([mirror, url])
  })

  it('keeps the direct URL as the canonical one in both orders', () => {
    expect(mirrorCandidates(url, 'global')).toContain(url)
    expect(mirrorCandidates(url, 'cn')).toContain(url)
  })

  it('returns the URL untouched when it is not a GitHub raw URL', () => {
    expect(mirrorCandidates('https://example.com/file.zip', 'cn')).toEqual(['https://example.com/file.zip'])
  })

  it('resolves the preference from the browser UI language', () => {
    const original = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
    expect(resolveMirrorPreference()).toBe('cn')
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true })
    expect(resolveMirrorPreference()).toBe('global')
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
  })

  it('lets a build pin the region over the browser language', () => {
    const original = globalThis.navigator
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'en-US' }, configurable: true })
    // The wxt `define` replaces the BARE `__CW_DEPLOY_REGION__` identifier
    // at build time, so the pin cannot be simulated through `globalThis`
    // here. The region pin is verified by the build itself (the define is
    // asserted by the bundle build); this test covers the runtime fallback
    // (no pin → the browser language decides).
    expect(resolveMirrorPreference()).toBe('global')
    Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })
    expect(resolveMirrorPreference()).toBe('cn')
    Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true })
  })
})

describe('fetchWithMirrorFallback', () => {
  const url = `https://${RAW_GITHUB_HOST}/nutstore/pkg/main/manifest.json`
  const mirror = `https://${JSDELIVR_HOST}/gh/nutstore/pkg@main/manifest.json`

  it('tries a ref-root file URL after the beside-manifest URL returns 404', async () => {
    const alt = `https://${RAW_GITHUB_HOST}/nutstore/pkg/main/packages/example/manifest.json`
    const tried: string[] = []
    const result = await fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      if (candidate !== alt) throw Object.assign(new Error('HTTP 404'), { status: 404 })
      return 'package file'
    }, { candidates: [url, mirror, alt], allowCanonicalNotFoundFallback: true })
    expect(tried).toEqual([url, mirror, alt])
    expect(result.value).toBe('package file')
  })

  it('reads an authorizing catalog only from the canonical origin', async () => {
    const registry = registryFromManifestUrl(url)
    const requested: string[] = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input))
      throw new Error('origin unavailable')
    }) as typeof fetch
    await expect(fetchRegistryManifest(registry, { force: true, preference: 'cn', fetchImpl })).rejects.toThrow(/origin unavailable/)
    expect(requested).toEqual([url])
  })

  it('falls back to the mirror when the direct host fails', async () => {
    const tried: string[] = []
    const result = await fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      if (candidate === url) throw new Error('network unreachable')
      return 'manifest'
    }, { preference: 'global' })
    expect(tried).toEqual([url, mirror])
    expect(result.value).toBe('manifest')
    expect(result.usedMirror).toBe(true)
    expect(result.url).toBe(mirror)
  })

  it('prefers the mirror first for the CN build', async () => {
    const tried: string[] = []
    await fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      return 'manifest'
    }, { preference: 'cn' })
    // The mirror answered, so the direct host is never contacted.
    expect(tried).toEqual([mirror])
  })

  it('falls back from the mirror to the direct host when the mirror fails', async () => {
    const tried: string[] = []
    const result = await fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      if (candidate === mirror) throw new Error('mirror unreachable')
      return 'manifest'
    }, { preference: 'cn' })
    expect(tried).toEqual([mirror, url])
    expect(result.usedMirror).toBe(false)
  })

  it('retries a mirror 404 on the remaining candidates and rethrows the last 404', async () => {
    const tried: string[] = []
    // CN order: mirror 404s first, direct 404s second — the LAST 404 is
    // the one rethrown after every origin was asked.
    await expect(fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      throw Object.assign(new Error(`Download failed: HTTP 404 (${candidate})`), { status: 404 })
    }, { preference: 'cn' })).rejects.toThrow(/HTTP 404/)
    expect(tried).toEqual([mirror, url])
  })

  it('falls through a mirror 404 to a canonical origin that has the file', async () => {
    const tried: string[] = []
    const result = await fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      if (candidate === mirror) throw Object.assign(new Error('Download failed: HTTP 404'), { status: 404 })
      return 'manifest'
    }, { preference: 'cn' })
    expect(tried).toEqual([mirror, url])
    expect(result.value).toBe('manifest')
    expect(result.usedMirror).toBe(false)
  })

  it('does not fall back on a non-retryable client error (403)', async () => {
    const tried: string[] = []
    await expect(fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      throw Object.assign(new Error('Download failed: HTTP 403'), { status: 403 })
    }, { preference: 'global' })).rejects.toThrow(/HTTP 403/)
    expect(tried).toEqual([url])
  })

  it('falls back when the first host TIMES OUT (a timeout is a transport failure)', async () => {
    // fetchWithTimeout re-labels an abort as RegistryError("Registry request
    // timed out…"). Without the wrapped transport error that error read as a
    // SEMANTIC verdict and the mirror was never tried — a host that answers
    // too slowly blocked the whole load (finding: "Timed-out hosts prevent
    // mirror fallback").
    const tried: string[] = []
    const result = await fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      if (candidate === url) {
        const abort = new Error('The operation was aborted')
        abort.name = 'AbortError'
        throw new RegistryError(`Registry request timed out after 30s: ${candidate}`, abort)
      }
      return 'manifest'
    }, { preference: 'global' })
    expect(tried).toEqual([url, mirror])
    expect(result.value).toBe('manifest')
  })

  it('falls back to the canonical origin when a MIRROR serves checksum-mismatched bytes', async () => {
    // The preview's catalog-checksum check must treat a MIRROR's mismatch as
    // a stale-content verdict (retryable) and the CANONICAL origin's mismatch
    // as final (finding: "Stale mirror content blocks origin").
    const mismatch = (candidate: string) =>
      Object.assign(new RegistryError(`The package manifest does not match the catalog checksum (candidate ${candidate})`), { retryable: candidate !== url })
    const tried: string[] = []
    const result = await fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      if (candidate !== url) throw mismatch(candidate) // the mirror mismatch
      return 'manifest'
    }, { preference: 'cn' }) // mirror first, so the mirror's mismatch is the retried verdict
    expect(tried).toEqual([mirror, url])
    expect(result.value).toBe('manifest')
    // The canonical origin's own mismatch is DEFINITIVE — no mirror retry:
    const canonicalTried: string[] = []
    await expect(fetchWithMirrorFallback(url, async candidate => {
      canonicalTried.push(candidate)
      throw mismatch(candidate)
    }, { preference: 'global' })).rejects.toThrow(/does not match the catalog checksum/)
    expect(canonicalTried).toEqual([url])
  })

  it('does not fall back on a canonical-origin 404', async () => {
    // 404 is DEFINITIVE for the canonical raw host: both transports serve
    // the same git ref, so a mirror retry could only accept stale content
    // the origin already withdrew.
    const tried: string[] = []
    await expect(fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      throw Object.assign(new Error(`Download failed: HTTP 404 (${candidate})`), { status: 404 })
    }, { preference: 'global' })).rejects.toThrow(/HTTP 404/)
    expect(tried).toEqual([url])
  })

  it('falls back when the loader wraps a transport failure in a RegistryError', async () => {
    // loadOnce/fetchRegistryManifest re-label timeouts and network errors as
    // RegistryError("Registry unreachable…") — the wrap must keep the
    // TRANSPORT verdict, or the mirror is never tried.
    const tried: string[] = []
    const result = await fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      if (candidate === url) throw new RegistryError('Registry unreachable: network down', new Error('network down'))
      return 'manifest'
    }, { preference: 'global' })
    expect(tried).toEqual([url, mirror])
    expect(result.value).toBe('manifest')
    expect(result.usedMirror).toBe(true)
  })

  it('stops retrying a canonical-origin 404 at the first candidate', async () => {
    // A "not found" RegistryError (no wrapped transport error) is semantic —
    // the file does not exist at this ref on ANY origin.
    const tried: string[] = []
    await expect(fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      throw new RegistryError(`Registry manifest not found: ${candidate}`)
    }, { preference: 'global' })).rejects.toThrow(/not found/)
    expect(tried).toEqual([url])
  })

  it('does not fall back on a validation (RegistryError) failure', async () => {
    const tried: string[] = []
    await expect(fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      throw new RegistryError('Registry manifest is not valid JSON')
    }, { preference: 'global' })).rejects.toThrow(/not valid JSON/)
    expect(tried).toEqual([url])
  })

  it('rethrows the last failure when every candidate fails', async () => {
    const tried: string[] = []
    await expect(fetchWithMirrorFallback(url, async candidate => {
      tried.push(candidate)
      throw new Error(`failed: ${candidate}`)
    }, { preference: 'global' })).rejects.toThrow(new RegExp(`failed: ${mirror.replace(/[/.]/g, '\\$&')}`))
    // Both candidates were tried and the LAST candidate's error is the one
    // propagated (an early stop would surface the direct URL's error).
    expect(tried).toEqual([url, mirror])
  })
})

describe('isNotFoundError', () => {
  it('recognises a 404 status and the 404 phrasing', () => {
    expect(isNotFoundError(Object.assign(new Error('x'), { status: 404 }))).toBe(true)
    expect(isNotFoundError(new Error('Download failed for https://x: HTTP 404'))).toBe(true)
    expect(isNotFoundError(new Error('Registry manifest not found: https://x'))).toBe(true)
  })

  it('does not treat a transport failure as a missing file', () => {
    expect(isNotFoundError(new Error('network unreachable'))).toBe(false)
    expect(isNotFoundError(new Error('Download failed: HTTP 502'))).toBe(false)
  })
})

describe('validateRegistryManifest', () => {
  const sha = 'a'.repeat(64)
  const valid = {
    packages: [{
      id: 'com.example.tools',
      version: '1.0.0',
      description: 'Example',
      toolCount: 1,
      files: [{ path: 'packages/com.example.tools/manifest.json', sha256: sha }],
    }],
  }

  it('accepts a well-formed manifest', () => {
    expect(validateRegistryManifest(valid).packages).toHaveLength(1)
  })

  it('rejects a package id that is not a reverse-domain namespace', () => {
    expect(() => validateRegistryManifest({ packages: [{ ...valid.packages[0], id: 'tools' }] })).toThrow(/reverse-domain/)
  })

  it('rejects a non-semver version', () => {
    expect(() => validateRegistryManifest({ packages: [{ ...valid.packages[0], version: '1.0' }] })).toThrow(/semantic version/)
  })

  it('rejects a file that escapes the package directory', () => {
    expect(() => validateRegistryManifest({
      packages: [{
        ...valid.packages[0],
        files: [
          { path: 'packages/com.example.tools/manifest.json', sha256: sha },
          { path: 'packages/other/manifest.json', sha256: sha },
        ],
      }],
    })).toThrow(/escapes the package directory/)
  })

  it('rejects a manifest without a sha256', () => {
    expect(() => validateRegistryManifest({
      packages: [{ ...valid.packages[0], files: [{ path: 'packages/com.example.tools/manifest.json', sha256: 'nope' }] }],
    })).toThrow(/valid sha256/)
  })

  it('rejects a package whose manifest.json is not listed', () => {
    expect(() => validateRegistryManifest({
      packages: [{ ...valid.packages[0], files: [{ path: 'packages/com.example.tools/tool.js', sha256: sha }] }],
    })).toThrow(/manifest.json is missing/)
  })
})
