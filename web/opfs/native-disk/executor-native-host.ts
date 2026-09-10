/**
 * NativeHostExecutor — the Native Messaging implementation of DiskExecutor.
 *
 * Performs disk IO through the chain: window.__agentWeb.nativeHostCall →
 * extension background → chrome.runtime.sendNativeMessage → Rust host binary.
 *
 * Large-file chunking:
 *   read: stat for size → ≤512KB via single read_file; >512KB via chunked read_file_at
 *   write: ≤512KB via single write_file; >512KB via chunked write_file_at (truncate + finalize)
 */

import type {
  DiskExecutor,
  DiskRoot,
  DiskStat,
  DiskEntry,
  DiskReadResult,
  DiskWriteContent,
} from './executor'
import { getFileContentType } from '../utils/opfs-utils'

const CHUNK_SIZE = 512 * 1024
const INLINE_THRESHOLD = 512 * 1024

/** Bridge to extension's __agentWeb */
interface AgentWebBridge {
  nativeHostCall(payload: Record<string, unknown>): Promise<Record<string, any>>
}

function getBridge(): AgentWebBridge | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    __agentWeb?: {
      nativeHostCall?: (payload: Record<string, unknown>) => Promise<unknown>
    }
  }
  if (w.__agentWeb?.nativeHostCall && typeof w.__agentWeb.nativeHostCall === 'function') {
    return {
      nativeHostCall: (payload: Record<string, unknown>) =>
        w.__agentWeb!.nativeHostCall!(payload) as Promise<Record<string, any>>,
    }
  }
  return null
}

// ── Base64 helpers (browser-native) ──────────────────────────

function decodeBase64(b64: string): ArrayBuffer {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

function encodeBase64(data: string | ArrayBuffer): string {
  if (typeof data === 'string') {
    return btoa(data)
  }
  const bytes = new Uint8Array(data)
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}

// ── Executor implementation ──────────────────────────────────

export class NativeHostExecutor implements DiskExecutor {
  readonly backend = 'native-host' as const

  private bridge: AgentWebBridge | null = null

  constructor() {
    this.bridge = getBridge()
  }

  /** Call the native host with an action + params */
  private async call(action: string, params: Record<string, unknown> = {}): Promise<any> {
    if (!this.bridge) {
      this.bridge = getBridge()
    }
    if (!this.bridge) {
      throw new Error('[NativeHostExecutor] Extension bridge not available (window.__agentWeb.nativeHostCall missing)')
    }
    const response = await this.bridge.nativeHostCall({ action, ...params })
    if (!response) {
      throw new Error(`[NativeHostExecutor] Empty response for action "${action}"`)
    }
    return response
  }

  // —— Authorization management ———————————————————————————————————

  async listRoots(_projectId: string): Promise<DiskRoot[]> {
    // Native host doesn't know about projectId — list all scopes.
    // The caller (WorkspaceRuntime) routes by scope_id.
    const resp = await this.call('list_scopes')
    if (!resp.ok) throw new Error(`list_scopes failed: ${resp.error}`)

    const scopes: Array<{ scope_id: string; display_name: string }> = resp.scopes || []
    return scopes.map((s) => ({
      id: s.scope_id,
      displayName: s.display_name,
      readOnly: false,
      backend: 'native-host',
      permissions: ['read', 'write', 'search'],
    }))
  }

  async authorizeRoot(
    _projectId: string,
    _opts?: { displayName?: string; readOnly?: boolean }
  ): Promise<DiskRoot | null> {
    const resp = await this.call('pick_folder')
    if (!resp.ok) throw new Error(`pick_folder failed: ${resp.error}`)
    if (resp.cancelled) return null

    return {
      id: resp.scope_id,
      displayName: resp.display_name,
      readOnly: _opts?.readOnly ?? false,
      backend: 'native-host',
      permissions: ['read', 'write', 'search'],
    }
  }

  async revokeRoot(_projectId: string, rootId: string): Promise<void> {
    const resp = await this.call('remove_scope', { scope_id: rootId })
    if (!resp.ok) {
      // The Rust host returns ok:true + removed:false when the scope is
      // already gone, but an explicit "unknown scope_id" / "missing scope_id"
      // error can also surface. Removing a non-existent scope is idempotent
      // success — the desired end state (scope gone) already holds.
      const err = String(resp.error || '')
      if (err.includes('unknown scope_id') || err.includes('missing scope_id')) {
        return
      }
      throw new Error(`remove_scope failed: ${resp.error}`)
    }
  }

  async hydrateRoot(_projectId: string, rootId: string): Promise<boolean> {
    // Native host scopes are persistent — verify by checking list_scopes
    try {
      const resp = await this.call('list_scopes')
      if (!resp.ok) return false
      const scopes: Array<{ scope_id: string }> = resp.scopes || []
      return scopes.some((s) => s.scope_id === rootId)
    } catch {
      return false
    }
  }

  // —— Disk execution ————————————————————————————————————————————

  async read(rootId: string, relativePath: string): Promise<DiskReadResult> {
    // 1. Stat to get file size
    const statResp = await this.call('stat_file', { scope_id: rootId, relative_path: relativePath })
    if (!statResp.ok) {
      // Map "not found" to a DOMException-like error so WorkspaceRuntime's
      // writeFile catch block (errorName === 'NotFoundError') handles new files
      // correctly instead of propagating the error and failing the write.
      if (statResp.error === 'not found' || statResp.error === 'file not found') {
        const err = new Error(`File not found: ${relativePath}`)
        ;(err as any).name = 'NotFoundError'
        throw err
      }
      throw new Error(`stat_file failed: ${statResp.error}`)
    }

    const size = statResp.size as number
    const mtime = statResp.mtime as number
    const contentType = this.guessContentType(relativePath)

    let content: string | ArrayBuffer

    if (size <= INLINE_THRESHOLD) {
      // Small file: single read_file
      const readResp = await this.call('read_file', { scope_id: rootId, relative_path: relativePath })
      if (!readResp.ok) throw new Error(`read_file failed: ${readResp.error}`)

      const decoded = decodeBase64(readResp.content as string)
      content = contentType === 'text' ? new TextDecoder().decode(decoded) : decoded
    } else {
      // Large file: chunked read_file_at
      content = await this.readChunked(rootId, relativePath, size, contentType)
    }

    return {
      content,
      stat: { mtime, size, contentType, isFile: true },
    }
  }

  private async readChunked(
    rootId: string,
    relativePath: string,
    totalSize: number,
    contentType: 'text' | 'binary'
  ): Promise<string | ArrayBuffer> {
    const chunks: ArrayBuffer[] = []
    let offset = 0

    while (offset < totalSize) {
      const resp = await this.call('read_file_at', {
        scope_id: rootId,
        relative_path: relativePath,
        offset,
        length: CHUNK_SIZE,
      })
      if (!resp.ok) throw new Error(`read_file_at failed at offset ${offset}: ${resp.error}`)

      chunks.push(decodeBase64(resp.data as string))
      offset += resp.bytes_read as number
      if (resp.eof) break
    }

    // Merge chunks
    const total = chunks.reduce((sum, c) => sum + c.byteLength, 0)
    const merged = new Uint8Array(total)
    let pos = 0
    for (const chunk of chunks) {
      merged.set(new Uint8Array(chunk), pos)
      pos += chunk.byteLength
    }

    return contentType === 'text' ? new TextDecoder().decode(merged) : merged.buffer
  }

  async write(
    rootId: string,
    relativePath: string,
    content: DiskWriteContent
  ): Promise<DiskStat> {
    // Convert content to raw bytes for size check
    const encoder = new TextEncoder()
    const rawData: ArrayBuffer = typeof content === 'string'
      ? encoder.encode(content).buffer.slice(0) as ArrayBuffer
      : content

    if (rawData.byteLength <= INLINE_THRESHOLD) {
      // Small file: single write_file
      const resp = await this.call('write_file', {
        scope_id: rootId,
        relative_path: relativePath,
        data: encodeBase64(rawData),
        encoding: 'base64',
      })
      if (!resp.ok) throw new Error(`write_file failed: ${resp.error}`)

      return {
        mtime: resp.mtime as number,
        size: resp.size as number,
        contentType: this.guessContentType(relativePath),
        isFile: true,
      }
    }

    // Large file: chunked write_file_at
    return this.writeChunked(rootId, relativePath, rawData)
  }

  private async writeChunked(
    rootId: string,
    relativePath: string,
    data: ArrayBuffer
  ): Promise<DiskStat> {
    const bytes = new Uint8Array(data)
    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE)

    for (let i = 0; i < totalChunks; i++) {
      const offset = i * CHUNK_SIZE
      const end = Math.min(offset + CHUNK_SIZE, bytes.length)
      const chunk = bytes.slice(offset, end)
      const isLast = i === totalChunks - 1

      const resp = await this.call('write_file_at', {
        scope_id: rootId,
        relative_path: relativePath,
        offset,
        data: encodeBase64(chunk.buffer),
        encoding: 'base64',
        truncate: i === 0,
        finalize: isLast,
      })
      if (!resp.ok) throw new Error(`write_file_at failed at offset ${offset}: ${resp.error}`)
    }

    // Get final stat
    const statResp = await this.call('stat_file', { scope_id: rootId, relative_path: relativePath })
    if (!statResp.ok) {
      // Return approximate stat
      return {
        mtime: Date.now(),
        size: bytes.length,
        contentType: this.guessContentType(relativePath),
        isFile: true,
      }
    }

    return {
      mtime: statResp.mtime as number,
      size: statResp.size as number,
      contentType: this.guessContentType(relativePath),
      isFile: true,
    }
  }

  async delete(
    rootId: string,
    relativePath: string,
    opts?: { pruneEmptyParents?: boolean; recursive?: boolean }
  ): Promise<void> {
    const resp = await this.call('delete_file', {
      scope_id: rootId,
      relative_path: relativePath,
      recursive: opts?.recursive === true,
    })
    if (!resp.ok) throw new Error(`delete_file failed: ${resp.error}`)

    // Prune the now-empty chain of parent directories upward (best-effort).
    // The Rust side's remove_dir already succeeds on empty directories and
    // errors on non-empty ones, so level-by-level list_dir checks + deletes
    // implement this without a new RPC. Stop conditions: non-empty /
    // missing / reached the root.
    if (opts?.pruneEmptyParents) {
      const parts = relativePath.split('/').filter(Boolean)
      for (let i = parts.length - 1; i > 0; i--) {
        const dirRel = parts.slice(0, i).join('/')
        try {
          const listResp = await this.call('list_dir', {
            scope_id: rootId,
            relative_path: dirRel,
          })
          if (!listResp.ok) break // directory missing — stop
          const entries = (listResp.entries as Array<{ name: string }> | undefined) || []
          if (entries.length > 0) break // non-empty — stop pruning upward
          const delResp = await this.call('delete_file', {
            scope_id: rootId,
            relative_path: dirRel,
          })
          if (!delResp.ok) break
        } catch {
          break
        }
      }
    }
  }

  async stat(rootId: string, relativePath: string): Promise<DiskStat | null> {
    const resp = await this.call('stat_file', { scope_id: rootId, relative_path: relativePath })
    if (!resp.ok) {
      if (resp.error === 'not found') return null
      throw new Error(`stat_file failed: ${resp.error}`)
    }

    return {
      mtime: resp.mtime as number,
      size: resp.size as number,
      contentType: this.guessContentType(relativePath),
      isFile: resp.is_file as boolean,
    }
  }

  async listDir(rootId: string, relativePath: string): Promise<DiskEntry[]> {
    const resp = await this.call('list_dir', { scope_id: rootId, relative_path: relativePath })
    if (!resp.ok) throw new Error(`list_dir failed: ${resp.error}`)

    const entries: Array<{ name: string; kind: string; size?: number; mtime?: number }> = resp.entries || []
    return entries.map((e) => ({
      name: e.name,
      kind: e.kind as 'file' | 'directory',
      stat: e.kind === 'file'
        ? {
            mtime: e.mtime ?? 0,
            size: e.size ?? 0,
            contentType: this.guessContentType(e.name),
            isFile: true,
          }
        : undefined,
    }))
  }

  // —— Helpers ——————————————————————————————————————————————

  private guessContentType(path: string): 'text' | 'binary' {
    // Delegate to the shared util so extension-less files (Dockerfile,
    // Jenkinsfile, Makefile, ...) are classified consistently with the
    // OPFS/backend paths. Previously this was a duplicated extension-only
    // list, which misclassified extension-less text files as binary and
    // made the edit tool reject them with binary_not_supported.
    return getFileContentType(path)
  }
}
