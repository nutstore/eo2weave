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
 */

export type GuideMethod = 'store' | 'zip'

/** Chrome Web Store listing for EO2Weave. */
export const CHROME_WEB_STORE_URL =
  'https://chromewebstore.google.com/detail/eo2weave/canpcddlognjbengiodekfbbfnjafeml'
