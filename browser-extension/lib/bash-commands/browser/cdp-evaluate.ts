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
 *
 * Stale-document guard: when the caller pins the document identity that
 * produced the compile failure (`expectedDocId`), this run first verifies the
 * tab's CURRENT document still exposes that exact identity via the runner's
 * `docId` token — URL equality alone cannot distinguish a reload or same-URL
 * navigation, and a document replaced between the failure and this run must
 * not receive the stale expression (fail closed).
 */

/**
 * Upper bound for one CDP-fallback evaluation. Without it, an expression
 * returning a never-settling promise would hold `withTabLock`'s per-tab queue
 * forever (Runtime.evaluate's awaitPromise never resolves), deadlocking every
 * later browser command on that tab even after the bridge request itself has
 * timed out. Matches the bridge's own request timeout (sendToBridge, 300s) so
 * the tab lock is released no later than the caller gives up.
 */
export const EVALUATE_DEADLINE_MS = 300_000

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
 * Stringify a thrown value for the error message without ever throwing:
 * JSON.stringify rejects BigInt (and cyclic structures), which would replace
 * the real thrown value with a serialization error. Values it cannot handle
 * fall back to a cycle-safe, bigint-safe JSON pass, then to String();
 * `fallback` wins when nothing sensible can be produced.
 */
function stringifyThrownValue(thrown: unknown, fallback: string): string {
  if (typeof thrown === 'string') return thrown
  if (typeof thrown === 'bigint') return thrown.toString()
  try {
    const json = JSON.stringify(thrown)
    if (json !== undefined) return json
  } catch {
    // BigInt / circular structure — try the sanitized pass below.
  }
  try {
    const seen = new WeakSet<object>()
    const json = JSON.stringify(thrown, (_key, item: unknown) => {
      if (typeof item === 'bigint') return item.toString() + 'n'
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]'
        seen.add(item)
      }
      return item
    })
    if (json !== undefined && json !== '"[object Object]"') return json
  } catch {
    // Still unserializable — fall through to String().
  }
  try {
    const s = String(thrown)
    return s === 'undefined' ? fallback : s
  } catch {
    return fallback
  }
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

/**
 * Evaluate an expression in the page's MAIN world through the CDP debugger
 * path. When `expectedDocId` is provided, the evaluation only runs if the
 * tab's CURRENT document still exposes the page-action runner with that exact
 * `docId` — a reload or same-URL navigation fails closed instead of executing
 * the stale expression in the replacement document.
 */
export async function evaluateBoundExpressionViaCdp(
  tabId: number,
  expression: string,
  expectedDocId?: string,
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
    // Deadline: stops WAITING and releases the tab lock (see
    // EVALUATE_DEADLINE_MS) instead of blocking the queue forever on a promise
    // that never settles. terminateExecution is a best-effort hint — the
    // page-side expression may keep running past the deadline, but it can
    // never overlap the next tab command: the lock is released only after we
    // stop waiting, and a later command re-validates the document.
    let reportTimeout: (() => void) | undefined
    const timeoutOutcome = new Promise<{ ok: false; error: string }>((resolve) => {
      reportTimeout = () =>
        resolve({
          ok: false,
          error: `CSP fallback evaluation timed out after ${EVALUATE_DEADLINE_MS}ms (page promise never settled); the tab lock has been released.`,
        })
    })
    const deadline = setTimeout(() => {
      void sendCommand(tabId, 'Runtime.terminateExecution')
        .catch(() => {})
        .then(() => reportTimeout?.())
    }, EVALUATE_DEADLINE_MS)
    try {
      const evaluation = (async () => {
        if (expectedDocId !== undefined) {
          // Document-identity check at evaluation time (not just a URL check
          // before): reads the runner's per-document docId in the tab's
          // CURRENT MAIN world. The runner preserves `__cwPageAction` across
          // re-injection but generates a fresh docId per document, so a
          // URL-equal replacement document fails this check.
          const identity = await sendCommand<{
            result?: { value?: unknown }
          }>(tabId, 'Runtime.evaluate', {
            expression:
              '(() => { const r = window.__cwPageAction; return r && r.ready ? (r.docId ?? null) : null })()',
            returnByValue: true,
            awaitPromise: false,
          })
          if (identity.result?.value !== expectedDocId) {
            return {
              ok: false as const,
              error:
                'CSP_FALLBACK_STALE_DOCUMENT: the tab navigated or reloaded after the CSP compile failure; the expression was NOT run in the new document. Retry the action if still needed.',
            }
          }
        }
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
          if (desc) return { ok: false as const, error: desc }
          const thrown = d.exception
            ? remoteObjectToValue(d.exception as Parameters<typeof remoteObjectToValue>[0])
            : undefined
          if (thrown !== undefined) {
            return {
              ok: false as const,
              error: stringifyThrownValue(thrown, d.text ?? 'Page execution failed'),
            }
          }
          return { ok: false as const, error: d.text ?? 'Page execution failed' }
        }
        return { ok: true as const, result: remoteObjectToValue(response.result ?? {}) }
      })()
      // If the deadline wins the race, the losing `evaluation` promise may
      // later reject (detached debugger, etc.) — pre-attach a handler so that
      // cannot surface as an unhandled rejection.
      evaluation.catch(() => {})
      return await Promise.race([evaluation, timeoutOutcome])
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    } finally {
      inFlight = false
      clearInterval(heartbeat)
      clearTimeout(deadline)
    }
  })
}
