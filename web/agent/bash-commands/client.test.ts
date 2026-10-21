import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bashExec, createBashWorkerClient, destroyBashWorker } from '@/agent/tools/bash-worker/client'
import type { FromWorkerMessage, ToWorkerMessage, WorkerExecRequest } from '@/agent/tools/bash-worker/protocol'
import { bashCommandRegistry } from './registry'

vi.mock('@/agent/tools/bash-worker/vfs-rpc-handler', () => ({
  handleVfsRpc: vi.fn(),
}))

class MockWorker {
  static instances: MockWorker[] = []
  onmessage?: (event: MessageEvent<FromWorkerMessage>) => void
  onerror?: () => void
  onmessageerror?: () => void
  messages: ToWorkerMessage[] = []
  terminate = vi.fn()
  constructor() { MockWorker.instances.push(this) }
  postMessage(message: ToWorkerMessage) { this.messages.push(message) }
  emit(message: FromWorkerMessage) { this.onmessage?.({ data: message } as MessageEvent<FromWorkerMessage>) }
  exec() { return this.messages.find(message => message.type === 'exec') as WorkerExecRequest }
  finish() { this.emit({ type: 'exec-result', requestId: this.exec().requestId, ok: true, stdout: 'done' }) }
}

const config = {
  workspaceId: null, projectId: null, currentAgentId: null,
  readOnly: false, restrictAgentCoreFiles: false,
}
const opts = { command: 'sample', rootNames: [], readOnly: false, restrictAgentCoreFiles: false, timeoutMs: 10000 }
const cleanups: (() => void)[] = []
function register(invoke: Parameters<typeof bashCommandRegistry.registerCommand>[0]['invoke']) {
  cleanups.push(bashCommandRegistry.registerCommand({
    isAlive: async () => true,
    manifest: { name: 'sample', description: 'Sample', manual: 'sample' }, invoke,
  }))
}
function current() { return MockWorker.instances.at(-1)! }
function call(worker: MockWorker) {
  worker.emit({ type: 'command', rpcId: 1, requestId: worker.exec().requestId, name: 'sample', input: { args: ['中文'], stdin: '你好' } })
}

beforeEach(() => {
  MockWorker.instances = []
  vi.stubGlobal('Worker', MockWorker)
})
afterEach(() => {
  destroyBashWorker()
  for (const cleanup of cleanups.splice(0)) cleanup()
  vi.unstubAllGlobals()
})

describe('external commands across the Bash worker boundary', () => {
  it('dispatches only args/stdin to the captured registration and returns a validated result', async () => {
    const invoke = vi.fn(async () => ({ stdout: '原始', stderr: '', exitCode: 0 }))
    register(invoke)
    const running = bashExec(opts, config)
    const worker = current()
    register(async () => ({ stdout: 'replacement', stderr: '', exitCode: 0 }))
    expect(worker.exec().externalCommands).toEqual(['sample'])
    call(worker)
    await vi.waitFor(() => expect(worker.messages).toContainEqual({
      type: 'command-result', rpcId: 1, result: { stdout: '原始', stderr: '', exitCode: 0 },
    }))
    expect(invoke).toHaveBeenCalledWith({ args: ['中文'], stdin: '你好' })
    worker.finish()
    await running
  })

  it('returns malformed plugin results as a shell error', async () => {
    register(async () => ({ stdout: undefined, stderr: '', exitCode: 0 }) as never)
    const running = bashExec(opts, config)
    const worker = current()
    call(worker)
    await vi.waitFor(() => expect(worker.messages.some(message =>
      message.type === 'command-result' && message.result.exitCode === 1,
    )).toBe(true))
    worker.finish()
    await running
  })

  it('does not register external commands in the read-only sandbox', async () => {
    const invoke = vi.fn()
    register(invoke)
    const running = bashExec({ ...opts, readOnly: true }, { ...config, readOnly: true })
    const worker = current()
    expect(worker.exec().externalCommands).toEqual([])
    call(worker)
    await vi.waitFor(() => expect(worker.messages.some(message =>
      message.type === 'command-result' && message.result.exitCode === 127,
    )).toBe(true))
    expect(invoke).not.toHaveBeenCalled()
    worker.finish()
    await running
  })

  it('refuses a disconnected command even if its page object remains', async () => {
    const invoke = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    cleanups.push(bashCommandRegistry.registerCommand({
      manifest: { name: 'sample', description: 'Sample', manual: 'sample' },
      invoke, isAlive: async () => false,
    }))
    const running = bashExec(opts, config)
    const worker = current()
    call(worker)
    await vi.waitFor(() => expect(worker.messages).toContainEqual({
      type: 'command-result', rpcId: 1,
      result: { stdout: '', stderr: 'sample: command unavailable\n', exitCode: 127 },
    }))
    expect(invoke).not.toHaveBeenCalled()
    expect(bashCommandRegistry.snapshot().has('sample')).toBe(false)
    worker.finish()
    await running
  })

  it('does not start invoke if stopped during the liveness probe', async () => {
    let resolve!: (alive: boolean) => void
    const invoke = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 }))
    cleanups.push(bashCommandRegistry.registerCommand({
      manifest: { name: 'sample', description: 'Sample', manual: 'sample' },
      invoke, isAlive: () => new Promise(r => { resolve = r }),
    }))
    const controller = new AbortController()
    const running = bashExec({ ...opts, abortSignal: controller.signal }, config)
    const stopped = expect(running).rejects.toThrow('aborted')
    call(current())
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    controller.abort()
    await stopped
    resolve(true)
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('emits the page lifecycle cancellation event when Bash is stopped', async () => {
    register(() => new Promise(() => {}))
    const canceled = vi.fn()
    window.addEventListener('creatorweave:bash-cancel', canceled)
    try {
      const controller = new AbortController()
      const running = bashExec({ ...opts, abortSignal: controller.signal }, config)
      const stopped = expect(running).rejects.toThrow('aborted')
      controller.abort()
      await stopped
      expect(canceled).toHaveBeenCalledTimes(1)
    } finally { window.removeEventListener('creatorweave:bash-cancel', canceled) }
  })

  it('rejects on stop and never posts a late plugin result to a new worker', async () => {
    let resolve!: (result: { stdout: string; stderr: string; exitCode: number }) => void
    register(() => new Promise(r => { resolve = r }))
    const controller = new AbortController()
    const running = bashExec({ ...opts, abortSignal: controller.signal }, config)
    const stopped = expect(running).rejects.toThrow('aborted')
    const oldWorker = current()
    call(oldWorker)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    controller.abort()
    await stopped
    const next = bashExec(opts, config)
    const newWorker = current()
    resolve({ stdout: 'late', stderr: '', exitCode: 0 })
    await Promise.resolve()
    await Promise.resolve()
    expect(newWorker.messages.some(message => message.type === 'command-result')).toBe(false)
    expect(oldWorker.messages.some(message => message.type === 'command-result')).toBe(false)
    newWorker.finish()
    await next
  })
})

describe('concurrent Bash callers', () => {
  it('runs an adapter Bash lane while the outer shell waits, with scoped cancellation', async () => {
    const adapter = createBashWorkerClient()
    let innerWorker: MockWorker
    register(async () => {
      const result = adapter.exec({ ...opts, command: 'inner' }, { ...config, workspaceId: 'adapter' })
      innerWorker = current()
      innerWorker.finish()
      return { stdout: (await result).stdout, stderr: '', exitCode: 0 }
    })
    const canceled: unknown[] = []
    const observe = (event: Event) => canceled.push((event as CustomEvent).detail)
    window.addEventListener('creatorweave:bash-cancel', observe)
    try {
      const outer = bashExec(opts, config)
      const outerWorker = current()
      call(outerWorker)
      await vi.waitFor(() => expect(outerWorker.messages).toContainEqual({
        type: 'command-result', rpcId: 1, result: { stdout: 'done', stderr: '', exitCode: 0 },
      }))
      expect(MockWorker.instances).toHaveLength(2)
      expect(canceled).toEqual([{ inputs: [] }])
      expect(outerWorker.terminate).not.toHaveBeenCalled()
      outerWorker.finish()
      await outer
      expect(canceled[1]).toMatchObject({ inputs: [{ args: ['中文'], stdin: '你好' }] })
    } finally { adapter.destroy(); window.removeEventListener('creatorweave:bash-cancel', observe) }
  })
  it('serializes execution slots and captured VFS contexts instead of replacing pending results', async () => {
    const first = bashExec(opts, config)
    const firstWorker = current()
    const second = bashExec({ ...opts, command: 'second' }, { ...config, workspaceId: 'other' })
    expect(MockWorker.instances).toHaveLength(1)
    expect(firstWorker.messages.filter(message => message.type === 'exec')).toHaveLength(1)
    firstWorker.finish()
    await first
    await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2))
    const secondWorker = current()
    expect(secondWorker.exec().command).toBe('second')
    expect(secondWorker.messages).toContainEqual(expect.objectContaining({ type: 'init', workspaceId: 'other' }))
    secondWorker.finish()
    await second
  })

  it('removes an aborted queued call without canceling the active browser command', async () => {
    const first = bashExec(opts, config)
    const worker = current()
    const controller = new AbortController()
    const queued = bashExec({ ...opts, abortSignal: controller.signal }, config)
    const canceled = expect(queued).rejects.toThrow('aborted')
    controller.abort()
    await canceled
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.finish()
    await first
    expect(worker.messages.filter(message => message.type === 'exec')).toHaveLength(1)
  })

  it('counts queue time in the deadline without terminating the active execution', async () => {
    const first = bashExec(opts, config)
    const worker = current()
    const queued = bashExec({ ...opts, timeoutMs: 10 }, config)
    await expect(queued).rejects.toThrow(/timed out|timeout/i)
    expect(worker.terminate).not.toHaveBeenCalled()
    worker.finish()
    await first
  })

  it('rejects both active and queued calls when the workspace worker is destroyed', async () => {
    const first = bashExec(opts, config)
    const queued = bashExec(opts, config)
    const stopped = Promise.all([expect(first).rejects.toThrow('destroyed'), expect(queued).rejects.toThrow('destroyed')])
    destroyBashWorker()
    await stopped
    expect(MockWorker.instances).toHaveLength(1)
  })
})
