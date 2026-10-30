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
} from '@/agent/providers/llm-gateway-provider'
import { getValidAccessToken } from '@/agent/providers/llm-gateway-auth'
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
    } catch {
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

  if (useSettingsStore.getState().hasApiKey) {
    return { ready: true, creditExhausted: false }
  }

  try {
    const providers = await withProbeTimeout(
      getAllApiKeyProviders(),
      'reading saved API keys',
    )
    // A stored gateway token shadow alone does NOT mean usable (the token
    // branch above already proved it invalid) — exclude it.
    const others = providers.filter((p) => p !== LLM_GATEWAY_API_KEY_ID)
    if (others.length > 0) {
      return { ready: true, creditExhausted: false }
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
