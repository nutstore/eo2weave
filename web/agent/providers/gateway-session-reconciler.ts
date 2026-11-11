/**
 * Observer-side gateway session reconciler (issues #171 + #172.1).
 *
 * A same-origin tab that merely OBSERVES a Nutstore AI login/logout/access-
 * refresh in another tab gets invalidation for free (the auth layer's
 * storage listener bumps the session generation and unregisters
 * `llm-gateway`), but nothing re-adopts the new session: the observing tab
 * stays unable to send despite a valid shared session. This module closes
 * that gap.
 *
 * Wiring: the auth layer (llm-gateway-auth.ts) publishes cross-tab session
 * events through a small subscription API — deliberately NOT a static
 * auth → provider import, which would create the fragile cycle documented
 * in the api-key store (removed in #277). This module statically imports BOTH sides
 * (the event API and the provider module) and is itself wired from the app
 * lifecycle (AppBootstrap) via a dynamic import, so no cycle exists.
 *
 * Two event kinds are handled by ONE reconciler (the issues require the
 * #171 identity reconciler and #172's access-only-refresh reconciliation to
 * be coordinated, not competing):
 *
 *  - 'identity-change' (#171): the refresh token changed — login, account
 *    replacement or logout in another tab. The old catalog is invalidated
 *    (already by the listener; re-asserted here), then the LATEST shared
 *    session is re-read (never the event payload). A usable session is
 *    adopted: token refreshed, provider registered, current account's
 *    catalog loaded, BOTH credential-status representations reconciled,
 *    stale status errors cleared, API-key availability cache invalidated.
 *    A confirmed-absent session reconciles to logged-out: provider/catalog
 *    removed, status set. A TRANSIENT storage/refresh/network failure is
 *    distinguished from confirmed absence: state is left alone (retryable)
 *    and a live session is never falsely labeled logged out.
 *
 *  - 'access-refresh' (#172 finding 1): same refresh identity, fresher
 *    access token. A tab that had marked the session expired re-reads the
 *    shared credential and reconciles its status to valid — without
 *    reloading the catalog (the account did not change).
 *
 * Fencing: every asynchronous result is checked against the CURRENT auth
 * session generation (and, for catalog writes, the catalog refresh version
 * enforced inside `updateGatewayModels`/`registerGatewayModels`). A job
 * started under one generation stops at its next await boundary after the
 * generation moved — rapid login → logout → login sequences can never let
 * an older job restore the previous account's catalog or overwrite the
 * newer status. Jobs are also serialized: only the newest accepted job
 * runs; a superseded job aborts at its fences.
 */

import {
  getGatewayAuthSessionGeneration,
  getGatewayCredentialStatus,
  resolveGatewayDispatchCredential,
  subscribeToGatewaySessionEvents,
  type GatewaySessionEvent,
} from '@/agent/providers/llm-gateway-auth'
import { getProviderConfig } from '@/agent/providers/types'
import {
  getLLMGatewayBaseURL,
  getLLMGatewayClientId,
  registerLLMGatewayProvider,
  registerGatewayModels,
  unregisterLLMGatewayProvider,
  updateGatewayModels,
} from '@/agent/providers/llm-gateway-provider'

/** Generation a reconcile job was started under. */
interface ReconcileJob {
  generation: number
}

/** Monotonic id of the newest job; older jobs stop at their fences. */
let newestJobId = 0

/** Whether a reconciler instance is currently installed. */
let installed = false

/** Whether this tab has a reconciler that owns provider/catalog state. */
export function isGatewayReconcilerInstalled(): boolean {
  return installed
}
let unsubscribe: (() => void) | null = null

/** Test/diagnostic hook: last terminal reconciliation outcome. */
export type GatewayReconcileOutcome =
  | 'adopted'
  | 'logged-out'
  | 'transient'
  | 'superseded'
let lastOutcome: GatewayReconcileOutcome | null = null

export function getLastGatewayReconcileOutcome(): GatewayReconcileOutcome | null {
  return lastOutcome
}

/** Reset reconciler module state (tests). */
export function __resetGatewaySessionReconcilerForTests(): void {
  unsubscribe?.()
  unsubscribe = null
  installed = false
  newestJobId = 0
  lastOutcome = null
  currentDispose = () => {}
  lastSetupWork = Promise.resolve()
}

function fence(job: ReconcileJob): boolean {
  return job.generation === getGatewayAuthSessionGeneration()
}

/**
 * True when a reconcile job's own credential refresh bumped the auth
 * generation: `resolveGatewayDispatchCredential` saves the refreshed pair
 * and bumps the generation, so a naive fence would retire the job's own
 * remaining reconciliation (#175 review). Generation moves not caused by
 * this job's refresh still supersede.
 */
function fenceAllowingOwnRefresh(job: ReconcileJob, generationBeforeRefresh: number): boolean {
  const current = getGatewayAuthSessionGeneration()
  return current === job.generation || current === generationBeforeRefresh + 1
}

/**
 * Mark the settings store's credential status with stale-write cleanup.
 * `stillCurrent` lets a caller relax the fence for its OWN credential
 * refresh's generation bump (#175 review).
 */
async function reconcileCredentialStatus(
  status: 'valid' | 'expired' | 'missing',
  options: { clearError: boolean },
  job: ReconcileJob,
  stillCurrent: () => boolean = () => fence(job),
): Promise<boolean> {
  // Dynamic import (same pattern the auth layer uses): keeps this module
  // loadable in tests that stub the settings store, and avoids a static
  // store dependency at module-eval time.
  const { useSettingsStore } = await import('@/store/settings.store')
  // Fence: a newer session change supersedes this status write.
  if (!stillCurrent()) return false
  const settings = useSettingsStore.getState()
  settings.setModelCredentialStatus(status)
  if (options.clearError) settings.setModelCredentialStatusError(null)
  return true
}

async function reconcileLoggedIn(job: ReconcileJob, event: GatewaySessionEvent): Promise<GatewayReconcileOutcome> {
  const baseURL = getLLMGatewayBaseURL()
  const clientId = getLLMGatewayClientId()

  // The resolver's own refresh bumps the auth generation (saveStoredTokens);
  // remember the pre-refresh value so the fences below tolerate THAT bump
  // while still retiring jobs superseded by a genuinely newer session (#175
  // review: "refresh retires its own reconciliation").
  const generationBeforeResolve = getGatewayAuthSessionGeneration()
  const fenceAfterResolve = (): boolean => fenceAllowingOwnRefresh(job, generationBeforeResolve)

  // Re-read the LATEST shared session (never the event payload) and obtain
  // a usable token. Confirmed absence and transient failures are
  // distinguished by the resolver's status-bearing result.
  const resolved = await resolveGatewayDispatchCredential(baseURL, clientId)
  if (!fenceAfterResolve()) return 'superseded'

  if (!resolved.ok) {
    if (resolved.kind === 'temporary') {
      // Transient storage/refresh/network failure: NOT evidence of logout.
      // Re-register the provider (the invalidation path unregistered it) so
      // the settings card and send path can retry, and leave BOTH credential-
      // status representations untouched — a possibly valid session must not
      // be labeled expired/missing, and a stale error is not cleared either
      // (the outcome is unknown, not healthy).
      // An identity change invalidates all account-scoped models. Clear the
      // registry before registering an unknown catalog so failed discovery
      // cannot retain a previous account's model IDs.
      if (event.type === 'identity-change') unregisterLLMGatewayProvider()
      registerLLMGatewayProvider()
      // 'loading', never 'failed': this job did not manage to fetch, which is
      // not evidence that the catalog is unavailable. 'failed' here is what
      // made the switcher warn about a perfectly healthy account.
      if (event.type === 'identity-change') registerGatewayModels([], 'loading')
      return 'transient'
    }
    // Logged out for real (the other tab removed the token pair) → removing
    // the provider is correct. A 'missing' verdict with a token key still in
    // place is more likely a read that raced another context's write (a side
    // panel booting, a second tab refreshing) — removing the provider then
    // reads as "provider unavailable, sign in again" for a selection that
    // still exists, which is exactly the reported symptom. Keep it registered
    // and let the switcher report the truth instead.
    if (event.type === 'identity-change' && event.newRefreshToken === null) {
      unregisterLLMGatewayProvider()
    } else {
      registerGatewayModels([], 'failed')
    }
    const statusOk = await reconcileCredentialStatus(resolved.kind, { clearError: false }, job)
    if (!statusOk) return 'superseded'
    return 'logged-out'
  }

  // Usable session: register the provider, load the CURRENT account's
  // catalog, then reconcile both status representations.
  registerLLMGatewayProvider()
  if (!fenceAfterResolve()) return 'superseded'

  const tokenGeneration = getGatewayAuthSessionGeneration()
  try {
    // updateGatewayModels fences its catalog commit against the auth
    // generation AND the catalog refresh version internally — an older
    // job's discovery can never overwrite a newer session's catalog.
    await updateGatewayModels(resolved.accessToken, tokenGeneration)
  } catch (e) {
    // Discovery failure is NOT authoritative: the provider stays registered
    // with a 'failed' catalog status (never the previous account's models
    // presented as verified — the registry retains them only as non-
    // authoritative display data, and a NEW account must not inherit them).
    // A generation change during discovery means the failure belongs to a
    // dead session: drop its catalog entirely.
    if (!fenceAfterResolve() || tokenGeneration !== getGatewayAuthSessionGeneration()) {
      unregisterLLMGatewayProvider()
      return 'superseded'
    }
    console.warn('[gateway-session-reconciler] catalog discovery failed after login; keeping failed catalog:', e)
  }
  if (!fenceAfterResolve()) return 'superseded'

  // Discovery may reject a seemingly fresh access token and then confirm
  // that refreshing it is impossible. Preserve the auth layer's verdict.
  const credentialStatus = getGatewayCredentialStatus()
  if (credentialStatus === 'expired' || credentialStatus === 'missing') return 'logged-out'

  const statusOk = await reconcileCredentialStatus('valid', { clearError: true }, job, fenceAfterResolve)
  if (!statusOk) return 'superseded'

  // Invalidate the API-key availability cache for the gateway's storage key
  // so the UI re-reads the (new) access-token shadow instead of trusting a
  // stale cached verdict, and refresh provider-driven UI collections.
  try {
    const { useSettingsStore } = await import('@/store/settings.store')
    if (fenceAfterResolve()) {
      const settings = useSettingsStore.getState()
      settings.checkHasApiKey()
      settings.triggerProviderRefresh()
    }
  } catch {
    // Settings store unavailable — reconciliation is best-effort here.
  }
  return 'adopted'
}

async function reconcileAccessRefresh(job: ReconcileJob): Promise<GatewayReconcileOutcome> {
  // Another tab refreshed the access token under the same refresh identity.
  // Re-read the shared session and validate: a tab that had marked the
  // session expired (its own refresh raced and failed, for example) must
  // reconcile to the now-valid shared credential. Never blindly set 'valid'
  // from the event — fence against a later logout/login/refresh.
  const baseURL = getLLMGatewayBaseURL()
  const clientId = getLLMGatewayClientId()
  const resolved = await resolveGatewayDispatchCredential(baseURL, clientId)
  if (!fence(job)) return 'superseded'

  if (resolved.ok) {
    const statusOk = await reconcileCredentialStatus('valid', { clearError: true }, job)
    if (!statusOk) return 'superseded'
    try {
      const { useSettingsStore } = await import('@/store/settings.store')
      if (fence(job)) {
        const settings = useSettingsStore.getState()
        settings.checkHasApiKey()
        settings.triggerProviderRefresh()
      }
    } catch {
      // Settings store unavailable — best-effort.
    }
    return 'adopted'
  }
  if (resolved.kind === 'temporary') {
    // A transient failure must leave the provider usable: the tab that owns
    // the selection cannot tell "missing" from "not yet readable" either.
    if (!getProviderConfig('llm-gateway')) registerLLMGatewayProvider()
    return 'transient'
  }
  // The shared session is genuinely gone/expired despite the refresh event
  // (e.g. a logout raced the event delivery): reconcile logged-out — again
  // without removing the provider, which only explicit logout may do.
  registerGatewayModels([], 'failed')
  const statusOk = await reconcileCredentialStatus(resolved.kind, { clearError: false }, job)
  return statusOk ? 'logged-out' : 'superseded'
}

async function runReconcile(event: GatewaySessionEvent): Promise<void> {
  const job: ReconcileJob = { generation: getGatewayAuthSessionGeneration() }
  const jobId = ++newestJobId
  try {
    const outcome = event.type === 'access-refresh'
      ? await reconcileAccessRefresh(job)
      : await reconcileLoggedIn(job, event)
    // Only the newest job may record its outcome; an older job that kept
    // running to a fence-stop must not clobber the newer job's verdict.
    if (jobId === newestJobId) lastOutcome = outcome
  } catch (e) {
    console.warn('[gateway-session-reconciler] reconciliation failed:', e)
    if (jobId === newestJobId) lastOutcome = 'transient'
  }
}

/**
 * Install the observer-side reconciler. Returns a dispose function that
 * unsubscribes (used by the wiring lifecycle and tests). Idempotent: a
 * second call returns the SAME disposer without double-subscribing, so one
 * caller's dispose always tears the subscription down coherently (#175
 * review) — after it, a fresh setup call re-subscribes cleanly.
 */
export function setupGatewaySessionReconciler(): () => void {
  // Every caller receives the SAME idempotent disposer (#175 review): a raw
  // `unsubscribe` would leave `installed`/`unsubscribe` set when one of
  // several callers disposed, so later setups would believe a listener is
  // still installed while cross-tab events go unreconciled.
  if (installed && unsubscribe) return currentDispose
  installed = true

  let queued: Promise<void> = Promise.resolve()
  const enqueue = (event: GatewaySessionEvent): void => {
    // Serialize jobs: each reconcile runs to completion (or its fences)
    // before the next starts, and `newestJobId` fencing retires the losers
    // of rapid login → logout → login sequences at their await boundaries.
    queued = queued
      .then(() => runReconcile(event))
      .catch((e) => {
        // runReconcile catches internally; this guard only keeps the chain
        // alive against unexpected rejections.
        console.warn('[gateway-session-reconciler] queue continuation failed:', e)
      })
  }
  unsubscribe = subscribeToGatewaySessionEvents(enqueue)

  // #175 review: the subscription only sees FUTURE events. A cross-tab
  // session change that landed between the auth storage listener's
  // activation and this subscription install would be missed forever —
  // inspect the CURRENT session once so late installers still converge.
  const initialReconcile = queued.then(() => runReconcile({ type: 'identity-change', oldRefreshToken: null, newRefreshToken: null, generation: getGatewayAuthSessionGeneration() }))
    .catch((e) => {
      console.warn('[gateway-session-reconciler] initial reconcile failed:', e)
    })
  // Exposed to tests so they can drain the initial reconcile deterministically.
  lastSetupWork = initialReconcile

  currentDispose = () => {
    unsubscribe?.()
    unsubscribe = null
    installed = false
  }
  return currentDispose
}

/** The shared idempotent disposer handed to every setup caller. */
let currentDispose: () => void = () => {}
/** Promise resolving when the most recent setup's initial reconcile settled. */
let lastSetupWork: Promise<void> = Promise.resolve()

/** Test hook: resolve after the setup-time initial reconcile has settled. */
export function whenGatewayReconcilerSettledForTests(): Promise<void> {
  return lastSetupWork
}
