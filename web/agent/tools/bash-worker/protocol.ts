import type { BashCommandInput, BashCommandResult } from '@/agent/bash-commands/registry'

/**
 * bash-worker protocol — message types between main thread and bash worker.
 *
 * Three channels:
 * 1. Main → Worker: exec requests (run a command)
 * 2. Worker → Main: VFS RPC requests (file IO during command execution)
 * 3. Worker → Main: external command invocation (args and UTF-8 stdin only)
 *
 * All messages carry an ID for correlating async responses. Binary content
 * is represented as latin1-shaped strings (each JS char's low byte = one
 * file byte), matching VfsBridgeFs / just-bash's internal encoding. This
 * avoids structured-clone overhead for ArrayBuffers.
 */

// ---------------------------------------------------------------------------
// Shared types (mirrors VfsBackend / VfsBridgeFs surfaces, serialized)
// ---------------------------------------------------------------------------

/** Which VFS backend a file operation targets. */
export type VfsRpcBackend = 'workspace' | 'assets' | 'agent' | 'webmcp'

/** File operation method names (subset of VfsBridgeFs / VfsBackend). */
export type VfsRpcMethod =
  | 'readFile'
  | 'readFileBuffer'
  | 'writeFile'
  | 'appendFile'
  | 'exists'
  | 'stat'
  | 'lstat'
  | 'readdir'
  | 'readdirWithFileTypes'
  | 'mkdir'
  | 'rm'
  | 'cp'
  | 'mv'

/** Serialized stat result. */
export interface VfsRpcStat {
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  mode: number
  size: number
  mtime: number // epoch ms (Date serialized as number)
}

/** Serialized directory entry. */
export interface VfsRpcDirent {
  name: string
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
}

/** Serialized VFS RPC request (Worker → Main). */
export interface VfsRpcRequest {
  type: 'vfs'
  rpcId: number
  backend: VfsRpcBackend
  method: VfsRpcMethod
  path: string
  /** Destination path for cp/mv. */
  dest?: string
  /** File content for write/append (latin1-shaped string for binary, plain text otherwise). */
  content?: string
  /** Encoding hint for read/write. */
  encoding?: 'text' | 'binary'
  /** Recursive flag for rm/cp/mkdir. */
  recursive?: boolean
  /** Force flag for rm. */
  force?: boolean
  /** Read options (for readFile). */
  options?: Record<string, unknown>
}

/** Serialized VFS RPC response (Main → Worker). */
export interface VfsRpcResponse {
  type: 'vfs-result'
  rpcId: number
  ok: boolean
  /** Method-specific result payload. */
  result?:
    | string // readFile / readFileBuffer content
    | boolean // exists
    | VfsRpcStat // stat / lstat
    | VfsRpcDirent[] // readdir / readdirWithFileTypes
    | void // writeFile / appendFile / mkdir / rm / cp / mv
  /** Error message when ok=false. */
  error?: string
}

// ---------------------------------------------------------------------------
// Exec channel (Main → Worker → Main)
// ---------------------------------------------------------------------------

/** Initialization payload sent once when a worker (re)starts. */
export interface WorkerInitMessage {
  type: 'init'
  workspaceId: string | null
  projectId: string | null
  currentAgentId: string | null
}

/** Exec request (Main → Worker). */
export interface WorkerExecRequest {
  type: 'exec'
  requestId: number
  command: string
  externalCommands?: string[]
  cwd?: string
  rootNames: string[]
  /** Plan mode: block all writes. */
  readOnly: boolean
  /** Subagent: restrict access to protected agent core files. */
  restrictAgentCoreFiles: boolean
}

/** Exec response (Worker → Main). */
export interface WorkerExecResponse {
  type: 'exec-result'
  requestId: number
  ok: boolean
  stdout?: string
  stderr?: string
  exitCode?: number
  truncated?: boolean
  stdoutKind?: 'text' | 'bytes'
  elapsedMs?: number
  error?: string
  /** When the exec failed due to subagent permission denial. */
  permissionDenied?: boolean
}

// ---------------------------------------------------------------------------
// Discriminated union of all worker-bound messages
// ---------------------------------------------------------------------------

/** Messages sent FROM main thread TO worker. */
export interface CommandRpcRequest {
  type: 'command'
  requestId: number
  rpcId: number
  name: string
  input: BashCommandInput
}

export interface CommandRpcResponse {
  type: 'command-result'
  rpcId: number
  result: BashCommandResult
}

export type ToWorkerMessage = WorkerInitMessage | WorkerExecRequest | VfsRpcResponse | CommandRpcResponse

/** Messages sent FROM worker TO main thread. */
export type FromWorkerMessage = WorkerExecResponse | VfsRpcRequest | CommandRpcRequest
