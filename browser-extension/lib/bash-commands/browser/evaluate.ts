import { BrowserError } from './errors'
import type { BrowserTask } from './task'

/** Source insertion keeps console lexical without eval(), CSP changes or page-global patches. */
export function evaluationFunction(source: string): string {
  if (!source.trim()) throw new Error('eval requires a page function or stdin')
  return `async function() {
    const logs = [];
    const serialize = value => {
      try {
        const ancestors = [];
        return JSON.parse(JSON.stringify(value, function (_key, item) {
          if (typeof item === 'undefined') return null;
          if (typeof item === 'bigint' || typeof item === 'symbol') return String(item);
          if (typeof item === 'function') return '[Function ' + (item.name || 'anonymous') + ']';
          if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
          if (item && typeof item === 'object') {
            while (ancestors.length && ancestors[ancestors.length - 1] !== this) ancestors.pop();
            if (ancestors.includes(item)) return '[Circular]';
            ancestors.push(item);
          }
          return item;
        }));
      } catch { return '[UnserializableValue]'; }
    };
    const log = (level, args) => logs.push({ level, args: args.map(serialize) });
    const console = {
      log: (...args) => log('log', args), info: (...args) => log('info', args),
      debug: (...args) => log('debug', args), warn: (...args) => log('warn', args),
      error: (...args) => log('error', args), trace: (...args) => log('trace', args.length ? args : [new Error('Trace')]),
      assert: (value, ...args) => { if (!value) log('assert', args.length ? args : ['Assertion failed']); }
    };
    try {
      const fn = (${source.trim().replace(/;+$/, '')}\n);
      if (typeof fn !== 'function') throw new Error('eval expects a page function, for example () => document.title');
      const result = serialize(await fn(this));
      return { ok: true, logs, result };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error), logs, exception: serialize(error) };
    }
  }`
}

export async function evaluatePage(task: BrowserTask, source: string, objectId?: string) {
  const wrapper = evaluationFunction(source)
  const result = objectId ? await task.call(objectId, wrapper) : await task.evaluate(`(${wrapper}).call(undefined)`)
  if (!result?.ok) throw new BrowserError(result?.message ?? 'Page evaluation failed', { tabId: task.tabId, logs: result?.logs ?? [], exception: result?.exception ?? null })
  return { tabId: task.tabId, logs: result.logs, result: result.result }
}
