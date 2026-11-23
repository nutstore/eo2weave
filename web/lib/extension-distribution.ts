/**
 * Extension install-channel constants.
 *
 * The extension can be installed two ways, and the install guide ALWAYS
 * offers both — the user picks whichever works for their network:
 *
 *   - store → one-click install from the Chrome Web Store (auto-updates).
 *     Unreachable from some mainland-China networks, but reachable for
 *     users with a VPN, so it must never be hidden by a build flag.
 *   - zip   → download the package hosted alongside the web app and load
 *     it unpacked (developer mode). Works on any network; manual updates.
 *
 * There is deliberately NO build-time branching here: both options ship in
 * every build. The guide marks the store option as "Recommended".
 *
 * Consumers of CHROME_WEB_STORE_URL:
 *   - ExtensionInstallGuide (store flow, step 2)
 *   - SettingsDialog extension panel (always-visible store install button,
 *     paired with the zip download button so both channels stay reachable
 *     from the settings page)
 */

export type GuideMethod = 'store' | 'zip'

/**
 * True on mobile devices (phones/tablets), where Chrome/Edge extensions
 * cannot be installed at all. User-agent based on purpose: a narrow
 * desktop window is still a desktop and CAN install the extension, so a
 * viewport check (useMobile) would be wrong here. SSR-safe (returns false).
 *
 * iPadOS 13+ is the one case a UA string alone cannot answer: Safari and
 * Chrome on iPad report a desktop "Macintosh" UA, so the iPad token below only
 * catches older devices. Touch points distinguish that UA from a real Mac.
 */
export function isMobileDeviceForExtension(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) return true
  return /Macintosh/i.test(ua) && (navigator.maxTouchPoints ?? 0) > 1
}

/** Chrome Web Store listing for EO2Weave. */
export const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/eo2weave/canpcddlognjbengiodekfbbfnjafeml'

/** Microsoft Edge Add-ons listing for EO2Weave. */
export const EDGE_ADDONS_URL =
  'https://microsoftedge.microsoft.com/addons/detail/eo2weave/hnndljbngdmcldojkaedhpehlghkljdm'

/**
 * True when the current browser is Microsoft Edge (UA contains the "Edg/"
 * token — the shortened form Edge ships on all platforms to avoid UA-sniffing
 * collisions with the legacy "Edge" token). SSR-safe (returns false).
 */
export function isEdgeBrowser(): boolean {
  if (typeof navigator === 'undefined') return false
  return navigator.userAgent.includes('Edg/')
}

/**
 * The store listing that best matches the current browser:
 * Edge users get the Edge Add-ons listing (native store, auto-updates,
 * reachable from mainland-China networks), everyone else gets the Chrome
 * Web Store. The zip download remains available as a universal fallback —
 * callers should keep offering it alongside this URL.
 */
export function getPreferredStoreUrl(): string {
  return isEdgeBrowser() ? EDGE_ADDONS_URL : CHROME_WEB_STORE_URL
}
