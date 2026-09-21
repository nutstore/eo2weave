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
