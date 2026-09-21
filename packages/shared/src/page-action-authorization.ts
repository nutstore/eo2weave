// Cross-process message authorization primitives shared by the web app and
// the browser extension.
//
// "Page actions" are a Chrome extension concept: the web app postMessages
// into the extension asking it to interact with a tab (click, type, screenshot).
// Both sides need to know the same allowlist of trusted origins, and both
// need the same UUID-v4 binding-id validator. Living in shared keeps them
// in lockstep — drift here would let either side trust the wrong origin.
//
// SECURITY: keep this allowlist intentionally exact. Production is dual-site
// (.cn / .com); legacy creatorweave.eo2suite.cn stays trusted during the
// migration window; any loopback dev origin (localhost/127.0.0.1/[::1] on
// any port) is trusted for local development.

import { CW_WEBAPP_ORIGINS, isLocalDevOrigin } from './webapp-origins'

const TRUSTED_CREATORWEAVE_ORIGINS = new Set(CW_WEBAPP_ORIGINS)

/**
 * True only when the message originated from an approved CreatorWeave origin
 * (production + legacy sites) or from any local dev server (loopback on any
 * port — see isLocalDevOrigin).
 */
export function isTrustedCreatorWeaveSenderUrl(senderUrl: string | undefined): boolean {
  if (!senderUrl) return false

  try {
    const url = new URL(senderUrl)
    return TRUSTED_CREATORWEAVE_ORIGINS.has(url.origin) || isLocalDevOrigin(url.origin)
  } catch {
    return false
  }
}

/** Opaque, extension-generated key which maps a side panel to one tab. */
export function isSidePanelBindingId(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
}
