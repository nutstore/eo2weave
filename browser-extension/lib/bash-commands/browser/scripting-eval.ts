import { evaluationFunction } from './evaluate'
import { BrowserError } from './errors'
import type { BrowserTask } from './task'

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
  const compile = new Function(`return (${fnSource})`) as () => (this: unknown) => Promise<unknown>
  return await compile().call(undefined)
}

type EvalOutcome = {
  ok?: boolean
  message?: string
  logs?: unknown[]
  result?: unknown
  exception?: unknown
}

/**
 * Evaluate a page function without attaching the debugger, so eval-style
 * package workflows never raise Chrome's "debugging started" banner. The
 * BrowserTask deadline still bounds the call — the page execution itself
 * cannot be interrupted without CDP, only abandoned.
 */
export async function evaluateViaScripting(task: BrowserTask, source: string): Promise<{ tabId: number; logs: unknown[]; result: unknown }> {
  const tabId = task.tabId!
  // Throws synchronously on an empty source, before any injection.
  const wrapper = evaluationFunction(source)
  let outcome: EvalOutcome | undefined
  try {
    const results = await task.wait(chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: runEvalWrapper,
      args: [wrapper],
    }))
    outcome = results?.[0]?.result as EvalOutcome | undefined
  } catch (error) {
    throw new BrowserError(error instanceof Error ? error.message : String(error), { tabId })
  }
  if (!outcome?.ok) {
    throw new BrowserError(outcome?.message ?? 'Page evaluation failed', {
      tabId, logs: outcome?.logs ?? [], exception: outcome?.exception ?? null,
    })
  }
  return { tabId, logs: outcome.logs ?? [], result: outcome.result }
}
