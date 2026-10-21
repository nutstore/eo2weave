/**
 * BashWorkerClient — main-thread manager for the bash Web Worker.
 *
 * Responsibilities:
 * 1. Lazy-create an isolated worker per client, reused across its exec calls.
 * 2. Send `init` + `exec` messages and await responses.
 * 3. Enforce wall-clock timeout via `worker.terminate()` (the ONLY way to
 *    truly interrupt a CPU-bound bash interpreter — Promise.race can't).
 * 4. Wire VFS RPC: listen for worker `vfs` requests, dispatch to
 *    `handleVfsRpc`, send back `vfs-result`.
 * 5. Support AbortSignal (user "stop") — also via terminate.
 *
 * After terminate, the worker is destroyed; the next exec call recreates it.
 */

import { bashCommandRegistry, type ExternalBashCommand } from '@/agent/bash-commands/registry'

import type {
  ToWorkerMessage,
  FromWorkerMessage,
  WorkerExecRequest,
  WorkerExecResponse,
  CommandRpcRequest,
  CommandRpcResponse,
  VfsRpcRequest,
  VfsRpcResponse,
  WorkerInitMessage,
} from './protocol'
import { handleVfsRpc, type VfsRpcHandlerConfig } from './vfs-rpc-handler'
import { ToolTimeoutError } from '../tool-utils'
import { isSubagentPermissionDenied, SUBAGENT_PERMISSION_DENIED } from '../agent-file-protection'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BashExecOptions {
  command: string
  cwd?: string
  rootNames: string[]
  readOnly: boolean
  restrictAgentCoreFiles: boolean
  timeoutMs: number
  abortSignal?: AbortSignal
}

export interface BashExecResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
  stdoutKind?: 'text' | 'bytes'
  elapsedMs: number
}

export interface BashWorkerClient {
  exec(opts: BashExecOptions, handlerConfig: VfsRpcHandlerConfig): Promise<BashExecResult>
  destroy(): void
}

const activeClients = new Set<BashWorkerClient>()

/** Adapters need independent execution lanes: their caller may itself be Bash. */
export function createBashWorkerClient(): BashWorkerClient {
  // ---------------------------------------------------------------------------
  // Client state
  // ---------------------------------------------------------------------------

  /** Each client owns its worker, pending result and VFS context. */
  let worker: Worker | null = null
  let currentInit: WorkerInitMessage | null = null

  /**
   * The most recent handler config, updated on every exec call.
   *
   * IMPORTANT: The worker's `onmessage` handler reads from this mutable
   * variable (not a closure capture) so that VFS RPC requests always use
   * the LATEST config — even when this client's worker is reused across
   * exec calls with different `readOnly`, `restrictAgentCoreFiles`,
   * `directoryHandle`, or `onWorkspacePathsChanged` values.
   *
   * Without this, Plan-mode reads after Act-mode calls would reuse the
   * stale `readOnly: false` config, defeating the defense-in-depth guard
   * on the main thread.
   */
  let activeHandlerConfig: VfsRpcHandlerConfig | null = null

  /** Pending exec — only one at a time within this client. */
  let pendingExec: {
    requestId: number
    commands: Map<string, ExternalBashCommand>
    inputs: Set<{ args: string[]; stdin: string }>
    resolve: (resp: BashExecResult) => void
    reject: (err: Error) => void
  } | null = null

  let requestIdCounter = 0

  // ---------------------------------------------------------------------------
  // Worker lifecycle
  // ---------------------------------------------------------------------------

  function ensureWorker(handlerConfig: VfsRpcHandlerConfig): Worker {
    // Always update activeHandlerConfig so the worker's onmessage closure
    // (set once at creation time) reads the latest config on every VFS RPC.
    activeHandlerConfig = handlerConfig

    if (worker && currentInit && isSameInit(currentInit, handlerConfig)) {
      return worker
    }
    // Context changed (or first run) — recreate
    if (worker) {
      worker.terminate()
      worker = null
    }

    // Create the module worker through a statically analyzable URL so Next's
    // webpack build emits worker.ts and its dependencies as a separate chunk.
    activeClients.add(client)
    worker = createBashWorker()
    const createdWorker = worker

    worker.onmessage = (e: MessageEvent<FromWorkerMessage>) => {
      if (worker !== createdWorker) return
      const msg = e.data
      if (!msg) return
      if (msg.type === 'exec-result') {
        handleExecResponse(msg)
      } else if (msg.type === 'command') {
        void handleCommandRequest(msg, createdWorker)
      } else if (msg.type === 'vfs') {
        // Read the current invocation's config, not the initial worker config.
        // This ensures the latest handlerConfig (updated on each exec) is used.
        if (activeHandlerConfig) {
          void handleVfsRequest(msg, activeHandlerConfig)
        }
      }
    }

    worker.onerror = (e) => {
      notifyExternalCancellation()
      console.error('[bash-worker] error:', e.message)
      if (pendingExec) {
        pendingExec.reject(new Error(`bash worker error: ${e.message}`))
        pendingExec = null
      }
    }

    worker.onmessageerror = () => {
      console.error('[bash-worker] messageerror (serialization failure)')
    }

    // Send init
    const initMsg: WorkerInitMessage = {
      type: 'init',
      workspaceId: handlerConfig.workspaceId,
      projectId: handlerConfig.projectId,
      currentAgentId: handlerConfig.currentAgentId,
    }
    currentInit = initMsg
    worker.postMessage(initMsg as ToWorkerMessage)

    return worker
  }

  function isSameInit(init: WorkerInitMessage, config: VfsRpcHandlerConfig): boolean {
    return (
      init.workspaceId === config.workspaceId &&
      init.projectId === config.projectId &&
      init.currentAgentId === config.currentAgentId
    )
  }

  // ---------------------------------------------------------------------------
  // Exec
  // ---------------------------------------------------------------------------

  type QueuedExecution = {
    start(): void
    cancel(error: Error): void
  }
  const executionQueue: QueuedExecution[] = []
  let executing = false

  function drainExecutionQueue(): void {
    if (executing) return
    executionQueue.shift()?.start()
  }

  /** A client cannot share pendingExec or VFS context across calls.
   * Queued cancellation never terminates another caller's running worker.
   */
  function exec(opts: BashExecOptions, handlerConfig: VfsRpcHandlerConfig): Promise<BashExecResult> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + opts.timeoutMs
      const cleanup = () => {
        clearTimeout(timer)
        opts.abortSignal?.removeEventListener('abort', abort)
      }
      const entry: QueuedExecution = {
        cancel(error) {
          const index = executionQueue.indexOf(entry)
          if (index < 0) return
          executionQueue.splice(index, 1)
          cleanup()
          reject(error)
        },
        start() {
          cleanup()
          const remaining = deadline - Date.now()
          if (opts.abortSignal?.aborted || remaining <= 0) {
            reject(opts.abortSignal?.aborted ? new Error('bash execution aborted') : new ToolTimeoutError('bash', opts.timeoutMs))
            drainExecutionQueue()
            return
          }
          executing = true
          void executeBash({ ...opts, timeoutMs: remaining }, handlerConfig).then(resolve, reject).finally(() => {
            executing = false
            drainExecutionQueue()
          })
        },
      }
      const abort = () => entry.cancel(new Error('bash execution aborted'))
      const timer = setTimeout(() => entry.cancel(new ToolTimeoutError('bash', opts.timeoutMs)), opts.timeoutMs)
      executionQueue.push(entry)
      opts.abortSignal?.addEventListener('abort', abort, { once: true })
      if (opts.abortSignal?.aborted) abort()
      drainExecutionQueue()
    })
  }

  async function executeBash(opts: BashExecOptions, handlerConfig: VfsRpcHandlerConfig): Promise<BashExecResult> {
    const w = ensureWorker(handlerConfig)
    const requestId = ++requestIdCounter

    const execPromise = new Promise<BashExecResult>((resolve, reject) => {
      const commands = opts.readOnly ? new Map<string, ExternalBashCommand>() : bashCommandRegistry.snapshot()
      pendingExec = { requestId, commands, inputs: new Set(), resolve, reject }
      const req: WorkerExecRequest = {
        type: 'exec',
        requestId,
        command: opts.command,
        externalCommands: Array.from(commands.keys()),
        cwd: opts.cwd,
        rootNames: opts.rootNames,
        readOnly: opts.readOnly,
        restrictAgentCoreFiles: opts.restrictAgentCoreFiles,
      }
      w.postMessage(req as ToWorkerMessage)
    })

    // Timeout: terminate the worker to truly interrupt CPU-bound execution.
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new ToolTimeoutError('bash', opts.timeoutMs))
      }, opts.timeoutMs)
    })

    // Abort: also terminate.
    const onAbort = () => {
      const pending = pendingExec
      terminateWorker()
      if (pending && pending.requestId === requestId) {
        pending.reject(new Error('bash execution aborted'))
        pendingExec = null
      }
    }
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (opts.abortSignal?.aborted) onAbort()

    try {
      return await Promise.race([execPromise, timeoutPromise])
    } catch (err) {
      if (err instanceof ToolTimeoutError) {
        // Terminate the worker to stop the CPU-bound interpreter immediately.
        terminateWorker()
      }
      // Normalize subagent permission-denied errors to the existing envelope
      if (isSubagentPermissionDenied(err)) {
        throw err
      }
      // Re-throw permission-denied exec errors with the recognized prefix
      if (err instanceof Error && err.message.startsWith('EACCES: delegated subagent')) {
        throw err
      }
      throw err
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      opts.abortSignal?.removeEventListener('abort', onAbort)
    }
  }

  // ---------------------------------------------------------------------------
  // Message handlers
  // ---------------------------------------------------------------------------

  function handleExecResponse(msg: WorkerExecResponse): void {
    if (!pendingExec) return

    // Ignore the worker-ready handshake (requestId -1)
    if (msg.requestId === -1) return

    if (msg.requestId !== pendingExec.requestId) return

    const { resolve, reject } = pendingExec
    // Dispose any background shell jobs that outlive this execution.
    notifyExternalCancellation()
    pendingExec = null

    if (!msg.ok) {
      const error = new Error(msg.error ?? 'bash execution failed')
      if (msg.permissionDenied) {
        error.message = `${SUBAGENT_PERMISSION_DENIED}: ${msg.error}`
      }
      reject(error)
      return
    }

    resolve({
      stdout: msg.stdout ?? '',
      stderr: msg.stderr ?? '',
      exitCode: msg.exitCode ?? 0,
      truncated: msg.truncated ?? false,
      stdoutKind: msg.stdoutKind,
      elapsedMs: msg.elapsedMs ?? 0,
    })
  }

  async function handleCommandRequest(req: CommandRpcRequest, originWorker: Worker): Promise<void> {
    const execution = pendingExec
    if (!execution || execution.requestId !== req.requestId) return
    const resp: CommandRpcResponse = {
      type: 'command-result', rpcId: req.rpcId,
      result: { stdout: '', stderr: `${req.name}: command unavailable\n`, exitCode: 127 },
    }
    try {
      const command = execution.commands.get(req.name)
      if (command && await bashCommandRegistry.checkAlive(command)) {
        if (worker !== originWorker || pendingExec !== execution) return
        const input = { args: req.input.args, stdin: req.input.stdin }
        execution.inputs.add(input)
        const result = await command.invoke(input)
        if (!result || typeof result.stdout !== 'string' || typeof result.stderr !== 'string' ||
            !Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255) {
          throw new TypeError('invoke must return { stdout: string, stderr: string, exitCode: 0..255 }')
        }
        resp.result = { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode }
      }
    } catch (error) {
      resp.result = { stdout: '', stderr: `${req.name}: ${error instanceof Error ? error.message : String(error)}\n`, exitCode: 1 }
    }
    // Plugins may honor the cancellation event; still reject every late result.
    if (worker === originWorker && pendingExec === execution) originWorker.postMessage(resp)
  }

  async function handleVfsRequest(req: VfsRpcRequest, config: VfsRpcHandlerConfig): Promise<void> {
    let resp: VfsRpcResponse
    try {
      resp = await handleVfsRpc(req, config)
    } catch (err) {
      // Should not happen (handlers catch internally), but guard against surprises
      resp = {
        type: 'vfs-result',
        rpcId: req.rpcId,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }
    }

    if (worker) {
      worker.postMessage(resp as ToWorkerMessage)
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  /** Lifecycle notification only; command business inputs remain args/stdin. */
  function notifyExternalCancellation(): void {
    if (pendingExec && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('creatorweave:bash-cancel', { detail: { inputs: [...pendingExec.inputs] } }))
  }

  function terminateWorker(): void {
    activeClients.delete(client)
    notifyExternalCancellation()
    if (worker) {
      worker.terminate()
      worker = null
      currentInit = null
      pendingExec = null
      activeHandlerConfig = null
    }
  }

  /** Tear down the worker (e.g. on workspace switch / app unload). */
  function destroy(): void {
    for (const entry of [...executionQueue]) entry.cancel(new Error('bash worker destroyed'))
    pendingExec?.reject(new Error('bash worker destroyed'))
    terminateWorker()
  }

  const client = { exec, destroy }
  return client
}

const defaultClient = createBashWorkerClient()
export const bashExec = defaultClient.exec

/** Workspace switches and unload must also stop adapter-owned workers. */
export function destroyBashWorker(): void {
  defaultClient.destroy()
  for (const client of [...activeClients]) client.destroy()
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', destroyBashWorker)

// ---------------------------------------------------------------------------
// Worker creation (isolated so tests can mock)
// ---------------------------------------------------------------------------

function createBashWorker(): Worker {
  // Next's webpack build recognizes this standard module-worker pattern and
  // bundles worker.ts with its dependencies into a separate chunk.
  return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
}
