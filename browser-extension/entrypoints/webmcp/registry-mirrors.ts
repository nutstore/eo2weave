/**
 * Mirror candidates for GitHub raw file downloads (issue #143).
 *
 * A registry manifest and every package file live in a GitHub repo, and the
 * canonical way to read them is `raw.githubusercontent.com`. That host is
 * unreachable (or heavily throttled) from mainland-China networks, which is
 * where a large part of the user base sits — the registry the user just
 * added would simply fail to load.
 *
 * jsDelivr serves the SAME GitHub content from a CDN edge that is reachable
 * from CN:
 *
 *   https://cdn.jsdelivr.net/gh/<owner>/<repo>@<ref>/<path>
 *
 * This module derives the mirror candidate list from a raw URL's SHAPE
 * (owner / repo / ref / path) so both the registry client and the plugin
 * download transfer can fall back without duplicating URL parsing.
 *
 * Ordering policy (owner instruction, 2026-11-02):
 *   - the CN build PREFERS the mirror (jsDelivr first, direct raw last),
 *   - the global build PREFERS the direct raw host,
 * and in both cases the direct raw URL stays the CANONICAL url that is
 * displayed to the user and stored in the registry entry — the mirror is a
 * transport detail, never the identity of the resource.
 */

/** The canonical host for GitHub raw content. */
export const RAW_GITHUB_HOST = 'raw.githubusercontent.com'
/** The jsDelivr GitHub CDN host. */
export const JSDELIVR_HOST = 'cdn.jsdelivr.net'

/**
 * Which transport is tried FIRST.
 *
 * `cn` prefers the mirror (jsDelivr) because `raw.githubusercontent.com` is
 * effectively unusable from mainland-China networks; `global` prefers the
 * direct raw host because it is the canonical origin and the fastest path
 * for the rest of the world.
 *
 * The default is `global` — the extension build is not region-specific
 * unless the build opts in (see `resolveMirrorOrder`).
 */
export type MirrorPreference = 'cn' | 'global'

export interface RawResource {
  /** GitHub owner (user or organisation). */
  owner: string
  /** GitHub repository name. */
  repo: string
  /** Branch, tag or commit the resource is pinned to. */
  ref: string
  /** Repo-relative path of the resource (no leading slash). */
  path: string
}

/**
 * Parse a `raw.githubusercontent.com` URL into its parts.
 *
 * Returns null for any URL that is not a GitHub raw URL — the caller then
 * keeps the original URL untouched (no mirror candidate is fabricated for
 * a host we do not understand).
 *
 * The ref may contain slashes (`feature/registry`): raw.githubusercontent
 * resolves refs greedily against the repo's existing refs, so the FIRST
 * segment boundary is ambiguous from the URL alone. We keep the whole tail
 * as the ref and derive the mirror from it verbatim — jsDelivr addresses
 * the same ambiguity with the same `@<ref>` form, so both URLs stay
 * consistent with each other.
 */
export function parseRawGithubUrl(url: string): RawResource | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  if (parsed.hostname !== RAW_GITHUB_HOST) return null
  const parts = parsed.pathname.split('/').filter(Boolean)
  // <owner>/<repo>/<ref...>/<path...>
  if (parts.length < 4) return null
  const [owner, repo, ...rest] = parts
  if (!owner || !repo || !rest.length) return null
  // The LAST segment is the file name; everything between is the ref path
  // plus the file's directory. Without a ref-path marker we cannot tell a
  // slashed ref from a directory, so we treat the first segment as the ref
  // and the remainder as the path — the same split the registry client
  // uses for `rawBase` (documented slash-in-branch caveat).
  const [ref, ...pathParts] = rest
  if (!ref || !pathParts.length) return null
  return { owner, repo, ref, path: pathParts.join('/') }
}

/** The canonical direct raw URL for a parsed resource. */
export function rawGithubUrl(resource: RawResource): string {
  return `https://${RAW_GITHUB_HOST}/${resource.owner}/${resource.repo}/${resource.ref}/${resource.path}`
}

/** The jsDelivr mirror URL for a parsed resource. */
export function jsdelivrUrl(resource: RawResource): string {
  return `https://${JSDELIVR_HOST}/gh/${resource.owner}/${resource.repo}@${resource.ref}/${resource.path}`
}

/**
 * The candidate URLs for a raw GitHub URL, in TRY order.
 *
 * The first entry is always the URL itself, so a caller can simply iterate
 * the list and use the first one that responds. The direct raw host is
 * always included — a mirror outage must never make a resource unreachable.
 */
export function mirrorCandidates(url: string, preference: MirrorPreference = 'global'): string[] {
  const resource = parseRawGithubUrl(url)
  if (!resource) return [url]
  const direct = rawGithubUrl(resource)
  const mirror = jsdelivrUrl(resource)
  // A URL that is already the canonical raw form is returned unchanged, so
  // the candidate list never contains the same URL twice.
  if (direct === url) {
    return preference === 'cn' ? [mirror, direct] : [direct, mirror]
  }
  return preference === 'cn' ? [mirror, direct, url] : [url, direct, mirror]
}

/**
 * The mirror-preference for the current build.
 *
 * A BUILD may pin the region explicitly (`CW_DEPLOY_REGION=cn` /
 * `=global`) — the extension then always prefers that region's transport.
 * Without the pin the preference follows the BROWSER's UI language (the
 * same signal the web app uses to pick the CN or the global site): a
 * Chinese-primary browser prefers the mirror, any other browser prefers
 * the direct host. That keeps a single build usable in both regions
 * instead of requiring a separate CN artifact.
 */
export function resolveMirrorPreference(): MirrorPreference {
  const pinned = pinnedRegion()
  if (pinned) return pinned
  if (typeof navigator === 'undefined') return 'global'
  const nav: { language?: string; languages?: readonly string[] } = navigator
  const primary = nav.language || nav.languages?.[0] || ''
  return /^zh/i.test(primary) ? 'cn' : 'global'
}

/**
 * The build-time region pin, if any.
 *
 * `__CW_DEPLOY_REGION__` is injected by the wxt `define` (the define MUST
 * live inside the vite hook — a top-level `define` is silently ignored).
 * An empty/unknown value means "no pin".
 *
 * The identifier is read BARE on purpose: esbuild's `define` replaces the
 * identifier itself, so `globalThis.__CW_DEPLOY_REGION__` would NOT be
 * substituted. `typeof` on an undefined identifier is safe in JavaScript
 * (no ReferenceError), so the module stays importable from plain Node
 * (tests, tooling) where the define is absent.
 */
declare const __CW_DEPLOY_REGION__: string

function pinnedRegion(): MirrorPreference | null {
  try {
    const region = typeof __CW_DEPLOY_REGION__ === 'string' ? __CW_DEPLOY_REGION__.toLowerCase() : ''
    if (region === 'cn') return 'cn'
    if (region === 'global') return 'global'
  } catch {
    // The define is absent (tests, tooling) — fall through to the runtime.
  }
  return null
}
