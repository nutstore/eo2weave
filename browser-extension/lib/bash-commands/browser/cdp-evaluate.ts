/// <reference types="chrome" />
import { ensureAttached, sendCommand, withTabLock, noteCdpActivity } from './cdp'

/**
 * Wall-clock deadline shared across one page-action request: the background
 * computes it from the CALLER's bridge timeout (sendToBridge, 300s from
 * request receipt) and hands it down through the queue-wait budget and the
 * CDP fallback, so no stage — including the fallback evaluation — can hold
 * the tab lock past the point its requester has already given up.
 *
 * Bounded wait applied to debugger callbacks (attach, terminateExecution)
 * that may simply never fire: an unbounded await would hold the tab lock
 * forever even though the deadline has passed.
 */
export const DEBUGGER_CALLBACK_TIMEOUT_MS = 15_000

/**
 * Resolve with `value` unless `p` settles first; resolves `value` on a `p`
 * win... i.e. returns the fallback `value` when the timeout fires, otherwise
 * `p`'s own settlement. Callers distinguish the timeout via a sentinel value.
 */
async function orTimeout<T>(p: Promise<T>, timeoutMs: number, value: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const fallback = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(value as T), timeoutMs)
  })
  try {
    return await Promise.race([p, fallback])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** True when the wall-clock deadline has passed. */
function isExpired(deadlineAt?: number): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt
}

export { isExpired as isCallerDeadlineExpired }

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
 * (NaN/Infinity/-0/BigInt) are returned in a tagged, JSON-safe form because
 * the extension-message bridge (`sendResponse` → JSON) would otherwise
 * corrupt or drop them.
 *
 * Stale-document guard: when the caller pins the frame identity that was live
 * at the compile failure (`expectedLoaderId` — the browser-provided frame
 * loader id from `Page.getFrameTree`), this run first re-reads the loader id
 * and refuses to evaluate on any mismatch (fail closed). The loader id is
 * browser-provided — page scripts can neither read it nor forge it, unlike a
 * runner token on `window` — it changes on every cross-document navigation or
 * reload, and stays stable across same-document history changes (pushState /
 * hash), so a same-document SPA navigation does not abort the fallback while
 * a replacement document always does.
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

type RemoteObjectLike = {
  value?: unknown
  unserializableValue?: string
  subtype?: string
  description?: string
}

type FrameTreeResponse = {
  frameTree?: { frame?: { loaderId?: string } }
}

/** Map a CDP RemoteObject to a structured-clone-safe JS value. */
function remoteObjectToValue(obj: RemoteObjectLike): unknown {
  // CDP reports values it cannot serialize (NaN, Infinity, -0, BigInt) via
  // `unserializableValue` and omits `value`. Parse the textual form back.
  // (Only used for thrown-value MESSAGE formatting — the result path must use
  // the tagged JSON-safe form below, because the extension-message bridge
  // JSON-serializes and would corrupt these native values.)
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
 * `fallback` wins only when String() itself throws.
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
    // `throw undefined` must surface as the string "undefined" — matching the
    // MAIN-world path, where String(err) renders the thrown value verbatim.
    return String(thrown)
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
  // PLAIN FUNCTION form, not an arrow: `new Function(body)` compiles the body
  // as a non-arrow function, so the MAIN-world path gives user code its own
  // `arguments` object and dynamic `this` (global in sloppy mode, undefined
  // in strict mode). An arrow wrapper has neither — it would break expressions
  // referencing `arguments` and change strict-mode `this` semantics on the
  // CSP-fallback path. The wrapper is still async (it awaits the IIFE's
  // promise via awaitPromise) and returns the body's completion value.
  return `(async function () {\n${expression}\n})()`
}

/**
 * Read the tab's current frame loader id via the debugger. This is the
 * browser-provided document identity used by the stale-document guard: page
 * scripts cannot read or forge it, it changes on every cross-document
 * navigation/reload, and it is stable across same-document history changes.
 * Returns null when the frame tree carries no usable loader id; transport
 * errors propagate to the caller (fail closed).
 */
async function queryFrameLoaderId(tabId: number): Promise<string | null> {
  const tree = await sendCommand<FrameTreeResponse>(tabId, 'Page.getFrameTree', {})
  const loaderId = tree?.frameTree?.frame?.loaderId
  return typeof loaderId === 'string' && loaderId ? loaderId : null
}

/**
 * Capture the frame loader id for the stale-document guard. Called by the
 * background immediately after the compile failure so the evaluator can
 * re-verify document identity at execution time. Returns null when the tab
 * cannot be inspected (gone, restricted, transport error) — the caller must
 * treat null as a mismatch (fail closed).
 *
 * BOUNDED: the caller invokes this while HOLDING the tab-op lock, so an
 * attach or Page.getFrameTree callback that never fires would block every
 * later command on the tab forever. Each stage is raced against
 * DEBUGGER_CALLBACK_TIMEOUT_MS (the same bound the evaluator applies to its
 * own attach), after which the capture gives up and returns null — which the
 * caller treats as a mismatch (fail closed), never as a green light.
 */
export async function captureFrameLoaderId(tabId: number, timeoutMs: number = DEBUGGER_CALLBACK_TIMEOUT_MS): Promise<string | null> {
  try {
    const captured = (async () => {
      await ensureAttached(tabId)
      return await queryFrameLoaderId(tabId)
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const capped = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    try {
      return await Promise.race([captured, capped])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  } catch {
    return null
  }
}

async function runBoundEvaluation(
  tabId: number,
  expression: string,
  expectedLoaderId?: string,
  deadlineAt?: number,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  // An already-expired caller deadline must never reach the page: neither
  // the attach nor any command below is dispatched, and the lock acquired
  // for this run is released immediately. (The evaluateDeadlineMs === 0
  // timer below is only a backstop for the boundary race — this check is
  // the authoritative gate.)
  if (isExpired(deadlineAt)) {
    return {
      ok: false,
      error: 'CSP fallback evaluation aborted: the caller\'s deadline had already expired; nothing was dispatched to the tab.',
    }
  }
  // Bounded attach: a debugger attach callback that never fires must not
  // hold the tab lock forever — cap the wait so the deadline machinery
  // below always gets a chance to run and release the lock.
  let attachTimer: ReturnType<typeof setTimeout> | undefined
  const attachWon = await Promise.race([
    ensureAttached(tabId).then(() => true as const),
    new Promise<false>((resolve) => {
      attachTimer = setTimeout(() => resolve(false), DEBUGGER_CALLBACK_TIMEOUT_MS)
    }),
  ])
  if (attachTimer !== undefined) clearTimeout(attachTimer)
  if (!attachWon) {
    return { ok: false, error: 'CSP fallback evaluation aborted: the debugger attach did not complete within the bounded wait; the tab lock is released.' }
  }
  // The evaluation may outlive any single idle window (awaitPromise on a
  // slow page promise). Keep the CDP session marked active for the whole
  // wait — sendCommand only notes activity at callback completion, so
  // without this the idle sweep would detach mid-evaluation and lose the
  // result.
  let inFlight = true
  const heartbeat = setInterval(() => {
    if (inFlight) noteCdpActivity(tabId)
  }, 10_000)
  // Deadline: stops WAITING instead of blocking the queue forever on a
  // promise that never settles. The tab lock is released only after
  // Runtime.terminateExecution was attempted AND its outcome confirmed (see
  // the deadline handler below) — releasing earlier would let later tab
  // commands overlap page work the deadline failed to stop.
  const evaluateDeadlineMs = deadlineAt !== undefined
    ? Math.max(0, deadlineAt - Date.now())
    : EVALUATE_DEADLINE_MS
  let reportTimeout: ((terminated: boolean) => void) | undefined
  const timeoutOutcome = new Promise<{ ok: false; error: string }>((resolve) => {
    reportTimeout = (terminated: boolean) =>
      resolve({
        ok: false,
        error: terminated
          ? `CSP fallback evaluation timed out after ${evaluateDeadlineMs}ms (page promise never settled); the evaluation was terminated and confirmed stopped before the tab lock was released.`
          : `CSP fallback evaluation timed out after ${evaluateDeadlineMs}ms (page promise never settled); termination could not be confirmed (debugger session gone — the evaluation cannot resume without it).`,
      })
  })
  // Fire the deadline handler no later than the shared deadline. When the
  // budget is already exhausted (evaluateDeadlineMs === 0) the timer fires
  // on the next macrotask — the termination attempt below still runs and is
  // awaited before the lock is released, so a stale evaluation (e.g. one
  // whose Runtime.evaluate dispatch was queued) is stopped, not leaked.
  let deadlineFired = false
  let terminationAcked: Promise<void> = Promise.resolve()
  const deadline = setTimeout(() => {
    deadlineFired = true
    const attempt = async (): Promise<boolean> => {
      try {
        // Bounded termination: the terminateExecution callback may stall;
        // race it against a cap so the deadline handler itself cannot hang.
        const acked = await orTimeout(
          sendCommand(tabId, 'Runtime.terminateExecution'),
          DEBUGGER_CALLBACK_TIMEOUT_MS,
          false,
        )
        return acked
      } catch {
        return false
      }
    }
    terminationAcked = (async () => {
      // One retry covers a transient transport error; a double failure means
      // the debugger detached, and with it the session the evaluation needs
      // to ever resume — release the lock in that case too.
      let terminated = await attempt()
      if (!terminated) {
        await new Promise((r) => setTimeout(r, 250))
        terminated = await attempt()
      }
      reportTimeout?.(terminated)
    })()
  }, evaluateDeadlineMs)
  try {
    const evaluation = (async () => {
      if (expectedLoaderId !== undefined) {
        // Document-identity check at evaluation time: re-read the
        // browser-provided frame loader id and refuse on any mismatch. A
        // reload or same-URL navigation yields a NEW loader id (fail closed),
        // while pushState/hash changes keep it (same document — allowed).
        // Transport errors here also fail closed via the catch below.
        const currentLoaderId = await queryFrameLoaderId(tabId)
        // The loader query may resolve long after the caller timed out (a
        // stalled Page.getFrameTree that finally completes). Once the
        // deadline has fired, the continuation must NOT dispatch
        // Runtime.evaluate: the expression would run after its requester is
        // gone and could overlap a later tab operation.
        if (deadlineFired) {
          return {
            ok: false as const,
            error: 'CSP fallback evaluation aborted: the caller\'s deadline expired while the frame-identity check was pending; Runtime.evaluate was NOT dispatched.',
          }
        }
        if (currentLoaderId === null || currentLoaderId !== expectedLoaderId) {
          return {
            ok: false as const,
            error:
              'CSP_FALLBACK_STALE_DOCUMENT: the tab navigated or reloaded after the CSP compile failure; the expression was NOT run in the new document. Retry the action if still needed.',
          }
        }
      }
      if (deadlineFired) {
        return {
          ok: false as const,
          error: 'CSP fallback evaluation aborted: the caller\'s deadline expired before Runtime.evaluate was dispatched.',
        }
      }
      const response = await sendCommand<{
        result?: RemoteObjectLike
        exceptionDetails?: {
          text?: string
          exception?: RemoteObjectLike
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
        // Detect the throw via exception-details PRESENCE, never via the
        // converted value: `throw undefined` converts to undefined and would
        // otherwise fall through to the generic CDP text.
        if (d.exception === undefined) {
          return { ok: false as const, error: d.text ?? 'Page execution failed' }
        }
        const thrown = remoteObjectToValue(d.exception)
        return {
          ok: false as const,
          error: stringifyThrownValue(thrown, d.text ?? 'Page execution failed'),
        }
      }
      const remote = response.result ?? {}
      if (remote.unserializableValue !== undefined) {
        // The extension-message bridge JSON-serializes this result
        // (sendResponse → chrome.runtime → postMessage): native NaN/±Infinity
        // would be coerced to null, -0 to 0, and BigInt would make
        // sendResponse throw entirely. Pass the value in a tagged JSON-safe
        // form instead — callers/agents see exactly what came back. Nested
        // occurrences inside objects are already flattened to null by CDP's
        // own returnByValue serialization, before this boundary.
        return { ok: true as const, result: { __unserializableValue: remote.unserializableValue } }
      }
      return { ok: true as const, result: remoteObjectToValue(remote) }
    })()
    // If the deadline wins the race, the losing `evaluation` promise may
    // later reject (detached debugger, etc.) — pre-attach a handler so that
    // cannot surface as an unhandled rejection.
    evaluation.catch(() => {})
    const raced = await Promise.race([evaluation, timeoutOutcome])
    // LATE-TERMINATION LOCK HOLD: once the deadline has fired, the
    // termination attempt (with its retry) may still be in flight even if
    // the evaluation settled first. Runtime.terminateExecution targets the
    // CURRENT or NEXT execution on the debuggee, so releasing the tab lock
    // while it is unacknowledged could let it interrupt the NEXT page
    // action's executeScript or evaluation. Await the termination outcome
    // (bounded by DEBUGGER_CALLBACK_TIMEOUT_MS inside the handler) before
    // returning — the caller releases the lock only after this resolves.
    await terminationAcked
    return raced
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    inFlight = false
    clearInterval(heartbeat)
    clearTimeout(deadline)
  }
}

/**
 * Evaluate an expression in the page's MAIN world through the CDP debugger
 * path, serialized on the per-tab operation lock. When `expectedLoaderId` is
 * provided, the evaluation only runs if the tab's CURRENT frame loader id
 * still matches — a reload or same-URL navigation fails closed instead of
 * executing the stale expression in the replacement document.
 * `deadlineAt` is the caller's absolute wall-clock deadline (epoch ms): the
 * evaluation budget shrinks to the caller's remaining time instead of
 * restarting a fresh {@link EVALUATE_DEADLINE_MS} window that would hold the
 * tab lock long after the requester has timed out.
 */
export async function evaluateBoundExpressionViaCdp(
  tabId: number,
  expression: string,
  expectedLoaderId?: string,
  deadlineAt?: number,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  return withTabLock(tabId, () => runBoundEvaluation(tabId, expression, expectedLoaderId, deadlineAt), deadlineAt !== undefined ? { maxQueueWaitMs: Math.max(0, deadlineAt - Date.now()) } : undefined)
}

/**
 * Unlocked variant of {@link evaluateBoundExpressionViaCdp} for callers that
 * already hold the per-tab operation lock (the background page-action handler
 * serializes the whole executeScript + fallback flow under one lock — nesting
 * withTabLock here would deadlock the queue).
 */
export async function evaluateBoundExpressionViaCdpUnlocked(
  tabId: number,
  expression: string,
  expectedLoaderId?: string,
  deadlineAt?: number,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  return runBoundEvaluation(tabId, expression, expectedLoaderId, deadlineAt)
}
