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

import {
  findPackageOptInCandidate,
  findPackageOptInCandidates,
  type PackageOptInCandidate,
} from './package-optin'
import type { WebMCPPackageEntry } from '@creatorweave/shared/webmcp-package-catalog'
import { readWebMCPCatalog, readWebMCPCatalogDetailed } from './package-repository'
import { readBuiltinConfig, setBuiltinConfig } from './builtin-storage'
import { serializeWebMCPConfig, parseWebMCPConfig } from '@creatorweave/shared/webmcp-config'
import { getAdapterStorage } from './provider-storage'
import { withPackageLock } from './package-lock'

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
 * Read the activation config of a package on EITHER mount. Builtin overrides
 * live in chrome.storage.local (`setBuiltinConfig`); user-mount packages
 * (registry installs, issue #117) carry their config.json inside the package
 * directory itself — the same file the extension's package-management page
 * writes. The consent-token protocol is identical for both.
 */
async function readPackageActivation(
  mount: string,
  directory: string,
): Promise<{ activation?: string } | null> {
  if (mount === 'builtin-webmcp') return readBuiltinConfig(directory)
  const provider = await getAdapterStorage()
  try {
    const bytes = await provider.readFile(`${directory}/config.json`)
    return parseWebMCPConfig(JSON.parse(new TextDecoder().decode(bytes)))
  } catch (error) {
    // The File System Access provider reports absence as a DOMException
    // (NotFoundError) — normalize it like `providerMount` does. A package
    // without config.json is simply at its disabled default.
    const name = (error as { name?: string }).name
    if ((error as { code?: string }).code === 'ENOENT' || name === 'NotFoundError') return null
    throw error
  }
}

/**
 * Sentinel key prefix used to announce a USER-mount package activation
 * change. The user mount's config.json lives in the extension's OPFS, which
 * has no storage.onChanged hook, so the write is announced through
 * chrome.storage.local. The adapter background listens for this prefix and
 * refreshes the catalog, so the newly enabled tools register immediately
 * (and an uninstalled package's routes are withdrawn).
 */
export const USER_PACKAGE_CONFIG_SENTINEL_PREFIX = 'webmcp_user_package_config_'

/** Enable a package on EITHER mount (see `readPackageActivation` for the split). */
async function writePackageActivation(mount: string, directory: string, signal?: AbortSignal): Promise<void> {
  if (mount === 'builtin-webmcp') {
    // The builtin override write touches chrome.storage.local, whose
    // onChanged listener in the adapter background triggers a catalog
    // refresh — routes update without extra work here.
    await setBuiltinConfig(directory, { activation: 'enabled' })
    return
  }
  const provider = await getAdapterStorage()
  // A lease lost while the provider bridge was being resolved must stop the
  // transaction BEFORE any mutation (finding: "Lost lease does not stop
  // mutations") — the caller fences its own steps, this is the backstop
  // inside the write itself.
  if (signal?.aborted) throw Object.assign(new Error('Package lease lost during enable'), { code: 'LOCK_LOST' })
  // Race guard (finding: "Uninstall leaves a phantom package"): between the
  // caller's presence check and the write below an uninstall can remove the
  // package directory — and the provider CREATES missing parent directories
  // for config.json, which would leave a directory holding ONLY activation
  // state (a "phantom package" the catalog then reports as installed). Stat
  // the manifest immediately before the write and re-stat it after; if the
  // manifest is gone post-write, remove the orphaned config.json (ENOENT-
  // tolerant) so the race degrades to a clean enable failure instead of a
  // resurrected directory.
  try {
    await provider.stat(`${directory}/manifest.json`)
  } catch {
    throw Object.assign(new Error('Package directory vanished before enable'), { code: 'PACKAGE_UNINSTALLED' })
  }
  // Recheck the lease AFTER the presence stat: an abort landing while the
  // stat was pending must stop the transaction here, before the write
  // (finding: "Lost lease does not stop mutations").
  if (signal?.aborted) throw Object.assign(new Error('Package lease lost during enable'), { code: 'LOCK_LOST' })
  const bytes = new TextEncoder().encode(serializeWebMCPConfig({ activation: 'enabled' }))
  // Finding: "Lease-lost writes still execute" — the activation write is the
  // transaction's last mutation; a lease lost while earlier awaits (the
  // presence stat, the catalog re-read) were pending must stop HERE, not
  // commit a config under the new owner's lease. The caller also fences its
  // own steps; this is the commit-point backstop inside the write itself.
  await provider.writeFile(`${directory}/config.json`, bytes)
  // Commit-time fence (finding: "Stale consent enables replacement"): if the
  // lease was lost WHILE the write was pending — the window the pre-write
  // checks cannot close — another operation may have replaced the package in
  // the meantime. Roll our activation write back instead of letting it commit
  // onto a package version the user never consented to.
  if (signal?.aborted) {
    try {
      await provider.remove(`${directory}/config.json`)
    } catch (rollbackError) {
      const e = rollbackError as { code?: string; name?: string }
      if (e.code !== 'ENOENT' && e.name !== 'NotFoundError') throw rollbackError
    }
    throw Object.assign(new Error('Package lease lost while the activation write was in flight; the write was rolled back'), { code: 'LOCK_LOST' })
  }
  try {
    await provider.stat(`${directory}/manifest.json`)
  } catch {
    // The uninstall removed the directory between our two operations (or the
    // write itself recreated a hollow one). Roll the orphaned config.json
    // back — a missing file is fine (the uninstall won), anything else
    // propagates.
    try {
      await provider.remove(`${directory}/config.json`)
    } catch (cleanupError) {
      const e = cleanupError as { code?: string; name?: string }
      if (e.code !== 'ENOENT' && e.name !== 'NotFoundError') throw cleanupError
    }
    throw Object.assign(new Error('Package directory vanished during enable; the orphaned activation file was removed'), { code: 'PACKAGE_UNINSTALLED' })
  }
  // The user-mount write has no storage.onChanged hook (the file lives in
  // OPFS, not chrome.storage). Bounce through chrome.storage.local — the same
  // key the builtin watcher listens on — so the adapter background refreshes
  // the catalog and the newly enabled tools register immediately instead of
  // waiting for an unrelated refresh. Only AFTER the write actually stuck.
  //
  // Finding: "Enable reports failure after committing" — the activation
  // config has COMMITTED by this point, so a failing sentinel must not
  // surface as a failed enable: the caller would report ENABLE_FAILED for a
  // package that is in fact enabled. Retry the bounce a few times (a
  // transient storage error must not leave the tools unregistered), and on
  // persistent failure report a DISTINCT code so the UI can say
  // "enabled, catalog refresh unconfirmed" instead of recording a failure
  // cooldown for a done deal.
  const sentinel = `${USER_PACKAGE_CONFIG_SENTINEL_PREFIX}${directory}`
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await chrome.storage.local.set({ [sentinel]: Date.now() })
      await chrome.storage.local.remove(sentinel)
      return
    } catch (error) {
      lastError = error
      // eslint-disable-next-line no-console
      console.warn('[PackageOptIn] activation sentinel bounce failed (the enable IS committed):', error)
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 250))
    }
  }
  void lastError
  throw Object.assign(
    new Error('The package was enabled, but the catalog refresh notification could not be delivered; the tools may register late.'),
    { code: 'ENABLE_NOTIFY_FAILED' },
  )
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
  /** The package the token was minted for — a token never enables a sibling. */
  packageId: string
  /**
   * Fingerprint of the package the user actually saw in the modal (manifest
   * version + tool names/paths). A package replaced under the same id between
   * the status probe and the confirmation carries a different fingerprint, so
   * the stale confirmation is rejected instead of enabling the replacement's
   * tools (finding: "Stale consent enables replaced tools").
   */
  fingerprint: string
  issuedAt: number
}

/**
 * Fingerprint of a package candidate: SHA-256 over the manifest version plus
 * a JSON record per tool (`name`, `path`, `urlRegex`, the ACTUAL SOURCE
 * bytes of the tool, and the tool DESCRIPTION — finding: "Changed tool
 * descriptions reuse consent": the opt-in modal DISPLAYS the description, so
 * a package that swaps descriptions under stable names/paths/source would
 * otherwise pass old consent while showing the user something it no longer
 * is — plus the package-level description) — finding: "Changed packages
 * reuse old consent" —
 * version, tool names and paths alone do not change when a repackaged
 * module swaps the workflow source under the same names, so the old consent
 * tokens kept working; tool NAMES belong in the fingerprint too — a rename
 * under a stable path changes what the user is consenting to). The digest is
 * cryptographic (round-3 finding: "Stale consent accepts changed code" — a
 * 32-bit FNV-1a truncation collides for crafted source swaps, which would
 * let a replacement pass the old consent) and deterministic across contexts;
 * Web Crypto is available in every extension context. Records are serialized
 * with `JSON.stringify` rather than delimiter joins — an unescaped `:`/`,`
 * join is injective only for delimiter-free fields, so different tool lists
 * could otherwise hash to the same input (round-5 finding: "Old consent
 * enables unseen tools").
 */
async function packageFingerprint(candidate: PackageOptInCandidate, entry?: WebMCPPackageEntry): Promise<string> {
  const manifest = entry?.package?.manifest
  const version = manifest?.version ?? ''
  const sources = entry?.package?.sources
  const sha256Hex = async (text: string): Promise<string> => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text) as BufferSource)
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  }
  // Each tool is serialized as a JSON record instead of being joined with
  // raw `:`/`,` delimiters (finding: "Old consent enables unseen tools"):
  // delimiter joins are ambiguous — a tool field CONTAINING the delimiters
  // can make two different tool lists produce the same hash input, so a
  // consent token minted for one list would validate against another and
  // enable tools the user never saw. JSON encoding is injective for these
  // string-keyed records and byte-deterministic, so the fingerprint stays
  // comparable across contexts.
  const records: Array<Record<string, string>> = manifest?.tools
    ? manifest.tools.map(tool => ({
        name: tool.name,
        path: tool.path,
        urlRegex: tool.urlRegex,
        source: sources?.[tool.path] ?? '',
        description: tool.description ?? '',
      }))
    : candidate.tools.map(tool => tool.name).sort().map(name => ({ name }))
  // Bytewise ordering (NOT localeCompare — that is environment-dependent):
  // the sort only fixes record order so the digest is stable.
  records.sort((a, b) => {
    const left = JSON.stringify(a)
    const right = JSON.stringify(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
  // The PACKAGE description is consent-visible too (finding: "Changed tool
  // descriptions reuse consent" — the modal shows it above the tool list), so
  // it joins the digest as its own record; a description swap under a stable
  // tool list must invalidate stale tokens the same way.
  records.push({ description: manifest?.description ?? '' })
  return `${version}|${await sha256Hex(JSON.stringify(records))}`
}

/**
 * Token store indirection: the MV3 service worker can be suspended between
 * the status probe and the confirm click, and a plain module-level Map would
 * silently drop every token on restart (finding: "Worker restarts invalidate
 * consent tokens"). Production keeps the in-memory Map — a suspended worker
 * loses the panel's modal anyway in the common case, and the web client
 * re-probes for a fresh token (fail-closed) — while tests can inject a
 * storage-backed map to prove the consume path accepts restored tokens.
 */
let consentTokens: Map<string, ConsentTokenRecord> = new Map()
export function setConsentTokenStoreForTests(
  store: Map<string, ConsentTokenRecord> | null,
): void {
  consentTokens = store ?? new Map()
}

function pruneConsentTokens(now: number): void {
  for (const [token, record] of consentTokens) {
    if (now - record.issuedAt > CONSENT_TOKEN_TTL_MS) consentTokens.delete(token)
  }
}

function issueConsentToken(tabId: number, packageId: string, fingerprint: string): string {
  const now = Date.now()
  pruneConsentTokens(now)
  const token =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `ct_${now}_${Math.random().toString(36).slice(2)}`
  consentTokens.set(token, { tabId, packageId, fingerprint, issuedAt: now })
  return token
}

/**
 * One-time consume: the token must exist, be fresh, and belong to this tab
 * AND this package (finding: "Consent transfers across packages" — a tab
 * navigating between two supported sites must not carry consent from one
 * package to another).
 *
 * The token is also bound to the package FINGERPRINT (finding: "Stale
 * consent enables replaced tools"): if the package was replaced under the
 * same id between the probe and the confirmation, the fingerprint differs
 * and the stale confirmation is rejected.
 */
function consumeConsentToken(
  token: string,
  tabId: number,
  packageId: string,
  fingerprint: string,
): boolean {
  const record = consentTokens.get(token)
  if (!record) return false
  consentTokens.delete(token)
  const now = Date.now()
  return (
    record.tabId === tabId &&
    record.packageId === packageId &&
    record.fingerprint === fingerprint &&
    now - record.issuedAt <= CONSENT_TOKEN_TTL_MS &&
    now - record.issuedAt >= CONSENT_TOKEN_MIN_AGE_MS
  )
}

/**
 * Durable recovery for an enabled-but-unreloaded tab (findings: "Recovery
 * reload is lost" / "Enabled state persists without reload"): the immediate
 * reload may fail (transient tab error), be skipped (the tab navigated away
 * between the enable write and the reload), or never run at all (the MV3
 * service worker is suspended between the config write and the reload). A
 * `setTimeout` retry chain lives only in worker memory — suspension drops it
 * and the enabled package stays unloaded while later status probes suppress
 * the prompt. `chrome.alarms` survive suspension and restart, so recovery is
 * scheduled as a periodic alarm that reloads the tab ONLY while it still
 * shows the consented URL, then clears itself. There is deliberately no
 * in-worker `setTimeout` fallback: a double mechanism would need cross-
 * restart coordination to avoid double reloads, and a ≤30s activation delay
 * is acceptable for a background recovery.
 */
export const RECOVERY_RELOAD_ALARM_PREFIX = 'webmcp-optin-recovery'
/** Recovery gives up after this window (the user probably moved on). */
const RECOVERY_RELOAD_WINDOW_MS = 5 * 60_000
/** 30s — Chrome's minimum alarm period. */
const RECOVERY_RELOAD_PERIOD_MINUTES = 0.5

/** Test seam: the scheduler itself (exported read-only for assertions). */
export function scheduleRecoveryReload(tabId: number, expectedUrl: string): void {
  try {
    // The alarm name carries tabId, issue time AND the consented URL: the
    // handler re-derives everything from the name alone after a restart.
    chrome.alarms?.create(
      `${RECOVERY_RELOAD_ALARM_PREFIX}:${tabId}:${Date.now()}:${expectedUrl}`,
      {
        delayInMinutes: RECOVERY_RELOAD_PERIOD_MINUTES,
        periodInMinutes: RECOVERY_RELOAD_PERIOD_MINUTES,
      },
    )
  } catch (err: unknown) {
    // eslint-disable-next-line no-console
    console.warn('[PackageOptIn] could not schedule the recovery alarm:', err)
  }
}

/** Cancel every pending recovery alarm for a tab (called after a good reload). */
export async function cancelRecoveryReloadAlarms(tabId: number): Promise<void> {
  try {
    const all = (await chrome.alarms?.getAll()) ?? []
    for (const alarm of all) {
      if (alarm.name.startsWith(`${RECOVERY_RELOAD_ALARM_PREFIX}:${tabId}:`)) {
        await chrome.alarms.clear(alarm.name)
      }
    }
  } catch {
    // Alarms unavailable (tests / exotic embeds) — nothing durable to cancel.
  }
}

/**
 * Alarm-listener half of the recovery flow. Registered ONCE by the
 * background; returns true when the alarm belonged to this feature so the
 * caller can stop processing it.
 */
export async function handlePackageOptInRecoveryAlarm(alarm: { name: string }): Promise<boolean> {
  const prefix = `${RECOVERY_RELOAD_ALARM_PREFIX}:`
  if (!alarm.name.startsWith(prefix)) return false
  const rest = alarm.name.slice(prefix.length)
  const sep1 = rest.indexOf(':')
  const sep2 = rest.indexOf(':', sep1 + 1)
  const tabId = Number(rest.slice(0, sep1))
  const issuedAt = Number(rest.slice(sep1 + 1, sep2))
  const expectedUrl = rest.slice(sep2 + 1)
  if (
    !Number.isInteger(tabId) ||
    !Number.isFinite(issuedAt) ||
    !expectedUrl ||
    Date.now() - issuedAt > RECOVERY_RELOAD_WINDOW_MS
  ) {
    void chrome.alarms.clear(alarm.name)
    return true
  }
  try {
    const tab = await chrome.tabs.get(tabId)
    if ((tab.url || '') !== expectedUrl) {
      // The user moved on — never reload a page they did not consent to.
      void chrome.alarms.clear(alarm.name)
      return true
    }
    await chrome.tabs.reload(tabId)
  } catch {
    // Tab not ready yet (cold start / transient error) — the alarm re-fires
    // within the window; suspension between fires loses nothing.
    return true
  }
  // Reload landed — the tools are active; stop the periodic alarm.
  void chrome.alarms.clear(alarm.name)
  return true
}

export function createPackageOptInHandler(deps: PackageOptInDependencies) {
  /**
   * Total tool count of the package, across ALL origins — not just the ones
   * matching the current tab URL. The enable flips the whole package on, so
   * the consent payload must disclose everything that will be activated.
   */
  const totalToolCount = (candidate: PackageOptInCandidate, entries: Awaited<ReturnType<typeof readWebMCPCatalog>>): number => {
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
        const tab = await chrome.tabs.get(tabId)
        const statusUrl = tab.url || ''
        const entries = statusUrl ? await readWebMCPCatalog() : []
        const candidate = statusUrl ? findPackageOptInCandidate(entries, statusUrl) : null
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
          candidate.activation === 'disabled'
            ? issueConsentToken(
                tabId,
                candidate.id,
                await packageFingerprint(candidate, entries.find(e => e.directory === candidate.directory)),
              )
            : undefined
        // Sibling candidates for the dismissed-best case (finding: "Dismissal
        // hides other package prompts"): the web client picks the best
        // NON-dismissed alternative instead of hiding every prompt for the
        // site. The list is NOT capped at two: when a tab hosts ≥4 builtin
        // packages and the first three are within their dismissal cooldowns,
        // a capped list would leave `getPendingPackagePrompt` without a
        // non-dismissed candidate and hide an available opt-in (finding:
        // "Dismissed packages hide later options"). Every DISABLED sibling is
        // returned (bounded at 8 — a tab hosting more builtin packages than
        // that is pathological, and each payload is metadata-only, same as
        // the primary). ALREADY-ENABLED siblings are excluded (finding:
        // "Enabled sibling gets an opt-in prompt"): the prompt exists to
        // enable packages, so offering an enabled sibling as an alternative
        // either re-enables and reloads it redundantly (grace mode) or fails
        // the consent check (strict mode).
        const alternatives = await Promise.all(
          findPackageOptInCandidates(entries, statusUrl)
            .filter(item => item.directory !== candidate.directory)
            .filter(item => item.activation === 'disabled')
            .slice(0, 8)
            // Each DISABLED sibling gets its OWN package-bound consent token
            // (findings: "Sibling consent cannot complete" / "Sibling opt-in
            // is rejected"): a token never enables a package other than the
            // one it was minted for, so the client must be able to echo a
            // sibling-bound token back on confirm.
            .map(item => ({ item, directory: entries.find(e => e.directory === item.directory) }))
            .map(async ({ item, directory }) => ({
              ...item,
              consentToken:
                item.activation === 'disabled'
                  ? issueConsentToken(tabId, item.id, await packageFingerprint(item, directory))
                  : undefined,
            })),
        )
        // Tokens minted for alternatives the client may never offer would
        // linger until TTL expiry; acceptable (bounded, in-memory, single
        // use) and far cheaper than a callback channel for revocation.
        sendResponse({
          ok: true,
          applicable: true,
          package: candidate,
          enabled: candidate.activation === 'enabled',
          consentToken,
          totalTools: totalToolCount(candidate, entries),
          alternatives,
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
      // SECURITY (round-3 finding: "External activation skips consent"):
      // the tokenless grace path exists ONLY for BUILTIN packages — old
      // extension builds never saw external (registry-installed) packages,
      // so there is no legacy caller to keep working for them. Whether the
      // requested package is EXTERNAL is decided below against the
      // re-derived candidate (never the web-supplied id alone).
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
        // Re-derive the candidates from the LIVE tab URL — never trust the
        // web-app-supplied id alone. The requested package must be AMONG the
        // candidates the bound tab actually hosts (finding: "Sibling opt-in
        // is rejected"): the best-candidate pick alone would reject a
        // legitimately offered sibling whose id differs from the primary's.
        // The read covers BOTH mounts (finding: "Conflicting packages can be
        // enabled"): a user-mounted package sharing the builtin candidate's
        // manifest id produces a duplicate-namespace diagnostic, and the
        // combined catalog excludes conflicting entries from active tools —
        // enabling the builtin twin would report success with zero tools.
        const tab = await chrome.tabs.get(tabId)
        const url = tab.url || ''
        if (!url) {
          sendResponse({
            ok: false,
            errorCode: 'PACKAGE_MISMATCH',
            error: 'The bound tab has no URL; enable cancelled.',
          })
          return false
        }
        // SAFETY-critical read: an INCOMPLETE catalog (the user mount could
        // not be listed) cannot prove the requested package is conflict-free
        // (finding: "Conflicting package activates without tools") — refuse
        // instead of enabling a builtin whose user-mounted twin may be hidden
        // by the degraded read. This is deliberately stricter than the status
        // probe, which may degrade to builtin-only for DISPLAY.
        const [entries, { userMountComplete }] = await readWebMCPCatalogDetailed()
        if (!userMountComplete) {
          sendResponse({
            ok: false,
            errorCode: 'PACKAGE_CONFLICT',
            error: 'User packages could not be listed; resolve the conflict risk in package management first.',
          })
          return false
        }
        const candidates = findPackageOptInCandidates(entries, url)
        const candidate = candidates.find(item => item.id === packageId)
        if (!candidate) {
          sendResponse({
            ok: false,
            errorCode: 'PACKAGE_MISMATCH',
            error: 'Package does not match the bound tab location.',
          })
          return false
        }
        // SECURITY (round-3 finding: "External activation skips consent"):
        // the tokenless grace path is a compatibility shim for clients that
        // predate consent tokens — those clients never knew about EXTERNAL
        // packages, so a registry-installed package must ALWAYS present a
        // valid consent token, even while builtin enables are still accepted
        // tokenless in grace mode. Checked against the RE-DERIVED candidate
        // (mount = `webmcp`), never the web-supplied id alone.
        if (!hasConsentToken && candidate.mount !== 'builtin-webmcp') {
          // eslint-disable-next-line no-console
          console.warn('[PackageOptIn] tokenless enable of an EXTERNAL package refused (no legacy caller exists)', {
            packageId,
            timestamp: new Date().toISOString(),
          })
          sendResponse({
            ok: false,
            errorCode: 'CONSENT_REQUIRED',
            error: 'packageId and a consent token from webmcp_package_optin_status are required.',
          })
          return false
        }
        // Fail-closed token consumption happens only NOW, against the
        // RE-DERIVED candidate: the token must match the package the user
        // ACTUALLY saw in the modal — tab, id AND fingerprint (finding:
        // "Stale consent enables replaced tools"). A package replaced under
        // the same id between the status probe and this confirmation carries
        // a different fingerprint, so the stale confirmation is rejected
        // instead of enabling the replacement's tools. Consuming after the
        // candidate lookup (not before) keeps a wrong-token request from
        // burning a valid token for a DIFFERENT package.
        if (
          hasConsentToken &&
          !consumeConsentToken(
            consentToken,
            tabId,
            packageId,
            await packageFingerprint(candidate, entries.find(e => e.directory === candidate.directory)),
          )
        ) {
          sendResponse({
            ok: false,
            errorCode: 'CONSENT_REQUIRED',
            error: 'Consent token missing, expired, already used, or bound to another tab/package/version.',
          })
          return false
        }
        // The duplicate-namespace diagnostic only exists when BOTH twins are
        // in the catalog. Read the mount ids of every entry sharing the
        // candidate's manifest id: if a user-mounted twin is present, the
        // combined catalog marks them conflicting and NEITHER package would
        // contribute tools — refuse instead of reporting a hollow success.
        const conflictingMounts = new Set(
          entries
            .filter(
              entry =>
                entry.package?.manifest.id === candidate.id &&
                entry.directory !== candidate.directory,
            )
            .map(entry => entry.mount),
        )
        if (conflictingMounts.size > 0) {
          sendResponse({
            ok: false,
            errorCode: 'PACKAGE_CONFLICT',
            error: 'A user-mounted package with the same id exists; resolve the conflict in package management first.',
          })
          return false
        }
        // The tab must still be the one the consent flow bound: a navigation
        // to an unrelated origin between token issue and confirm must not
        // reload somebody else's page (finding: "Unrelated page gets
        // reloaded" / "A stale site's package gets enabled").
        const owner = await chrome.tabs.get(tabId)
        if ((owner.url || '') !== url) {
          sendResponse({
            ok: false,
            errorCode: 'PACKAGE_MISMATCH',
            error: 'The bound tab navigated away; enable cancelled.',
          })
          return false
        }
        // Revalidate package PRESENCE immediately before the activation
        // write (finding: "Uninstall races can recreate packages"): an
        // uninstall that removed the directory after the catalog read above
        // must not be resurrected by this write — the provider creates
        // missing parent directories for config.json, which would leave a
        // directory holding ONLY activation state, and the post-reload
        // verification would then report a package whose manifest and tools
        // are gone as "enabled". For builtin packages the config lives in
        // chrome.storage.local, not the package directory, so there is
        // nothing to resurrect.
        // SECURITY (finding: "Replacement receives old consent", round 3):
        // presence check + fresh-fingerprint + activation write must be
        // ATOMIC with respect to install/uninstall transactions. "Fresh" is
        // not "atomic": a swap landing between the re-read and the write
        // still armed a replacement. Hold the SAME cross-context lease the
        // installer takes, so a replacement cannot land mid-enable.
        // The enable is executed INSIDE the lease below; failures inside
        // respond and return false through the lock wrapper's callback.
        const enableFailure = (errorCode: string, error: string) => {
          sendResponse({ ok: false, errorCode, error })
        }
        const enableResult = await withPackageLock(candidate.directory, async (lockSignal): Promise<boolean> => {
          // Guard every step (finding: "Lost lease does not stop
          // mutations"): when the heartbeat loses the lease the signal
          // aborts, and the transaction stops BEFORE the next mutation
          // instead of writing a config under the new owner's lease.
          const lost = () => {
            enableFailure('LOCK_LOST', 'The package lease was lost while enabling; nothing was enabled.')
            return false
          }
          if (lockSignal.aborted) return lost()
          if (candidate.mount !== 'builtin-webmcp') {
            const provider = await getAdapterStorage()
            try {
              await provider.stat(`${candidate.directory}/manifest.json`)
            } catch {
              enableFailure('PACKAGE_UNINSTALLED', 'The package was removed while enabling; nothing was enabled.')
              return false
            }
            if (lockSignal.aborted) return lost()
          }
          // Re-check the package CONTENT under the lock (finding:
          // "Replacement receives old consent"): the fingerprint in the
          // token was validated against the catalog read ABOVE, but an
          // install replacing the package between that read and this write
          // would receive the OLD consent. Re-read the catalog fresh and
          // recompute the fingerprint from the live entry; a change rejects
          // with PACKAGE_MISMATCH instead of arming the replacement.
          const [freshEntries, { userMountComplete: freshMountComplete }] = await readWebMCPCatalogDetailed()
          // An incomplete fresh read can hide a user-mounted duplicate of a
          // builtin candidate (finding: "Incomplete fresh catalog permits
          // enable") — refuse rather than enable into a conflict.
          if (!freshMountComplete) {
            enableFailure('PACKAGE_CONFLICT', 'User packages could not be listed while enabling; nothing was enabled.')
            return false
          }
          const freshEntry = freshEntries.find(e => e.directory === candidate.directory && e.mount === candidate.mount)
          // Fingerprint EACH entry against its OWN manifest/sources (round-3
          // finding: "Replacement bypasses fresh consent check"): the
          // manifest portion of the digest comes from the ENTRY passed in,
          // so a replacement that changed tool names or URL rules (while
          // keeping paths + source bytes) now yields a different fingerprint
          // and the old consent is rejected instead of arming it.
          if (lockSignal.aborted) return lost()
          const freshFingerprint = freshEntry ? await packageFingerprint(candidate, freshEntry) : null
          const oldFingerprint = await packageFingerprint(candidate, entries.find(e => e.directory === candidate.directory))
          if (lockSignal.aborted) return lost()
          if (freshFingerprint === null || freshFingerprint !== oldFingerprint) {
            enableFailure('PACKAGE_MISMATCH', 'The package changed while enabling; nothing was enabled.')
            return false
          }
          // The activation write is the mutation: an aborted transaction
          // must not perform it (finding: "Lost lease does not stop
          // mutations").
          if (lockSignal.aborted) return lost()
          await writePackageActivation(candidate.mount, candidate.directory, lockSignal)
          // Finding: "Enable reports failure after committing" — the sentinel
          // bounce is a NOTIFICATION, not part of the activation state: the
          // config write has already committed when it runs. A storage
          // failure here must not flip a committed enable into ENABLE_FAILED
          // (which records a cooldown and claims the enable failed); the
          // storage.onChanged listener ALSO refreshes on the set/remove
          // lifecycle, so report the partial state honestly instead.
          return true
        })
        if (!enableResult) {
          return false
        }
        // Reload FIRST, then verify, then respond (finding: "Disabled package
        // reported enabled"): a disable that commits after our enable write
        // must be OBSERVED before success is reported, and the reload must
        // not carry a post-verification disable to the page unobserved. The
        // order enable → reload → verify closes both windows as far as an
        // out-of-transaction read protocol allows: any disable that commits
        // before the FINAL read below is caught; one committing after it is
        // a user action concurrent with — and after — the consented enable.
        let reloaded = false
        try {
          const preReload = await chrome.tabs.get(tabId)
          if ((preReload.url || '') === url) {
            await chrome.tabs.reload(tabId)
            reloaded = true
          } else {
            // eslint-disable-next-line no-console
            console.warn(
              '[PackageOptIn] skipped reloading the bound tab: it navigated away after the enable —',
              'the package is enabled; the new page will pick the tools up on its next reload.',
            )
          }
        } catch (reloadErr: unknown) {
          // The enable is persisted; only this page load misses the tools.
          // Findings "Enabled package skips page reload" / "Enabled package
          // remains unloaded": schedule a recovery reload so an enabled
          // package does not silently stay unloaded until the next reload.
          // eslint-disable-next-line no-console
          console.warn(
            '[PackageOptIn] enable succeeded but reloading the bound tab failed —',
            'scheduling a recovery reload:',
            reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
          )
          scheduleRecoveryReload(tabId, url)
        }
        // The reload landed — the tools are active, so any recovery alarm
        // from an EARLIER failed enable of this tab is now obsolete.
        if (reloaded) await cancelRecoveryReloadAlarms(tabId)
        // Verify the write actually stuck AFTER the reload (findings: "Disable
        // choice gets overwritten" / "Success reported after disable"): a
        // queued package-management disable must still be able to win AFTER
        // our write commits. Hold the check open for a short window so a
        // disable racing the enable lands inside it — the last state observed
        // wins, and a disable observed here is reported, never overridden.
        // A verification read that THROWS (transient storage error) is kept
        // apart from an observed `disabled` (finding: "Enabled package
        // reported failed"): the config write and the reload already
        // succeeded, so reporting ENABLE_FAILED would record a 1-day
        // cooldown and tell the user the enable failed even though the
        // package is active. VERIFY_INCOMPLETE reports the uncertainty
        // without the cooldown; the package stays enabled and revocable.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          let stored: { activation?: string } | null
          try {
            stored = await readPackageActivation(candidate.mount, candidate.directory)
          } catch (verifyErr: unknown) {
            // eslint-disable-next-line no-console
            console.warn(
              '[PackageOptIn] post-enable verification read failed — the package is enabled but unverified:',
              verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
            )
            sendResponse({
              ok: false,
              errorCode: 'VERIFY_INCOMPLETE',
              error:
                'The package was enabled and the page reloaded, but the final check could not be read. Check the Supported Sites page.',
            })
            return false
          }
          if (stored?.activation !== 'enabled') {
            sendResponse({
              ok: false,
              errorCode: 'ENABLE_REVERTED',
              error: 'The package was disabled again while enabling; nothing was enabled.',
            })
            return false
          }
          if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000))
        }
        sendResponse({ ok: true, packageId, hostname: candidate.hostname, reloaded })
      } catch (err: unknown) {
        // The write path's race guards (finding: "Uninstall leaves a phantom
        // package") signal a clean enable failure with a dedicated code —
        // report that honestly instead of the generic ENABLE_FAILED (which
        // records a cooldown as if storage were broken).
        const raceCode = (err as { code?: string }).code
        if (raceCode === 'PACKAGE_UNINSTALLED') {
          sendResponse({
            ok: false,
            errorCode: 'PACKAGE_UNINSTALLED',
            error: err instanceof Error ? err.message : String(err),
          })
          return false
        }
        // Finding: "Enable reports failure after committing" — a failed
        // sentinel bounce after a COMMITTED activation write is a partial
        // success, not a failed enable: the config on disk is `enabled`.
        // Report the dedicated code (the UI treats it like VERIFY_INCOMPLETE:
        // guidance, no failure cooldown) so the user is not told the enable
        // failed when the tools are (or will be) active.
        if (raceCode === 'ENABLE_NOTIFY_FAILED') {
          sendResponse({
            ok: false,
            errorCode: 'ENABLE_NOTIFY_FAILED',
            error: err instanceof Error ? err.message : String(err),
          })
          return false
        }
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
