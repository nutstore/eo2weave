// Canonical eo2weave web-app origins — single source of truth shared by the
// web app and the browser extension.
//
// Production is dual-site:
//   - weave.eo2suite.cn  — domestic (国内) deployment
//   - weave.eo2suite.com — international deployment
// The legacy creatorweave.eo2suite.cn origin stays trusted during the
// migration window so existing bookmarks/installed panels keep working
// until the old domain is decommissioned.
// Plus the local dev origin used during development.
//
// SECURITY: any change here widens (or shrinks) the set of origins trusted
// by both the web app and the browser extension. Never duplicate these
// constants — import them from this module everywhere.

export const CW_WEBAPP_ORIGIN_CN = 'https://weave.eo2suite.cn'
export const CW_WEBAPP_ORIGIN_COM = 'https://weave.eo2suite.com'
export const CW_WEBAPP_ORIGIN_LEGACY = 'https://creatorweave.eo2suite.cn'
export const CW_WEBAPP_ORIGIN_DEV = 'http://localhost:5173'

/** Every origin the web app is (or was, during migration) served from. */
export const CW_WEBAPP_ORIGINS: readonly string[] = [
  CW_WEBAPP_ORIGIN_CN,
  CW_WEBAPP_ORIGIN_COM,
  CW_WEBAPP_ORIGIN_LEGACY,
  CW_WEBAPP_ORIGIN_DEV,
]

/**
 * In-app path the extension should open (side panel / popup fallback).
 * The marketing landing page now owns `/`; the workspace lives under
 * `/projects`. Kept here so the extension and web app share one constant.
 */
export const CW_WEBAPP_APP_PATH = '/projects'

/** True when `origin` is one of the web app's own origins. */
export function isCwWebappOrigin(origin: string): boolean {
  return CW_WEBAPP_ORIGINS.includes(origin)
}

/**
 * True when `origin` is a local dev origin (localhost / 127.0.0.1 / [::1])
 * on ANY port. Dev servers don't always run on 5173 (port taken → Vite
 * auto-increments, custom --port, etc.), so trust the loopback family
 * rather than one hardcoded port.
 *
 * SECURITY: loopback origins are still cross-origin to each other — a
 * malicious local dev server on port 3000 could call the extension bridge
 * exactly like the real app. That is acceptable: anyone able to run code
 * on the user's machine already out-ranks anything the extension protects
 * (native host scopes, browser storage). Keep this check loopback-ONLY:
 * never widen to 0.0.0.0, LAN IPs, or *.local hostnames.
 */
export function isLocalDevOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
    const host = url.hostname
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' // URL keeps IPv6 brackets in hostname, e.g. '[::1]'
    )
  } catch {
    return false
  }
}
