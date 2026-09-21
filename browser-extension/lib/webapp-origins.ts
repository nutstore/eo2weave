// Browser-extension-side shim around the shared webapp origins.
//
// The pure-data origin constants (CW_WEBAPP_ORIGIN_*) and `isCwWebappOrigin`
// live in `@creatorweave/shared` so the web app and the extension consume
// from the same source. This file adds the one extension-specific piece —
// `getCwWebappBaseUrl()`, which uses Vite-injected `import.meta.env.MODE`
// to choose between the local dev origin and the production origin.
//
// Re-exports are kept so existing extension callers
// (`import { ... } from './webapp-origins'`) keep working without churn.

import {
  CW_WEBAPP_APP_PATH,
  CW_WEBAPP_ORIGIN_CN,
  CW_WEBAPP_ORIGIN_COM,
  CW_WEBAPP_ORIGIN_LEGACY,
  CW_WEBAPP_ORIGIN_DEV,
  CW_WEBAPP_ORIGINS,
  isCwWebappOrigin,
} from '@creatorweave/shared'

export {
  CW_WEBAPP_APP_PATH,
  CW_WEBAPP_ORIGIN_CN,
  CW_WEBAPP_ORIGIN_COM,
  CW_WEBAPP_ORIGIN_LEGACY,
  CW_WEBAPP_ORIGIN_DEV,
  CW_WEBAPP_ORIGINS,
  isCwWebappOrigin,
}

/**
 * Base URL the extension uses to OPEN the web app (side panel / new tab).
 *
 * Runtime site selection by browser UI language: a Chinese-primary browser
 * gets the domestic .cn site, everything else gets the international .com
 * site. We look at the MOST preferred language only (navigator.language,
 * equivalent to navigator.languages[0]) — the full list may contain e.g.
 * ['en-US', 'zh-CN'] for an English-primary user who also reads Chinese,
 * and routing should follow their primary preference.
 * Dev builds always target the local Vite server regardless of language.
 *
 * Vite-flavored: `import.meta.env.MODE` is provided by the extension's
 * WXT/Vite build and is NOT available in the web app's Next.js bundle.
 * Keep this function out of any cross-workspace import.
 */
export function getCwWebappBaseUrl(): string {
  if (import.meta.env.MODE === 'development') return CW_WEBAPP_ORIGIN_DEV
  const nav: { language?: string; languages?: readonly string[] } =
    typeof navigator === 'undefined' ? {} : navigator
  const primary = nav.language || nav.languages?.[0] || ''
  return /^zh/i.test(primary) ? CW_WEBAPP_ORIGIN_CN : CW_WEBAPP_ORIGIN_COM
}
