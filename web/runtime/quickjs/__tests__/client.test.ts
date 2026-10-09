import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeCode } from '../client'
import { DEFAULT_LIMITS } from '@creatorweave/quickjs-runtime'

class WorkerMock {
  static instances: WorkerMock[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  terminate = vi.fn()
  postMessage = vi.fn()
  constructor() { WorkerMock.instances.push(this) }
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); WorkerMock.instances = [] })
const request = { code: 'return 1', setup: '', filename: 'test.js', limits: DEFAULT_LIMITS }
const bindings = { globals: {}, functions: {} }

describe('Worker client lifecycle', () => {
  it('rejects invalid syntax before creating a Worker', async () => {
    vi.stubGlobal('Worker', WorkerMock)
    expect(await executeCode({ ...request, code: 'const x = ;' }, bindings, new AbortController().signal)).toMatchObject({ ok: false, error: { code: 'JS_PREFLIGHT_FAILED' } })
    expect(WorkerMock.instances).toHaveLength(0)
  })
  it('terminates an unresponsive Worker on cancellation', async () => {
    vi.stubGlobal('Worker', WorkerMock)
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    const abort = new AbortController()
    const execution = executeCode(request, bindings, abort.signal)
    abort.abort()
    expect(await execution).toMatchObject({ ok: false, error: { code: 'JS_CANCELED' } })
    expect(WorkerMock.instances[0].terminate).toHaveBeenCalledOnce()
  })
  it('enforces watchdog timeout without cooperation from the Worker', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('Worker', WorkerMock)
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    const execution = executeCode(request, bindings, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.timeoutMs + 5001)
    expect(await execution).toMatchObject({ ok: false, error: { code: 'JS_TIMEOUT' } })
    expect(WorkerMock.instances[0].terminate).toHaveBeenCalledOnce()
  })
})
