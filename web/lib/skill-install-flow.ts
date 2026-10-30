/**
 * skill-install-flow — pure helpers for the /skill-install promotion landing
 * page (issue #126).
 *
 * Split out of the component so the decision branches (AI-readiness
 * detection, navigation-target selection, input prefill) can be unit-tested
 * without rendering React.
 */

import { ENABLE_LLM_GATEWAY } from '@/lib/deploy-region'
import {
  fetchGatewayRateLimits,
  getLLMGatewayBaseURL,
  getLLMGatewayClientId,
  isLLMGatewayConfigured,
  LLM_GATEWAY_API_KEY_ID,
  LLM_GATEWAY_PROVIDER_TYPE,
} from '@/agent/providers/llm-gateway-provider'
import {
  getValidAccessToken,
  LLM_GATEWAY_REFRESH_TOKEN_KEY_ID,
} from '@/agent/providers/llm-gateway-auth'
import { useSettingsStore } from '@/store/settings.store'
import { getAllApiKeyProviders } from '@/security/api-key-store'

// ── AI readiness ────────────────────────────────────────────────────

export interface AiReadinessResult {
  /** True when at least one usable model credential exists. */
  ready: boolean
  /** Gateway logged in but /v1/rate-limits reports 0 available credit. */
  creditExhausted: boolean
  /**
   * True when the API-key store itself could not be probed (storage
   * outage) — the "not ready" verdict is then UNPROVEN, not confirmed:
   * the visitor's key may well be in that store. The caller should offer
   * a retry instead of the login step.
   */
  keyStoreUnavailable?: boolean
}

/**
 * Deadline for each readiness probe (token refresh, rate-limits request,
 * api-key store read): a probe that stalls without settling must not pin
 * `checkAiReadiness` forever — the visitor would be stuck on the details
 * screen with Start blocked by the in-flight guard and no way to retry.
 */
const READINESS_PROBE_TIMEOUT_MS = 10_000

/**
 * Race `p` against a deadline. On expiry the probe's (still pending) result
 * is discarded and a retryable timeout error is thrown — the caller decides
 * how to degrade.
 */
async function withProbeTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`AI readiness check timed out while ${what}. Please try again.`))
    }, READINESS_PROBE_TIMEOUT_MS)
  })
  try {
    return await Promise.race([p, timeout])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Decide whether the visitor can run the skill right away.
 *
 * Branches (issue #126):
 *   1. llm-gateway logged in (valid access token) → ready; also probe
 *      /v1/rate-limits so a 0-credit account gets the "can't use yet"
 *      hint early (ties into the #122 recharge entry).
 *   2. settings.store.hasApiKey (current provider has a key) → ready.
 *   3. any OTHER provider key in the api-key store → ready.
 *   4. nothing → not ready (caller offers inline device-code login).
 *
 * All probes are best-effort: a failing quota/key-store probe never turns
 * a ready visitor "not ready". When the api-key store probe fails, the
 * not-ready verdict is flagged as unproven (`keyStoreUnavailable`) so the
 * page can offer a retry instead of sending a visitor whose usable key
 * sits in that store to the login step with no explanation.
 */
export async function checkAiReadiness(): Promise<AiReadinessResult> {
  return checkAiReadinessOnce(/* allowRecheck: */ true)
}

/**
 * Single readiness pass. `allowRecheck` permits ONE recursive re-run when
 * the visitor changed the selected provider while a probe was pending (the
 * new provider's credentials must be evaluated before reporting ready);
 * the re-run itself disallows further re-checks so a visitor switching
 * repeatedly within the probe window degrades to the safe not-ready/login
 * verdict instead of looping.
 */
async function checkAiReadinessOnce(allowRecheck: boolean): Promise<AiReadinessResult> {
  let gatewayProbeTimeout: Error | null = null
  if (ENABLE_LLM_GATEWAY && isLLMGatewayConfigured()) {
    // The token lookup itself can throw (storage not ready, corrupted token
    // cache) — treat that as "no gateway token" and keep evaluating the
    // remaining credential branches instead of aborting readiness. The
    // deadline also bounds a stalled probe before checking other credentials.
    let token: string | null = null
    try {
      token = await withProbeTimeout(
        getValidAccessToken(getLLMGatewayBaseURL(), getLLMGatewayClientId()),
        'checking the gateway login',
      )
    } catch (e) {
      // A stalled probe is still unknown. Check other credentials before
      // surfacing its retryable error when no usable credential is found.
      if (e instanceof Error && e.message.includes('timed out')) gatewayProbeTimeout = e
      token = null
    }
    if (token) {
      let creditExhausted = false
      try {
        const limits = await withProbeTimeout(fetchGatewayRateLimits(), 'checking gateway credit')
        creditExhausted = limits.available_credit <= 0
      } catch {
        // Quota is informational. A failed or stalled probe does not make
        // an otherwise valid gateway credential unusable.
      }
      return { ready: true, creditExhausted }
    }
  }

  // The gateway branch above proved the gateway credential unusable (no
  // valid token). If the CURRENT provider is the gateway, its saved key IS
  // the (missing/expired) gateway token — treating `hasApiKey` as usable
  // here would let an expired or purged gateway login report ready, skip
  // the login step, and fail on the first conversation send. Only a
  // non-gateway current provider counts as an independent credential.
  const settingsState = useSettingsStore.getState()
  const currentProviderType = settingsState.providerType
  const currentProviderIsGateway =
    currentProviderType === LLM_GATEWAY_PROVIDER_TYPE
  if (settingsState.hasApiKey && !currentProviderIsGateway) {
    return { ready: true, creditExhausted: false }
  }

  try {
    const providers = await withProbeTimeout(
      getAllApiKeyProviders(),
      'reading saved API keys',
    )
    // A stored gateway token shadow OR refresh-token backup alone does NOT
    // mean usable (the token branch above already proved the shadow invalid;
    // the refresh-token backup is internal bookkeeping, not a provider key)
    // — exclude both before declaring "another provider has a key".
    const gatewayOwnedKeys = new Set([LLM_GATEWAY_API_KEY_ID, LLM_GATEWAY_REFRESH_TOKEN_KEY_ID])
    const { getProviderMeta, isPotentiallyDynamicProviderType } = await import(
      '@/agent/providers/types'
    )
    // Only REGISTERED MODEL providers count as usable credentials: the
    // api-key store also holds non-model secrets (e.g. Jianguoyun WebDAV
    // app passwords). Selecting one of those as the provider would start a
    // conversation with no usable model configuration. A provider that
    // registers asynchronously (llm-gateway, codex-oauth, custom-*) may not
    // be in the registry yet at probe time — treat it as a model provider
    // so a genuinely usable key is not mistaken for a non-model secret.
    const others = providers.filter(
      (p) =>
        !gatewayOwnedKeys.has(p) &&
        (getProviderMeta(p as Parameters<typeof getProviderMeta>[0]) !== null ||
          isPotentiallyDynamicProviderType(p)),
    )
    if (others.length > 0) {
      // A usable credential exists, but under a DIFFERENT provider than the
      // currently selected one: reporting plain "ready" would start a
      // conversation with the unconfigured selected provider and fail on
      // the first request. Switch the selection to the provider that has a
      // saved key (first available), then report ready.
      const { loadApiKey } = await import('@/security/api-key-store')
      for (const candidate of others) {
        const key = await withProbeTimeout(
          loadApiKey(candidate),
          `reading the ${candidate} key`,
        )
        if (key) {
          // Fresh getState() AND a fresh selected-provider re-check: the
          // earlier snapshot predates the probe awaits, and the visitor may
          // have selected a different provider while the key lookup was
          // pending. Switching blindly would overwrite their newer choice
          // with this page's stale probe target — when the selection
          // changed, RE-EVALUATE readiness from the top against the new
          // provider instead of returning ready unconditionally (the newly
          // selected provider may itself have no usable key). The page's
          // own generation gate drops this stale flow's navigation either
          // way; only its settings side effects are governed here.
          const freshProvider = useSettingsStore.getState().providerType
          if (freshProvider !== currentProviderType) {
            if (useSettingsStore.getState().hasApiKey) {
              return { ready: true, creditExhausted: false }
            }
            // Re-check the new provider's credentials; `allowRecheck` false
            // (a visitor switching twice within the probe window) falls
            // through to the plain not-ready verdict, where the page offers
            // the login step — the safe default.
            if (allowRecheck) {
              return checkAiReadinessOnce(/* allowRecheck: */ false)
            }
            return { ready: false, creditExhausted: false }
          }
          // Resolve the model to select for the candidate BEFORE switching:
          // an empty string would overwrite the visitor's saved model for
          // that provider (`lastUsedModelByProvider`) and leave the
          // conversation with no model. Preference order: the provider's
          // last-used model (must still exist in its catalog), then the
          // provider's default model, then its first catalog entry.
          const target = candidate as Parameters<
            ReturnType<typeof useSettingsStore.getState>['switchProviderAndModel']
          >[0]
          const { getModelsForProvider } = await import('@/agent/providers/types')
          const lastUsed =
            useSettingsStore.getState().lastUsedModelByProvider[target] ?? ''
          const catalog = getModelsForProvider(target).map((m) => m.id)
          const { DEFAULT_PINNED_MODELS } = await import('@/agent/providers/default-models')
          const defaultPinned = (DEFAULT_PINNED_MODELS[target] ?? [])[0] ?? ''
          const resolvedModel =
            (lastUsed && (catalog.length === 0 || catalog.includes(lastUsed))
              ? lastUsed
              : '') ||
            (defaultPinned && (catalog.length === 0 || catalog.includes(defaultPinned))
              ? defaultPinned
              : '') ||
            catalog[0] ||
            ''
          useSettingsStore
            .getState()
            .switchProviderAndModel(target, resolvedModel)
          return { ready: true, creditExhausted: false }
        }
      }
    }
  } catch (e) {
    // Key store unavailable (storage not ready): the not-ready verdict
    // below is UNPROVEN — the visitor's usable key may live in that
    // store. Log it and flag it so the page can offer a retry rather
    // than silently prompting for login. A STALLED probe is different:
    // the timeout must propagate so the page surfaces a retryable error
    // instead of treating readiness as (unproven) not-ready.
    if (e instanceof Error && e.message.includes('timed out')) throw e
    console.error('[skill-install-flow] api-key store probe failed:', e)
    return { ready: false, creditExhausted: false, keyStoreUnavailable: true }
  }

  if (gatewayProbeTimeout) throw gatewayProbeTimeout
  return { ready: false, creditExhausted: false }
}

// ── Navigation-target selection ─────────────────────────────────────

export interface ConversationTarget {
  id: string
  /** True when a brand-new conversation was created for the visitor. */
  created: boolean
}

/**
 * Pick the conversation the landing page navigates to (issue #126):
 * history → most recent by lastAccessedAt; none → createNew() and use its
 * id (conversationId === workspaceId in this app).
 */
export function pickConversationTarget(
  workspaces: Array<{ id: string; lastAccessedAt?: number | null }>,
  createNew: () => { id: string },
): ConversationTarget {
  if (workspaces.length > 0) {
    const sorted = [...workspaces].sort(
      (a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0),
    )
    return { id: sorted[0].id, created: false }
  }
  return { id: createNew().id, created: true }
}

// ── Input prefill ───────────────────────────────────────────────────

/**
 * Merge the skill prefill into any unsent draft the target conversation
 * already holds: existing text is preserved below the command, and a
 * re-click is idempotent — but ONLY when the draft already carries the
 * exact requested prefill. A draft that merely starts with the command
 * (e.g. a longer command sharing its prefix, or the same command with a
 * different prompt) does NOT count as present: the requested prefill is
 * stacked on top so the visitor's link always lands intact.
 */
export function mergePrefillText(
  existingText: string | null | undefined,
  prefill: string,
): string {
  const trimmed = (existingText ?? '').trim()
  if (!trimmed) return prefill
  const command = prefill.split(/\s+/)[0] ?? prefill
  // "Already present" requires the draft to start with the EXACT command
  // token (word boundary — a longer command sharing the prefix does not
  // count). When the link requests a prompt, that prompt must match the
  // draft's remainder exactly; a bare command counts as present over any
  // user-typed continuation (keeps re-clicks idempotent).
  const rest = trimmed.slice(command.length)
  const hasCommandToken = trimmed.startsWith(command) && (rest === '' || rest.startsWith(' '))
  const requestedPrompt = prefill.slice(command.length).trim()
  if (hasCommandToken && (requestedPrompt === '' || rest.trim() === requestedPrompt)) {
    return trimmed
  }
  return `${prefill}\n${trimmed}`
}

/**
 * Build the prefill text: `/{skill-name}` slash command (explicit skill
 * activation, teaches the slash convention), plus the promoter-defined
 * `prompt` suffix when present.
 */
export function buildPrefillText(skillName: string, prompt?: string | null): string {
  const command = `/${skillName}`
  const suffix = (prompt ?? '').trim()
  return suffix ? `${command} ${suffix}` : command
}

// ── Init polling ────────────────────────────────────────────────────

/**
 * Wait until `predicate` turns true (AppBootstrap-driven store init is
 * async relative to the landing page mount). Resolves false on timeout so
 * the caller can fall back to a safe route instead of hanging.
 */
export async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 10_000,
  intervalMs = 200,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  return predicate()
}
