/**
 * VfsRpcHandler — main-thread side of the bash worker VFS RPC channel.
 *
 * Receives VFS RPC requests from the worker and executes them against real
 * VfsBackend instances (WorkspaceBackend / AssetsBackend / AgentBackend).
 *
 * This is where all main-thread state lives:
 * - Permission checks (subagent access to protected agent files)
 * - Plan-mode read-only enforcement (defense-in-depth)
 * - Pending-change tracking + UI refresh callbacks
 *
 * The handler is stateless across requests — each RPC carries enough info
 * (backend type + path) to construct the right backend instance on the fly.
 */

import type { VfsRpcRequest, VfsRpcResponse } from './protocol'
import type {
  VfsBackend,
  VfsReadResult,
} from '../vfs-backend'
import { WorkspaceBackend } from '../backends/workspace-backend'
import { AssetsBackend } from '../backends/assets-backend'
import { WebMcpBackend } from '../backends/webmcp-backend'
import { AgentBackend } from '../backends/agent-backend'
import {
  isProtectedAgentCoreFile,
  SUBAGENT_PERMISSION_DENIED,
} from '../agent-file-protection'
import {
  latin1StringToBytes,
  bytesToLatin1String,
  utf8Decode,
} from './bridge-shared'

// ---------------------------------------------------------------------------
// Handler config (bound at worker spawn time)
// ---------------------------------------------------------------------------

export interface VfsRpcHandlerConfig {
  workspaceId: string | null
  projectId: string | null
  currentAgentId: string | null
  /** Plan mode: block all writes. */
  readOnly: boolean
  /** Subagent: restrict access to protected agent core files. */
  restrictAgentCoreFiles: boolean
  /** Notifies UI that workspace paths changed (file writes / deletes). */
  onWorkspacePathsChanged?: (paths: readonly string[]) => void
  /** Directory handle for WorkspaceBackend (native FS). */
  directoryHandle?: FileSystemDirectoryHandle | null
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handles a single VFS RPC request. Returns the response to send back to worker.
 *
 * Throws are caught and converted to `{ ok: false, error }` — the worker
 * interprets that as a failed operation (matching VfsBackend throw semantics).
 */
export async function handleVfsRpc(
  req: VfsRpcRequest,
  config: VfsRpcHandlerConfig,
): Promise<VfsRpcResponse> {
  const { rpcId } = req

  try {
    // agent backend is routed to handleAgentRpc by the client; if it reaches
    // here, reject early (see guard below).

    // Plan-mode read-only enforcement (defense-in-depth; worker also checks)
    if (config.readOnly && isWriteMethod(req.method) && req.backend !== 'agent') {
      return {
        type: 'vfs-result',
        rpcId,
        ok: false,
        error: `bash: ${req.path}: ${req.method} blocked (read-only mode)`,
      }
    }

    // agent backend requires async ProjectManager resolution and is handled
    // exclusively by handleAgentRpc. If we get here, it's a routing error.
    if (req.backend === 'agent') {
      return {
        type: 'vfs-result',
        rpcId,
        ok: false,
        error: `agent backend must be routed through handleAgentRpc`,
      }
    }

    const result = await dispatch(req, resolveBackend(req.backend, config))

    // Notify UI on workspace mutations
    if (isWriteMethod(req.method) && req.backend === 'workspace' && config.onWorkspacePathsChanged) {
      config.onWorkspacePathsChanged([req.path])
    }

    return { type: 'vfs-result', rpcId, ok: true, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const permissionDenied =
      req.backend === 'agent' &&
      (message.startsWith(`${SUBAGENT_PERMISSION_DENIED}:`) ||
        message.startsWith('EACCES: delegated subagent'))
    return {
      type: 'vfs-result',
      rpcId,
      ok: false,
      error: permissionDenied ? `${SUBAGENT_PERMISSION_DENIED}: ${message}` : message,
    }
  }
}

// ---------------------------------------------------------------------------
// Backend resolution
// ---------------------------------------------------------------------------

function resolveBackend(backend: VfsRpcRequest['backend'], config: VfsRpcHandlerConfig): VfsBackend {
  // NOTE: 'agent' is handled separately via handleAgentRpc (needs async
  // ProjectManager resolution). This function only handles workspace/assets.
  switch (backend) {
    case 'workspace':
      return new WorkspaceBackend(
        config.workspaceId,
        config.directoryHandle ?? null,
        config.projectId,
        config.onWorkspacePathsChanged,
      )
    case 'assets':
      return new AssetsBackend(config.workspaceId)
    case 'webmcp':
      return new WebMcpBackend()
    default:
      throw new Error(`Backend '${backend}' requires async resolution — use handleAgentRpc`)
  }
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

function isWriteMethod(method: VfsRpcRequest['method']): boolean {
  return (
    method === 'writeFile' ||
    method === 'appendFile' ||
    method === 'rm' ||
    method === 'mkdir' ||
    method === 'cp' ||
    method === 'mv'
  )
}

async function dispatch(
  req: VfsRpcRequest,
  backend: VfsBackend,
): Promise<VfsRpcResponse['result']> {
  switch (req.method) {
    case 'readFile': {
      const result = await backend.readFile(req.path, {
        encoding: 'text',
        ...(req.options as object),
      })
      return decodeToString(result)
    }

    case 'readFileBuffer': {
      const result = await backend.readFile(req.path, { encoding: 'binary' })
      return decodeToLatin1(result)
    }

    case 'writeFile': {
      const content = decodeWriteContent(req.content ?? '', req.encoding)
      await backend.writeFile(req.path, content)
      return undefined
    }

    case 'appendFile': {
      // VfsBackend has no appendFile; replicate read+write semantics.
      const encoding = req.encoding ?? 'text'
      let existing: string
      try {
        const result = await backend.readFile(req.path, { encoding })
        existing = await decodeToString(result)
      } catch {
        existing = ''
      }
      const toAppend = req.content ?? ''
      const content =
        encoding === 'binary'
          ? mergeLatin1(existing, toAppend)
          : existing + toAppend
      await backend.writeFile(req.path, content)
      return undefined
    }

    case 'exists': {
      if (backend.exists) return await backend.exists(req.path)
      try {
        await backend.readFile(req.path)
        return true
      } catch {
        return false
      }
    }

    case 'stat':
    case 'lstat': {
      return await statPath(backend, req.path)
    }

    case 'readdir':
    case 'readdirWithFileTypes': {
      const entries = await backend.listDir(req.path)
      return entries.map(e => ({
        name: e.name,
        isFile: e.kind === 'file',
        isDirectory: e.kind === 'directory',
        isSymbolicLink: false,
      }))
    }

    case 'mkdir': {
      // VfsBackend auto-creates dirs on writeFile; mkdir is a no-op (matches VfsBridgeFs)
      return undefined
    }

    case 'rm': {
      if (req.recursive && backend.deleteDir) {
        try {
          await backend.deleteDir(req.path)
          return undefined
        } catch {
          // might be a file, fall through
        }
      }
      await backend.deleteFile(req.path)
      return undefined
    }

    case 'cp': {
      // Read source, write to dest.
      // If recursive, handle directory copy; otherwise single file.
      const dest = req.dest!
      if (req.recursive) {
        // Check if source is a directory
        try {
          const s = await statPath(backend, req.path)
          if (s.isDirectory) {
            await copyDirRecursive(backend, req.path, dest)
            return undefined
          }
        } catch {
          // statPath failed — fall through to file copy
        }
      }
      // Single file copy — preserve binary by passing content as-is
      const srcResult = await backend.readFile(req.path)
      await backend.writeFile(dest, toWritableContent(srcResult.content))
      return undefined
    }

    case 'mv': {
      // cp + rm (non-atomic, same as VfsBridgeFs)
      const srcResult = await backend.readFile(req.path)
      const dest = req.dest!
      await backend.writeFile(dest, toWritableContent(srcResult.content))
      await backend.deleteFile(req.path)
      return undefined
    }

    default:
      throw new Error(`Unknown VFS method: ${req.method}`)
  }
}

// ---------------------------------------------------------------------------
// Agent namespace async resolution
// ---------------------------------------------------------------------------

/**
 * Agent namespace needs ProjectManager → AgentManager (async). We re-dispatch
 * agent requests through this path so the common workspace/assets path stays
 * synchronous-lean.
 *
 * Called by the client when `req.backend === 'agent'`.
 */
export async function handleAgentRpc(
  req: VfsRpcRequest,
  config: VfsRpcHandlerConfig,
): Promise<VfsRpcResponse> {
  const { rpcId } = req

  try {
    assertAgentAccess(req.path, config)

    if (!config.projectId || !config.currentAgentId) {
      throw new Error('No active project/agent for agent namespace')
    }

    const { ProjectManager } = await import('@/opfs')
    const projectManager = await ProjectManager.create()
    const project = await projectManager.getProject(config.projectId)
    if (!project) throw new Error(`Project not found: ${config.projectId}`)

    const backend = new AgentBackend(project.agentManager, config.currentAgentId)
    const result = await dispatch(req, backend)
    return { type: 'vfs-result', rpcId, ok: true, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const permissionDenied =
      message.startsWith(`${SUBAGENT_PERMISSION_DENIED}:`) ||
      message.startsWith('EACCES: delegated subagent')
    return {
      type: 'vfs-result',
      rpcId,
      ok: false,
      error: permissionDenied ? `${SUBAGENT_PERMISSION_DENIED}: ${message}` : message,
    }
  }
}

// ---------------------------------------------------------------------------
// Path stat (file vs directory detection)
// ---------------------------------------------------------------------------

/** Default file/directory mode constants for stat results. */
const STAT_FILE_MODE = 0o644
const STAT_DIR_MODE = 0o755

/**
 * Stat a path, detecting whether it's a file or directory.
 *
 * Mirrors VfsBridgeFs.stat logic:
 * 1. Try readFile (is it a file?)
 * 2. If that fails, try listDir (is it a directory?)
 * 3. Cross-check parent directory for empty-dir vs non-existent ambiguity
 * 4. Throw ENOENT if nothing found
 */
async function statPath(backend: VfsBackend, path: string): Promise<{
  isFile: boolean
  isDirectory: boolean
  isSymbolicLink: boolean
  mode: number
  size: number
  mtime: number
}> {
  // Empty path = workspace root = directory
  if (!path) {
    return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: STAT_DIR_MODE, size: 0, mtime: Date.now() }
  }

  // Try as file first
  try {
    const result = await backend.readFile(path)
    return {
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
      mode: STAT_FILE_MODE,
      size: result.size,
      mtime: result.mtime ?? Date.now(),
    }
  } catch {
    // Not a file — fall through to directory check
  }

  // Try as directory
  try {
    const entries = await backend.listDir(path)
    if (entries.length > 0) {
      return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: STAT_DIR_MODE, size: 0, mtime: Date.now() }
    }
    // Empty listing — verify the path actually exists as a directory by
    // checking its parent contains this name as a directory entry.
    // (listDir can return [] for non-existent paths in some backends.)
    const parts = path.split('/').filter(Boolean)
    const name = parts.pop()!
    const parentPath = parts.join('/')
    try {
      const parentEntries = await backend.listDir(parentPath)
      const found = parentEntries.some(e => e.name === name && e.kind === 'directory')
      if (found) {
        return { isFile: false, isDirectory: true, isSymbolicLink: false, mode: STAT_DIR_MODE, size: 0, mtime: Date.now() }
      }
    } catch {
      // Parent check failed
    }
    throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('ENOENT')) throw e
    throw new Error(`ENOENT: no such file or directory, stat '${path}'`)
  }
}

// ---------------------------------------------------------------------------
// Recursive directory copy
// ---------------------------------------------------------------------------

/**
 * Recursively copy a directory's contents from src to dest.
 * Mirrors VfsBridgeFs.cpVfsDir: list entries, copy files recursively.
 */
async function copyDirRecursive(backend: VfsBackend, srcPath: string, destPath: string): Promise<void> {
  const entries = await backend.listDir(srcPath)
  for (const entry of entries) {
    const childSrc = srcPath ? `${srcPath}/${entry.name}` : entry.name
    const childDest = destPath ? `${destPath}/${entry.name}` : entry.name
    if (entry.kind === 'file') {
      const result = await backend.readFile(childSrc)
      await backend.writeFile(childDest, toWritableContent(result.content))
    } else if (entry.kind === 'directory') {
      await copyDirRecursive(backend, childSrc, childDest)
    }
  }
}

// ---------------------------------------------------------------------------
// Permission checks
// ---------------------------------------------------------------------------

function assertAgentAccess(path: string, config: VfsRpcHandlerConfig): void {
  if (!config.restrictAgentCoreFiles) return
  if (isProtectedAgentCoreFile(path)) {
    throw new Error(`EACCES: delegated subagent cannot access protected agent path '${path}'`)
  }
}

// ---------------------------------------------------------------------------
// Content encoding helpers
// ---------------------------------------------------------------------------

/** Decode VfsReadResult to a UTF-8 string (for readFile RPC). */
async function decodeToString(result: VfsReadResult): Promise<string> {
  const { content } = result
  if (typeof content === 'string') return content
  if (content instanceof Uint8Array) return utf8Decode(content)
  if (content instanceof ArrayBuffer) return utf8Decode(new Uint8Array(content))
  return await content.text()
}

/** Convert the read union into the content types accepted by VfsBackend.writeFile. */
function toWritableContent(content: VfsReadResult['content']): string | ArrayBuffer | Blob {
  if (content instanceof Uint8Array) {
    return new Blob([content as unknown as BlobPart])
  }
  return content
}

/** Decode VfsReadResult to a latin1-shaped string (for readFileBuffer RPC). */
async function decodeToLatin1(result: VfsReadResult): Promise<string> {
  const { content } = result
  if (typeof content === 'string') return bytesToLatin1String(new TextEncoder().encode(content))
  if (content instanceof Uint8Array) return bytesToLatin1String(content)
  if (content instanceof ArrayBuffer) return bytesToLatin1String(new Uint8Array(content))
  return bytesToLatin1String(new Uint8Array(await content.arrayBuffer()))
}

/** Convert RPC content string to the writable form VfsBackend.writeFile expects. */
function decodeWriteContent(content: string, encoding?: 'text' | 'binary'): string | ArrayBuffer {
  if (encoding === 'binary') {
    // latin1-shaped string → ArrayBuffer (preserves bytes)
    const bytes = latin1StringToBytes(content)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }
  return content
}

/** Merge two latin1-shaped strings (for appendFile binary). */
function mergeLatin1(a: string, b: string): string {
  return a + b
}
