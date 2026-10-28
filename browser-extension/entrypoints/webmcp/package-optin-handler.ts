/**
 * Side-panel package opt-in — extension side (issue #100).
 *
 * The side panel asks two questions:
 *   1. `webmcp_package_optin_status` — does the BOUND upstream tab host a
 *      builtin package that is still disabled? (metadata only)
 *   2. `webmcp_package_optin_enable`  — enable that package and reload the
 *      bound tab so its tools register.
 *
 * SECURITY: same boundary as the other bound-tab handlers — the sender must
 * be a trusted CreatorWeave origin AND the binding must resolve to a real
 * tab. Only package metadata (id / description / tool names) crosses the
 * bridge; tool schemas and page content never do.
 *
 * The enable path PREFERRED a CONSENT TOKEN that the background itself
 * issued in the status response: a short-lived, single-use, tab-bound random
 * id. A page script cannot flip the config by calling the enable method alone —
 * it needs a token that only exists while the status probe reports a
 * disabled package, and each token enables exactly one package on exactly
 * one tab. The 600ms minimum token age makes an instant scripted
 * status→enable chain fail while a human reading the modal and clicking
 * Confirm passes easily. (A malicious script running inside the trusted
 * side-panel document can still pace the chain — but such a script already
 * holds the full agent bridge, so this is defence in depth, not a sandbox.)
 *
 * GRACE-PERIOD COMPATIBILITY (`CONSENT_TOKEN_ENFORCEMENT`, default 'grace'):
 * we cannot control when users' extensions update, so the web app may talk
 * to an extension build that predates consent tokens. Requests WITHOUT a
 * token are therefore ACCEPTED during the grace period (legacy path, the
 * pre-token behaviour), each one logged via console.warn (ua + timestamp)
 * so the extension-update rollout can be measured. Requests WITH a token
 * are always validated strictly — a present-but-wrong token signals
 * tampering, not an old extension, and is rejected. There is deliberately
 * NO version probing / capability negotiation: the page (untrusted side)
 * supplies the fields, so a forged "I'm legacy" version string would be
 * indistinguishable from a real one — token presence is the only honest
 * discriminator.
 *
 * THREAT MODEL of the grace period: while 'grace' is active, a malicious
 * page could call the enable method without a token — but that is exactly
 * the behaviour shipped before this PR, so the grace period is NOT a new
 * exposure surface; it merely keeps the old water level until every
 * extension has updated. Flipping the switch to 'strict' (TODO: after the
 * extension auto-update rollout has reached the fleet) closes the legacy
 * path for good.
 *
 * The enable path also re-derives the candidate from the LIVE tab URL and
 * re-checks it immediately before writing the config, so a navigation that
 * happens while the catalog is being read cannot arm a package for a site
 * the user never saw.
 */

import { findPackageOptInCandidate, type PackageOptInCandidate } from './package-optin'
import { readBuiltinWebMCPCatalog } from './package-repository'
import { readBuiltinConfig, setBuiltinConfig } from './builtin-storage'

export interface PackageOptInStatus {
  ok: boolean
  /** A builtin package hosts this tab (enabled or not). */
  applicable: boolean
  /** The package matching the bound tab. */
  package?: PackageOptInCandidate
  /** The package is already enabled extension-side. */
  enabled?: boolean
  /**
   * One-time proof of user consent, issued only when the package is still
   * disabled. The enable handler consumes it.
   */
  consentToken?: string
  errorCode?: string
  error?: string
}

export interface PackageOptInDependencies {
  /** Resolve the bound tab id for this request (null when unauthorized). */
  resolveBoundTab: () => Promise<number | null>
}

/**
 * Consent tokens live for the status→modal→confirm window only. The service
 * worker may be killed between status and enable — an expired/unknown token
 * then yields CONSENT_REQUIRED and the side panel re-probes, which is the
 * correct (fail-closed) behaviour for a caller that HAS a token.
 */
export const CONSENT_TOKEN_TTL_MS = 10 * 60 * 1000
/** A human needs a moment to read the modal; a scripted chain does not. */
export const CONSENT_TOKEN_MIN_AGE_MS = 600

/**
 * Consent-token enforcement mode. Flip this to 'strict' (TODO: once the
 * extension auto-update rollout has reached the fleet — check the
 * `[PackageOptIn] legacy enable (no consent token)` warn volume first) to
 * reject tokenless enable requests and close the legacy path for good.
 * See the module docblock for the full threat-model trade-off.
 */
export const CONSENT_TOKEN_ENFORCEMENT: 'grace' | 'strict' = 'grace'

/**
 * Test-only seam: `CONSENT_TOKEN_ENFORCEMENT` is a compile-time const, so
 * tests flip 'strict' through this override instead (null = use the const).
 */
let enforcementOverride: 'grace' | 'strict' | null = null
export function setConsentTokenEnforcementForTests(mode: 'grace' | 'strict' | null): void {
  enforcementOverride = mode
}
function activeEnforcement(): 'grace' | 'strict' {
  return enforcementOverride ?? CONSENT_TOKEN_ENFORCEMENT
}

interface ConsentTokenRecord {
  tabId: number
  issuedAt: number
}

const consentTokens = new Map<string, ConsentTokenRecord>()

function pruneConsentTokens(now: number): void {
  for (const [token, record] of consentTokens) {
    if (now - record.issuedAt > CONSENT_TOKEN_TTL_MS) consentTokens.delete(token)
  }
}

function issueConsentToken(tabId: number): string {
  const now = Date.now()
  pruneConsentTokens(now)
  const token =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `ct_${now}_${Math.random().toString(36).slice(2)}`
  consentTokens.set(token, { tabId, issuedAt: now })
  return token
}

/** One-time consume: the token must exist, be fresh, and belong to this tab. */
function consumeConsentToken(token: string, tabId: number): boolean {
  const record = consentTokens.get(token)
  if (!record) return false
  consentTokens.delete(token)
  const now = Date.now()
  return (
    record.tabId === tabId &&
    now - record.issuedAt <= CONSENT_TOKEN_TTL_MS &&
    now - record.issuedAt >= CONSENT_TOKEN_MIN_AGE_MS
  )
}

export function createPackageOptInHandler(deps: PackageOptInDependencies) {
  const candidateFor = async (
    tabId: number,
  ): Promise<{
    candidate: PackageOptInCandidate | null
    entries: Awaited<ReturnType<typeof readBuiltinWebMCPCatalog>>
  }> => {
    const tab = await chrome.tabs.get(tabId)
    const url = tab.url || ''
    if (!url) return { candidate: null, entries: [] }
    // Builtin-only read (finding: "Builtin prompt depends on user storage"):
    // a failing user-mounted OPFS provider must not break the opt-in probe.
    const entries = await readBuiltinWebMCPCatalog()
    return { candidate: findPackageOptInCandidate(entries, url), entries }
  }

  /**
   * Total tool count of the package, across ALL origins — not just the ones
   * matching the current tab URL. The enable flips the whole package on, so
   * the consent payload must disclose everything that will be activated.
   */
  const totalToolCount = (candidate: PackageOptInCandidate, entries: Awaited<ReturnType<typeof readBuiltinWebMCPCatalog>>): number => {
    const entry = entries.find(e => e.directory === candidate.directory)
    return entry?.package?.manifest?.tools.length ?? candidate.tools.length
  }

  return async (
    message: Record<string, unknown>,
    sendResponse: (response: unknown) => void,
  ): Promise<boolean> => {
    const tabId = await deps.resolveBoundTab()
    if (tabId === null) {
      sendResponse({
        ok: false,
        applicable: false,
        errorCode: 'UNAUTHORIZED_TARGET',
        error: 'Missing or invalid side-panel binding.',
      })
      return false
    }

    if (message.type === 'webmcp_package_optin_status') {
      try {
        const { candidate, entries } = await candidateFor(tabId)
        if (!candidate) {
          sendResponse({ ok: true, applicable: false })
          return false
        }
        // A token is only minted while the package is still disabled — this
        // is the proof the enable handler demands. totalTools discloses the
        // package-wide tool count (finding: "Consent omits package-wide
        // tools"): enabling activates tools for other origins too, and the
        // consent must cover them.
        const consentToken =
          candidate.activation === 'disabled' ? issueConsentToken(tabId) : undefined
        sendResponse({
          ok: true,
          applicable: true,
          package: candidate,
          enabled: candidate.activation === 'enabled',
          consentToken,
          totalTools: totalToolCount(candidate, entries),
        })
      } catch (err: unknown) {
        sendResponse({
          ok: false,
          applicable: false,
          errorCode: 'STATUS_FAILED',
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return false
    }

    if (message.type === 'webmcp_package_optin_enable') {
      const packageId = typeof message.packageId === 'string' ? message.packageId : ''
      const hasConsentToken = typeof message.consentToken === 'string' && message.consentToken !== ''
      const consentToken = hasConsentToken ? (message.consentToken as string) : ''
      // Token-less requests come from extension builds that predate consent
      // tokens (the legacy path). 'strict' rejects them once the fleet has
      // updated; 'grace' accepts them exactly as the pre-token build did,
      // with a warn log so the migration can be measured. A PRESENT but
      // wrong token is never downgraded to legacy — a supplied token means
      // the caller claims the token protocol, so a bad one is tampering.
      if (!packageId || (!hasConsentToken && activeEnforcement() === 'strict')) {
        sendResponse({
          ok: false,
          errorCode: 'CONSENT_REQUIRED',
          error: hasConsentToken
            ? 'packageId is required.'
            : 'packageId and a consent token from webmcp_package_optin_status are required.',
        })
        return false
      }
      if (!hasConsentToken) {
        // eslint-disable-next-line no-console
        console.warn(
          '[PackageOptIn] legacy enable (no consent token) — old extension pre-consent build',
          {
            packageId,
            timestamp: new Date().toISOString(),
            userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
          },
        )
      }
      try {
        // Consume first (fail-closed): an invalid/expired/replayed token must
        // never reach the config write. Only reached with a token present.
        if (hasConsentToken && !consumeConsentToken(consentToken, tabId)) {
          sendResponse({
            ok: false,
            errorCode: 'CONSENT_REQUIRED',
            error: 'Consent token missing, expired, already used, or bound to another tab.',
          })
          return false
        }
        // Re-derive the candidate from the LIVE tab URL — never trust the
        // web-app-supplied id alone. This proves the package matches what
        // the bound tab actually hosts before flipping the config.
        const { candidate, entries } = await candidateFor(tabId)
        if (!candidate || candidate.id !== packageId) {
          sendResponse({
            ok: false,
            errorCode: 'PACKAGE_MISMATCH',
            error: 'Package does not match the bound tab location.',
          })
          return false
        }
        // Revalidate one last time AFTER all awaits above: if the tab
        // navigated while the catalog was read, the freshly read URL no
        // longer matches the candidate and the write must not happen.
        const freshTab = await chrome.tabs.get(tabId)
        const freshUrl = freshTab.url || ''
        const freshCandidate = freshUrl
          ? findPackageOptInCandidate(entries, freshUrl)
          : null
        if (!freshCandidate || freshCandidate.id !== candidate.id) {
          sendResponse({
            ok: false,
            errorCode: 'PACKAGE_MISMATCH',
            error: 'The bound tab navigated away from the package site; enable cancelled.',
          })
          return false
        }
        await setBuiltinConfig(candidate.directory, { activation: 'enabled' })
        // Verify the write actually stuck (finding: "Concurrent disable is
        // overwritten"): if the user disabled the package through package
        // management between our write and now, the disable must win — we
        // report failure instead of claiming a success that was reverted.
        const stored = await readBuiltinConfig(candidate.directory)
        if (stored?.activation !== 'enabled') {
          sendResponse({
            ok: false,
            errorCode: 'ENABLE_REVERTED',
            error: 'The package was disabled again while enabling; nothing was enabled.',
          })
          return false
        }
        // The reload guarantees the tools register in this tab: adapter
        // proxies are injected by a static content script, so a config change
        // alone cannot reach a page loaded before the extension update. A
        // failed reload must NOT fail the whole operation — the package is
        // enabled and persisted; only this page load misses the tools.
        let reloaded = true
        try {
          await chrome.tabs.reload(tabId)
        } catch (reloadErr: unknown) {
          reloaded = false
          // eslint-disable-next-line no-console
          console.warn(
            '[PackageOptIn] enable succeeded but reloading the bound tab failed —',
            'the page keeps running without the package tools until reloaded:',
            reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
          )
        }
        sendResponse({ ok: true, packageId, hostname: candidate.hostname, reloaded })
      } catch (err: unknown) {
        sendResponse({
          ok: false,
          errorCode: 'ENABLE_FAILED',
          error: err instanceof Error ? err.message : String(err),
        })
      }
      return false
    }

    return false
  }
}
