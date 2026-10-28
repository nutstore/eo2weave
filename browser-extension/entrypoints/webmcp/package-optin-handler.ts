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
 * The enable path re-derives the candidate from the LIVE tab URL and
 * re-checks the catalog, so a stale panel cannot arm an unrelated package.
 */

import { findPackageOptInCandidate, type PackageOptInCandidate } from './package-optin'
import { readWebMCPCatalog } from './package-repository'
import { setBuiltinConfig } from './builtin-storage'

export interface PackageOptInStatus {
  ok: boolean
  /** A builtin package hosts this tab (enabled or not). */
  applicable: boolean
  /** The package matching the bound tab. */
  package?: PackageOptInCandidate
  /** The package is already enabled extension-side. */
  enabled?: boolean
  errorCode?: string
  error?: string
}

export interface PackageOptInDependencies {
  /** Resolve the bound tab id for this request (null when unauthorized). */
  resolveBoundTab: () => Promise<number | null>
}

export function createPackageOptInHandler(deps: PackageOptInDependencies) {
  const candidateFor = async (tabId: number): Promise<PackageOptInCandidate | null> => {
    const tab = await chrome.tabs.get(tabId)
    const url = tab.url || ''
    if (!url) return null
    const entries = await readWebMCPCatalog()
    return findPackageOptInCandidate(entries, url)
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
        const candidate = await candidateFor(tabId)
        if (!candidate) {
          sendResponse({ ok: true, applicable: false })
          return false
        }
        sendResponse({
          ok: true,
          applicable: true,
          package: candidate,
          enabled: candidate.activation === 'enabled',
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
      if (!packageId) {
        sendResponse({ ok: false, errorCode: 'INVALID_REQUEST', error: 'packageId is required' })
        return false
      }
      try {
        // Re-derive the candidate from the LIVE tab URL — never trust the
        // web-app-supplied id alone. This proves the package matches what
        // the bound tab actually hosts before flipping the config.
        const candidate = await candidateFor(tabId)
        if (!candidate || candidate.id !== packageId) {
          sendResponse({
            ok: false,
            errorCode: 'PACKAGE_MISMATCH',
            error: 'Package does not match the bound tab location.',
          })
          return false
        }
        await setBuiltinConfig(candidate.directory, { activation: 'enabled' })
        // The reload guarantees the tools register in this tab: adapter
        // proxies are injected by a static content script, so a config change
        // alone cannot reach a page loaded before the extension update.
        await chrome.tabs.reload(tabId)
        sendResponse({ ok: true, packageId, hostname: candidate.hostname, reloaded: true })
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
