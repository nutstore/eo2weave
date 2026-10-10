import { BrowserError } from './errors'
import type { BrowserTask } from './task'

/** Source insertion keeps console lexical without eval(), CSP changes or page-global patches. */
export function evaluationFunction(source: string): string {
  if (!source.trim()) throw new Error('eval requires a page function or stdin')
  return `async function() {
    const entries = [];
    const format = value => {
      if (typeof value === 'string') return value;
      const seen = new WeakSet();
      return JSON.stringify(value, (_key, item) => {
        if (typeof item === 'bigint' || typeof item === 'symbol') return String(item);
        if (typeof item === 'function') return '[Function ' + (item.name || 'anonymous') + ']';
        if (item instanceof Error) return item.name + ': ' + item.message + (item.stack ? ' | ' + item.stack : '');
        if (item && typeof item === 'object') { if (seen.has(item)) return '[Circular]'; seen.add(item); }
        return item;
      }) ?? String(value);
    };
    const log = (level, args) => entries.push('[' + level + '] ' + args.map(value => {
      try { return format(value); } catch { return '[UnserializableValue]'; }
    }).join(' '));
    const console = {
      log: (...args) => log('log', args), info: (...args) => log('info', args),
      debug: (...args) => log('debug', args), warn: (...args) => log('warn', args),
      error: (...args) => log('error', args), trace: (...args) => log('trace', args.length ? args : [new Error('Trace')]),
      assert: (value, ...args) => { if (!value) log('assert', args.length ? args : ['Assertion failed']); }
    };
    try {
      const fn = (${source.trim().replace(/;+$/, '')}\n);
      if (typeof fn !== 'function') throw new Error('eval expects a page function, for example () => document.title');
      log('result', [await fn(this)]);
      return { ok: true, buffer: entries.join('\\n') };
    } catch (error) {
      log('error', [error]);
      return { ok: false, message: error instanceof Error ? error.message : String(error), buffer: entries.join('\\n') };
    }
  }`
}

export async function evaluatePage(task: BrowserTask, source: string, objectId?: string) {
  const wrapper = evaluationFunction(source)
  const result = objectId ? await task.call(objectId, wrapper) : await task.evaluate(`(${wrapper}).call(undefined)`)
  if (!result?.ok) throw new BrowserError(result?.message ?? 'Page evaluation failed', { buffer: result?.buffer ?? '' })
  return { tabId: task.tabId, buffer: result.buffer }
}
