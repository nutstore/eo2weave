/**
 * WebMCP package registry client — extension side (issue #143).
 *
 * A registry is ANY repo hosting a `manifest.json` catalog of site packages:
 *
 *   { generatedAt, packages: [{ id, version, description, toolCount,
 *                               files: [{ path, sha256 }] }] }
 *
 * There is deliberately NO built-in/preloaded registry: every registry —
 * including the pilot `eo2weave-webmcp-packages` repo — is added by the user
 * through the extension's management UI ("add custom package repository").
 *
 * Users only paste a repo URL; `parseRegistryInput` derives the raw manifest
 * URL from the three accepted forms:
 *   1. full GitHub URL   github.com/<owner>/<repo>[/tree/<branch>][/sub/dir]
 *   2. owner/repo shorthand
 *   3. direct raw URL    raw.githubusercontent.com/... (manifest or any file)
 *
 * This is the extension-side port of the web app's
 * `web/webmcp/package-registry-client.ts` (issue #117). The URL derivation,
 * the manifest validation and the safety caps are kept byte-for-byte
 * equivalent. Catalogs are fetched from the canonical origin because their
 * hashes authorize installations. Package files can use the jsDelivr mirror
 * after their bytes are checked against those hashes.
 *
 * Manifests are cached in memory for 5 minutes per registry (session-level)
 * so re-opening the management page does not re-fetch.
 */

import { mirrorCandidates, resolveMirrorPreference, type MirrorPreference } from './registry-mirrors'

/** Manifest shape served by the packages registry (CI-validated source side). */
export interface RegistryManifestFile {
  /** Repo-relative package file path, e.g. `packages/<id>/manifest.json`. */
  path: string
  sha256: string
}

export interface RegistryManifestPackage {
  id: string
  version: string
  description: string
  toolCount: number
  files: RegistryManifestFile[]
}

export interface RegistryManifest {
  generatedAt?: string
  packages: RegistryManifestPackage[]
}

/** A registry the user added; everything needed to fetch files is derived. */
export interface PackageRegistry {
  /**
   * Raw ROOT able to serve any ref-path (`.../<ref>/<path>`): the manifest
   * URL keeps the FULL `<ref>` tail (a branch may contain `/`, and raw
   * hosts resolve refs greedily), while `rawBase` stays at the repo root so
   * manifest-listed package paths (`packages/<id>/...`, repo-relative)
   * build correct URLs under either branch/dir split. For a subdirectory
   * manifest URL this is also the repo root — manifest paths are
   * repo-relative — while `manifestUrl` keeps the subdirectory.
   */
  rawBase: string
  /** The full raw URL of the registry manifest. */
  manifestUrl: string
  /** Human label (owner/repo, or the host for non-GitHub raw inputs). */
  label: string
}

export class RegistryError extends Error {
  /**
   * The transport failure this error WRAPS, when the message was re-labelled
   * for the user (a timeout became "Registry request timed out…"). A wrapped
   * error is still a transport verdict, so the mirror fallback may try the
   * next candidate; an unwrapped one is a semantic verdict (invalid
   * manifest, not JSON, size cap) that no other origin can answer better.
   */
  readonly wrappedError?: unknown

  constructor(message: string, wrappedError?: unknown) {
    super(message)
    this.name = 'RegistryError'
    this.wrappedError = wrappedError
  }
}

const GITHUB_HOST = 'github.com'
const RAW_HOST = 'raw.githubusercontent.com'
/** Default branch when the input does not carry one (issue #117 decision). */
const DEFAULT_BRANCH = 'main'
/**
 * Bound on every registry/file request: a server that accepts a connection
 * but never responds must not keep the catalog loader or an install busy
 * forever. The error is phrased as retryable.
 */
export const REGISTRY_FETCH_TIMEOUT_MS = 30_000

/** Session-level manifest cache TTL (skill-store pattern). */
export const CACHE_TTL_MS = 5 * 60 * 1000
/**
 * Cache generation per manifest URL. An invalidation (or a newer fetch
 * starting) bumps the generation, so an OLDER fetch finishing afterwards
 * no longer caches its stale response with a fresh TTL — the late stale
 * catalog used to replace the refreshed one and kept serving outdated
 * packages for another full TTL (finding: "Older catalogs replace
 * refreshed ones").
 */
const cacheGenerations = new Map<string, number>()
/**
 * Byte cap for a registry manifest download. Enforced WHILE the body
 * streams — a hostile registry cannot balloon the management page's memory
 * with an oversized catalog.
 */
export const MAX_REGISTRY_MANIFEST_BYTES = 2 * 1024 * 1024

/**
 * Byte cap for the management page's own per-package manifest PREVIEW
 * fetch (the page fetches `packages/<id>/manifest.json` directly for the
 * tool list).
 */
export const MAX_PACKAGE_MANIFEST_PREVIEW_BYTES = 512 * 1024

/** Per-package caps: a registry entry cannot list unbounded/large payloads. */
export const MAX_PACKAGE_FILES = 200
/** Total staged size cap — the extension bridge itself refuses files > 32 MiB. */
export const MAX_PACKAGE_TOTAL_BYTES = 20 * 1024 * 1024
export const MAX_PACKAGE_FILE_BYTES = 8 * 1024 * 1024
/**
 * Cap on packages per registry catalog: the management page fetches a
 * manifest preview per package, so an unbounded catalog would launch
 * unbounded requests and rendering work. 50 packages is far above any
 * legitimate catalog.
 */
export const MAX_REGISTRY_PACKAGES = 50

const manifestCache = new Map<string, { data: RegistryManifest; ts: number }>()

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * Loose registry URL resolution. Accepts:
 *   - `https://github.com/<owner>/<repo>` (optionally `/tree/<branch>[/dir]`)
 *   - `<owner>/<repo>`
 *   - `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/...` (any
 *     file — the manifest path itself, or one file deeper in the tree)
 * and returns the derived raw base + manifest URL. Non-GitHub raw URLs are
 * taken as-is (path = the given directory). Anything unparseable throws a
 * `RegistryError` with an explicit reason — never a silent guess.
 */
export function parseRegistryInput(input: string): PackageRegistry {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) throw new RegistryError('Registry URL is required')

  // owner/repo shorthand: no scheme, exactly one slash, both segments clean.
  if (/^[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+$/.test(raw)) {
    const rawBase = `https://${RAW_HOST}/${raw}/${DEFAULT_BRANCH}`
    return { rawBase, manifestUrl: `${rawBase}/manifest.json`, label: raw }
  }

  let url: URL
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`)
  } catch {
    throw new RegistryError(`Invalid registry URL: ${input}`)
  }
  // Plain HTTP would let an interceptor replace the manifest, its checksums
  // AND the package files in transit — sha256 verification verifies against
  // the tampered manifest and passes. Registries are HTTPS-only.
  if (url.protocol !== 'https:') {
    throw new RegistryError(`Registry URLs must use HTTPS (got ${url.protocol})`)
  }

  if (url.hostname === RAW_HOST) {
    // raw.githubusercontent.com/<owner>/<repo>/<branch>[/dir...]/<file>
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 3) {
      throw new RegistryError('Raw registry URL must include owner, repo and branch')
    }
    const [owner, repo, ...refPath] = parts
    const label = `${owner}/${repo}`
    // BRANCH-ROOT input (finding: "Raw branch URLs fail to load"): a URL
    // with ONLY the ref (`.../owner/repo/main`) has no file segment —
    // treating the branch as the manifest filename produced a URL ending
    // in `/main`, and the catalog fetch failed for input the parser had
    // just accepted. Derive the manifest URL instead. With MORE than one
    // ref segment the tail is genuinely ambiguous (branch-with-slash +
    // directory vs. branch + path), so it is kept verbatim — see below.
    const tail = refPath.length === 1 ? [...refPath, 'manifest.json'] : refPath
    // A branch name containing `/` (`feature/registry`) is indistinguishable
    // from branch `feature` + directory `registry` by URL shape. raw+
    // jsDelivr both resolve ref-paths greedily against the repo's existing
    // refs, so the whole tail works for BOTH the manifest and repo-relative
    // package-file URLs — package files derive from `manifestUrl`, whose
    // tail is identical under either split (finding: "Slash branches break
    // package downloads": deriving from only the FIRST branch segment built
    // package-file URLs against a shorter ref).
    const rawBase = `${url.protocol}//${RAW_HOST}/${owner}/${repo}`
    return {
      rawBase,
      manifestUrl: `${rawBase}/${tail.join('/')}`,
      label,
    }
  }

  if (url.hostname === GITHUB_HOST || url.hostname === 'www.github.com') {
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) {
      throw new RegistryError('GitHub registry URL must include owner and repository')
    }
    const [owner, repo, keyword, ...treePath] = parts
    if (keyword !== undefined && keyword !== 'tree') {
      throw new RegistryError(`Unsupported GitHub URL path: /${keyword}`)
    }
    if (treePath.length === 0) {
      // No /tree/<ref> given — default branch, no subdirectory.
      const rawBase = `${url.protocol}//${RAW_HOST}/${owner}/${repo}/${DEFAULT_BRANCH}`
      return { rawBase, manifestUrl: `${rawBase}/manifest.json`, label: `${owner}/${repo}` }
    }
    // `/tree/<branch>[/dir]` with the same slash-in-branch caveat as the
    // raw form: the whole tail is kept in the manifest URL (identical under
    // either branch/dir split) and repo-relative package files derive from
    // it, so a slashed branch (`feature/x`) keeps working for downloads
    // (finding: "Slash branches break package downloads"). GitHub's own
    // ref resolution is greedy the same way.
    const repoRoot = `${url.protocol}//${RAW_HOST}/${owner}/${repo}`
    const manifestUrl = `${repoRoot}/${treePath.join('/')}/manifest.json`
    return { rawBase: repoRoot, manifestUrl, label: `${owner}/${repo}` }
  }

  throw new RegistryError(`Unsupported registry host: ${url.hostname}. Use a github.com repository URL or a raw.githubusercontent.com URL.`)
}

/** Build a registry from an already-resolved raw manifest URL (tests, power users). */
export function registryFromManifestUrl(manifestUrl: string, label?: string): PackageRegistry {
  let url: URL
  try {
    url = new URL(manifestUrl)
  } catch {
    throw new RegistryError(`Invalid manifest URL: ${manifestUrl}`)
  }
  const parts = url.pathname.split('/').filter(Boolean)
  // owner/<repo> minimum: the manifest must sit in a repo the raw host can
  // serve (the ref path follows).
  if (parts.length < 4) {
    throw new RegistryError('Manifest URL must include owner, repo and ref path')
  }
  // rawBase is the REPO ROOT (owner/repo): the manifest URL keeps the full
  // `<ref>[/<dir>]` tail — identical under either branch/dir split, so a
  // branch containing `/` keeps both the catalog and the repo-relative
  // package-file downloads working (finding: "Slash branches break package
  // downloads"). Repo-relative package paths append to the root directly.
  const rawBase = `${url.protocol}//${url.host}/${parts.slice(0, 2).join('/')}`
  return { rawBase, manifestUrl, label: label ?? parts.slice(0, 2).join('/') }
}

/**
 * Raw URL for one manifest-listed package file.
 *
 * Package paths are REPO-relative (`packages/<id>/...` — the CI generator
 * in the packages repo hashes files with `path.relative(repoRoot, …)`),
 * but the ref boundary inside a raw-URL tail cannot be split from the
 * catalog subdirectory by URL shape. The manifest URL therefore carries
 * the FULL `<ref>[/<dir>]` tail and the file URL REPLACES the manifest
 * file name inside it — the primary resolution — while
 * `registryAltFileUrl` derives the REF-ROOT alternative for the one case
 * the swap cannot cover: a manifest in a repo subdirectory whose catalog
 * lists paths from the repo root (finding: "Subdirectory registries
 * cannot load packages").
 */
export function registryFileUrl(registry: PackageRegistry, path: string): string {
  const clean = path.replace(/^\/+/, '')
  if (!clean || clean.includes('..')) throw new RegistryError(`Invalid package file path: ${path}`)
  const manifestUrl = registry.manifestUrl
  // A raw manifest URL ends in a file name under `<ref>[/<dir>]`; swap that
  // final segment for the package file path. (The stored manifest URL is
  // always produced by this module's parsers, which guarantee a final
  // segment.)
  const lastSlash = manifestUrl.lastIndexOf('/')
  if (lastSlash <= manifestUrl.indexOf('://') + 2) {
    throw new RegistryError(`Registry manifest URL has no file segment: ${manifestUrl}`)
  }
  return `${manifestUrl.slice(0, lastSlash + 1)}${clean}`
}

/**
 * REF-ROOT alternative URLs for one manifest-listed package file.
 *
 * `registryFileUrl` resolves package paths BESIDE the manifest, which is
 * right when the catalog and its packages share a directory. The manifest
 * format, though, stores REPO-relative paths (the packages repo's CI
 * generator hashes files with `path.relative(repoRoot, …)`), so a manifest
 * hosted in a SUBDIRECTORY (`<ref>/registry/manifest.json`) with catalog
 * paths like `packages/<id>/manifest.json` must load them from the REF
 * ROOT — the beside-the-manifest URL 404s (finding: "Subdirectory
 * registries cannot load packages").
 *
 * The ref boundary inside the manifest URL's tail is unknowable from the
 * URL shape alone (a branch may contain `/`), so EVERY prefix of the tail
 * is offered as an alternative: for a manifest under
 * `<owner>/<repo>/<a1>/…/<ak>/<file>` the candidates re-anchor the file at
 * `<a1>`, `<a1>/<a2>`, … — the true ref-root form is among them whichever
 * way the branch/dir split actually goes. The prefix that equals the whole
 * dir tail reproduces the primary form and is dropped (no duplicates).
 * Order is stable (shortest ref first), the list is capped, and every
 * candidate's bytes are still verified against the catalog sha256 — a
 * stale or hostile answer cannot slip through either split. Empty when the
 * manifest has no directory under its ref (both derivations coincide) or
 * the manifest URL is not a GitHub raw URL.
 */
const MAX_ALT_FILE_URLS = 3

export function registryAltFileUrls(registry: PackageRegistry, path: string): string[] {
  const clean = path.replace(/^\/+/, '')
  if (!clean || clean.includes('..')) throw new RegistryError(`Invalid package file path: ${path}`)
  const parsed = new URL(registry.manifestUrl)
  const parts = parsed.pathname.split('/').filter(Boolean)
  // <owner>/<repo>/<ref...>[/<dir...>]/<file>: at least ref + file.
  if (parsed.hostname !== RAW_HOST || parts.length < 4) return []
  const [owner, repo, ...tail] = parts
  const primary = registryFileUrl(registry, path)
  const alternatives: string[] = []
  // Prefix j of the tail (excluding the file segment) re-anchors the file
  // at `<a1>/…/<aj>`; the FULL tail minus the file reproduces the primary
  // form, so j stops one short of it.
  for (let j = 1; j <= tail.length - 2 && alternatives.length < MAX_ALT_FILE_URLS; j++) {
    const alt = `${parsed.protocol}//${RAW_HOST}/${owner}/${repo}/${tail.slice(0, j).join('/')}/${clean}`
    if (alt !== primary && !alternatives.includes(alt)) alternatives.push(alt)
  }
  return alternatives
}

/**
 * Shared fetch deadline for registry and package-file requests. A stalled
 * connection aborts after `REGISTRY_FETCH_TIMEOUT_MS` with a retryable error
 * instead of hanging the management page or an install indefinitely. The
 * abort deadline is returned WITH the response and must stay armed until the
 * BODY has been consumed — clearing it at header time let a hostile server
 * stall the caller forever after answering the headers.
 */
async function fetchWithTimeout(url: string, init: RequestInit, fetchImpl: typeof fetch, timeoutMs: number = REGISTRY_FETCH_TIMEOUT_MS): Promise<{ response: Response; done: () => void }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal })
    return { response, done: () => clearTimeout(timer) }
  } catch (error) {
    clearTimeout(timer)
    if (controller.signal.aborted) {
      // The wrap KEEPS the transport error (`wrappedError`): `isRetryableFetchError`
      // classifies a RegistryError WITHOUT a wrapped error as a semantic verdict
      // and would not fall through to the mirror, so a bare timeout RegistryError
      // stopped `fetchWithMirrorFallback` at the first candidate (finding: "Timed-out
      // hosts prevent mirror fallback").
      throw new RegistryError(`Registry request timed out after ${timeoutMs / 1000}s: ${url}`, error)
    }
    throw error
  }
}

/**
 * Stream a JSON response under a byte cap with the deadline active through
 * body consumption. Buffering `json()` first would let an oversized body
 * exhaust memory before the size check ran.
 *
 * Returns the parsed value AND the raw bytes — the checksum verification
 * must hash EXACTLY what was received, not a re-serialization of the
 * parsed object (key order/whitespace would differ).
 */
async function parseJsonCappedBytes(response: Response, maxBytes: number, done: () => void): Promise<{ data: unknown; bytes: Uint8Array }> {
  let data: unknown
  let bytes: Uint8Array
  try {
    const reader = response.body?.getReader()
    if (!reader) { // no streaming body (test doubles)
      bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length > maxBytes) throw new RegistryError(`Registry manifest exceeds the size limit (${maxBytes} bytes)`)
      data = JSON.parse(new TextDecoder().decode(bytes))
      return { data, bytes }
    }
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        // The abort deadline fired MID-BODY — report it as the timeout it
        // is, not as a bare DOMException. The wrap KEEPS the transport
        // error (`wrappedError`) so the mirror fallback still sees a
        // retryable transport verdict (finding: "Timed-out hosts prevent
        // mirror fallback" — an unwrapped timeout RegistryError read as a
        // semantic verdict and stopped the fallback).
        if ((error as { name?: string }).name === 'AbortError') {
          throw new RegistryError(`Registry request timed out while reading the body: ${response.url}`, error)
        }
        throw error
      }
      const { done: finished, value } = chunk
      if (finished) break
      total += value.byteLength
      if (total > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new RegistryError(`Registry manifest exceeds the size limit (${maxBytes} bytes)`)
      }
      chunks.push(value)
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      merged.set(chunk, offset)
      offset += chunk.byteLength
    }
    bytes = merged
    try {
      data = JSON.parse(new TextDecoder().decode(merged))
    } catch {
      throw new RegistryError('Registry manifest is not valid JSON')
    }
    return { data, bytes }
  } finally {
    done()
  }
}

/** JSON-only variant of `parseJsonCappedBytes` for callers that ignore the bytes. */
async function parseJsonCapped(response: Response, maxBytes: number, done: () => void): Promise<unknown> {
  return (await parseJsonCappedBytes(response, maxBytes, done)).data
}

/** Registry ids must satisfy the same reverse-domain rule as package manifests. */
const REGISTRY_ID_PATTERN = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/
/** Same semver rule the package manifest validator applies. */
const REGISTRY_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * Structural validation — the installer reads `packages[].files[].{path,sha256}`
 * to decide what to download, so every entry must be well-formed. Extra
 * manifest fields are tolerated (forward compatibility); a malformed entry
 * rejects the WHOLE manifest rather than installing a half-readable catalog.
 *
 * Package IDs are validated against the SAME reverse-domain rule the
 * extension's `validateManifest` enforces — an entry the catalog would list
 * but the installer can never install is rejected at catalog time instead.
 * Versions must be semantic versions for the same reason: the downloaded
 * manifest's version field must pass `validateManifest`, so a registry
 * version claim that is not a semver would guarantee an install failure.
 */
export function validateRegistryManifest(data: unknown): RegistryManifest {
  if (!isPlainObject(data)) throw new RegistryError('Registry manifest must be a JSON object')
  if (!Array.isArray(data.packages)) throw new RegistryError('Registry manifest is missing the packages array')
  if (data.packages.length > MAX_REGISTRY_PACKAGES) {
    throw new RegistryError(`Registry manifest lists too many packages (${data.packages.length}; the limit is ${MAX_REGISTRY_PACKAGES})`)
  }
  const packages: RegistryManifestPackage[] = data.packages.map((entry, index) => {
    if (!isPlainObject(entry)) throw new RegistryError(`Package #${index} is not an object`)
    const { id, version, description, toolCount, files } = entry
    if (typeof id !== 'string' || !REGISTRY_ID_PATTERN.test(id)) {
      throw new RegistryError(`Package #${index} has an invalid id (must be a reverse-domain namespace, such as com.example.tools)`)
    }
    if (typeof version !== 'string' || !REGISTRY_VERSION_PATTERN.test(version)) {
      throw new RegistryError(`Package ${id}: version must be a semantic version`)
    }
    if (typeof description !== 'string') throw new RegistryError(`Package ${id}: missing description`)
    if (typeof toolCount !== 'number' || !Number.isInteger(toolCount) || toolCount < 0) {
      throw new RegistryError(`Package ${id}: invalid toolCount`)
    }
    if (!Array.isArray(files) || files.length === 0) throw new RegistryError(`Package ${id}: files must be a non-empty array`)
    if (files.length > MAX_PACKAGE_FILES) {
      throw new RegistryError(`Package ${id}: too many files (${files.length}; the limit is ${MAX_PACKAGE_FILES})`)
    }
    const seen = new Set<string>()
    const validatedFiles = files.map((file, fileIndex) => {
      if (!isPlainObject(file)) throw new RegistryError(`Package ${id}: file #${fileIndex} is not an object`)
      const { path, sha256 } = file
      if (typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) {
        throw new RegistryError(`Package ${id}: invalid file path ${JSON.stringify(path)}`)
      }
      // Every file of a package must live under the package's own directory.
      if (!path.startsWith(`packages/${id}/`)) {
        throw new RegistryError(`Package ${id}: file ${path} escapes the package directory`)
      }
      if (!isSha256(sha256)) throw new RegistryError(`Package ${id}: file ${path} has no valid sha256`)
      if (seen.has(path)) throw new RegistryError(`Package ${id}: duplicate file ${path}`)
      seen.add(path)
      return { path, sha256 }
    })
    if (!validatedFiles.some(file => file.path === `packages/${id}/manifest.json`)) {
      throw new RegistryError(`Package ${id}: manifest.json is missing from files`)
    }
    return { id, version, description, toolCount, files: validatedFiles }
  })
  const ids = new Set<string>()
  for (const pkg of packages) {
    if (ids.has(pkg.id)) throw new RegistryError(`Duplicate package id in manifest: ${pkg.id}`)
    ids.add(pkg.id)
  }
  return { generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : undefined, packages }
}

/**
 * The outcome of a mirror-aware fetch: the URL that actually answered plus
 * whether it was the canonical URL or a mirror.
 */
export interface MirrorFetchResult<T> {
  value: T
  /** The URL that produced the value (a mirror when the direct host failed). */
  url: string
  /** True when the value came from a mirror rather than the canonical URL. */
  usedMirror: boolean
}

/**
 * Fetch a URL through the mirror candidate list.
 *
 * The canonical URL is tried FIRST for the `global` preference and the
 * jsDelivr mirror is tried first for the `cn` preference (see
 * `registry-mirrors.ts`).
 *
 * Fallback policy:
 *   - Transport failures (network errors, timeouts) and 5xx server errors
 *     move on to the next candidate — that is the mirror's whole purpose;
 *   - a 404 falls through when the answering candidate is a MIRROR:
 *     a CDN can lag the origin or be unable to serve private files, and a
 *     mirror 404 that aborted the whole load used to block valid resources
 *     (finding: "Mirror 404 blocks valid origins"). A 404 from the
 *     CANONICAL raw URL is terminal (finding: "Missing resources contact
 *     another host"): the direct host IS the identity of the resource and
 *     every mirror serves the same git ref, so the 404 of the canonical
 *     candidate is the one rethrown by default. Package-file callers can
 *     opt into trying a distinct ref-root path after a canonical 404;
 *   - validation failures and other NON-retryable client errors (4xx other
 *     than 404/429) do not fall through either: retrying them on a mirror
 *     could accept different or stale mirror content instead of surfacing
 *     the preferred candidate's answer (finding: "Invalid mirrors mask
 *     catalog errors"). `isRetryableFetchError` is the whitelist.
 *
 * The returned `url` is the one that answered, so callers can report which
 * transport served the bytes without re-deriving it.
 */
export async function fetchWithMirrorFallback<T>(
  url: string,
  load: (candidate: string) => Promise<T>,
  options?: { preference?: MirrorPreference; candidates?: string[]; signal?: AbortSignal; allowCanonicalNotFoundFallback?: boolean },
): Promise<MirrorFetchResult<T>> {
  const candidates = options?.candidates ?? mirrorCandidates(url, options?.preference ?? resolveMirrorPreference())
  let lastError: unknown
  for (let index = 0; index < candidates.length; index++) {
    options?.signal?.throwIfAborted()
    const candidate = candidates[index]!
    const isLast = index === candidates.length - 1
    try {
      const value = await load(candidate)
      return { value, url: candidate, usedMirror: candidate !== url }
    } catch (error) {
      options?.signal?.throwIfAborted()
      lastError = error
      // Catalog 404s are terminal at the canonical origin. Package-file
      // callers opt into ref-root alternatives for subdirectory registries.
      if (isNotFoundError(error)) {
        if ((candidate === url && !options?.allowCanonicalNotFoundFallback) || isLast) throw error
        continue
      }
      // A definitive non-retryable answer (validation failure, a client
      // error other than 404/429) is the SAME answer a mirror would give —
      // do not retry it and risk masking the real error with mirror data.
      if (!isRetryableFetchError(error)) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new RegistryError(`Registry unreachable: ${String(lastError)}`)
}

/**
 * True when the failure is worth retrying on the next mirror candidate:
 * transport errors (network, timeout, abort) and HTTP server/429 responses.
 * Deliberately narrow — a validation error or an unexpected 4xx must reach
 * the caller instead of being papered over by another origin's response.
 *
 * A 404 is NOT retryable (findings: "Missing resources contact another
 * host"): the raw host is the canonical identity of the resource and both
 * transports serve the same git ref, so a 404 answer does not improve on
 * another origin's — retrying one let a stale mirror serve content the
 * canonical origin had already withdrawn. A 404 from a MIRROR candidate is
 * still fall-through-able (a CDN can lag the origin), which
 * `fetchWithMirrorFallback` expresses with `isNotFoundError`, not here.
 *
 * A RegistryError that was WRAPPED around a transport failure (timeout,
 * stalled body — `loadOnce` re-labels those so the user sees a registry
 * message) stays retryable (finding: "Available mirror is never tried"):
 * `wrappedError` records the original transport error, and a registry
 * error WITHOUT one is a semantic verdict (invalid manifest, not JSON,
 * size cap) that another transport cannot answer better.
 *
 * An error explicitly marked `retryable` by its loader is retried too: a
 * loader that verified the received bytes (the preview's catalog-checksum
 * check) can distinguish a mirror's stale content (the canonical origin
 * may hold the published file) from a canonical origin's final mismatch.
 */
export function isRetryableFetchError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status
  if (typeof status === 'number') return status >= 500 || status === 429
  // An explicit `retryable` verdict from a loader that INSPECTED the bytes
  // (e.g. the preview's catalog-checksum check): the checksum mismatch of a
  // mirror candidate is a stale-content verdict the canonical origin may
  // still answer correctly (finding: "Stale mirror content blocks origin").
  if ((error as { retryable?: boolean } | null)?.retryable === true) return true
  // A 404 phrasing without a status ("not found", "HTTP 404") is likewise
  // definitive — see above.
  if (isNotFoundError(error)) return false
  const name = (error as { name?: string } | null)?.name
  if (name === 'AbortError' || name === 'TimeoutError') return true
  if (error instanceof RegistryError) return error.wrappedError !== undefined
  // Any other Error is a transport/network failure — retry.
  return error instanceof Error
}

/** True when the failure means "this path does not exist" (not a transport failure). */
export function isNotFoundError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status
  if (status === 404) return true
  const message = error instanceof Error ? error.message : String(error)
  // Both the client's own "not found" phrasing and the installer's
  // "HTTP 404" phrasing are definitive: the file does not exist in the
  // repo, and every mirror would answer the same way.
  return /HTTP 404\b|\bnot found\b/i.test(message)
}

/** Fetch + validate a registry manifest (5-minute session cache per URL). */
export async function fetchRegistryManifest(
  registry: PackageRegistry,
  options?: { force?: boolean; fetchImpl?: typeof fetch; timeoutMs?: number; preference?: MirrorPreference },
): Promise<RegistryManifest> {
  const doFetch = options?.fetchImpl ?? fetch
  const cached = manifestCache.get(registry.manifestUrl)
  if (!options?.force && cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.data

  // Bump the URL's cache generation: any fetch that started EARLIER (and is
  // still in flight) must not cache its response over ours.
  const generation = (cacheGenerations.get(registry.manifestUrl) ?? 0) + 1
  cacheGenerations.set(registry.manifestUrl, generation)

  const loadOnce = async (manifestUrl: string): Promise<{ manifest: RegistryManifest }> => {
    let response: Response
    let done: () => void
    try {
      ({ response, done } = await fetchWithTimeout(
        manifestUrl,
        { credentials: 'omit', cache: options?.force ? 'no-cache' : 'default' },
        doFetch,
        options?.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS,
      ))
    } catch (error) {
      if (error instanceof RegistryError) throw error
      // The timeout wrap KEEPS the transport error: the mirror fallback
      // must see a retryable (transport) verdict, not a semantic one.
      throw new RegistryError(`Registry unreachable: ${error instanceof Error ? error.message : String(error)}`, error)
    }
    if (response.status === 404) {
      done()
      // Definitive — the file does not exist at this ref, and every mirror
      // serves the same ref. Not retried on the next candidate.
      throw new RegistryError(`Registry manifest not found: ${registry.manifestUrl}`)
    }
    if (!response.ok) {
      done()
      // 5xx/429 are transport-class failures the mirror can cover; other
      // 4xx answers are definitive and MUST NOT reach another origin —
      // mark them with the status so `isRetryableFetchError` classifies
      // them as final (finding: "Client errors trigger mirror attempts").
      const error = new RegistryError(`Failed to fetch registry manifest: HTTP ${response.status}`)
      ;(error as { status?: number }).status = response.status
      throw error
    }
    // The deadline stays armed and the byte cap enforced WHILE streaming.
    const data = await parseJsonCapped(response, MAX_REGISTRY_MANIFEST_BYTES, done)
    return { manifest: validateRegistryManifest(data) }
  }

  // The catalog authorizes package hashes. A CDN response cannot establish
  // what the publisher currently authorizes, so read catalogs from their
  // canonical origin; mirrors remain available for hash-checked file bytes.
  const result = await loadOnce(registry.manifestUrl)
  // Cache only when this fetch is still the newest one for the URL — a
  // stale in-flight request finishing after a forced refresh must not
  // overwrite the refreshed catalog with a fresh TTL.
  if (cacheGenerations.get(registry.manifestUrl) === generation) {
    manifestCache.set(registry.manifestUrl, { data: result.manifest, ts: Date.now() })
  }
  return result.manifest
}

/**
 * Fetch one package's own manifest for the TOOL PREVIEW.
 *
 * The catalog entry's `toolCount` is a publisher-provided CLAIM — it may
 * disagree with the manifest the installer will actually validate. The
 * preview fetches the real manifest under a byte cap so the card can show
 * the tool names; when the preview fails, the count stays UNVERIFIED and
 * the install verifies the manifest for real.
 *
 * The preview manifest is validated against the SAME schema the installer
 * applies (`validateManifest`, via a dynamic import that avoids the
 * client→installer cycle) and must agree with the CATALOG entry's id and
 * version: a manifest with a tools array that is otherwise malformed, or
 * names a different package/version than the catalog lists, is not a
 * verified preview — the installer would reject it at install time and the
 * page must not mark those tools as verified (findings: "Invalid manifests
 * appear verified", "Unverified tools appear verified").
 *
 * Previewed package bytes may come from a mirror, but the catalog checksum
 * that authorizes those bytes comes from the canonical registry origin.
 */
export async function fetchPackageManifestPreview(
  registry: PackageRegistry,
  packageId: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number; preference?: MirrorPreference; expectedVersion?: string; expectedManifestSha256?: string },
): Promise<{ tools: Array<{ name: string; description: string }> }> {
  const doFetch = options?.fetchImpl ?? fetch
  const load = async (candidate: string): Promise<{ tools: Array<{ name: string; description: string }>; bytes: Uint8Array }> => {
    let response: Response
    let done: () => void
    try {
      ({ response, done } = await fetchWithTimeout(
        candidate,
        { credentials: 'omit', cache: 'default' },
        doFetch,
        options?.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS,
      ))
    } catch (error) {
      // Keep the transport verdict retryable for the mirror fallback (see
      // `fetchRegistryManifest.loadOnce`).
      if (error instanceof RegistryError) throw error
      throw new RegistryError(`Registry unreachable: ${error instanceof Error ? error.message : String(error)}`, error)
    }
    if (!response.ok) {
      done()
      // Status preserved: 5xx/429 stay mirror-retryable, other 4xx are
      // definitive (see `fetchRegistryManifest.loadOnce`).
      const error = new RegistryError(`Failed to fetch package manifest: HTTP ${response.status}`)
      ;(error as { status?: number }).status = response.status
      throw error
    }
    const { data, bytes } = await parseJsonCappedBytes(response, MAX_PACKAGE_MANIFEST_PREVIEW_BYTES, done)
    if (!isPlainObject(data) || !Array.isArray(data.tools)) {
      throw new RegistryError('The package manifest lists no tools')
    }
    // Schema-validate the manifest exactly like the installer will, and
    // require the catalog's id/version agreement before trusting the tools.
    const { validateManifest } = await import('@creatorweave/shared/webmcp-adapter')
    let manifest: import('@creatorweave/shared/webmcp-adapter').WebMCPPackageManifest
    try {
      manifest = validateManifest(data, packageId)
    } catch (error) {
      throw new RegistryError(
        `The package manifest is not valid: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (options?.expectedVersion !== undefined && manifest.version !== options.expectedVersion) {
      throw new RegistryError(
        `The package manifest version ${manifest.version} does not match the catalog version ${options.expectedVersion}`,
      )
    }
    // Verify the fetched bytes against the CATALOG's manifest.json sha256
    // (finding: "Preview skips catalog checksum"). The install path already
    // refuses a manifest that does not match what the catalog author
    // published — a preview that skipped the check marked a changed or
    // stale mirror's same-version manifest as verified. The catalog entry
    // is the reference; the mirror never is.
    if (options?.expectedManifestSha256 !== undefined) {
      const { sha256Hex } = await import('./package-installer')
      const actual = await sha256Hex(bytes)
      if (actual !== options.expectedManifestSha256.toLowerCase()) {
        // The checksum mismatch of a NON-CANONICAL candidate (a mirror) is a
        // TRANSPORT-class verdict: the CDN served stale or altered bytes, and
        // the canonical origin may still hold the published file — mark the
        // error so `fetchWithMirrorFallback` tries the next candidate instead
        // of aborting the preview (finding: "Stale mirror content blocks
        // origin"). A canonical candidate's mismatch stays NON-retryable: the
        // origin IS the identity of the file, so a mismatch there is final.
        throw Object.assign(
          new RegistryError(
            `The package manifest does not match the catalog checksum (expected ${options.expectedManifestSha256}, got ${actual})`,
          ),
          { retryable: candidate !== url },
        )
      }
    }
    return { tools: manifest.tools.map(tool => ({ name: tool.name, description: tool.description })), bytes }
  }
  // Candidates: the beside-the-manifest form first (both its transports),
  // then the REF-ROOT alternative — a manifest in a repo subdirectory lists
  // repo-relative paths the primary form cannot address (finding:
  // "Subdirectory registries cannot load packages"). Same-origin extra
  // candidate, same 404/transport semantics as any other fallback step.
  const url = registryFileUrl(registry, `packages/${packageId}/manifest.json`)
  const candidates = mirrorCandidates(url, options?.preference ?? resolveMirrorPreference())
  for (const alt of registryAltFileUrls(registry, `packages/${packageId}/manifest.json`)) {
    if (!candidates.includes(alt)) candidates.push(alt)
  }
  const result = await fetchWithMirrorFallback(url, load, { preference: options?.preference, candidates, allowCanonicalNotFoundFallback: true })
  return result.value
}

/** Drop cached manifests (the management page's "refresh" button). */
export function invalidateRegistryCache(registry?: PackageRegistry): void {
  if (registry) {
    manifestCache.delete(registry.manifestUrl)
    // A fetch still in flight for this URL must not cache its stale
    // response now that the cache was invalidated.
    cacheGenerations.set(registry.manifestUrl, (cacheGenerations.get(registry.manifestUrl) ?? 0) + 1)
  } else {
    manifestCache.clear()
    for (const url of cacheGenerations.keys()) {
      cacheGenerations.set(url, (cacheGenerations.get(url) ?? 0) + 1)
    }
  }
}
