/**
 * Workspace Files Directory Operations
 *
 * Standalone implementations of WorkspaceRuntime's OPFS files/ and
 * .baseline/ directory methods (index building, read/write/delete,
 * baseline capture/restore, stats, directory handles). Each function
 * takes the runtime instance (via the WorkspaceFilesDirInternals bridge
 * interface) as its first parameter; the class methods on WorkspaceRuntime
 * are one-line delegates.
 *
 * Cross-method calls go through the runtime instance (rt.method()) so
 * instance-level overrides keep working exactly as before extraction.
 */

import type { FileContent } from '../types/opfs-types'
import { getFileContentType, shouldSkipScanEntry } from '../utils/opfs-utils'
import { getFSOverlayRepository } from '@/sqlite/repositories/fs-overlay.repository'
import type { WorkspacePendingManager } from './workspace-pending'

const FILES_DIR = 'files'
const BASELINE_DIR = '.baseline'
const ASSETS_DIR = 'assets'
/**
 * Team board scratch, owned by the workspace (one conversation = one workspace).
 *
 * A sibling of `files/` and `assets/` rather than under either: a board must not
 * enter `files/` (that is the user's folder, with pending/sync/conflict tracking)
 * and must not enter `assets/` (that is user uploads, mounted at /mnt_assets).
 * Living here means the boards of a conversation are deleted with it.
 */
const TEAM_DIR = 'team'

/**
 * Compare two Uint8Arrays for equality using 4-byte (Uint32) chunks.
 * Falls back to byte-by-byte for the tail (< 4 bytes remainder).
 * ~4x faster than byte-by-byte loop on V8 for large arrays.
 */
function compareUint8Arrays(a: Uint8Array, b: Uint8Array): boolean {
  const len = a.byteLength
  if (b.byteLength !== len) return false

  // Align to 4-byte boundaries via Uint32Array DataView
  const u32Len = len >>> 2 // floor(len / 4)
  if (u32Len > 0) {
    const a32 = new Uint32Array(a.buffer, a.byteOffset, u32Len)
    const b32 = new Uint32Array(b.buffer, b.byteOffset, u32Len)
    for (let i = 0; i < u32Len; i++) {
      if (a32[i] !== b32[i]) return false
    }
  }

  // Compare remaining bytes (0-3)
  const tail = u32Len << 2
  for (let i = tail; i < len; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

/**
 * Internal bridge onto WorkspaceRuntime's private files/baseline state and
 * delegate methods. The class delegates cast `this` to this interface so
 * the standalone implementations can access the fields/methods they need.
 */
export interface WorkspaceFilesDirInternals {
  readonly workspaceId: string
  readonly workspaceDir: FileSystemDirectoryHandle
  /** In-memory index of files stored in files/ directory */
  filesIndex: Set<string>
  initialized: boolean
  readonly pendingManager: WorkspacePendingManager
  initialize(): Promise<void>
  buildFilesIndex(): Promise<void>
  scanDirRecursive(dir: FileSystemDirectoryHandle, prefix: string, index: Set<string>): Promise<void>
  readFromFilesDir(path: string): Promise<{ content: FileContent; mtime: number; size: number; contentType: 'text' | 'binary' } | null>
  writeToFilesDir(path: string, content: FileContent): Promise<void>
  deleteFromFilesDir(path: string): Promise<void>
  deleteFromFilesDirIfExists(path: string): Promise<void>
  readFromBaselineDir(path: string): Promise<{ content: FileContent; mtime: number; size: number; contentType: 'text' | 'binary' } | null>
  contentToBytes(content: FileContent): Promise<Uint8Array>
  areFileContentsEqual(left: FileContent, right: FileContent): Promise<boolean>
  writeToBaselineDir(path: string, content: FileContent): Promise<void>
  deleteFromBaselineDirIfExists(path: string): Promise<void>
  captureModifyBaseline(path: string, content: FileContent, forceOverwrite?: boolean): Promise<void>
  tryLoadFromSnapshotHistory(path: string): Promise<FileContent | null>
  restorePendingModifyFromBaseline(path: string): Promise<boolean>
  listBaselinePaths(): Promise<string[]>
  cleanupStaleBaselines(): Promise<void>
  rebuildFilesIndex(): Promise<void>
  hasFileInIndex(path: string): boolean
  getIndexedPaths(): string[]
  clearFilesDir(): Promise<void>
  clearBaselineDir(): Promise<void>
  getFilesStats(): Promise<{ size: number; fileCount: number }>
  calculateDirStats(dir: FileSystemDirectoryHandle): Promise<{ size: number; fileCount: number }>
  getFilesDir(): Promise<FileSystemDirectoryHandle>
  getAssetsDir(): Promise<FileSystemDirectoryHandle>
  getTeamDir(options?: { create?: boolean }): Promise<FileSystemDirectoryHandle>
  getBaselineDir(): Promise<FileSystemDirectoryHandle>
}

/**
 * Build in-memory index of files in files/ directory
 */
export async function buildFilesIndexImpl(rt: WorkspaceFilesDirInternals): Promise<void> {
  const newIndex = new Set<string>()
  try {
    const filesDir = await rt.getFilesDir()
    await rt.scanDirRecursive(filesDir, '', newIndex)
  } catch {
    // files/ directory doesn't exist yet
  }
  rt.filesIndex = newIndex
}

/**
 * Recursively scan directory and add paths to index
 */
export async function scanDirRecursiveImpl(
  rt: WorkspaceFilesDirInternals,
  dir: FileSystemDirectoryHandle,
  prefix: string,
  index: Set<string>
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (shouldSkipScanEntry(name)) continue
    const path = prefix ? `${prefix}/${name}` : name
    if (handle.kind === 'file') {
      index.add(path)
    } else {
      await rt.scanDirRecursive(handle as FileSystemDirectoryHandle, path, index)
    }
  }
}

/**
 * Read file content from files/ directory
 * @returns Content, mtime, size, contentType or null if not found
 */
export async function readFromFilesDirImpl(
  rt: WorkspaceFilesDirInternals,
  path: string
): Promise<{ content: FileContent; mtime: number; size: number; contentType: 'text' | 'binary' } | null> {
  try {
    const filesDir = await rt.getFilesDir()
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return null

    let current = filesDir
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i])
    }

    const fileHandle = await current.getFileHandle(parts[parts.length - 1])
    const file = await fileHandle.getFile()
    let content: FileContent
    const contentType = getFileContentType(path)
    if (contentType === 'text') {
      content = await file.text()
    } else {
      content = await file.arrayBuffer()
    }
    return {
      content,
      mtime: file.lastModified,
      size: file.size,
      contentType,
    }
  } catch {
    return null
  }
}

/**
 * Write file content to files/ directory
 */
export async function writeToFilesDirImpl(
  rt: WorkspaceFilesDirInternals,
  path: string,
  content: FileContent
): Promise<void> {
  const filesDir = await rt.getFilesDir()
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return

  const fileName = parts[parts.length - 1]
  let currentDir = filesDir

  // Create directories if needed
  for (let i = 0; i < parts.length - 1; i++) {
    currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true })
  }

  // Write file
  const targetFile = await currentDir.getFileHandle(fileName, { create: true })
  const writable = await targetFile.createWritable()
  await writable.write(content)
  await writable.close()

  // Update index
  rt.filesIndex.add(path)
}

/**
 * Delete file from files/ directory
 */
export async function deleteFromFilesDirImpl(
  rt: WorkspaceFilesDirInternals,
  path: string
): Promise<void> {
  try {
    const filesDir = await rt.getFilesDir()
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return

    // Record the parent-handle chain so empty directories can be pruned upward after deletion
    const handleChain: Array<{ handle: FileSystemDirectoryHandle; name: string }> = []
    let current = filesDir
    for (let i = 0; i < parts.length - 1; i++) {
      handleChain.push({ handle: current, name: parts[i] })
      current = await current.getDirectoryHandle(parts[i])
    }
    await current.removeEntry(parts[parts.length - 1])

    // Prune the now-empty parents bottom-up, stopping at the first non-empty one.
    // Otherwise OPFS files/ keeps an empty directory tree, which later syncs/scans treat as
    // valid entries, so migrated-away directories get recreated on disk over and over (ghost dirs).
    for (let i = handleChain.length - 1; i >= 0; i--) {
      const { handle, name } = handleChain[i]
      try {
        const dir = await handle.getDirectoryHandle(name)
        let isEmpty = true
        // @ts-ignore — for await on directory entries
        for await (const _entry of dir.entries()) {
          void _entry
          isEmpty = false
          break
        }
        if (isEmpty) {
          await handle.removeEntry(name, { recursive: false })
        } else {
          break
        }
      } catch {
        break
      }
    }

    // Update index
    rt.filesIndex.delete(path)
  } catch {
    // File doesn't exist, ignore
  }
}

/**
 * Delete file from files/ directory if it exists (alias for deleteFromFilesDir)
 */
export async function deleteFromFilesDirIfExistsImpl(
  rt: WorkspaceFilesDirInternals,
  path: string
): Promise<void> {
  await rt.deleteFromFilesDir(path)
}

/**
 * Read file content from .baseline/ directory.
 */
export async function readFromBaselineDirImpl(
  rt: WorkspaceFilesDirInternals,
  path: string
): Promise<{ content: FileContent; mtime: number; size: number; contentType: 'text' | 'binary' } | null> {
  try {
    const baselineDir = await rt.getBaselineDir()
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return null

    let current = baselineDir
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i])
    }

    const fileHandle = await current.getFileHandle(parts[parts.length - 1])
    const file = await fileHandle.getFile()
    let content: FileContent
    const contentType = getFileContentType(path)
    if (contentType === 'text') {
      content = await file.text()
    } else {
      content = await file.arrayBuffer()
    }
    return {
      content,
      mtime: file.lastModified,
      size: file.size,
      contentType,
    }
  } catch {
    return null
  }
}

export async function contentToBytesImpl(
  _rt: WorkspaceFilesDirInternals,
  content: FileContent
): Promise<Uint8Array> {
  if (typeof content === 'string') {
    return new TextEncoder().encode(content)
  }
  if (content instanceof Blob) {
    return new Uint8Array(await content.arrayBuffer())
  }
  return new Uint8Array(content)
}

/**
 * Compare two FileContent values for byte-level equality.
 *
 * Optimization layers:
 * 1. String fast-path: skip comparison when string lengths differ.
 * 2. Same-reference shortcut: identical objects are always equal.
 * 3. Byte-level: convert both sides to Uint8Array, compare length
 *    then use TypedArray friendly comparison.
 */
export async function areFileContentsEqualImpl(
  rt: WorkspaceFilesDirInternals,
  left: FileContent,
  right: FileContent
): Promise<boolean> {
  // Same reference — always equal (covers both being the same string/object)
  if (left === right) return true

  // String fast-path: different JS string length → different byte content
  if (typeof left === 'string' && typeof right === 'string') {
    if (left.length !== right.length) return false
    // Same length strings — still need full comparison (different chars,
    // same length is possible). Fall through to byte comparison below.
  }

  const leftBytes = await rt.contentToBytes(left)
  const rightBytes = await rt.contentToBytes(right)
  if (leftBytes.byteLength !== rightBytes.byteLength) return false

  // Use DataView for efficient multi-byte comparison instead of
  // byte-by-byte loop. Process 4 bytes at a time via Uint32Array view.
  return compareUint8Arrays(leftBytes, rightBytes)
}

/**
 * Write file content to .baseline/ directory.
 */
export async function writeToBaselineDirImpl(
  rt: WorkspaceFilesDirInternals,
  path: string,
  content: FileContent
): Promise<void> {
  const baselineDir = await rt.getBaselineDir()
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return

  const fileName = parts[parts.length - 1]
  let currentDir = baselineDir

  for (let i = 0; i < parts.length - 1; i++) {
    currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true })
  }

  const targetFile = await currentDir.getFileHandle(fileName, { create: true })
  const writable = await targetFile.createWritable()
  await writable.write(content)
  await writable.close()
}

/**
 * Delete file from .baseline/ directory if it exists.
 */
export async function deleteFromBaselineDirIfExistsImpl(
  rt: WorkspaceFilesDirInternals,
  path: string
): Promise<void> {
  try {
    const baselineDir = await rt.getBaselineDir()
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) return

    let current = baselineDir
    for (let i = 0; i < parts.length - 1; i++) {
      current = await current.getDirectoryHandle(parts[i])
    }

    await current.removeEntry(parts[parts.length - 1])
  } catch {
    // Ignore if baseline entry doesn't exist.
  }
}

/**
 * Capture baseline content for modify operations.
 * - First modify in current pending cycle: write baseline.
 * - Subsequent modifies in same pending cycle: keep original baseline.
 */
export async function captureModifyBaselineImpl(
  rt: WorkspaceFilesDirInternals,
  path: string,
  content: FileContent,
  forceOverwrite = false
): Promise<void> {
  const hasPendingPath = rt.pendingManager.hasPendingPath(path)
  const existingBaseline = await rt.readFromBaselineDir(path)
  if (!forceOverwrite && hasPendingPath && existingBaseline) {
    return
  }

  await rt.writeToBaselineDir(path, content)
}

/**
 * Look up the most recent committed snapshot's `after` content for a path.
 * Used by `writeFile` as a final fallback when neither native disk nor
 * the OPFS filesIndex has the file - in that case we still know from
 * history whether the file existed. A non-null result means the write is
 * an overwrite (must be classified as `modify`); `null` means the file
 * is genuinely new to this workspace.
 *
 * Skips snapshots whose last op for this path was `delete` - a deleted
 * file is gone from the user's POV, so writing it again is a fresh create.
 */
export async function tryLoadFromSnapshotHistoryImpl(
  rt: WorkspaceFilesDirInternals,
  path: string
): Promise<FileContent | null> {
  const repo = getFSOverlayRepository()
  let prior
  try {
    prior = await repo.findLatestSnapshotFileForPath(rt.workspaceId, path)
  } catch (err) {
    // SQLite may not be initialized in test contexts (pure-OPFS tests
    // mock the workspace and skip DB setup). History lookup is a
    // best-effort signal — if it fails for any reason, fall back to
    // the legacy behavior (treat as new file) rather than breaking the
    // write.
    console.warn(`[WorkspaceRuntime] snapshot-history lookup failed for ${path}:`, err)
    return null
  }
  if (!prior) return null
  if (prior.opType === 'delete') return null
  if (prior.afterContentKind === 'none') return null
  if (prior.afterContentKind === 'text' && prior.afterContentText !== null) {
    return prior.afterContentText
  }
  if (prior.afterContentKind === 'binary' && prior.afterContentBlob !== null) {
    // FileContent allows ArrayBuffer; convert Uint8Array -> ArrayBuffer slice.
    return prior.afterContentBlob.buffer.slice(
      prior.afterContentBlob.byteOffset,
      prior.afterContentBlob.byteOffset + prior.afterContentBlob.byteLength,
    ) as ArrayBuffer
  }
  return null
}

/**
 * Restore a modified file from OPFS baseline snapshot.
 */
export async function restorePendingModifyFromBaselineImpl(
  rt: WorkspaceFilesDirInternals,
  path: string
): Promise<boolean> {
  const baseline = await rt.readFromBaselineDir(path)
  if (!baseline) return false

  await rt.writeToFilesDir(path, baseline.content)
  await rt.deleteFromBaselineDirIfExists(path)
  return true
}

/**
 * List all baseline file paths in .baseline/ directory.
 */
export async function listBaselinePathsImpl(rt: WorkspaceFilesDirInternals): Promise<string[]> {
  try {
    const baselineDir = await rt.getBaselineDir()
    const paths = new Set<string>()
    await rt.scanDirRecursive(baselineDir, '', paths)
    return Array.from(paths)
  } catch {
    return []
  }
}

/**
 * Remove stale baseline files which no longer have pending entries.
 */
export async function cleanupStaleBaselinesImpl(rt: WorkspaceFilesDirInternals): Promise<void> {
  const baselinePaths = await rt.listBaselinePaths()
  if (baselinePaths.length === 0) return

  for (const path of baselinePaths) {
    if (!rt.pendingManager.hasPendingPath(path)) {
      await rt.deleteFromBaselineDirIfExists(path)
    }
  }
}

/**
 * Rebuild the in-memory files index from the files/ directory.
 * Called after external tools (e.g. sync) write files directly to OPFS
 * without going through the runtime's writeFile path.
 *
 * Note: This performs a full rescan of the files/ directory. The index is
 * rebuilt atomically (new Set swap) so there is no empty-window during the scan.
 */
export async function rebuildFilesIndexImpl(rt: WorkspaceFilesDirInternals): Promise<void> {
  if (!rt.initialized) await rt.initialize()
  await rt.buildFilesIndex()
}

/**
 * Check if file exists in files/ directory (uses in-memory index)
 */
export function hasFileInIndexImpl(
  rt: WorkspaceFilesDirInternals,
  path: string
): boolean {
  return rt.filesIndex.has(path)
}

/**
 * Get all file paths from files/ directory (uses in-memory index)
 */
export function getIndexedPathsImpl(rt: WorkspaceFilesDirInternals): string[] {
  return Array.from(rt.filesIndex)
}

/**
 * Clear all files from files/ directory
 */
export async function clearFilesDirImpl(rt: WorkspaceFilesDirInternals): Promise<void> {
  try {
    // Remove entire files/ directory and recreate
    await rt.workspaceDir.removeEntry(FILES_DIR, { recursive: true })
    // Recreate empty
    await rt.workspaceDir.getDirectoryHandle(FILES_DIR, { create: true })
    rt.filesIndex.clear()
  } catch {
    // Directory doesn't exist, just clear index
    rt.filesIndex.clear()
  }
}

/**
 * Clear all files from .baseline/ directory.
 */
export async function clearBaselineDirImpl(rt: WorkspaceFilesDirInternals): Promise<void> {
  try {
    await rt.workspaceDir.removeEntry(BASELINE_DIR, { recursive: true })
  } catch {
    // Directory doesn't exist, ignore.
  }
}

/**
 * Get statistics for files/ directory
 */
export async function getFilesStatsImpl(rt: WorkspaceFilesDirInternals): Promise<{ size: number; fileCount: number }> {
  let size = 0
  let fileCount = 0

  try {
    const filesDir = await rt.getFilesDir()
    const stats = await rt.calculateDirStats(filesDir)
    size = stats.size
    fileCount = stats.fileCount
  } catch {
    // Directory doesn't exist
  }

  return { size, fileCount }
}

/**
 * Calculate directory statistics recursively
 */
export async function calculateDirStatsImpl(
  rt: WorkspaceFilesDirInternals,
  dir: FileSystemDirectoryHandle
): Promise<{ size: number; fileCount: number }> {
  let size = 0
  let fileCount = 0

  for await (const [, handle] of dir.entries()) {
    if (handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile()
      size += file.size
      fileCount++
    } else {
      const subStats = await rt.calculateDirStats(handle as FileSystemDirectoryHandle)
      size += subStats.size
      fileCount += subStats.fileCount
    }
  }

  return { size, fileCount }
}

/**
 * Get the files/ directory handle (Agent workspace)
 * This is the mount point for Pyodide Python execution
 */
export async function getFilesDirImpl(rt: WorkspaceFilesDirInternals): Promise<FileSystemDirectoryHandle> {
  return await rt.workspaceDir.getDirectoryHandle(FILES_DIR, { create: true })
}

/**
 * Get the assets/ directory handle (user uploads & agent-generated files)
 * This is the mount point for /mnt_assets in Pyodide Python execution
 */
export async function getAssetsDirImpl(rt: WorkspaceFilesDirInternals): Promise<FileSystemDirectoryHandle> {
  return await rt.workspaceDir.getDirectoryHandle(ASSETS_DIR, { create: true })
}

/**
 * Get the team/ directory handle — scratch for this conversation's team runs.
 *
 * `create` defaults to false: reading a board must not bring one into existence,
 * otherwise "which runs exist" becomes unknowable. Writers pass `create: true`.
 */
export async function getTeamDirImpl(
  rt: WorkspaceFilesDirInternals,
  options?: { create?: boolean },
): Promise<FileSystemDirectoryHandle> {
  return await rt.workspaceDir.getDirectoryHandle(TEAM_DIR, { create: options?.create ?? false })
}

/**
 * Get the .baseline/ directory handle for OPFS-only modify rollbacks.
 */
export async function getBaselineDirImpl(rt: WorkspaceFilesDirInternals): Promise<FileSystemDirectoryHandle> {
  return await rt.workspaceDir.getDirectoryHandle(BASELINE_DIR, { create: true })
}
