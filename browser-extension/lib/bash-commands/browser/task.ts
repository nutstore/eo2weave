import { sendCommand } from './cdp'
import { BrowserError } from './errors'

/** One deadline and cancellation source for queueing, waiting and CDP calls. */
export class BrowserTask {
  readonly controller = new AbortController()
  readonly signal = this.controller.signal
  tabId?: number
  private evaluating = 0
  private readonly timer: ReturnType<typeof setTimeout>
  private readonly canceled: Promise<never>
  private readonly forwardAbort: () => void
  private readonly parent?: AbortSignal

  constructor(timeout: number, parent?: AbortSignal) {
    this.parent = parent
    this.forwardAbort = () => this.controller.abort(parent?.reason ?? new Error('Browser command canceled'))
    this.canceled = new Promise((_, reject) => {
      this.signal.addEventListener('abort', () => {
        // Terminate before releasing the tab queue, so a later task is not killed.
        const terminate = this.tabId !== undefined && this.evaluating > 0
          ? sendCommand(this.tabId, 'Runtime.terminateExecution') : Promise.resolve()
        void terminate.then(() => reject(this.signal.reason), error => reject(new BrowserError('Could not terminate page execution', { cause: String(error) })))
      }, { once: true })
    })
    void this.canceled.catch(() => {})
    this.timer = setTimeout(() => this.controller.abort(new Error(`Browser command timed out after ${timeout}ms`)), timeout)
    parent?.addEventListener('abort', this.forwardAbort, { once: true })
    if (parent?.aborted) this.forwardAbort()
  }
  check() { this.signal.throwIfAborted() }
  async wait<T>(promise: Promise<T>): Promise<T> {
    this.check()
    try {
      const result = await Promise.race([promise, this.canceled])
      if (this.signal.aborted) return await this.canceled
      return result
    } catch (error) {
      // CDP may report the interrupted evaluation before acknowledging
      // terminateExecution. Keep the queue occupied until that acknowledgement.
      if (this.signal.aborted) return await this.canceled
      throw error
    }
  }
  async send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    this.check()
    if (this.tabId === undefined) throw new Error('No browser tab assigned')
    const evaluation = method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn'
    if (evaluation) this.evaluating++
    try { return await this.wait(sendCommand<T>(this.tabId, method, params)) }
    finally { if (evaluation) this.evaluating-- }
  }
  async evaluate(expression: string, byValue = true) {
    return this.result(await this.send('Runtime.evaluate', { expression, returnByValue: byValue, awaitPromise: true }), byValue)
  }
  async call(objectId: string, fn: string, args: unknown[] = [], byValue = true) {
    return this.result(await this.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: fn, arguments: args.map(value => ({ value })), returnByValue: byValue, awaitPromise: true,
    }), byValue)
  }
  private result(response: any, byValue: boolean) {
    if (response.exceptionDetails) {
      const d = response.exceptionDetails
      throw new BrowserError(d.exception?.description ?? d.text ?? 'Page execution failed', d)
    }
    return byValue ? response.result?.value : response.result
  }
  async poll<T>(attempt: () => Promise<T | undefined>): Promise<T> {
    for (;;) {
      this.check()
      const result = await attempt()
      if (result !== undefined) return result
      await this.wait(new Promise<void>(resolve => setTimeout(resolve, 80)))
    }
  }
  dispose() { clearTimeout(this.timer); this.parent?.removeEventListener('abort', this.forwardAbort) }
}
