/**
 * Nutstore AI (坚果云 AI) console URL — the single place that resolves
 * where the user's credit balance is managed.
 *
 * The console host is the SAME host as the gateway API base: the gateway
 * API is served under `{base}/v1`, while the console (login, credit
 * balance, top-up) lives at the root of that host. So the recharge
 * entries must resolve the host from the deployment's configured base
 * URL rather than hardcoding a hostname — a demo/deployment that points
 * at a different gateway host must not have its recharge button send
 * the user to production (and vice versa).
 *
 * Mirrors the display in the provider card's "Service URL" row.
 */
export function getNutstoreAIConsoleURL(): string {
  const DEFAULT_CONSOLE = 'https://ai.jianguoyun.com'
  const configured = process.env.NEXT_PUBLIC_JIANGUOYUN_AI_BASE_URL
  // A blank / whitespace-only value must not produce an empty console URL —
  // the recharge entry would then open about:blank.
  const base = (configured || '').trim() || DEFAULT_CONSOLE
  // Strip a trailing slash so callers can append a path safely.
  return base.replace(/\/+$/, '')
}
