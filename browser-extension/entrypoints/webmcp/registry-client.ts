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
 * equivalent; the ONE behavioural addition is the MIRROR FALLBACK (see
 * `registry-mirrors.ts`): when the canonical `raw.githubusercontent.com`
 * host does not answer, the client retries through the jsDelivr CDN mirror
 * instead of failing the whole catalog load. The direct raw URL stays the
 * canonical identity of the resource — the mirror is only a transport
 * fallback.
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
   * Raw base able to serve any REPO-RELATIVE path (`.../<branch>`). For a
   * subdirectory manifest URL this stays at the repo root — manifest paths
   * are repo-relative — while `manifestUrl` keeps the subdirectory.
   */
  rawBase: string
  /** The full raw URL of the registry manifest. */
  manifestUrl: string
  /** Human label (owner/repo, or the host for non-GitHub raw inputs). */
  label: string
}

export class RegistryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RegistryError'
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
    // A branch name containing `/` (`feature/registry`) is indistinguishable
    // from branch `feature` + directory `registry` by URL shape. The
    // manifest URL keeps the FULL tail, which is identical under either
    // split, and raw.githubusercontent.com resolves ref-paths greedily
    // against the repo's existing refs — so both the catalog and
    // repo-relative file downloads under the first-segment rawBase work for
    // slashed branches. The only ambiguity left (both `feature` and
    // `feature/registry` exist AND the manifest sits under only one) is not
    // resolvable client-side without an API round-trip.
    const [branch, ...dir] = refPath
    const rawBase = `${url.protocol}//${RAW_HOST}/${owner}/${repo}/${branch}`
    return {
      rawBase,
      manifestUrl: dir.length ? `${rawBase}/${dir.join('/')}` : `${rawBase}/manifest.json`,
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
    // raw form: the first segment is the branch, the rest the subdirectory
    // (matching the documented URL form), and raw.githubusercontent's greedy
    // ref resolution keeps manifest AND repo-relative file URLs working
    // when the branch itself contains slashes.
    const [branch, ...dir] = treePath
    const repoRoot = `${url.protocol}//${RAW_HOST}/${owner}/${repo}`
    const rawBase = `${repoRoot}/${branch}`
    return {
      rawBase,
      manifestUrl: dir.length ? `${rawBase}/${dir.join('/')}/manifest.json` : `${rawBase}/manifest.json`,
      label: `${owner}/${repo}`,
    }
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
  if (parts.length < 2) throw new RegistryError('Manifest URL must include at least owner/repo')
  // Everything up to the last segment is the raw base (the final segment is
  // conventionally the manifest file name). Subdirectory manifests keep their
  // directory in the manifest URL; file paths stay repo-relative.
  const base = parts.slice(0, -1).join('/')
  return { rawBase: `${url.protocol}//${url.host}/${base}`, manifestUrl, label: label ?? parts.slice(0, 2).join('/') }
}

/** Raw URL for one manifest-listed package file. */
export function registryFileUrl(registry: PackageRegistry, path: string): string {
  const clean = path.replace(/^\/+/, '')
  if (!clean || clean.includes('..')) throw new RegistryError(`Invalid package file path: ${path}`)
  return `${registry.rawBase}/${clean}`
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
      throw new RegistryError(`Registry request timed out after ${timeoutMs / 1000}s: ${url}`)
    }
    throw error
  }
}

/**
 * Stream a JSON response under a byte cap with the deadline active through
 * body consumption. Buffering `json()` first would let an oversized body
 * exhaust memory before the size check ran.
 */
async function parseJsonCapped(response: Response, maxBytes: number, done: () => void): Promise<unknown> {
  try {
    const reader = response.body?.getReader()
    if (!reader) return await response.json() // no streaming body (test doubles)
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        // The abort deadline fired MID-BODY — report it as the timeout it
        // is, not as a bare DOMException.
        if ((error as { name?: string }).name === 'AbortError') {
          throw new RegistryError(`Registry request timed out while reading the body: ${response.url}`)
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
    try {
      return JSON.parse(new TextDecoder().decode(merged))
    } catch {
      throw new RegistryError('Registry manifest is not valid JSON')
    }
  } finally {
    done()
  }
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
 *   - a 404 IS retried on the remaining candidates, because a mirror can
 *     miss content the canonical origin has (CDN propagation lag, private
 *     files with an access query jsDelivr cannot serve) — a mirror 404 used
 *     to abort the whole load and block valid resources (finding: "Mirror
 *     404 blocks valid origins"). The 404 of the LAST candidate is the one
 *     rethrown, so a genuinely absent file still fails fast after every
 *     origin has been asked;
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
  options?: { preference?: MirrorPreference; candidates?: string[] },
): Promise<MirrorFetchResult<T>> {
  const candidates = options?.candidates ?? mirrorCandidates(url, options?.preference ?? resolveMirrorPreference())
  let lastError: unknown
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]!
    const isLast = index === candidates.length - 1
    try {
      const value = await load(candidate)
      return { value, url: candidate, usedMirror: candidate !== url }
    } catch (error) {
      lastError = error
      // A definitive non-retryable answer (validation failure, a client
      // error other than 404/429) is the SAME answer a mirror would give —
      // do not retry it and risk masking the real error with mirror data.
      if (!isRetryableFetchError(error)) throw error
      // A 404 from the LAST candidate is final — nothing left to ask.
      if (isNotFoundError(error) && isLast) throw error
    }
  }
  throw lastError instanceof Error ? lastError : new RegistryError(`Registry unreachable: ${String(lastError)}`)
}

/**
 * True when the failure is worth retrying on the next mirror candidate:
 * transport errors (network, timeout, abort) and HTTP server/429 responses.
 * Deliberately narrow — a validation error or an unexpected 4xx must reach
 * the caller instead of being papered over by another origin's response.
 */
export function isRetryableFetchError(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status
  if (status === 404) return true // a mirror can miss; ask the next origin
  if (typeof status === 'number') return status >= 500 || status === 429
  if (isNotFoundError(error)) return true // 404 phrasing without a status
  const name = (error as { name?: string } | null)?.name
  if (name === 'AbortError' || name === 'TimeoutError') return true
  // RegistryError carries a semantic verdict (invalid manifest, not JSON,
  // size cap) — that answer does not improve on another transport.
  if (error instanceof RegistryError) return false
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
      throw new RegistryError(`Registry unreachable: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (response.status === 404) {
      done()
      throw new RegistryError(`Registry manifest not found: ${registry.manifestUrl}`)
    }
    if (!response.ok) {
      done()
      throw new RegistryError(`Failed to fetch registry manifest: HTTP ${response.status}`)
    }
    // The deadline stays armed and the byte cap enforced WHILE streaming.
    const data = await parseJsonCapped(response, MAX_REGISTRY_MANIFEST_BYTES, done)
    return { manifest: validateRegistryManifest(data) }
  }

  const result = await fetchWithMirrorFallback(
    registry.manifestUrl,
    // A 404 is definitive (the file does not exist in the repo) and is NOT
    // retried on a mirror; every other failure (network error, timeout, 5xx)
    // is worth a retry on the CDN.
    candidate => loadOnce(candidate),
    { preference: options?.preference },
  )
  manifestCache.set(registry.manifestUrl, { data: result.value.manifest, ts: Date.now() })
  return result.value.manifest
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
 * The preview goes through the same mirror candidate list as the catalog:
 * a registry that only the CDN can reach must still preview.
 */
export async function fetchPackageManifestPreview(
  registry: PackageRegistry,
  packageId: string,
  options?: { fetchImpl?: typeof fetch; timeoutMs?: number; preference?: MirrorPreference },
): Promise<{ tools: Array<{ name: string; description: string }> }> {
  const doFetch = options?.fetchImpl ?? fetch
  const url = registryFileUrl(registry, `packages/${packageId}/manifest.json`)
  const load = async (candidate: string): Promise<{ tools: Array<{ name: string; description: string }> }> => {
    const { response, done } = await fetchWithTimeout(
      candidate,
      { credentials: 'omit', cache: 'default' },
      doFetch,
      options?.timeoutMs ?? REGISTRY_FETCH_TIMEOUT_MS,
    )
    if (!response.ok) {
      done()
      throw new RegistryError(`Failed to fetch package manifest: HTTP ${response.status}`)
    }
    const data = await parseJsonCapped(response, MAX_PACKAGE_MANIFEST_PREVIEW_BYTES, done)
    if (!isPlainObject(data) || !Array.isArray(data.tools)) {
      throw new RegistryError('The package manifest lists no tools')
    }
    const tools = (data.tools as unknown[])
      .filter(isPlainObject)
      .map(tool => ({
        name: typeof tool.name === 'string' ? tool.name : '',
        description: typeof tool.description === 'string' ? tool.description : '',
      }))
      .filter(tool => tool.name.length > 0)
    return { tools }
  }
  const result = await fetchWithMirrorFallback(url, load, { preference: options?.preference })
  return result.value
}

/** Drop cached manifests (the management page's "refresh" button). */
export function invalidateRegistryCache(registry?: PackageRegistry): void {
  if (registry) manifestCache.delete(registry.manifestUrl)
  else manifestCache.clear()
}
