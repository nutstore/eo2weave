/**
 * Site footer compliance config — build-time inlined.
 *
 * The domestic (weave.eo2suite.cn) and international (weave.eo2suite.com)
 * sites are BUILT separately (NEXT_PUBLIC_DEPLOY_REGION, see next.config.mjs).
 * Each deployment names its own operating entity in the footer:
 *   - cn     → 上海奕惟网络科技有限公司 (domestic operator)
 *   - global → Astronet Technology PTE LTD (overseas operator)
 *
 * ICP filing number: CN regulations require the filing number to be shown
 * (linked to beian.miit.gov.cn) on domestic sites. It is injected via
 * NEXT_PUBLIC_ICP_NUMBER at build time — unset hides the entry entirely, so
 * the site can ship before the filing is granted and light up later with an
 * env change only (no code change).
 *
 * Everything is derived from two pure helpers so tests can cover both
 * regions without re-importing the module under different envs.
 */

/** True when the ICP env var holds a plausible filing number (non-empty, no angle brackets). */
export function resolveIcpNumber(raw: string | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed || /[<>]/.test(trimmed)) return null
  return trimmed
}

export type SiteFooterConfig = {
  /** Operator shown in the copyright line, already localized. */
  operator: string
  /** "All rights reserved" (localized per deploy region) */
  rights: string
  /** ICP filing number to display, or null when unset (entry hidden). */
  icpNumber: string | null
  /** Privacy policy route (trailing slash matches alternates.canonical). */
  privacyHref: string
}

export function resolveSiteFooterConfig(isCnBuild: boolean, icpRaw: string | undefined): SiteFooterConfig {
  return {
    operator: isCnBuild ? '上海奕惟网络科技有限公司' : 'Astronet Technology PTE LTD',
    rights: isCnBuild ? '保留所有权利' : 'All rights reserved.',
    icpNumber: isCnBuild ? resolveIcpNumber(icpRaw) : null,
    privacyHref: '/help/privacy/',
  }
}

/** Build-time constants (mirrors lib/currency.ts). */
export const IS_CN_BUILD = process.env.NEXT_PUBLIC_DEPLOY_REGION === 'cn'

export const SITE_FOOTER_CONFIG = resolveSiteFooterConfig(IS_CN_BUILD, process.env.NEXT_PUBLIC_ICP_NUMBER)
