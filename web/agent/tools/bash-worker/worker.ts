/**
 * bash-worker entry point — runs inside a Web Worker.
 *
 * Responsibilities:
 * 1. Receive `exec` requests, construct a Bash instance + WorkerVfsBridgeFs,
 *    run the command, and post the result back.
 * 2. Bridge VFS RPC: WorkerVfsBridgeFs calls invoke this worker's RPC channel,
 *    which posts `vfs` requests to main thread and awaits `vfs-result`.
 *
 * The just-bash module is imported dynamically (via variable name) to avoid
 * rollup statically analyzing its internals (contains node:zlib references
 * that break PWA build) — same strategy as the original bash.tool.ts.
 */

/// <reference lib="webworker" />

import { WorkerVfsBridgeFs, type VfsRpcInvoker } from './worker-vfs-bridge'
import type {
  ToWorkerMessage,
  FromWorkerMessage,
  WorkerExecRequest,
  WorkerExecResponse,
  VfsRpcRequest,
  VfsRpcResponse,
} from './protocol'

// ---------------------------------------------------------------------------
// just-bash dynamic import (heavy module — loaded once)
// ---------------------------------------------------------------------------

type BashExecResult = {
  stdout: string
  stderr: string
  exitCode: number
  env?: Record<string, string>
  stdoutKind?: 'text' | 'bytes'
  stdoutEncoding?: 'binary'
}

type BashInstance = {
  exec(commandLine: string, options?: any): Promise<BashExecResult>
  fs: any
}

type BashConstructor = new (options: any) => BashInstance

type JustBashModule = {
  Bash: BashConstructor
  decodeBytesToUtf8: (input: unknown) => string
  unsafeBytesFromLatin1: (input: string) => unknown
  stdoutKind?: (result: { stdoutKind?: 'text' | 'bytes'; stdoutEncoding?: 'binary' }) => 'text' | 'bytes'
}

let BashClass: BashConstructor | null = null
let decodeBytesToUtf8Helper: ((input: unknown) => string) | null = null
let unsafeBytesFromLatin1Helper: ((input: string) => unknown) | null = null
let stdoutKindHelper: JustBashModule['stdoutKind'] | null = null
let loadError: string | null = null
let loadErrorTime = 0
const LOAD_ERROR_TTL = 30_000

async function loadBash(): Promise<void> {
  if (BashClass) return
  if (loadError && Date.now() - loadErrorTime < LOAD_ERROR_TTL) {
    throw new Error(loadError)
  }
  loadError = null
  try {
    // Direct static import — worker.plugins includes nodeZlibShimPlugin() which
    // intercepts just-bash's `node:zlib` imports and polyfills them with pako,
    // so rollup can safely analyze just-bash's dependency graph.
    const mod = await import('just-bash') as JustBashModule
    BashClass = mod.Bash
    decodeBytesToUtf8Helper = mod.decodeBytesToUtf8
    unsafeBytesFromLatin1Helper = mod.unsafeBytesFromLatin1
    stdoutKindHelper = mod.stdoutKind ?? null
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    loadError = `just-bash module not available: ${msg}`
    loadErrorTime = Date.now()
    throw new Error(loadError)
  }
}

// ---------------------------------------------------------------------------
// Pending VFS RPC requests — keyed by rpcId
// ---------------------------------------------------------------------------

const pendingVfsRpc = new Map<
  number,
  { resolve: (resp: VfsRpcResponse) => void; reject: (err: Error) => void }
>()

let rpcCounter = 0

/** RPC invoker wired to postMessage + pending map. */
const rpcInvoker: VfsRpcInvoker = (request: VfsRpcRequest) => {
  // Assign the authoritative rpcId (single source of truth).
  // WorkerVfsBridgeFs passes rpcId: 0 as a placeholder.
  const rpcId = ++rpcCounter
  request.rpcId = rpcId
  const promise = new Promise<VfsRpcResponse>((resolve, reject) => {
    pendingVfsRpc.set(rpcId, { resolve, reject })
  })
  const msg: FromWorkerMessage = request
  postToMain(msg)
  return promise
}

// ---------------------------------------------------------------------------
// Message handling
// ---------------------------------------------------------------------------

self.onmessage = async (e: MessageEvent<ToWorkerMessage>) => {
  const msg = e.data
  if (!msg) return

  try {
    switch (msg.type) {
      case 'init':
        // No state to store — workspace/project/agent context lives on the
        // main thread (used by VFS RPC handler). Init is just a handshake.
        return

      case 'exec':
        await handleExec(msg)
        return

      case 'vfs-result':
        handleVfsResult(msg)
        return
    }
  } catch (err) {
    console.error('[bash-worker] unhandled error:', err)
  }
}

async function handleExec(req: WorkerExecRequest): Promise<void> {
  const { requestId, command, cwd, rootNames, readOnly, restrictAgentCoreFiles } = req

  // Ensure just-bash is loaded
  try {
    await loadBash()
  } catch (err) {
    postExecError(requestId, (err as Error).message)
    return
  }

  if (!BashClass) {
    postExecError(requestId, 'just-bash failed to load')
    return
  }

  const bridgeFs = new WorkerVfsBridgeFs(
    rpcInvoker,
    rootNames,
    true, // hasAssets — main thread RPC handler decides availability
    true, // hasAgent
    { readOnly, restrictAgentCoreFiles },
  )

  const defaultCwd = rootNames.length > 0 ? `/workspace/${rootNames[0]}` : '/workspace'

  const bash: BashInstance = new BashClass({
    fs: bridgeFs as any,
    cwd: cwd || defaultCwd,
    executionLimits: {
      maxCommandCount: 5000,
      maxLoopIterations: 10000,
      maxCallDepth: 50,
    },
  })

  const startTime = Date.now()

  try {
    const result = await bash.exec(command, { cwd: cwd || defaultCwd })
    const elapsedMs = Date.now() - startTime

    // Decode byte-shaped stdout (same logic as the original bash.tool.ts)
    const outputKind = stdoutKindHelper
      ? stdoutKindHelper(result)
      : result.stdoutEncoding === 'binary'
        ? 'bytes'
        : 'text'

    const MAX_OUTPUT = 50_000
    let stdout = result.stdout || ''
    let stderr = result.stderr || ''
    let truncated = false

    if (
      outputKind === 'bytes' &&
      decodeBytesToUtf8Helper &&
      unsafeBytesFromLatin1Helper
    ) {
      try {
        stdout = decodeBytesToUtf8Helper(unsafeBytesFromLatin1Helper(stdout))
      } catch {
        // Fall back to raw stdout
      }
    }

    if (stdout.length > MAX_OUTPUT) {
      stdout = stdout.slice(0, MAX_OUTPUT) + `\n... truncated (${stdout.length} total chars)`
      truncated = true
    }
    if (stderr.length > MAX_OUTPUT) {
      stderr = stderr.slice(0, MAX_OUTPUT) + `\n... truncated (${stderr.length} total chars)`
      truncated = true
    }

    const response: WorkerExecResponse = {
      type: 'exec-result',
      requestId,
      ok: true,
      stdout,
      stderr,
      exitCode: result.exitCode,
      truncated,
      stdoutKind: outputKind,
      elapsedMs,
    }
    postToMain(response)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const permissionDenied =
      message.startsWith('EACCES: delegated subagent') ||
      message.startsWith('PERMISSION_DENIED')
    const response: WorkerExecResponse = {
      type: 'exec-result',
      requestId,
      ok: false,
      error: message,
      permissionDenied,
      elapsedMs: Date.now() - startTime,
    }
    postToMain(response)
  }
}

function handleVfsResult(resp: VfsRpcResponse): void {
  const pending = pendingVfsRpc.get(resp.rpcId)
  if (!pending) return
  pendingVfsRpc.delete(resp.rpcId)
  pending.resolve(resp)
}

function postExecError(requestId: number, error: string): void {
  const response: WorkerExecResponse = {
    type: 'exec-result',
    requestId,
    ok: false,
    error,
  }
  postToMain(response)
}

/** Type-safe postMessage helper. */
function postToMain(msg: FromWorkerMessage): void {
  (self as DedicatedWorkerGlobalScope).postMessage(msg)
}

// Signal readiness
postToMain({ type: 'exec-result', requestId: -1, ok: true, stdout: '__worker_ready__' })
