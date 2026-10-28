import { ensureAttached } from './cdp'
import { evaluationFunction, evaluatePage } from './evaluate'
import { isCspCompileRejection } from './csp-rejection'
import { BrowserError } from './errors'
import type { BrowserTask } from './task'

type EvalOutcome = {
  ok?: boolean
  message?: string
  logs?: unknown[]
  result?: unknown
  exception?: unknown
  compileError?: boolean
}

/**
 * Compiles and runs the evaluationFunction wrapper in the page's MAIN world.
 *
 * `new Function` here is subject to the page's CSP (strict-CSP pages reject
 * the compile, which surfaces as a failed evaluation), while the wrapper
 * itself never touches eval: chrome.scripting serializes `func` mechanically,
 * so no extension-side eval is involved. Await inside the injected function —
 * executeScript serializes results with structured clone, which cannot carry
 * a pending Promise.
 */
async function runEvalWrapper(fnSource: string): Promise<unknown> {
  try {
    const factory = new Function(`return (${fnSource})`) as () => (this: unknown) => Promise<unknown>
    const fn = factory()
    return await fn.call(undefined)
  } catch (error) {
    // The compile failed before any user code ran — tag it so the caller can
    // tell a CSP-blocked compile apart from the user function's own failure
    // (whose message may coincidentally match CSP patterns) and only then
    // re-run the function through the CDP fallback.
    return { ok: false, compileError: true, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Does this executeScript rejection mean the page's CSP refused the MAIN-world
 * wrapper compile, so the injected function provably never ran?
 *
 * Only reached when chrome.scripting.executeScript itself rejected — i.e. the
 * injection failed at the extension boundary. Even then, some Chrome versions
 * surface unrelated injection errors (the classic "Cannot access a chrome://
 * URL" family) with messages that cannot be told apart from a CSP refusal by
 * shape, so the message prefix is matched strictly against Chrome's documented
 * Function-constructor CSP wording rather than loose keyword containment.
 */
export function isCspRejection(message: string): boolean {
  return isCspCompileRejection(message)
}

/**
 * Evaluate a page function without attaching the debugger, so eval-style
 * package workflows never raise Chrome's "debugging started" banner.
 *
 * Strict-CSP pages (no 'unsafe-eval') reject the MAIN-world function compile;
 * those fall back to the CDP evaluation path, which injects through the
 * debugger and is not CSP-bound. That attaches the debugger (and raises the
 * banner) — the price of evaluating at all on such pages. The scripting
 * attempt leaves no tab state behind (executeScript is stateless from the
 * extension's perspective), and the CDP fallback cleans up via the normal
 * idle auto-detach, so the result is identical either way.
 *
 * Timeout/cancellation: there is no way to interrupt an injected executeScript
 * without a debugger session. Instead of abandoning a still-running page
 * function while the tab lock is released, we hold the lock until the
 * execution settles (or the extension's own settle deadline expires), then
 * report the timeout. The page function may run past the task deadline, but it
 * can never overlap the next tab command.
 */
export async function evaluateViaScripting(task: BrowserTask, source: string): Promise<Awaited<ReturnType<typeof evaluatePage>>> {
  const tabId = task.tabId!
  // Throws synchronously on an empty source, before any injection.
  const wrapper = evaluationFunction(source)
  let outcome: EvalOutcome | undefined
  let scriptingError: Error | undefined
  try {
    const results = await task.wait(chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runEvalWrapper,
      args: [wrapper],
    }))
    outcome = results?.[0]?.result as EvalOutcome | undefined
  } catch (error) {
    scriptingError = error instanceof Error ? error : new Error(String(error))
    const message = scriptingError.message
    // Fallback only on an executeScript rejection: the injection itself failed
    // at the extension boundary, so the page function provably never ran and
    // re-running it via CDP cannot duplicate any of its effects. The strict
    // CSP prefix additionally excludes unrelated injection errors (blocked
    // chrome:// targets, disconnected tabs, other extension errors) that must
    // surface as failures, not trigger a second execution attempt.
    if (isCspRejection(message)) {
      // The scripting attempt is stateless (nothing to clean up in the tab),
      // but the CDP path needs an attached debugger — the no-ref branch
      // normally never attaches, so ensure our session exists first.
      await ensureAttached(tabId)
      return await evaluatePage(task, source)
    }
  }
  if (!outcome?.ok) {
    // A CSP rejection also surfaces as a failed outcome carrying the page's
    // own EvalError message rather than an executeScript rejection. Only the
    // tagged compile failure (raised before any user code ran) is safe to
    // re-run: a message from the user function itself could coincide with
    // CSP patterns, and re-running it would double its external effects.
    if (outcome?.compileError === true) {
      await ensureAttached(tabId)
      return await evaluatePage(task, source)
    }
  }
  if (scriptingError) throw new BrowserError(scriptingError.message, { tabId })
  if (!outcome?.ok) {
    throw new BrowserError(outcome?.message ?? 'Page evaluation failed', {
      tabId, logs: outcome?.logs ?? [], exception: outcome?.exception ?? null,
    })
  }
  return { tabId, logs: outcome.logs ?? [], result: outcome.result }
}

