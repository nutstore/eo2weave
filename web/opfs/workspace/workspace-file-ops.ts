/**
 * Workspace File Operations
 *
 * Standalone implementations of WorkspaceRuntime's file operation methods
 * (read/write/delete, native FS reads, baseline checks, conflict marker
 * materialization, native-to-OPFS preparation). Each function takes the
 * runtime instance (via the WorkspaceFileOpsInternals bridge interface)
 * as its first parameter; the class methods on WorkspaceRuntime are
 * one-line delegates.
 *
 * Cross-method calls go through the runtime instance (rt.method()) so
 * instance-level overrides keep working exactly as before extraction.
 */

import type {
  FileContent,
  FileMetadata,
  SyncResult,
  ReadPolicy,
} from '../types/opfs-types'
import {
  buildConflictMarkerContent,
  hasConflictMarkers,
} from './conflict-markers'
import {
  isGitIgnored,
  parseGitIgnore,
  type GitIgnoreRule,
} from '../native-disk/gitignore-policy'
import type { WorkspacePendingManager } from './workspace-pending'
import type { DiskExecutor } from '../native-disk/executor'

const BASELINE_DIR = '.baseline'

/** Workspace metadata shape persisted to workspace.json. */
interface WorkspaceFileOpsMetadata {
  workspaceId: string
  createdAt: number
  lastAccessedAt: number
  rootDirectory: string
}

/**
 * Internal bridge onto WorkspaceRuntime's private file-op state and
 * delegate methods. The class delegates cast `this` to this interface so
 * the standalone implementations can access the fields/methods they need.
 */
export interface WorkspaceFileOpsInternals {
  readonly workspaceId: string
  readonly workspaceDir: FileSystemDirectoryHandle
  /** In-memory index of files stored in files/ directory */
  filesIndex: Set<string>
  initialized: boolean
  metadata: WorkspaceFileOpsMetadata
  readonly pendingManager: WorkspacePendingManager
  readonly diskExec: DiskExecutor
  initialize(): Promise<void>
  saveMetadata(): Promise<void>
  normalizeWorkspacePath(path: string): string
  resolvePath(path: string, projectId?: string | null): Promise<{
    rootName: string
    rootId: string | null
    backend: 'fsaccess' | 'native-host'
    relativePath: string
    readOnly: boolean
  }>
  getNativeDirectoryHandleForPath(path: string, projectId?: string | null): Promise<FileSystemDirectoryHandle | null>
  getAllNativeDirectoryHandles(projectId?: string | null): Promise<Map<string, FileSystemDirectoryHandle>>
  hasAnyNativeDirectoryHandle(): Promise<boolean>
  getFilesDir(): Promise<FileSystemDirectoryHandle>
  resolveRootIdForHandle(directoryHandle: FileSystemDirectoryHandle): Promise<string>
  hasFileInIndex(path: string): boolean
  readFromFilesDir(path: string): Promise<{ content: FileContent; mtime: number; size: number; contentType: 'text' | 'binary' } | null>
  writeToFilesDir(path: string, content: FileContent): Promise<void>
  deleteFromFilesDir(path: string): Promise<void>
  deleteFromFilesDirIfExists(path: string): Promise<void>
  readFromBaselineDir(path: string): Promise<{ content: FileContent; mtime: number; size: number; contentType: 'text' | 'binary' } | null>
  deleteFromBaselineDirIfExists(path: string): Promise<void>
  captureModifyBaseline(path: string, content: FileContent, forceOverwrite?: boolean): Promise<void>
  tryLoadFromSnapshotHistory(path: string): Promise<FileContent | null>
  areFileContentsEqual(left: FileContent, right: FileContent): Promise<boolean>
  readFromDiskRoot(rootId: string, path: string): Promise<{ content: FileContent; metadata: FileMetadata }>
  getDiskFileMetadata(rootId: string, path: string): Promise<{ mtime: number; size: number; contentType: 'text' | 'binary' }>
  readFromNativeFS(path: string, directoryHandle: FileSystemDirectoryHandle): Promise<{ content: FileContent; metadata: FileMetadata }>
  writeFileToOPFS(targetDir: FileSystemDirectoryHandle, path: string, content: ArrayBuffer): Promise<void>
  getFileMetadata(directoryHandle: FileSystemDirectoryHandle, path: string): Promise<{ mtime: number; size: number; contentType: 'text' | 'binary' }>
  isGitIgnoredPath(nativePath: string, directoryHandle: FileSystemDirectoryHandle | null, rootId: string | null, kind?: 'file' | 'directory'): Promise<boolean>
  deleteIgnoredPathImmediately(workspacePath: string, nativePath: string, directoryHandle: FileSystemDirectoryHandle | null, recursive: boolean, resolvedRootId?: string | null): Promise<void>
  collectGitIgnoreRules(nativePath: string, directoryHandle: FileSystemDirectoryHandle): Promise<GitIgnoreRule[]>
  validatePath(path: string): string
  copyFileWithProgress(fileHandle: FileSystemFileHandle, targetDir: FileSystemDirectoryHandle, path: string, onProgress: (progress: number) => void): Promise<void>
  getFileHandle(nativeDir: FileSystemDirectoryHandle, path: string): Promise<FileSystemFileHandle>
}

  /**
   * Read file from workspace
   * @param path File path
   * @param directoryHandle Real filesystem directory handle
   * @param options Read policy options
   * @returns File content and metadata
   */
export async function readFileImpl(
  rt: WorkspaceFileOpsInternals,
  path: string,
  directoryHandle?: FileSystemDirectoryHandle | null,
  options: { policy?: ReadPolicy; projectId?: string | null } = {}
): Promise<{ content: FileContent; metadata: FileMetadata; source: 'native' | 'opfs' }> {
    if (!rt.initialized) await rt.initialize()
    const normalizedPath = rt.normalizeWorkspacePath(path)
    const readPolicy = options.policy ?? 'auto'
    const preferOpfs = readPolicy === 'prefer_opfs'
    const preferNative = readPolicy === 'prefer_native'
    const projectId = options.projectId

    // Multi-root: resolve the correct native handle for this path
    // If directoryHandle is provided, use it (explicit override) but still
    // strip the rootName prefix so nativePath matches the disk layout
    // (otherwise readFromNativeFS misses the file and falls back to OPFS).
    // Otherwise, resolve the per-root handle based on path prefix.
    let nativeHandle: FileSystemDirectoryHandle | null
    let diskRootId: string | null = null
    let nativePath = normalizedPath
    if (directoryHandle) {
      nativeHandle = directoryHandle
      try {
        const resolved = await rt.resolvePath(normalizedPath, projectId)
        nativePath = resolved.relativePath || normalizedPath
      } catch {
        nativePath = normalizedPath
      }
    } else {
      nativeHandle = await rt.getNativeDirectoryHandleForPath(normalizedPath, projectId)
      // Resolve the path relative to the root (strip root prefix for native FS access)
      const resolved = await rt.resolvePath(normalizedPath, projectId)
      nativePath = resolved.relativePath || normalizedPath
      diskRootId = resolved.rootId
    }

    if (diskRootId && preferNative) {
      try {
        const native = await rt.readFromDiskRoot(diskRootId, nativePath)
        return { ...native, source: 'native' }
      } catch {
        // Fallback to OPFS branch below.
      }
    }

    // If path has pending changes, check for conflicts first.
    // If disk mtime differs from OPFS baseline, disk is newer - read disk.
    // This handles the conflict scenario where disk has been updated but OPFS hasn't.
    const isPendingPath = rt.pendingManager.hasPendingPath(normalizedPath)
    if ((nativeHandle || diskRootId) && isPendingPath) {
      let fromFilesDir: {
        content: FileContent
        mtime: number
        size: number
        contentType: 'text' | 'binary'
      } | null = null
      if (rt.hasFileInIndex(normalizedPath)) {
        fromFilesDir = await rt.readFromFilesDir(normalizedPath)
      }

      // If conflict markers are materialized in OPFS, always return OPFS content first
      // so the agent can resolve <<<<<<< / ======= / >>>>>>> markers.
      if (
        fromFilesDir &&
        fromFilesDir.contentType === 'text' &&
        typeof fromFilesDir.content === 'string' &&
        hasConflictMarkers(fromFilesDir.content)
      ) {
        return {
          content: fromFilesDir.content,
          source: 'opfs',
          metadata: {
            path: normalizedPath,
            mtime: fromFilesDir.mtime,
            size: fromFilesDir.size,
            contentType: fromFilesDir.contentType,
          },
        }
      }

      if (!preferOpfs) {
        // Check if disk has been modified since OPFS recorded baseline
        try {
          const diskMeta = diskRootId
            ? await rt.getDiskFileMetadata(diskRootId, nativePath)
            : await rt.getFileMetadata(nativeHandle!, nativePath)
          const pendingChanges = await rt.pendingManager.getAll()
          const pending = pendingChanges.find(
            (p) => rt.normalizeWorkspacePath(p.path) === normalizedPath
          )
          if (pending && pending.fsMtime && diskMeta.mtime > pending.fsMtime) {
            const diskContent = diskRootId
              ? await rt.readFromDiskRoot(diskRootId, nativePath)
              : await rt.readFromNativeFS(nativePath, nativeHandle!)
            const baseline = await rt.readFromBaselineDir(normalizedPath)
            if (baseline) {
              const diskMatchesBaseline = await rt.areFileContentsEqual(baseline.content, diskContent.content)
              if (diskMatchesBaseline) {
                // Migration case: pure-OPFS pending baseline rebased to native view.
                // Keep OPFS draft as source of truth for pending edits.
              } else {
                // Disk is newer than OPFS baseline - disk has been modified externally.
                return {
                  content: diskContent.content,
                  source: 'native',
                  metadata: {
                    path: normalizedPath,
                    mtime: diskMeta.mtime,
                    size: diskMeta.size,
                    contentType: diskMeta.contentType,
                  },
                }
              }
            } else {
              // No baseline snapshot available, keep existing safety behavior and prefer disk.
              return {
                content: diskContent.content,
                source: 'native',
                metadata: {
                  path: normalizedPath,
                  mtime: diskMeta.mtime,
                  size: diskMeta.size,
                  contentType: diskMeta.contentType,
                },
              }
            }
          }
        } catch {
          // Ignore errors, fall through to OPFS read
        }
      }

      // Pending path defaults to OPFS draft content.
      if (fromFilesDir) {
        return {
          content: fromFilesDir.content,
          source: 'opfs',
          metadata: {
            path: normalizedPath,
            mtime: fromFilesDir.mtime,
            size: fromFilesDir.size,
            contentType: fromFilesDir.contentType,
          },
        }
      }
    }

    if ((nativeHandle || diskRootId) && !isPendingPath && !preferOpfs) {
      // For non-pending files, always prefer native disk view so external
      // filesystem changes are visible to tools immediately.
      try {
        const native = diskRootId
          ? await rt.readFromDiskRoot(diskRootId, nativePath)
          : await rt.readFromNativeFS(nativePath, nativeHandle!)
        return { ...native, source: 'native' }
      } catch {
        // Disk read failed (e.g. file only exists in OPFS, not yet synced).
        // Fall through to OPFS read below.
      }
    }

    // Read from files/ only (no native FS available or has pending changes without conflict)
    // Always try readFromFilesDir — files may exist without being in the index
    // (e.g., written directly by Pyodide via /mnt/ mount)
    const fromFilesDir = await rt.readFromFilesDir(normalizedPath)
    if (fromFilesDir) {
      return {
        content: fromFilesDir.content,
        source: 'opfs',
        metadata: {
          path: normalizedPath,
          mtime: fromFilesDir.mtime,
          size: fromFilesDir.size,
          contentType: fromFilesDir.contentType,
        },
      }
    }

    // prefer_opfs can still fall back to native when OPFS body is missing.
    if (nativeHandle || diskRootId) {
      try {
        const native = diskRootId
          ? await rt.readFromDiskRoot(diskRootId, nativePath)
          : await rt.readFromNativeFS(nativePath, nativeHandle!)
        return { ...native, source: 'native' }
      } catch {
        // Fall through to not-found error below.
      }
    }

    throw new Error(`File not found in OPFS workspace: ${normalizedPath}`)
  }

  /**
   * Get file metadata from native filesystem
   */
export async function getFileMetadataImpl(
  rt: WorkspaceFileOpsInternals,
  directoryHandle: FileSystemDirectoryHandle,
  path: string
): Promise<{ mtime: number; size: number; contentType: 'text' | 'binary' }> {
    const rootId = await rt.resolveRootIdForHandle(directoryHandle)
    const stat = await rt.diskExec.stat(rootId, path)
    if (!stat) throw new Error(`File not found: ${path}`)
    return { mtime: stat.mtime, size: stat.size, contentType: stat.contentType }
  }

  /**
   * Read file from native filesystem
   */
export async function readFromNativeFSImpl(
  rt: WorkspaceFileOpsInternals,
  path: string,
  directoryHandle: FileSystemDirectoryHandle
): Promise<{ content: FileContent; metadata: FileMetadata }> {
    const rootId = await rt.resolveRootIdForHandle(directoryHandle)
    const result = await rt.diskExec.read(rootId, path)
    return {
      content: result.content,
      metadata: {
        path,
        mtime: result.stat.mtime,
        size: result.stat.size,
        contentType: result.stat.contentType,
      },
    }
  }

  /**
   * Read file content from files/ directory only (no native FS fallback).
   * Returns null if the file is not in files/.
   */
export async function readCachedFileImpl(
  rt: WorkspaceFileOpsInternals,
  path: string
): Promise<FileContent | null> {
    if (!rt.initialized) await rt.initialize()
    const normalizedPath = rt.normalizeWorkspacePath(path)
    if (!rt.hasFileInIndex(normalizedPath)) {
      return null
    }
    const fromFilesDir = await rt.readFromFilesDir(normalizedPath)
    return fromFilesDir?.content ?? null
  }

  /**
   * Read baseline content from .baseline/ for pending modify/delete comparisons.
   */
export async function readBaselineFileImpl(
  rt: WorkspaceFileOpsInternals,
  path: string
): Promise<FileContent | null> {
    if (!rt.initialized) await rt.initialize()
    const normalizedPath = rt.normalizeWorkspacePath(path)
    const baseline = await rt.readFromBaselineDir(normalizedPath)
    return baseline?.content ?? null
  }

  /**
   * Read a file directly from the native disk (bypassing OPFS cache).
   * Supports BOTH FS Access roots (via directoryHandle) and native-host
   * roots (via diskExec). Used by conflict resolution UI (FileDiffViewer)
   * to show the "本机版本" side of a conflict.
   *
   * Returns null if the file does not exist on disk.
   */
export async function readDiskFileImpl(
  rt: WorkspaceFileOpsInternals,
  path: string
): Promise<FileContent | null> {
    if (!rt.initialized) await rt.initialize()
    const normalizedPath = rt.normalizeWorkspacePath(path)
    try {
      // Try FS Access handle first
      const nativeHandle = await rt.getNativeDirectoryHandleForPath(normalizedPath)
      if (nativeHandle) {
        const resolved = await rt.resolvePath(normalizedPath)
        const nativePath = resolved.relativePath || normalizedPath
        const fromNative = await rt.readFromNativeFS(nativePath, nativeHandle)
        return fromNative.content
      }
      // Fall back to native-host executor
      const resolved = await rt.resolvePath(normalizedPath).catch(() => null)
      if (resolved?.rootId) {
        const nativePath = resolved.relativePath || normalizedPath
        const fromDisk = await rt.readFromDiskRoot(resolved.rootId, nativePath)
        return fromDisk.content
      }
      return null
    } catch (err: unknown) {
      const errorName = err && typeof err === 'object' && 'name' in err ? (err as { name: string }).name : undefined
      if (errorName === 'NotFoundError') return null
      // NativeHostExecutor throws NotFoundError for missing files
      if (err instanceof Error && err.message.includes('not found')) return null
      throw err
    }
  }

  /**
   * Check if a file exists on the native disk (bypassing OPFS cache).
   * Supports BOTH FS Access roots and native-host roots.
   * Used by conflict resolution UI to decide whether to show disk version.
   */
export async function fileExistsOnDiskImpl(
  rt: WorkspaceFileOpsInternals,
  path: string
): Promise<boolean> {
    if (!rt.initialized) await rt.initialize()
    const normalizedPath = rt.normalizeWorkspacePath(path)
    try {
      const nativeHandle = await rt.getNativeDirectoryHandleForPath(normalizedPath)
      if (nativeHandle) {
        const resolved = await rt.resolvePath(normalizedPath)
        const nativePath = resolved.relativePath || normalizedPath
        const stat = await rt.diskExec.stat(await rt.resolveRootIdForHandle(nativeHandle), nativePath)
        return stat !== null
      }
      const resolved = await rt.resolvePath(normalizedPath).catch(() => null)
      if (resolved?.rootId) {
        const nativePath = resolved.relativePath || normalizedPath
        const stat = await rt.diskExec.stat(resolved.rootId, nativePath)
        return stat !== null
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * Write file to workspace (files/ + pending)
   * @param path File path
   * @param content File content
   * @param directoryHandle Real filesystem directory handle (for mtime baseline)
   */
export async function writeFileImpl(
  rt: WorkspaceFileOpsInternals,
  path: string,
  content: FileContent,
  directoryHandle?: FileSystemDirectoryHandle | null,
  projectId?: string | null
): Promise<void> {
    if (!rt.initialized) await rt.initialize()
    const normalizedPath = rt.normalizeWorkspacePath(path)

    // Pure OPFS mode: no native directory mounted and caller didn't pass one.
    // Skip pending queue, baseline capture, conflict detection — just write to OPFS.
    if (directoryHandle == null && !(await rt.hasAnyNativeDirectoryHandle())) {
      await rt.writeToFilesDir(normalizedPath, content)
      rt.filesIndex.add(normalizedPath)
      try {
        const channel = new BroadcastChannel('opfs-file-changes')
        channel.postMessage({ type: 'opfs-file-changed', path: normalizedPath })
        channel.close()
      } catch (e) {
        console.warn('[WorkspaceRuntime] Failed to broadcast file change:', e)
      }
      rt.metadata.lastAccessedAt = Date.now()
      await rt.saveMetadata()
      return
    }

    // Multi-root: resolve the correct native handle for this path
    let nativeHandle: FileSystemDirectoryHandle | null
    let diskRootId: string | null = null
    let nativePath = normalizedPath
    if (directoryHandle) {
      nativeHandle = directoryHandle
      // Strip rootName prefix so nativePath matches disk layout. Without this,
      // readFromNativeFS throws NotFoundError → baselineFsMtime falls back to
      // the OPFS mtime → false conflict in detect_conflicts (disk mtime ≠ OPFS
      // mtime). Agent write/edit pass null so were unaffected; only callers
      // passing a directoryHandle (FilePreview saves, git restore) hit rt.
      try {
        const resolved = await rt.resolvePath(normalizedPath, projectId)
        nativePath = resolved.relativePath || normalizedPath
      } catch {
        nativePath = normalizedPath
      }
    } else {
      nativeHandle = await rt.getNativeDirectoryHandleForPath(normalizedPath, projectId)
      const resolved = await rt.resolvePath(normalizedPath, projectId)
      nativePath = resolved.relativePath || normalizedPath
      diskRootId = resolved.rootId
    }

    // Get baseline mtime for conflict detection
    // Also track if this is a new file (not in files/ index and not in native FS)
    let baselineFsMtime = 0
    let isNewFile = false
    let baselineContent: FileContent | null = null
    try {
      if (nativeHandle || diskRootId) {
        // Always use native mtime as conflict baseline when directory handle is available.
        // OPFS cache mtime can diverge from native disk mtime after prior approvals/syncs.
        const fromNative = diskRootId
          ? await rt.readFromDiskRoot(diskRootId, nativePath)
          : await rt.readFromNativeFS(nativePath, nativeHandle!)
        baselineFsMtime = fromNative.metadata.mtime
        baselineContent = fromNative.content
      } else {
        // No directoryHandle (pure OPFS mode): check if file exists in filesIndex
        // If not in index, this is a new file
        if (!rt.hasFileInIndex(normalizedPath)) {
          isNewFile = true
        } else {
          // File exists in index, get mtime from files/
          const fromFiles = await rt.readFromFilesDir(normalizedPath)
          if (fromFiles) {
            baselineFsMtime = fromFiles.mtime
            baselineContent = fromFiles.content
          }
        }
      }
    } catch (err) {
      // Only treat as new file if the error is NotFoundError
      // Other errors (permission, IO, etc.) should be propagated
      const errorName = err && typeof err === 'object' && 'name' in err ? (err as { name: string }).name : undefined
      if (errorName === 'NotFoundError') {
        // File not found on native disk — but it may exist in OPFS as an
        // uncommitted pending change (e.g. LLM created it, not yet synced).
        // Fall back to OPFS filesIndex to determine new-vs-modify.
        if (rt.hasFileInIndex(normalizedPath)) {
          // File exists in OPFS cache → this is a modification, not a new file.
          const fromFiles = await rt.readFromFilesDir(normalizedPath)
          if (fromFiles) {
            baselineFsMtime = fromFiles.mtime
            baselineContent = fromFiles.content
          } else {
            // Index hit but read failed — rare (index/file/dir out of sync).
            // Fall back to snapshot history before giving up: if this path
            // existed in any prior committed snapshot, the write is an
            // overwrite and must be classified as `modify`, not `create`.
            const fromHistory = await rt.tryLoadFromSnapshotHistory(normalizedPath)
            if (fromHistory !== null) {
              baselineContent = fromHistory
              // isNewFile is already false (we got here from the !isNewFile
              // branch above), but be explicit for clarity.
              isNewFile = false
            } else {
              console.warn(`[WorkspaceRuntime] hasFileInIndex hit but readFromFilesDir returned null for ${normalizedPath}`)
            }
          }
        } else {
          // Not in OPFS cache AND not on native disk. Default assumption is
          // "new file", BUT first check the workspace's snapshot history:
          // if this path existed in any prior committed snapshot, the write
          // is an overwrite (modify) and the snapshot's after-content is
          // the real baseline.
          const fromHistory = await rt.tryLoadFromSnapshotHistory(normalizedPath)
          if (fromHistory !== null) {
            baselineContent = fromHistory
            isNewFile = false
          } else {
            isNewFile = true
            baselineFsMtime = 0
          }
        }
      } else {
        throw err
      }
    }

    // Detect if the OLD content in files/ has conflict markers (from a prior
    // detectSyncConflicts materialization). If so, this edit is resolving a
    // conflict — update the baseline mtime and content to match the current DISK version.
    let resolvingConflict = false
    if (
      !isNewFile &&
      baselineContent !== null &&
      (nativeHandle || diskRootId) &&
      typeof content === 'string' &&
      baselineFsMtime > 0
    ) {
      try {
        const oldFilesContent = await rt.readFromFilesDir(normalizedPath)
        if (
          oldFilesContent &&
          oldFilesContent.contentType === 'text' &&
          typeof oldFilesContent.content === 'string' &&
          hasConflictMarkers(oldFilesContent.content)
        ) {
          resolvingConflict = true
        }
      } catch {
        // Best effort detection
      }
    }

    // Ghost change dedup: if the content to be written is identical to the
    // baseline (disk/native version, or current OPFS files/ content in pure
    // OPFS mode), there is no real change. Skip all write operations and
    // clean up any prior ghost pending entry + stale baseline snapshot.
    // Check BEFORE write to avoid redundant I/O and spurious notifications.
    if (!isNewFile && baselineContent !== null) {
      const contentsMatch = await rt.areFileContentsEqual(baselineContent, content)
      if (contentsMatch) {
        if (rt.pendingManager.hasPendingPath(normalizedPath)) {
          await rt.pendingManager.removeByPath(normalizedPath)
          await rt.deleteFromBaselineDirIfExists(normalizedPath)
        }
        // If files/ contains conflict markers from a prior materialization,
        // replace them with the clean baseline content so other tabs/readers
        // no longer see stale conflict markers.
        if (resolvingConflict) {
          await rt.writeToFilesDir(normalizedPath, content)
        }
        console.log(`[WorkspaceRuntime] Skipping no-op write (content matches baseline): ${normalizedPath}`)
        rt.metadata.lastAccessedAt = Date.now()
        await rt.saveMetadata()
        return
      }
    }

    if (!isNewFile && baselineContent !== null) {
      await rt.captureModifyBaseline(normalizedPath, baselineContent, resolvingConflict)
    }

    // Write to files/ directory
    await rt.writeToFilesDir(normalizedPath, content)
    rt.filesIndex.add(normalizedPath)

    // Notify other tabs about the file change
    try {
      const channel = new BroadcastChannel('opfs-file-changes')
      channel.postMessage({ type: 'opfs-file-changed', path: normalizedPath })
      channel.close()
    } catch (e) {
      console.warn('[WorkspaceRuntime] Failed to broadcast file change:', e)
    }

    // Mark as pending - use markAsCreated for new files, add for modifications
    if (isNewFile) {
      await rt.pendingManager.markAsCreated(normalizedPath, baselineFsMtime)
    } else {
      await rt.pendingManager.add(normalizedPath, baselineFsMtime, {
        forceUpdateMtime: resolvingConflict,
      })
    }

    // Update last accessed time
    rt.metadata.lastAccessedAt = Date.now()
    await rt.saveMetadata()
  }

  /**
   * Delete file from workspace
   * @param path File path
   * @param directoryHandle Real filesystem directory handle (for mtime baseline)
   */
export async function deleteFileImpl(
  rt: WorkspaceFileOpsInternals,
  path: string,
  directoryHandle?: FileSystemDirectoryHandle | null,
  projectId?: string | null
): Promise<void> {
    if (!rt.initialized) await rt.initialize()

    const normalizedPath = rt.normalizeWorkspacePath(path)

    // Pure OPFS mode: no native directory mounted and caller didn't pass one.
    // Skip pending queue and baseline capture — just remove from OPFS.
    if (directoryHandle == null && !(await rt.hasAnyNativeDirectoryHandle())) {
      await rt.deleteFromFilesDir(normalizedPath)
      rt.filesIndex.delete(normalizedPath)
      rt.metadata.lastAccessedAt = Date.now()
      await rt.saveMetadata()
      return
    }

    // Multi-root: resolve the correct native handle for this path
    let nativeHandle: FileSystemDirectoryHandle | null
    let nativePath = normalizedPath
    let rootId: string | null = null
    if (directoryHandle) {
      nativeHandle = directoryHandle
      try {
        const resolved = await rt.resolvePath(normalizedPath, projectId)
        nativePath = resolved.relativePath || normalizedPath
        rootId = resolved.rootId
      } catch {
        nativePath = normalizedPath
      }
    } else {
      nativeHandle = await rt.getNativeDirectoryHandleForPath(normalizedPath, projectId)
      const resolved = await rt.resolvePath(normalizedPath, projectId)
      nativePath = resolved.relativePath || normalizedPath
      rootId = resolved.rootId
    }

    const pendingEntry = rt.pendingManager
      .getAll()
      .find((change) => rt.normalizeWorkspacePath(change.path) === normalizedPath)

    if (await rt.isGitIgnoredPath(nativePath, nativeHandle, rootId, 'file')) {
      await rt.deleteIgnoredPathImmediately(normalizedPath, nativePath, nativeHandle, false, rootId)
      return
    }

    // Get baseline mtime for conflict detection
    let baselineFsMtime = 0
    let baselineContent: FileContent | null = null
    try {
      if (nativeHandle) {
        const oldData = await rt.readFromNativeFS(nativePath, nativeHandle)
        baselineFsMtime = oldData.metadata.mtime || 0
        baselineContent = oldData.content
      } else if (rt.hasFileInIndex(normalizedPath)) {
        const fromFiles = await rt.readFromFilesDir(normalizedPath)
        if (fromFiles) {
          baselineContent = fromFiles.content
        }
      }
    } catch {
      // File doesn't exist
    }

    // Keep rollback source for delete rejection in pure OPFS mode.
    // Skip create->delete cancel-out cycles since no committed baseline is needed.
    if (pendingEntry?.type !== 'create' && baselineContent !== null) {
      await rt.captureModifyBaseline(normalizedPath, baselineContent)
    } else if (pendingEntry?.type === 'create') {
      await rt.deleteFromBaselineDirIfExists(normalizedPath)
    }

    // Delete from files/ directory
    await rt.deleteFromFilesDir(normalizedPath)
    rt.filesIndex.delete(normalizedPath)

    // Mark as pending for deletion
    await rt.pendingManager.markForDeletion(normalizedPath, baselineFsMtime)

    // Update last accessed time
    rt.metadata.lastAccessedAt = Date.now()
    await rt.saveMetadata()
  }

  /**
   * Mark a DIRECTORY for deletion as a pending change, without touching any
   * file. Mirrors deleteFile()'s pending pipeline but for directory paths.
   *
   * Why this exists: deleteDir() in the workspace backend deletes files one by
   * one (each producing its own pending 'delete' record), but directories that
   * contain no files produced ZERO records — so empty directory trees on disk
   * could never be cleaned up by sync (pruneEmptyParents only fires when a
   * file record exists as the anchor). Recording the directory path itself as
   * a pending delete closes that gap; sync executes idempotent deletes that
   * also handle empty directories (FS Access removeEntry / native-host
   * delete_file are both directory-capable and idempotent).
   *
   * Semantics:
   * - The path is expected to be an empty (or empty-in-OPFS) directory on
   *   disk. fsMtime is recorded as 0 so conflict detection is skipped
   *   (directories have no meaningful baseline mtime in this model).
   * - Callers should record deepest-first ordering (children before parents)
   *   so sync executes bottom-up.
   * - Rollback (discard/reject) treats it as a ghost delete: no baseline
   *   exists, so the record is simply dropped and nothing is restored —
   *   correct, because no file data was ever removed.
   * - Idempotent with respect to files/: there is no OPFS files/ entry for a
   *   directory, and markForDeletion on a fresh path just creates a record.
   */
export async function deleteDirPendingImpl(
  rt: WorkspaceFileOpsInternals,
  path: string,
  directoryHandle?: FileSystemDirectoryHandle | null,
  _projectId?: string | null
): Promise<void> {
    if (!rt.initialized) await rt.initialize()

    const normalizedPath = rt.normalizeWorkspacePath(path)

    // Pure OPFS mode: no native root mounted — nothing on disk to delete, and
    // no pending record is meaningful. Still prune the OPFS files/ side as a
    // best-effort (no-op when the directory has no files/ representation).
    if (directoryHandle == null && !(await rt.hasAnyNativeDirectoryHandle())) {
      try {
        await rt.deleteFromFilesDirIfExists(normalizedPath)
      } catch {
        // Directory has no files/ representation — expected, ignore.
      }
      return
    }

    const resolved = await rt.resolvePath(normalizedPath, _projectId)
    const nativeHandle = directoryHandle ?? await rt.getNativeDirectoryHandleForPath(normalizedPath, _projectId)
    const nativePath = resolved.relativePath || normalizedPath

    if (await rt.isGitIgnoredPath(nativePath, nativeHandle, resolved.rootId)) {
      await rt.deleteIgnoredPathImmediately(normalizedPath, nativePath, nativeHandle, true, resolved.rootId)
      return
    }

    // Mark the directory path itself as pending deletion.
    // fsMtime = 0 → sync's conflict check is skipped for this record.
    await rt.pendingManager.markForDeletion(normalizedPath, 0, { deleteMode: 'tree' })

    rt.metadata.lastAccessedAt = Date.now()
    await rt.saveMetadata()
  }

export async function materializeTextConflictMarkersImpl(
  rt: WorkspaceFileOpsInternals,
  directoryHandle: FileSystemDirectoryHandle | null,
  conflicts: SyncResult['conflicts']
): Promise<void> {
    for (const conflict of conflicts) {
      const path = rt.normalizeWorkspacePath(conflict.path)
      try {
        const fromFiles = await rt.readFromFilesDir(path)
        if (!fromFiles || fromFiles.contentType !== 'text' || typeof fromFiles.content !== 'string') {
          continue
        }
        if (hasConflictMarkers(fromFiles.content)) {
          continue
        }

        // Resolve to correct root and strip prefix for native FS read
        const resolved = await rt.resolvePath(path)
        const nativePath = resolved.relativePath || path

        // Try FS Access handle first (if available), then fall back to executor
        // for native-host roots (which have no FileSystemDirectoryHandle).
        const nativeHandle = (await rt.getNativeDirectoryHandleForPath(path)) ?? directoryHandle
        let nativeContent: string | null = null

        if (nativeHandle) {
          const fromNative = await rt.readFromNativeFS(nativePath, nativeHandle)
          if (fromNative.metadata.contentType !== 'text' || typeof fromNative.content !== 'string') {
            continue
          }
          nativeContent = fromNative.content
        } else if (resolved.rootId) {
          // Native-host root: read directly via executor (no handle available)
          const readResult = await rt.diskExec.read(resolved.rootId, nativePath)
          if (readResult.stat.contentType !== 'text') {
            continue
          }
          nativeContent = typeof readResult.content === 'string'
            ? readResult.content
            : new TextDecoder().decode(readResult.content)
        } else {
          continue
        }

        const merged = buildConflictMarkerContent(fromFiles.content, nativeContent)
        await rt.writeToFilesDir(path, merged)
      } catch {
        // Best effort: leave conflict unresolved if marker materialization fails.
      }
    }
  }

export async function restorePendingModifyFromNativeImpl(
  rt: WorkspaceFileOpsInternals,
  path: string
): Promise<boolean> {
    // Multi-root: resolve the correct handle for this path
    const nativeDir = await rt.getNativeDirectoryHandleForPath(path)
    if (!nativeDir) return false
    try {
      const resolved = await rt.resolvePath(path)
      const nativePath = resolved.relativePath || path
      const native = await rt.readFromNativeFS(nativePath, nativeDir)
      await rt.writeToFilesDir(path, native.content)
      return true
    } catch {
      return false
    }
  }

  /**
   * Check whether a .baseline copy exists for the given path.
   * Used by discardPendingPath to distinguish "file never existed on disk"
   * from "file existed but baseline capture failed / was lost".
   */
export async function hasBaselineFileImpl(
  rt: WorkspaceFileOpsInternals,
  path: string
): Promise<boolean> {
    try {
      const parts = path.split('/').filter(Boolean)
      if (parts.length === 0) return false
      let current = await rt.workspaceDir.getDirectoryHandle(BASELINE_DIR)
      for (let i = 0; i < parts.length - 1; i++) {
        current = await current.getDirectoryHandle(parts[i])
      }
      await current.getFileHandle(parts[parts.length - 1])
      return true
    } catch {
      return false
    }
  }

  /** Read applicable .gitignore files from an FS Access root, root-first. */
export async function collectGitIgnoreRulesImpl(
  _rt: WorkspaceFileOpsInternals,
  nativePath: string,
  directoryHandle: FileSystemDirectoryHandle
): Promise<GitIgnoreRule[]> {
    const segments = nativePath.split('/').filter(Boolean)
    const directories = segments.slice(0, -1)
    const rules: GitIgnoreRule[] = []
    let current = directoryHandle
    let baseDir = ''

    for (let i = 0; i <= directories.length; i++) {
      try {
        const ignoreHandle = await current.getFileHandle('.gitignore')
        const ignoreFile = await ignoreHandle.getFile()
        rules.push(...parseGitIgnore(await ignoreFile.text(), baseDir))
      } catch {
        // A .gitignore at this level is optional.
      }

      const segment = directories[i]
      if (!segment) continue
      try {
        current = await current.getDirectoryHandle(segment)
        baseDir = baseDir ? `${baseDir}/${segment}` : segment
      } catch {
        break
      }
    }

    return rules
  }

  /** Whether a root-relative path matches its applicable .gitignore rules. */
export async function isGitIgnoredPathImpl(
  rt: WorkspaceFileOpsInternals,
  nativePath: string,
  directoryHandle: FileSystemDirectoryHandle | null,
  rootId: string | null,
  kind: 'file' | 'directory' = 'directory'
): Promise<boolean> {
    if (!nativePath) return false
    if (directoryHandle) {
      return isGitIgnored(nativePath, await rt.collectGitIgnoreRules(nativePath, directoryHandle), kind)
    }
    if (!rootId) return false

    const directories = nativePath.split('/').filter(Boolean).slice(0, -1)
    const rules: GitIgnoreRule[] = []
    let baseDir = ''
    for (let i = 0; i <= directories.length; i++) {
      const ignorePath = baseDir ? `${baseDir}/.gitignore` : '.gitignore'
      try {
        const result = await rt.diskExec.read(rootId, ignorePath)
        if (typeof result.content === 'string') {
          rules.push(...parseGitIgnore(result.content, baseDir))
        }
      } catch {
        // A .gitignore at this level is optional or unreadable.
      }
      const segment = directories[i]
      if (segment) baseDir = baseDir ? `${baseDir}/${segment}` : segment
    }
    return isGitIgnored(nativePath, rules, kind)
  }

  /**
   * Bypass the overlay for ignored build/dependency paths. Delete the local
   * disk entry first; only then remove its OPFS mirror and pending record.
   */
export async function deleteIgnoredPathImmediatelyImpl(
  rt: WorkspaceFileOpsInternals,
  workspacePath: string,
  nativePath: string,
  directoryHandle: FileSystemDirectoryHandle | null,
  recursive: boolean,
  resolvedRootId?: string | null
): Promise<void> {
    if (!directoryHandle && !resolvedRootId) {
      throw new Error(`Cannot immediately delete ignored path without disk access: ${workspacePath}`)
    }

    const rootId = resolvedRootId ?? await rt.resolveRootIdForHandle(directoryHandle!)
    await rt.diskExec.delete(rootId, nativePath, {
      pruneEmptyParents: true,
      recursive,
    })

    await rt.deleteFromFilesDirIfExists(workspacePath)
    rt.filesIndex.delete(workspacePath)
    await rt.pendingManager.removeByPath(workspacePath)
    rt.metadata.lastAccessedAt = Date.now()
    await rt.saveMetadata()
  }

  /**
   * Validate file path format
   * Rules:
   * - Must start with /mnt/
   * - Use / separator (no backslashes)
   * - No .. or . path components
   * @param path File path to validate
   * @returns Validated normalized path or throws error
   */
export function validatePathImpl(_rt: WorkspaceFileOpsInternals, path: string): string {
    // Check for empty path
    if (!path || path.trim().length === 0) {
      throw new Error('文件路径不能为空')
    }

    // Normalize path separators
    let normalized = path.replace(/\\/g, '/')

    // Check for .. or . components
    const parts = normalized.split('/')
    if (parts.some((p) => p === '..' || p === '.')) {
      throw new Error('文件路径不能包含 .. 或 .')
    }

    // Remove leading /mnt/ if present for internal use
    if (normalized.startsWith('/mnt/')) {
      normalized = normalized.substring(5) // Remove /mnt/
    } else if (normalized.startsWith('/mnt')) {
      normalized = normalized.substring(5) // Remove /mnt
    } else if (!normalized.startsWith('/')) {
      throw new Error('文件路径必须以 /mnt/ 开头')
    }

    return normalized
  }

  /**
   * Prepare files: Copy from Native FS to OPFS files/
   * @param files File path list (relative to workspace root)
   * @param onProgress Optional progress callback for large files
   * @throws Error if file doesn't exist or path is invalid
   */
export async function prepareFilesImpl(
  rt: WorkspaceFileOpsInternals,
  files: string[],
  onProgress?: (file: string, progress: number) => void
): Promise<void> {
    if (!rt.initialized) await rt.initialize()

    const opfsFilesDir = await rt.getFilesDir()

    // Multi-root: resolve each file's path to the correct root
    const allHandles = await rt.getAllNativeDirectoryHandles()
    const hasDiskRoot = await rt.hasAnyNativeDirectoryHandle()

    for (const filePath of files) {
      try {
        // Validate and normalize path
        const normalizedPath = rt.validatePath(filePath)

        // Resolve the native handle / disk root for this file's path
        const resolved = await rt.resolvePath(normalizedPath)
        const nativePath = resolved.relativePath || normalizedPath

        if (resolved.rootId && resolved.backend === 'native-host') {
          // ---- Native host root: read via executor ----
          const result = await rt.diskExec.read(resolved.rootId, nativePath)
          const content = typeof result.content === 'string'
            ? new TextEncoder().encode(result.content).buffer as ArrayBuffer
            : result.content
          await rt.writeFileToOPFS(opfsFilesDir, normalizedPath, content)
        } else {
          // ---- FS Access root: use handle directly ----
          let nativeDir: FileSystemDirectoryHandle
          if (allHandles.size > 0) {
            const handle = allHandles.get(resolved.rootName)
            if (!handle) {
              throw new Error(`未找到项目文件夹 "${resolved.rootName}" 的目录句柄`)
            }
            nativeDir = handle
          } else if (!hasDiskRoot) {
            throw new Error('未设置 Native FS 目录句柄，请先选择项目目录')
          } else {
            throw new Error(`未找到项目文件夹 "${resolved.rootName}" 的磁盘根`)
          }

          const fileHandle = await rt.getFileHandle(nativeDir, nativePath)
          const file = await fileHandle.getFile()
          const size = file.size

          // Check if large file (>50MB)
          const LARGE_FILE_THRESHOLD = 50 * 1024 * 1024
          if (size > LARGE_FILE_THRESHOLD && onProgress) {
            await rt.copyFileWithProgress(
              fileHandle,
              opfsFilesDir,
              normalizedPath,
              (progress) => onProgress(filePath, progress)
            )
          } else {
            // Direct copy for small files
            const content = await file.arrayBuffer()
            await rt.writeFileToOPFS(opfsFilesDir, normalizedPath, content)
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`准备文件 ${filePath} 失败: ${message}`)
      }
    }
  }

  /**
   * Copy file with progress tracking
   */
export async function copyFileWithProgressImpl(
  _rt: WorkspaceFileOpsInternals,
  fileHandle: FileSystemFileHandle,
  targetDir: FileSystemDirectoryHandle,
  path: string,
  onProgress: (progress: number) => void
): Promise<void> {
    const file = await fileHandle.getFile()
    const size = file.size
    const chunkSize = 1024 * 1024 // 1MB chunks
    let offset = 0

    // Create target file
    const parts = path.split('/')
    const fileName = parts[parts.length - 1]
    let currentDir = targetDir

    for (let i = 0; i < parts.length - 1; i++) {
      if (!parts[i]) continue
      try {
        currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true })
      } catch {
        throw new Error(`创建目录 ${parts[i]} 失败`)
      }
    }

    const targetFile = await currentDir.getFileHandle(fileName, { create: true })
    const writable = await targetFile.createWritable()

    // Read and write in chunks
    while (offset < size) {
      const chunk = file.slice(offset, offset + chunkSize)
      const buffer = await chunk.arrayBuffer()
      await writable.write({ type: 'write', data: buffer, position: offset })

      offset += buffer.byteLength
      onProgress(Math.round((offset / size) * 100))
    }

    await writable.close()
  }

  /**
   * Write file to OPFS
   */
export async function writeFileToOPFSImpl(
  _rt: WorkspaceFileOpsInternals,
  targetDir: FileSystemDirectoryHandle,
  path: string,
  content: ArrayBuffer
): Promise<void> {
    const parts = path.split('/')
    const fileName = parts[parts.length - 1]
    let currentDir = targetDir

    // Create directories if needed
    for (let i = 0; i < parts.length - 1; i++) {
      if (!parts[i]) continue
      try {
        currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true })
      } catch {
        throw new Error(`创建目录 ${parts[i]} 失败`)
      }
    }

    // Write file
    const targetFile = await currentDir.getFileHandle(fileName, { create: true })
    const writable = await targetFile.createWritable()
    await writable.write(content)
    await writable.close()
  }