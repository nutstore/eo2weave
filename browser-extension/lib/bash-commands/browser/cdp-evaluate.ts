/// <reference types="chrome" />
import { ensureAttached, sendCommand, withTabLock, noteCdpActivity } from './cdp'

/**
 * Evaluate an expression in the page's MAIN world through the CDP debugger
 * path, which injects via the debugger and is NOT bound by the page's CSP.
 *
 * This is the fallback for strict-CSP pages (#106): `new Function`-based
 * compilation in the MAIN world is refused there, while CDP `Runtime.evaluate`
 * compiles internally without going through the page's Function constructor.
 * Callers may only reach this after a tagged compile-stage failure (see
 * page-action-runner.content.ts / scripting-eval.ts) — the compile refusal is
 * thrown BEFORE any user code runs, so the expression is provably
 * side-effect-free and a re-run cannot duplicate effects. The per-tab
 * operation lock serializes the evaluation against other browser commands on
 * the same tab, so a timed-out browser request cannot `terminateExecution`
 * this expression mid-flight (and vice versa).
 *
 * Like the browser.eval fallback, this attaches the debugger (Chrome shows the
 * "debugging started" banner); the normal idle auto-detach clears it when the
 * tab goes quiet. The runtime keeps CDP activity recorded while an evaluation
 * is in flight, so a long `awaitPromise` wait cannot trip the idle auto-detach.
 * Results are structured-clone-safe only (returnByValue) — the page-action
 * bridge cannot carry remote object handles anyway; unserializable values
 * (NaN/Infinity/-0/BigInt) are surfaced through `unserializableValue` and
 * mapped back to their JS equivalents.
 */

/** Map a CDP RemoteObject to a structured-clone-safe JS value. */
function remoteObjectToValue(obj: {
  value?: unknown
  unserializableValue?: string
  subtype?: string
  description?: string
}): unknown {
  // CDP reports values it cannot serialize (NaN, Infinity, -0, BigInt) via
  // `unserializableValue` and omits `value`. Parse the textual form back.
  if (obj.unserializableValue !== undefined) {
    const raw = obj.unserializableValue
    switch (raw) {
      case 'NaN':
        return Number.NaN
      case 'Infinity':
        return Number.POSITIVE_INFINITY
      case '-Infinity':
        return Number.NEGATIVE_INFINITY
      case '-0':
        return Number(-0)
      default:
        // BigInt literals arrive as e.g. `123n`.
        if (/^-?\d+n$/.test(raw)) {
          try {
            return BigInt(raw.slice(0, -1))
          } catch {
            return raw
          }
        }
        return raw
    }
  }
  return obj.value
}

/**
 * Wrap the expression for `Runtime.evaluate`, which parses its input as
 * SCRIPT source. The page-action `evaluate` expression is a FUNCTION BODY
 * (`new Function(expression)` semantics: statements, `return`, top-level
 * `await` allowed) — wrap it in an async IIFE so all valid body syntax keeps
 * working through the CDP path, and the completion value comes back the same
 * way the MAIN-world path would have returned it.
 */
function wrapAsAsyncBody(expression: string): string {
  return `(async () => {\n${expression}\n})()`
}

export async function evaluateBoundExpressionViaCdp(
  tabId: number,
  expression: string,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  return withTabLock(tabId, async () => {
    await ensureAttached(tabId)
    // The evaluation may outlive any single idle window (awaitPromise on a
    // slow page promise). Keep the CDP session marked active for the whole
    // wait — sendCommand only notes activity at callback completion, so
    // without this the idle sweep would detach mid-evaluation and lose the
    // result.
    let inFlight = true
    const heartbeat = setInterval(() => {
      if (inFlight) noteCdpActivity(tabId)
    }, 10_000)
    try {
      const response = await sendCommand<{
        result?: {
          value?: unknown
          unserializableValue?: string
          subtype?: string
          description?: string
        }
        exceptionDetails?: {
          text?: string
          exception?: {
            description?: string
            value?: unknown
            unserializableValue?: string
          }
        }
      }>(tabId, 'Runtime.evaluate', {
        expression: wrapAsAsyncBody(expression),
        returnByValue: true,
        awaitPromise: true,
      })
      if (response.exceptionDetails) {
        const d = response.exceptionDetails
        // A thrown PRIMITIVE may carry no `description`; prefer the thrown
        // value itself (stringified) over the generic `Uncaught` text so the
        // caller sees what the page actually threw.
        const desc = d.exception?.description
        if (desc) return { ok: false, error: desc }
        const thrown = d.exception
          ? remoteObjectToValue(d.exception as Parameters<typeof remoteObjectToValue>[0])
          : undefined
        if (thrown !== undefined) {
          return {
            ok: false,
            error: typeof thrown === 'string' ? thrown : JSON.stringify(thrown),
          }
        }
        return { ok: false, error: d.text ?? 'Page execution failed' }
      }
      return { ok: true, result: remoteObjectToValue(response.result ?? {}) }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      inFlight = false
      clearInterval(heartbeat)
    }
  })
}
