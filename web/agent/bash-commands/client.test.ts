import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bashExec, destroyBashWorker } from '@/agent/tools/bash-worker/client'
import type { FromWorkerMessage, ToWorkerMessage, WorkerExecRequest } from '@/agent/tools/bash-worker/protocol'
import { bashCommandRegistry } from './registry'

vi.mock('@/agent/tools/bash-worker/vfs-rpc-handler', () => ({
  handleVfsRpc: vi.fn(), handleAgentRpc: vi.fn(),
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
