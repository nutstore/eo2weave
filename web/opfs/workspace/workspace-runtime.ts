/**
 * Workspace Runtime
 *
 * Encapsulates a single workspace's OPFS operations.
 * Coordinates pending queue for file operations.
 * Undo/redo is handled by SQLite fs_snapshot_files table.
 */

import type {
  FileContent,
  FileMetadata,
  PendingChange,
  SyncResult,
  FileScanItem,
  FileChange,
  ChangeDetectionResult,
  ErrorDetail,
  SystemLog,
  ConflictInfo,
  ReadPolicy,
} from '../types/opfs-types'
import { ErrorCode } from '../types/opfs-types'
import { WorkspacePendingManager } from './workspace-pending'
import { scanFilesInWorker } from '@/workers/diff-worker-manager'
import { getRuntimeDirectoryHandle } from '@/native-fs'
import { getFSOverlayRepository } from '@/sqlite/repositories/fs-overlay.repository'
import type { DiskExecutor } from '../native-disk/executor'
import { FSAccessExecutor } from '../native-disk/executor-fsaccess'
import type { GitIgnoreRule } from '../native-disk/gitignore-policy'
import {
  type ResolvedRoot,
  type WorkspaceRuntimeInternals,
  resolveProjectIdImpl,
  ensureRootMapImpl,
  resolvePathImpl,
  isReadOnlyRootImpl,
  invalidateRootCacheImpl,
  getNativeDirectoryHandleForPathImpl,
  getAllNativeDirectoryHandlesImpl,
  hasAnyNativeDirectoryHandleImpl,
  listDiskDirImpl,
  scanDiskTreeImpl,
  readFromDiskRootImpl,
  getDiskFileMetadataImpl,
  resolveRootIdForHandleImpl,
  readNativeFileContentForPathImpl,
  readNativeFileContentImpl,
  writeNativeFileImpl,
} from './workspace-multiroot'
import {
  type WorkspaceFilesDirInternals,
  buildFilesIndexImpl,
  scanDirRecursiveImpl,
  readFromFilesDirImpl,
  writeToFilesDirImpl,
  deleteFromFilesDirImpl,
  deleteFromFilesDirIfExistsImpl,
  readFromBaselineDirImpl,
  contentToBytesImpl,
  areFileContentsEqualImpl,
  writeToBaselineDirImpl,
  deleteFromBaselineDirIfExistsImpl,
  captureModifyBaselineImpl,
  tryLoadFromSnapshotHistoryImpl,
  restorePendingModifyFromBaselineImpl,
  listBaselinePathsImpl,
  cleanupStaleBaselinesImpl,
  rebuildFilesIndexImpl,
  hasFileInIndexImpl,
  getIndexedPathsImpl,
  clearFilesDirImpl,
  clearBaselineDirImpl,
  getFilesStatsImpl,
  calculateDirStatsImpl,
  getFilesDirImpl,
  getAssetsDirImpl,
  getBaselineDirImpl,
} from './workspace-files-dir'
import {
  type WorkspaceChangeDetectionInternals,
  scanFilesImpl,
  detectChangesImpl,
  scanFilesWithCacheImpl,
  refreshPendingChangesImpl,
  registerDetectedChangesImpl,
} from './workspace-change-detection'
import {
  type WorkspaceFileOpsInternals,
  readFileImpl,
  getFileMetadataImpl,
  readFromNativeFSImpl,
  readCachedFileImpl,
  readBaselineFileImpl,
  readDiskFileImpl,
  fileExistsOnDiskImpl,
  writeFileImpl,
  deleteFileImpl,
  deleteDirPendingImpl,
  materializeTextConflictMarkersImpl,
  restorePendingModifyFromNativeImpl,
  hasBaselineFileImpl,
  collectGitIgnoreRulesImpl,
  isGitIgnoredPathImpl,
  deleteIgnoredPathImmediatelyImpl,
  validatePathImpl,
  prepareFilesImpl,
  copyFileWithProgressImpl,
  writeFileToOPFSImpl,
} from './workspace-file-ops'

const WORKSPACE_METADATA_FILE = 'workspace.json'

/**
 * Workspace metadata for persistence.
 */
interface WorkspaceMetadataPersist {
  workspaceId: string
  createdAt: number
  lastAccessedAt: number
  rootDirectory: string
}

/**
 * Workspace Runtime
 *
 * Responsibilities:
 * - Encapsulate single workspace's OPFS operations
 * - Coordinate pending queue for file operations
 * - All file content is stored directly in files/ directory
 * - Undo/redo handled by SQLite fs_snapshot_files
 */
export class WorkspaceRuntime {
  readonly workspaceId: string
  readonly workspaceDir: FileSystemDirectoryHandle
  readonly rootDirectory: string

  private readonly pendingManager: WorkspacePendingManager

  /** In-memory index of files stored in files/ directory */
  private filesIndex: Set<string> = new Set()

  private initialized = false
  private metadata: WorkspaceMetadataPersist

  /**
   * Cached projectId for this workspace, resolved from DB.
   * Avoids repeated DB queries and prevents falling through to
   * the global activeProject pointer (which may point to a different project
   * when the user switches browser tabs mid-conversation).
   */
  // Public (underscore-prefixed) so workspace-multiroot.ts impls can access
  // them via the WorkspaceRuntimeInternals bridge interface.
  _cachedProjectId: string | null | undefined = undefined

  /**
   * Multi-root mapping for this workspace's project.
   * Populated lazily on first access via resolvePath().
   * Key = rootName, value = persisted disk root routing metadata.
   * When null, no project_roots entries exist yet.
   */
  _rootMap: Map<string, {
    readOnly: boolean
    isDefault: boolean
    backend: 'fsaccess' | 'native-host'
    rootId: string | null
  }> | null = null
  _rootMapProjectId: string | null = null

  /**
   * Disk executor — prepared for Native Host injection. OPFS-internal
   * operations continue to use `workspaceDir` directly.
   */
  private readonly diskExec: DiskExecutor

  constructor(
    workspaceId: string,
    workspaceDir: FileSystemDirectoryHandle,
    rootDirectory: string,
    diskExec?: DiskExecutor
  ) {
    this.workspaceId = workspaceId
    this.workspaceDir = workspaceDir
    this.rootDirectory = rootDirectory

    this.diskExec = diskExec ?? new FSAccessExecutor()

    // Initialize pending manager (files/ is the source of truth)
    this.pendingManager = new WorkspacePendingManager(workspaceId, workspaceDir)

    // Initial metadata
    this.metadata = {
      workspaceId,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      rootDirectory,
    }
  }

  /**
   * Initialize workspace runtime
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    // Load or create metadata
    await this.loadMetadata()

    // Initialize pending manager
    await this.pendingManager.initialize()

    // Build files index from existing files/ directory
    await this.buildFilesIndex()

    // Update last accessed time
    this.metadata.lastAccessedAt = Date.now()
    await this.saveMetadata()

    this.initialized = true
  }

  /**
   * Load workspace metadata from OPFS
   */
  private async loadMetadata(): Promise<void> {
    const toMetadata = (data: unknown): WorkspaceMetadataPersist => {
      const obj = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
      const persistedWorkspaceId =
        typeof obj.workspaceId === 'string'
          ? obj.workspaceId
          : this.workspaceId
      const createdAt = typeof obj.createdAt === 'number' ? obj.createdAt : Date.now()
      const lastAccessedAt = typeof obj.lastAccessedAt === 'number' ? obj.lastAccessedAt : createdAt
      const rootDirectory =
        typeof obj.rootDirectory === 'string' && obj.rootDirectory.length > 0
          ? obj.rootDirectory
          : this.rootDirectory

      return {
        workspaceId: persistedWorkspaceId,
        createdAt,
        lastAccessedAt,
        rootDirectory,
      }
    }

    try {
      const metadataFile = await this.workspaceDir.getFileHandle(WORKSPACE_METADATA_FILE)
      const file = await metadataFile.getFile()
      const text = await file.text()
      this.metadata = toMetadata(JSON.parse(text))
    } catch {
      // Metadata doesn't exist yet, will be created on first save.
      this.metadata = {
        workspaceId: this.workspaceId,
        createdAt: Date.now(),
        lastAccessedAt: Date.now(),
        rootDirectory: this.rootDirectory,
      }
    }
  }

  /**
   * Save workspace metadata to OPFS
   */
  private async saveMetadata(): Promise<void> {
    const metadataFile = await this.workspaceDir.getFileHandle(WORKSPACE_METADATA_FILE, {
      create: true,
    })
    const writable = await metadataFile.createWritable()
    const dataToPersist: WorkspaceMetadataPersist = {
      workspaceId: this.workspaceId,
      createdAt: this.metadata.createdAt,
      lastAccessedAt: this.metadata.lastAccessedAt,
      rootDirectory: this.metadata.rootDirectory,
    }
    await writable.write(JSON.stringify(dataToPersist, null, 2))
    await writable.close()
  }

  // ============ Files Directory Operations (replaces cache) ============
  //
  // Implementations live in workspace-files-dir.ts as standalone *Impl
  // functions; the class methods below are one-line delegates. Cross-method
  // calls dispatch through the instance (rt.method()) so instance-level
  // overrides keep working exactly as before extraction.

  /**
   * Build in-memory index of files in files/ directory
   */
  private buildFilesIndex(): Promise<void> {
    return buildFilesIndexImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Recursively scan directory and add paths to index
   */
  // Public (was private) — bridge interface for workspace-files-dir.ts needs it.
  scanDirRecursive(
    dir: FileSystemDirectoryHandle,
    prefix: string,
    index: Set<string>
  ): Promise<void> {
    return scanDirRecursiveImpl(this as unknown as WorkspaceFilesDirInternals, dir, prefix, index)
  }

  /**
   * Read file content from files/ directory
   * @returns Content, mtime, size, contentType or null if not found
   */
  private readFromFilesDir(
    path: string
  ): Promise<{ content: FileContent; mtime: number; size: number; contentType: 'text' | 'binary' } | null> {
    return readFromFilesDirImpl(this as unknown as WorkspaceFilesDirInternals, path)
  }

  /**
   * Write file content to files/ directory
   */
  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  writeToFilesDir(path: string, content: FileContent): Promise<void> {
    return writeToFilesDirImpl(this as unknown as WorkspaceFilesDirInternals, path, content)
  }

  /**
   * Delete file from files/ directory
   */
  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  deleteFromFilesDir(path: string): Promise<void> {
    return deleteFromFilesDirImpl(this as unknown as WorkspaceFilesDirInternals, path)
  }

  /**
   * Delete file from files/ directory if it exists (alias for deleteFromFilesDir)
   */
  private deleteFromFilesDirIfExists(path: string): Promise<void> {
    return deleteFromFilesDirIfExistsImpl(this as unknown as WorkspaceFilesDirInternals, path)
  }

  /**
   * Read file content from .baseline/ directory.
   */
  private readFromBaselineDir(
    path: string
  ): Promise<{ content: FileContent; mtime: number; size: number; contentType: 'text' | 'binary' } | null> {
    return readFromBaselineDirImpl(this as unknown as WorkspaceFilesDirInternals, path)
  }

  // Public (was private) — bridge interface for workspace-files-dir.ts needs it.
  contentToBytes(content: FileContent): Promise<Uint8Array> {
    return contentToBytesImpl(this as unknown as WorkspaceFilesDirInternals, content)
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
  private areFileContentsEqual(left: FileContent, right: FileContent): Promise<boolean> {
    return areFileContentsEqualImpl(this as unknown as WorkspaceFilesDirInternals, left, right)
  }

  /**
   * Write file content to .baseline/ directory.
   */
  // Public (was private) — bridge interface for workspace-files-dir.ts needs it.
  writeToBaselineDir(path: string, content: FileContent): Promise<void> {
    return writeToBaselineDirImpl(this as unknown as WorkspaceFilesDirInternals, path, content)
  }

  /**
   * Delete file from .baseline/ directory if it exists.
   */
  private deleteFromBaselineDirIfExists(path: string): Promise<void> {
    return deleteFromBaselineDirIfExistsImpl(this as unknown as WorkspaceFilesDirInternals, path)
  }

  /**
   * Capture baseline content for modify operations.
   * - First modify in current pending cycle: write baseline.
   * - Subsequent modifies in same pending cycle: keep original baseline.
   */
  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  captureModifyBaseline(path: string, content: FileContent, forceOverwrite = false): Promise<void> {
    return captureModifyBaselineImpl(this as unknown as WorkspaceFilesDirInternals, path, content, forceOverwrite)
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
  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  tryLoadFromSnapshotHistory(path: string): Promise<FileContent | null> {
    return tryLoadFromSnapshotHistoryImpl(this as unknown as WorkspaceFilesDirInternals, path)
  }

  /**
   * Restore a modified file from OPFS baseline snapshot.
   */
  private restorePendingModifyFromBaseline(path: string): Promise<boolean> {
    return restorePendingModifyFromBaselineImpl(this as unknown as WorkspaceFilesDirInternals, path)
  }

  /**
   * List all baseline file paths in .baseline/ directory.
   */
  // Public (was private) — bridge interface for workspace-files-dir.ts needs it.
  listBaselinePaths(): Promise<string[]> {
    return listBaselinePathsImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Remove stale baseline files which no longer have pending entries.
   */
  private cleanupStaleBaselines(): Promise<void> {
    return cleanupStaleBaselinesImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Rebuild the in-memory files index from the files/ directory.
   * Called after external tools (e.g. sync) write files directly to OPFS
   * without going through the runtime's writeFile path.
   *
   * Note: This performs a full rescan of the files/ directory. The index is
   * rebuilt atomically (new Set swap) so there is no empty-window during the scan.
   */
  async rebuildFilesIndex(): Promise<void> {
    return rebuildFilesIndexImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Check if file exists in files/ directory (uses in-memory index)
   */
  private hasFileInIndex(path: string): boolean {
    return hasFileInIndexImpl(this as unknown as WorkspaceFilesDirInternals, path)
  }

  /**
   * Get all file paths from files/ directory (uses in-memory index)
   */
  private getIndexedPaths(): string[] {
    return getIndexedPathsImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Clear all files from files/ directory
   */
  private clearFilesDir(): Promise<void> {
    return clearFilesDirImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Clear all files from .baseline/ directory.
   */
  private clearBaselineDir(): Promise<void> {
    return clearBaselineDirImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Get statistics for files/ directory
   */
  private getFilesStats(): Promise<{ size: number; fileCount: number }> {
    return getFilesStatsImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Calculate directory statistics recursively
   */
  // Public (was private) — bridge interface for workspace-files-dir.ts needs it.
  calculateDirStats(
    dir: FileSystemDirectoryHandle
  ): Promise<{ size: number; fileCount: number }> {
    return calculateDirStatsImpl(this as unknown as WorkspaceFilesDirInternals, dir)
  }

  // ============ File Operations ============

  async readFile(
    path: string,
    directoryHandle?: FileSystemDirectoryHandle | null,
    options: { policy?: ReadPolicy; projectId?: string | null } = {}
  ): Promise<{ content: FileContent; metadata: FileMetadata; source: 'native' | 'opfs' }> {
    return readFileImpl(this as unknown as WorkspaceFileOpsInternals, path, directoryHandle, options)
  }

  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  getFileMetadata(
    directoryHandle: FileSystemDirectoryHandle,
    path: string
  ): Promise<{ mtime: number; size: number; contentType: 'text' | 'binary' }> {
    return getFileMetadataImpl(this as unknown as WorkspaceFileOpsInternals, directoryHandle, path)
  }

  private async readFromNativeFS(
    path: string,
    directoryHandle: FileSystemDirectoryHandle
  ): Promise<{ content: FileContent; metadata: FileMetadata }> {
    return readFromNativeFSImpl(this as unknown as WorkspaceFileOpsInternals, path, directoryHandle)
  }

  async readCachedFile(path: string): Promise<FileContent | null> {
    return readCachedFileImpl(this as unknown as WorkspaceFileOpsInternals, path)
  }

  async readBaselineFile(path: string): Promise<FileContent | null> {
    return readBaselineFileImpl(this as unknown as WorkspaceFileOpsInternals, path)
  }

  async readDiskFile(path: string): Promise<FileContent | null> {
    return readDiskFileImpl(this as unknown as WorkspaceFileOpsInternals, path)
  }

  async fileExistsOnDisk(path: string): Promise<boolean> {
    return fileExistsOnDiskImpl(this as unknown as WorkspaceFileOpsInternals, path)
  }

  async writeFile(
    path: string,
    content: FileContent,
    directoryHandle?: FileSystemDirectoryHandle | null,
    projectId?: string | null
  ): Promise<void> {
    return writeFileImpl(this as unknown as WorkspaceFileOpsInternals, path, content, directoryHandle, projectId)
  }

  async deleteFile(path: string, directoryHandle?: FileSystemDirectoryHandle | null, projectId?: string | null): Promise<void> {
    return deleteFileImpl(this as unknown as WorkspaceFileOpsInternals, path, directoryHandle, projectId)
  }

  async deleteDirPending(path: string, directoryHandle?: FileSystemDirectoryHandle | null, _projectId?: string | null): Promise<void> {
    return deleteDirPendingImpl(this as unknown as WorkspaceFileOpsInternals, path, directoryHandle, _projectId)
  }

  /**
   * Get pending changes
   */
  getPendingChanges(): PendingChange[] {
    return this.pendingManager.getAll()
  }

  /**
   * Get pending count
   */
  get pendingCount(): number {
    return this.pendingManager.count
  }

  /**
   * Get file paths that are approved but not yet synced to disk
   */
  async getApprovedNotSyncedPaths(): Promise<Set<string>> {
    if (!this.initialized) await this.initialize()
    const repo = getFSOverlayRepository()
    return await repo.getApprovedNotSyncedPaths(this.workspaceId)
  }

  /**
   * Rebase pending baseline mtimes after switching from OPFS-only to native binding.
   *
   * For modify/delete ops, if native content still matches OPFS baseline snapshot,
   * update fs_mtime to current native mtime so conflict checks stop reporting
   * migration-only mtime drift as real conflicts.
   */
  async rebindPendingBaselinesToNative(
    directoryHandle?: FileSystemDirectoryHandle | null
  ): Promise<{ checked: number; rebased: number; skipped: number; conflicts: number }> {
    if (!this.initialized) await this.initialize()

    // Multi-root: if no explicit handle provided, we'll resolve per-path
    const explicitHandle = directoryHandle ?? null

    const repo = getFSOverlayRepository()
    const activeOps = await repo.listActivePendingOps(this.workspaceId)

    let checked = 0
    let rebased = 0
    let skipped = 0
    let conflicts = 0

    for (const op of activeOps) {
      if (op.type === 'create') {
        skipped++
        continue
      }

      const path = this.normalizeWorkspacePath(op.path)
      const baseline = await this.readFromBaselineDir(path)
      if (!baseline) {
        skipped++
        continue
      }

      try {
        // Resolve the correct native handle for this path
        let nativeDir: FileSystemDirectoryHandle | null
        let nativePath = path

        if (explicitHandle) {
          nativeDir = explicitHandle
        } else {
          nativeDir = await this.getNativeDirectoryHandleForPath(path)
          const resolved = await this.resolvePath(path)
          nativePath = resolved.relativePath || path
        }

        if (!nativeDir) {
          skipped++
          continue
        }

        const native = await this.readFromNativeFS(nativePath, nativeDir)
        checked++

        const equalsBaseline = await this.areFileContentsEqual(baseline.content, native.content)
        if (!equalsBaseline) {
          conflicts++
          continue
        }

        if (native.metadata.mtime > 0 && native.metadata.mtime !== op.fsMtime) {
          await repo.updatePendingFsMtime(op.id, native.metadata.mtime)
          rebased++
        } else {
          skipped++
        }
      } catch {
        skipped++
      }
    }

    if (rebased > 0) {
      await this.pendingManager.reload()
    }

    return { checked, rebased, skipped, conflicts }
  }

  /**
   * Sync pending changes to real filesystem
   * @param directoryHandle Fallback handle when no root handles available
   * @param onlyPaths Optional list of paths to sync (if not provided, sync all)
   * @param forceOverwrite If true, skip conflict check and overwrite disk files
   * @returns Sync result
   */
  async syncToDisk(
    directoryHandle?: FileSystemDirectoryHandle | null,
    onlyPaths?: string[],
    forceOverwrite?: boolean
  ): Promise<SyncResult> {
    if (!this.initialized) await this.initialize()

    const allHandles = await this.getAllNativeDirectoryHandles()
    const projectId = await this.resolveProjectId()
    const rootMap = projectId ? await this.ensureRootMap(projectId) : null

    // Browser roots can use the explicit fallback handle. Native Host roots
    // have no FileSystemDirectoryHandle and are routed by their persisted
    // scope ID inside syncToDiskMultiRoot.
    if (allHandles.size === 0) {
      if (directoryHandle) {
        return this.syncToDiskSingleRoot(directoryHandle, onlyPaths, forceOverwrite)
      }
      if (!rootMap || rootMap.size === 0) {
        throw new Error('No authorized local folder is available for sync')
      }
    }

    return this.syncToDiskMultiRoot(allHandles, onlyPaths, forceOverwrite, directoryHandle ?? null)
  }

  /**
   * Sync pending changes for a single directory handle.
   * Used internally by syncToDiskMultiRoot per-root, and as fallback when no root handles exist.
   */
  private async syncToDiskSingleRoot(
    directoryHandle: FileSystemDirectoryHandle,
    onlyPaths?: string[],
    forceOverwrite?: boolean,
    pathTransform?: (path: string) => string
  ): Promise<SyncResult> {
    const cacheInterface = {
      readCached: async (path: string) => {
        const result = await this.readFromFilesDir(path)
        return result?.content ?? null
      },
      read: async (path: string, dirHandle?: FileSystemDirectoryHandle | null) => {
        const fromFiles = await this.readFromFilesDir(path)
        if (fromFiles) return { content: fromFiles.content }
        if (dirHandle) {
          try {
            const result = await this.readFromNativeFS(path, dirHandle)
            return { content: result.content }
          } catch {
            return null
          }
        }
        return null
      },
    }

    // Build DiskAccessor if we can resolve rootId for this handle
    let disk: { rootId: string; exec: DiskExecutor } | undefined
    try {
      const rootId = await this.resolveRootIdForHandle(directoryHandle)
      disk = { rootId, exec: this.diskExec }
    } catch {
      // Handle not in runtime map — fall back to raw handle path
    }

    const result = await this.pendingManager.sync(directoryHandle, cacheInterface, onlyPaths, forceOverwrite, pathTransform, disk)
    await this.cleanupStaleBaselines()
    this.metadata.lastAccessedAt = Date.now()
    await this.saveMetadata()
    return result
  }

  /**
   * Multi-root sync: routes each path to its corresponding root handle.
   */
  private async syncToDiskMultiRoot(
    rootHandles: Map<string, FileSystemDirectoryHandle>,
    onlyPaths?: string[],
    forceOverwrite?: boolean,
    fallbackHandle: FileSystemDirectoryHandle | null = null,
  ): Promise<SyncResult> {
    const aggregated: SyncResult = {
      success: 0,
      failed: 0,
      skipped: 0,
      conflicts: [],
    }

    // Group onlyPaths by root
    const pathsByRoot = new Map<string, string[]>()
    const pathsToSync = onlyPaths ?? (await this.getPendingPaths())

    for (const rawPath of pathsToSync) {
      const resolved = await this.resolvePath(rawPath)
      const rootPaths = pathsByRoot.get(resolved.rootName) ?? []
      rootPaths.push(rawPath)
      pathsByRoot.set(resolved.rootName, rootPaths)
    }

    // Sync each root's paths with the corresponding handle
    for (const [rootName, rootPaths] of pathsByRoot) {
      const handle = rootHandles.get(rootName)
      const resolvedRoot = await this.resolvePath(rootPaths[0])
      const rootId = resolvedRoot.rootId
      if (!handle && !rootId) {
        // Defensive: a path was routed to rootName but no native handle is
        // bound for it. This usually means the SQLite `project_roots` table
        // has a row with no matching FileSystemDirectoryHandle (handle revoked,
        // never granted, or data drift). Log loudly instead of silently
        // skipping — silent skips cause files to never reach disk.
        console.warn(
          `[syncToDiskMultiRoot] No native handle for root "${rootName}" — skipping ${rootPaths.length} path(s):`,
          rootPaths.length > 5 ? rootPaths.slice(0, 5).concat(['...']) : rootPaths
        )
        aggregated.skipped += rootPaths.length
        continue
      }

      // Build pathTransform to strip root prefix for native FS operations
      const stripPrefix = (rootName + '/').toLowerCase()
      const pathTransform = (path: string) => {
        const lower = path.toLowerCase()
        if (lower.startsWith(stripPrefix)) return path.slice(stripPrefix.length)
        return path
      }

      if (handle) {
        const result = await this.syncToDiskSingleRoot(handle, rootPaths, forceOverwrite, pathTransform)
        aggregated.success += result.success
        aggregated.failed += result.failed
        aggregated.skipped += result.skipped
        aggregated.conflicts.push(...result.conflicts)
        continue
      }

      // Native Host root: pending manager uses the disk accessor exclusively;
      // its directory handle parameter is never touched on this branch.
      const disk = { rootId: rootId!, exec: this.diskExec }
      const cacheInterface = {
        readCached: async (path: string) => (await this.readFromFilesDir(path))?.content ?? null,
        read: async (path: string) => {
          const fromFiles = await this.readFromFilesDir(path)
          return fromFiles ? { content: fromFiles.content } : null
        },
      }
      const result = await this.pendingManager.sync(
        fallbackHandle as FileSystemDirectoryHandle,
        cacheInterface,
        rootPaths,
        forceOverwrite,
        pathTransform,
        disk,
      )
      aggregated.success += result.success
      aggregated.failed += result.failed
      aggregated.skipped += result.skipped
      aggregated.conflicts.push(...result.conflicts)
    }

    await this.cleanupStaleBaselines()
    this.metadata.lastAccessedAt = Date.now()
    await this.saveMetadata()
    return aggregated
  }

  /**
   * Get all pending paths from the pending manager.
   */
  private async getPendingPaths(): Promise<string[]> {
    if (!this.initialized) await this.initialize()
    const all = this.pendingManager.getAll()
    return all.map((change) => change.path)
  }

  async detectSyncConflicts(
    directoryHandle?: FileSystemDirectoryHandle | null,
    onlyPaths?: string[]
  ): Promise<SyncResult['conflicts']> {
    if (!this.initialized) await this.initialize()

    const allHandles = await this.getAllNativeDirectoryHandles()

    // Browser roots can use the optional fallback handle. Native Host roots
    // are checked through their persisted disk root ID below.
    if (allHandles.size === 0) {
      if (directoryHandle) {
        let disk: { rootId: string; exec: DiskExecutor } | undefined
        try {
          const rootId = await this.resolveRootIdForHandle(directoryHandle)
          disk = { rootId, exec: this.diskExec }
        } catch { /* fall back to raw handle */ }
        const conflicts = await this.pendingManager.detectConflicts(directoryHandle, onlyPaths, undefined, disk)
        await this.materializeTextConflictMarkers(directoryHandle, conflicts)
        return conflicts
      }
    }

    // Group paths by root and detect conflicts per root
    const allConflicts: SyncResult['conflicts'] = []
    const pathsToCheck = onlyPaths ?? (await this.getPendingPaths())

    const pathsByRoot = new Map<string, string[]>()
    for (const rawPath of pathsToCheck) {
      const resolved = await this.resolvePath(rawPath)
      const rootPaths = pathsByRoot.get(resolved.rootName) ?? []
      rootPaths.push(rawPath)
      pathsByRoot.set(resolved.rootName, rootPaths)
    }

    for (const [rootName, rootPaths] of pathsByRoot) {
      const handle = allHandles.get(rootName) ?? directoryHandle ?? null
      // Build pathTransform to strip root prefix for native FS operations
      const stripPrefix = (rootName + '/').toLowerCase()
      const pathTransform = (path: string) => {
        const lower = path.toLowerCase()
        if (lower.startsWith(stripPrefix)) return path.slice(stripPrefix.length)
        return path
      }
      // Build DiskAccessor for this root
      let disk: { rootId: string; exec: DiskExecutor } | undefined
      const resolvedRoot = await this.resolvePath(rootPaths[0])
      if (handle) {
        try {
          const rootId = await this.resolveRootIdForHandle(handle)
          disk = { rootId, exec: this.diskExec }
        } catch { /* fall back to raw handle */ }
      } else if (resolvedRoot.rootId) {
        disk = { rootId: resolvedRoot.rootId, exec: this.diskExec }
      } else {
        continue
      }
      const conflicts = await this.pendingManager.detectConflicts(handle as FileSystemDirectoryHandle, rootPaths, pathTransform, disk)
      allConflicts.push(...conflicts)
    }

    // Always materialize conflict markers — materializeTextConflictMarkers
    // handles both FS Access handles (non-null directoryHandle) and native-host
    // roots (null directoryHandle, routed via resolvePath + diskExec).
    await this.materializeTextConflictMarkers(directoryHandle ?? null, allConflicts)
    return allConflicts
  }

  private async materializeTextConflictMarkers(
    directoryHandle: FileSystemDirectoryHandle | null,
    conflicts: SyncResult['conflicts']
  ): Promise<void> {
    return materializeTextConflictMarkersImpl(this as unknown as WorkspaceFileOpsInternals, directoryHandle, conflicts)
  }

  /**
   * Discard all pending changes without syncing to native filesystem.
   * For newly created files (type=create), also remove file bodies from OPFS files/.
   * For modified files (type=modify), restore file content from native filesystem baseline.
   */
  async discardAllPendingChanges(): Promise<void> {
    if (!this.initialized) await this.initialize()
    const pending = this.pendingManager.getAll()
    const restoreFailures: string[] = []

    for (const change of pending) {
      const normalizedPath = this.normalizeWorkspacePath(change.path)
      if (change.type === 'create') {
        await this.deleteFromFilesDirIfExists(normalizedPath)
        await this.deleteFromBaselineDirIfExists(normalizedPath)
      } else if (change.type === 'modify') {
        let restored = await this.restorePendingModifyFromNative(normalizedPath)
        if (!restored) {
          restored = await this.restorePendingModifyFromBaseline(normalizedPath)
        }
        if (!restored) {
          // No captured baseline means this is an OPFS-only draft, so there is
          // no native version to restore while discarding it.
          const hadBaseline = await this.hasBaselineFile(normalizedPath)
          if (hadBaseline) {
            restoreFailures.push(change.path)
            continue
          }
          await this.deleteFromFilesDirIfExists(normalizedPath)
        }
        await this.deleteFromBaselineDirIfExists(normalizedPath)
      } else if (change.type === 'delete') {
        let restored = await this.restorePendingModifyFromNative(normalizedPath)
        if (!restored) {
          restored = await this.restorePendingModifyFromBaseline(normalizedPath)
        }
        if (!restored) {
          // Ghost delete: file never existed on disk, just clean up the record.
          const hadBaseline = await this.hasBaselineFile(normalizedPath)
          if (hadBaseline) {
            restoreFailures.push(change.path)
            continue
          }
        }
        await this.deleteFromBaselineDirIfExists(normalizedPath)
      }
      await this.pendingManager.removeByPath(change.path)
    }

    if (restoreFailures.length > 0) {
      throw new Error(
        `无法拒绝 ${restoreFailures.length} 个变更（缺少本地文件基线）: ${restoreFailures.slice(0, 3).join(', ')}${restoreFailures.length > 3 ? ' ...' : ''}`
      )
    }

    this.metadata.lastAccessedAt = Date.now()
    await this.saveMetadata()
  }

  /**
   * Discard multiple pending paths at once without syncing to native filesystem.
   * This is more efficient than calling discardPendingPath in a loop because
   * it only saves metadata once at the end.
   * @returns Object with success/failed counts and failed paths
   */
  async discardPendingPaths(paths: string[]): Promise<{ successCount: number; failedCount: number; failedPaths: string[] }> {
    if (!this.initialized) await this.initialize()
    const pending = this.pendingManager.getAll()
    const pathSet = new Set(paths.map((p) => this.normalizeWorkspacePath(p)))
    let successCount = 0
    const failedPaths: string[] = []

    for (const change of pending) {
      const normalizedPath = this.normalizeWorkspacePath(change.path)
      if (!pathSet.has(normalizedPath)) continue

      try {
        if (change.type === 'create') {
          await this.deleteFromFilesDirIfExists(normalizedPath)
          await this.deleteFromBaselineDirIfExists(normalizedPath)
        } else if (change.type === 'delete') {
          // Fast-path for ghost deletes: check baseline first to skip expensive restore attempts.
          const hadBaseline = await this.hasBaselineFile(normalizedPath)
          if (hadBaseline) {
            let restored = await this.restorePendingModifyFromNative(normalizedPath)
            if (!restored) {
              restored = await this.restorePendingModifyFromBaseline(normalizedPath)
            }
            if (!restored) {
              failedPaths.push(change.path)
              continue
            }
          }
          await this.deleteFromBaselineDirIfExists(normalizedPath)
        } else if (change.type === 'modify') {
          let restored = await this.restorePendingModifyFromNative(normalizedPath)
          if (!restored) {
            restored = await this.restorePendingModifyFromBaseline(normalizedPath)
          }
          if (!restored) {
            // OPFS-only modify: no baseline exists, so discard the draft body.
            const hadBaseline = await this.hasBaselineFile(normalizedPath)
            if (hadBaseline) {
              failedPaths.push(change.path)
              continue
            }
            await this.deleteFromFilesDirIfExists(normalizedPath)
          }
          await this.deleteFromBaselineDirIfExists(normalizedPath)
        }
        await this.pendingManager.removeByPath(change.path)
        successCount++
      } catch {
        failedPaths.push(change.path)
      }
    }

    this.metadata.lastAccessedAt = Date.now()
    await this.saveMetadata()

    return { successCount, failedCount: failedPaths.length, failedPaths }
  }

  /**
   * Discard one pending path without syncing to native filesystem.
   * If the pending op is a newly created file, remove it from OPFS files/.
   * If the pending op is a modify, restore content from native filesystem baseline.
   */
  async discardPendingPath(path: string): Promise<void> {
    if (!this.initialized) await this.initialize()
    const normalizedTargetPath = this.normalizeWorkspacePath(path)
    const existing = this.pendingManager
      .getAll()
      .find((change) => this.normalizeWorkspacePath(change.path) === normalizedTargetPath)
    if (existing?.type === 'create') {
      await this.deleteFromFilesDirIfExists(normalizedTargetPath)
      await this.deleteFromBaselineDirIfExists(normalizedTargetPath)
    } else if (existing?.type === 'modify') {
      let restored = await this.restorePendingModifyFromNative(normalizedTargetPath)
      if (!restored) {
        restored = await this.restorePendingModifyFromBaseline(normalizedTargetPath)
      }
      if (!restored) {
        // A modify record without any captured baseline was produced from an
        // OPFS-only write. It has no known disk state to restore, so rejecting
        // it must only clear the draft instead of blocking on directory access.
        const hadBaseline = await this.hasBaselineFile(normalizedTargetPath)
        if (hadBaseline) {
          throw new Error(`无法拒绝修改 "${path}"：缺少本地文件基线，请先恢复目录访问权限`)
        }
        await this.deleteFromFilesDirIfExists(normalizedTargetPath)
      }
      await this.deleteFromBaselineDirIfExists(normalizedTargetPath)
    } else if (existing?.type === 'delete') {
      // Fast-path for ghost deletes: if there's no baseline file at all,
      // the file never existed on native disk — skip expensive restore attempts.
      const hadBaseline = await this.hasBaselineFile(normalizedTargetPath)
      if (hadBaseline) {
        let restored = await this.restorePendingModifyFromNative(normalizedTargetPath)
        if (!restored) {
          restored = await this.restorePendingModifyFromBaseline(normalizedTargetPath)
        }
        if (!restored) {
          throw new Error(`无法拒绝删除 "${path}"：缺少本地文件基线，请先恢复目录访问权限`)
        }
        await this.deleteFromBaselineDirIfExists(normalizedTargetPath)
      }
      // No baseline → file never existed on disk → safe to just discard the record.
    }
    await this.pendingManager.removeByPath(existing?.path || normalizedTargetPath)
    this.metadata.lastAccessedAt = Date.now()
    await this.saveMetadata()
  }

  private normalizeWorkspacePath(path: string): string {
    let normalized = path.replace(/\\/g, '/')
    if (normalized.startsWith('/mnt/')) {
      normalized = normalized.slice('/mnt/'.length)
    } else if (normalized === '/mnt') {
      normalized = ''
    } else if (normalized.startsWith('/')) {
      normalized = normalized.slice(1)
    }
    return normalized
  }

  private async restorePendingModifyFromNative(path: string): Promise<boolean> {
    return restorePendingModifyFromNativeImpl(this as unknown as WorkspaceFileOpsInternals, path)
  }

  private async hasBaselineFile(path: string): Promise<boolean> {
    return hasBaselineFileImpl(this as unknown as WorkspaceFileOpsInternals, path)
  }

  /**
   * Clear all workspace data (files, pending)
   */
  async clear(): Promise<void> {
    await Promise.all([
      this.clearFilesDir(),
      this.clearBaselineDir(),
      this.pendingManager.clear(),
    ])

    // Clear in-memory index
    this.filesIndex.clear()

    // Update last accessed time
    this.metadata.lastAccessedAt = Date.now()
    await this.saveMetadata()
  }

  /**
   * Get workspace statistics
   */
  async getStats(): Promise<{
    files: { size: number; fileCount: number }
    pending: number
    metadata: WorkspaceMetadataPersist
  }> {
    const filesStats = await this.getFilesStats()

    return {
      files: filesStats,
      pending: this.pendingCount,
      metadata: { ...this.metadata },
    }
  }

  /**
   * Get cached file paths
   */
  getCachedPaths(): string[] {
    return this.getIndexedPaths()
  }

  async createDraftSnapshot(
    summary?: string,
    directoryHandle?: FileSystemDirectoryHandle | null
  ): Promise<{ snapshotId: string; opCount: number } | null> {
    if (!this.initialized) await this.initialize()
    const repo = getFSOverlayRepository()
    const result = await repo.commitLatestDraftSnapshot(this.workspaceId, summary)
    if (!result) return null

    // Save before/after content for each op so rollback can restore files
    const snapshotOps = await repo.listSnapshotOps(this.workspaceId, result.snapshotId)
    for (const op of snapshotOps) {
      let beforeContent: string | ArrayBuffer | null = null
      let afterContent: string | ArrayBuffer | null = null

      try {
        if (op.type === 'create') {
          const fileResult = await this.readFile(op.path)
          afterContent = await this.normalizeContentForSnapshot(fileResult.content)
        } else if (op.type === 'modify') {
          try {
            beforeContent = await this.readNativeFileContentForPath(op.path, directoryHandle)
          } catch {
            // Native file may not exist — keep before as null
          }
          const fileResult = await this.readFile(op.path)
          afterContent = await this.normalizeContentForSnapshot(fileResult.content)
        } else if (op.type === 'delete') {
          try {
            beforeContent = await this.readNativeFileContentForPath(op.path, directoryHandle)
          } catch {
            // Native file may not exist — keep before as null
          }
        }
      } catch {
        // Keep missing side as null
      }

      await repo.upsertSnapshotFileContent({
        snapshotId: result.snapshotId,
        workspaceId: this.workspaceId,
        path: op.path,
        opType: op.type,
        beforeContent,
        afterContent,
      })
    }

    return result
  }

  async createApprovedSnapshotForPaths(
    paths: string[],
    summary?: string,
    directoryHandle?: FileSystemDirectoryHandle | null,
    runId?: string | null
  ): Promise<{ snapshotId: string; opCount: number; conflicts?: ConflictInfo[] } | null> {
    if (!this.initialized) await this.initialize()
    if (paths.length === 0) return null

    // Detect conflicts but don't block - let the agent handle them
    let conflicts: ConflictInfo[] = []
    if (directoryHandle) {
      const allHandles = await this.getAllNativeDirectoryHandles()
      if (allHandles.size > 0) {
        // Multi-root: check conflicts per root with path stripping
        const pathsByRoot = new Map<string, { paths: string[]; transform: (p: string) => string }>()
        for (const rawPath of paths) {
          const resolved = await this.resolvePath(rawPath)
          let entry = pathsByRoot.get(resolved.rootName)
          if (!entry) {
            const stripPrefix = (resolved.rootName + '/').toLowerCase()
            entry = { paths: [], transform: (p: string) => {
              const lower = p.toLowerCase()
              return lower.startsWith(stripPrefix) ? p.slice(stripPrefix.length) : p
            }}
            pathsByRoot.set(resolved.rootName, entry)
          }
          entry.paths.push(rawPath)
        }
        for (const [rootName, { paths: rootPaths, transform }] of pathsByRoot) {
          const handle = allHandles.get(rootName) ?? directoryHandle
          const rootConflicts = await this.pendingManager.detectConflicts(handle, rootPaths, transform)
          conflicts.push(...rootConflicts)
        }
      } else {
        conflicts = await this.pendingManager.detectConflicts(directoryHandle, paths)
      }
    }

    const repo = getFSOverlayRepository()
    const snapshot = await repo.createApprovedSnapshotForPaths(this.workspaceId, paths, summary, runId)
    if (!snapshot) return null
    await repo.setCurrentSnapshotId(this.workspaceId, snapshot.snapshotId)

    const snapshotOps = await repo.listSnapshotOps(this.workspaceId, snapshot.snapshotId)
    for (const op of snapshotOps) {
      let beforeContent: string | ArrayBuffer | null = null
      let afterContent: string | ArrayBuffer | null = null

      try {
        if (op.type === 'create') {
          const result = await this.readFile(op.path)
          afterContent = await this.normalizeContentForSnapshot(result.content)
        } else if (op.type === 'modify') {
          try {
            beforeContent = await this.readNativeFileContentForPath(op.path, directoryHandle)
          } catch {
            // Native file may not exist
          }
          const result = await this.readFile(op.path)
          afterContent = await this.normalizeContentForSnapshot(result.content)
        } else if (op.type === 'delete') {
          try {
            beforeContent = await this.readNativeFileContentForPath(op.path, directoryHandle)
          } catch {
            // Native file may not exist
          }
        }
      } catch {
        // Keep missing side as null for unresolved historical states.
      }

      await repo.upsertSnapshotFileContent({
        snapshotId: snapshot.snapshotId,
        workspaceId: this.workspaceId,
        path: op.path,
        opType: op.type,
        beforeContent,
        afterContent,
      })
    }

    // Notify UI (SnapshotList) that a new snapshot was created, so it can
    // auto-reload without waiting for a manual tab switch.
    try {
        const { useWorkspaceStore } = await import('@/store/workspace.store')
        useWorkspaceStore.getState().triggerSnapshotRefresh()
    } catch {
        // Store import is best-effort; never block snapshot creation.
    }

    return { ...snapshot, conflicts }
  }

  async rollbackSnapshot(
    snapshotId: string,
    directoryHandle?: FileSystemDirectoryHandle | null
  ): Promise<{ reverted: number; unresolved: string[] }> {
    if (!this.initialized) await this.initialize()
    const repo = getFSOverlayRepository()
    const ops = await repo.listSnapshotOps(this.workspaceId, snapshotId)
    let reverted = 0
    const unresolved: string[] = []

    for (const op of ops) {
      try {
        const snapshotFile = await repo.getSnapshotFileContent(snapshotId, op.path)
        const requiresNativeRollback = op.status === 'synced'
        if (op.type === 'create') {
          if (requiresNativeRollback && !directoryHandle) {
            unresolved.push(op.path)
            continue
          }
          await this.deleteFromFilesDirIfExists(op.path)
          this.filesIndex.delete(op.path)
          if (directoryHandle) {
            await this.deleteFromNativeIfExists(directoryHandle, op.path)
          }
          await this.pendingManager.removeByPath(op.path)
          reverted++
          continue
        }

        const restored = await this.restoreFromSnapshotContent(
          op.path,
          snapshotFile?.beforeContentKind,
          snapshotFile?.beforeContentText,
          snapshotFile?.beforeContentBlob || null
        )
        if (!restored) {
          unresolved.push(op.path)
          continue
        }

        if (requiresNativeRollback && !directoryHandle) {
          unresolved.push(op.path)
          continue
        }

        if (directoryHandle) {
          const data = await this.readCacheContentForPath(op.path)
          if (data !== null) {
            await this.writeNativeFile(directoryHandle, op.path, data)
          } else {
            unresolved.push(op.path)
            continue
          }
        }

        await this.pendingManager.removeByPath(op.path)
        reverted++
      } catch {
        unresolved.push(op.path)
      }
    }

    if (unresolved.length === 0 && reverted > 0) {
      await repo.markSnapshotRolledBack(this.workspaceId, snapshotId)
      await this.syncCurrentSnapshotPointer()
    }

    return { reverted, unresolved }
  }

  async rollbackLatestSnapshot(
    directoryHandle?: FileSystemDirectoryHandle | null
  ): Promise<{ snapshotId: string | null; reverted: number; unresolved: string[] }> {
    if (!this.initialized) await this.initialize()
    const repo = getFSOverlayRepository()
    const snapshots = await repo.listSnapshots(this.workspaceId, 200)
    const latest = snapshots.find((item) => item.status === 'approved' || item.status === 'committed')
    if (!latest) {
      return { snapshotId: null, reverted: 0, unresolved: [] }
    }

    const result = await this.rollbackSnapshot(latest.id, directoryHandle)
    return {
      snapshotId: latest.id,
      reverted: result.reverted,
      unresolved: result.unresolved,
    }
  }

  async rollbackToSnapshot(
    snapshotId: string,
    directoryHandle?: FileSystemDirectoryHandle | null
  ): Promise<{
    targetSnapshotId: string
    rolledBackSnapshotIds: string[]
    reverted: number
    unresolved: string[]
    failedSnapshotId?: string
  }> {
    if (!this.initialized) await this.initialize()
    const repo = getFSOverlayRepository()
    const snapshots = await repo.listSnapshots(this.workspaceId, 500)
    const targetIndex = snapshots.findIndex((item) => item.id === snapshotId)
    if (targetIndex < 0) {
      throw new Error(`快照不存在: ${snapshotId}`)
    }

    const newerSnapshotIds = snapshots
      .slice(0, targetIndex)
      .filter((item) => item.status === 'approved' || item.status === 'committed')
      .map((item) => item.id)

    const rolledBackSnapshotIds: string[] = []
    let reverted = 0
    let unresolved: string[] = []
    let failedSnapshotId: string | undefined

    for (const id of newerSnapshotIds) {
      const result = await this.rollbackSnapshot(id, directoryHandle)
      reverted += result.reverted
      if (result.unresolved.length > 0) {
        unresolved = result.unresolved
        failedSnapshotId = id
        break
      }
      rolledBackSnapshotIds.push(id)
    }

    return {
      targetSnapshotId: snapshotId,
      rolledBackSnapshotIds,
      reverted,
      unresolved,
      failedSnapshotId,
    }
  }

  private async syncCurrentSnapshotPointer(): Promise<void> {
    const repo = getFSOverlayRepository()
    const snapshots = await repo.listSnapshots(this.workspaceId, 500)
    const current = snapshots.find((item) => item.status === 'approved' || item.status === 'committed')
    await repo.setCurrentSnapshotId(this.workspaceId, current?.id || null)
  }

  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  collectGitIgnoreRules(
    nativePath: string,
    directoryHandle: FileSystemDirectoryHandle
  ): Promise<GitIgnoreRule[]> {
    return collectGitIgnoreRulesImpl(this as unknown as WorkspaceFileOpsInternals, nativePath, directoryHandle)
  }

  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  isGitIgnoredPath(
    nativePath: string,
    directoryHandle: FileSystemDirectoryHandle | null,
    rootId: string | null
  ): Promise<boolean> {
    return isGitIgnoredPathImpl(this as unknown as WorkspaceFileOpsInternals, nativePath, directoryHandle, rootId)
  }

  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  deleteIgnoredPathImmediately(
    workspacePath: string,
    nativePath: string,
    directoryHandle: FileSystemDirectoryHandle | null,
    recursive: boolean,
    resolvedRootId?: string | null
  ): Promise<void> {
    return deleteIgnoredPathImmediatelyImpl(this as unknown as WorkspaceFileOpsInternals, workspacePath, nativePath, directoryHandle, recursive, resolvedRootId)
  }

  private async deleteFromNativeIfExists(
    directoryHandle: FileSystemDirectoryHandle,
    path: string
  ): Promise<void> {
    const rootId = await this.resolveRootIdForHandle(directoryHandle)
    await this.diskExec.delete(rootId, path)
  }

  private async resolveRootIdForHandle(
    directoryHandle: FileSystemDirectoryHandle
  ): Promise<string> {
    return resolveRootIdForHandleImpl(this as unknown as WorkspaceRuntimeInternals, directoryHandle)
  }

  /**
   * Read native file content for a workspace path, resolving the correct
   * root handle and stripping the root prefix in multi-root setups.
   * Falls back to the provided directoryHandle with the raw path if multi-root
   * resolution fails.
   */
  private async readNativeFileContentForPath(
    path: string,
    fallbackHandle?: FileSystemDirectoryHandle | null
  ): Promise<string | ArrayBuffer | null> {
    return readNativeFileContentForPathImpl(this as unknown as WorkspaceRuntimeInternals, path, fallbackHandle)
  }

  // Public (called from workspace-multiroot.ts impls via the internals bridge)
  async readNativeFileContent(
    directoryHandle: FileSystemDirectoryHandle,
    path: string
  ): Promise<string | ArrayBuffer> {
    return readNativeFileContentImpl(this as unknown as WorkspaceRuntimeInternals, directoryHandle, path)
  }

  private async writeNativeFile(
    directoryHandle: FileSystemDirectoryHandle,
    path: string,
    content: string | ArrayBuffer
  ): Promise<void> {
    return writeNativeFileImpl(this as unknown as WorkspaceRuntimeInternals, directoryHandle, path, content)
  }

  private async readCacheContentForPath(path: string): Promise<string | ArrayBuffer | null> {
    const cached = await this.readFromFilesDir(path)
    if (cached === null) return null
    if (typeof cached.content === 'string') return cached.content
    if (cached.content instanceof Blob) return await cached.content.arrayBuffer()
    return cached.content
  }

  private async normalizeContentForSnapshot(content: FileContent): Promise<string | ArrayBuffer> {
    if (typeof content === 'string') return content
    if (content instanceof Blob) return await content.arrayBuffer()
    return content
  }

  private async restoreFromSnapshotContent(
    path: string,
    contentKind?: 'text' | 'binary' | 'none',
    contentText?: string | null,
    contentBlob?: Uint8Array | ArrayBuffer | null
  ): Promise<boolean> {
    if (!contentKind || contentKind === 'none') return false

    if (contentKind === 'text') {
      const filesDir = await this.getFilesDir()
      const encoded = new TextEncoder().encode(contentText || '')
      await this.writeFileToOPFS(
        filesDir,
        path,
        encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
      )
      this.filesIndex.add(path)
      return true
    }

    const binary =
      contentBlob instanceof Uint8Array
        ? (contentBlob.buffer.slice(
            contentBlob.byteOffset,
            contentBlob.byteOffset + contentBlob.byteLength
          ) as ArrayBuffer)
        : contentBlob
    if (!(binary instanceof ArrayBuffer)) return false

    const filesDir = await this.getFilesDir()
    await this.writeFileToOPFS(filesDir, path, binary)
    this.filesIndex.add(path)
    return true
  }

  /**
   * Check if file is in cache
   * @param path File path
   */
  hasCachedFile(path: string): boolean {
    return this.hasFileInIndex(path)
  }

  /**
   * Get workspace metadata
   */
  getMetadata(): WorkspaceMetadataPersist {
    return { ...this.metadata }
  }

  /**
   * Update root directory
   * @param rootDirectory New root directory
   */
  async updateRootDirectory(rootDirectory: string): Promise<void> {
    this.metadata.rootDirectory = rootDirectory
    await this.saveMetadata()
  }

  // ============ Dual Storage: Change Detection ============

  /**
   * Get the files/ directory handle (Agent workspace)
   * This is the mount point for Pyodide Python execution
   */
  async getFilesDir(): Promise<FileSystemDirectoryHandle> {
    return getFilesDirImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Get the assets/ directory handle (user uploads & agent-generated files)
   * This is the mount point for /mnt_assets in Pyodide Python execution
   */
  async getAssetsDir(): Promise<FileSystemDirectoryHandle> {
    return getAssetsDirImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Get the .baseline/ directory handle for OPFS-only modify rollbacks.
   */
  // Public so the workspace-files-dir.ts bridge interface can access it.
  async getBaselineDir(): Promise<FileSystemDirectoryHandle> {
    return getBaselineDirImpl(this as unknown as WorkspaceFilesDirInternals)
  }

  /**
   * Get native directory handle for file preparation
   * @returns First root's Native FS directory handle, or null if not set
   */
  async getNativeDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
    if (!this.metadata.rootDirectory) return null

    try {
      const projectId = await this.resolveProjectId()
      if (projectId) {
        const rootMap = await this.ensureRootMap(projectId)
        if (rootMap && rootMap.size > 0) {
          const firstRootName = rootMap.keys().next().value!
          return getRuntimeDirectoryHandle(projectId, firstRootName)
        }
      }

      return null
    } catch {
      return null
    }
  }

  /**
   * Get native directory handle for a specific path, resolving multi-root routing.
   *
   * Resolution logic:
   * 1. If path starts with a known rootName prefix → use that root's handle
   * 2. Otherwise → use the first root's handle
   */
  async getNativeDirectoryHandleForPath(path: string, projectId?: string | null): Promise<FileSystemDirectoryHandle | null> {
    return getNativeDirectoryHandleForPathImpl(this as unknown as WorkspaceRuntimeInternals, path, projectId)
  }

  /**
   * Get all native directory handles for the project (multi-root).
   * Returns a Map of rootName → handle for all roots with active handles.
   */
  async getAllNativeDirectoryHandles(projectId?: string | null): Promise<Map<string, FileSystemDirectoryHandle>> {
    return getAllNativeDirectoryHandlesImpl(this as unknown as WorkspaceRuntimeInternals, projectId)
  }

  /**
   * Returns true if at least one native directory handle is mounted for this
   * project (across all roots). Used to detect "pure OPFS mode" — when no
   * native directory is mounted, agent writes/deletes go directly to OPFS
   * without entering the pending/approval workflow.
   */
  async hasAnyNativeDirectoryHandle(): Promise<boolean> {
    return hasAnyNativeDirectoryHandleImpl(this as unknown as WorkspaceRuntimeInternals)
  }

  /**
   * List disk directory entries via executor (supports native-host roots).
   * Used by ls tool when the root is native-host-backed (no FileSystemDirectoryHandle).
   *
   * @param path Workspace-relative path (may include rootName prefix)
   * @returns Array of entries, or null if the root is FS Access (caller should use handle instead)
   */
  async listDiskDir(
    path: string,
    projectId?: string | null
  ): Promise<Array<{ name: string; kind: 'file' | 'directory'; size?: number; mtime?: number }> | null> {
    return listDiskDirImpl(this as unknown as WorkspaceRuntimeInternals, path, projectId)
  }

  /**
   * Recursively scan a native-host disk root up to maxDepth.
   * Returns entries with paths relative to the root.
   */
  async scanDiskTree(
    path: string,
    maxDepth: number,
    projectId?: string | null,
    options?: { includeSizes?: boolean; excludeDirs?: string[]; maxEntries?: number; deadlineMs?: number; respectGitignore?: boolean; includeIgnored?: boolean }
  ): Promise<Array<{ path: string; type: 'file' | 'directory'; size: number; depth: number }> | null> {
    return scanDiskTreeImpl(this as unknown as WorkspaceRuntimeInternals, path, maxDepth, projectId, options)
  }

  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  readFromDiskRoot(rootId: string, path: string): Promise<{ content: FileContent; metadata: FileMetadata }> {
    return readFromDiskRootImpl(this as unknown as WorkspaceRuntimeInternals, rootId, path)
  }

  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  getDiskFileMetadata(rootId: string, path: string): Promise<{ mtime: number; size: number; contentType: 'text' | 'binary' }> {
    return getDiskFileMetadataImpl(this as unknown as WorkspaceRuntimeInternals, rootId, path)
  }

  // ===========================================================================
  // Multi-root path resolution
  // ===========================================================================

  /**
   * Resolve the projectId for this workspace from the DB.
   * Cached after first lookup to avoid repeated queries.
   *
   * IMPORTANT: This should be used instead of findActiveProject() in all
   * methods that need a projectId, because the global activeProject pointer
   * may point to a different project if the user switches browser tabs
   * while an agent conversation is still running.
   */
  private async resolveProjectId(): Promise<string | null> {
    return resolveProjectIdImpl(this as unknown as WorkspaceRuntimeInternals)
  }

  /**
   * Ensure the root map is loaded from SQLite for the given project.
   * Cached in memory; re-loaded only when projectId changes.
   */
  private async ensureRootMap(
    projectId: string
  ): Promise<Map<string, {
    readOnly: boolean
    isDefault: boolean
    backend: 'fsaccess' | 'native-host'
    rootId: string | null
  }> | null> {
    return ensureRootMapImpl(this as unknown as WorkspaceRuntimeInternals, projectId)
  }

  /**
   * Resolve a workspace-relative path to its root and root-relative sub-path.
   *
   * Path patterns:
   * - `"my-app/src/App.tsx"` → `{ rootName: "my-app", relativePath: "src/App.tsx" }`
   * - `"src/App.tsx"`        → `{ rootName: <defaultRoot>, relativePath: "src/App.tsx" }`
   *
   * If the first path segment matches a known root name, it's treated as a root prefix.
   * Otherwise, the path is assigned to the default root.
   */
  async resolvePath(
    path: string,
    projectId?: string | null
  ): Promise<ResolvedRoot> {
    return resolvePathImpl(this as unknown as WorkspaceRuntimeInternals, path, projectId)
  }

  /**
   * Check if a root is read-only (for write guards).
   */
  async isReadOnlyRoot(rootName: string): Promise<boolean> {
    return isReadOnlyRootImpl(this as unknown as WorkspaceRuntimeInternals, rootName)
  }

  /**
   * Invalidate cached root map (call when roots change).
   */
  invalidateRootCache(): void {
    invalidateRootCacheImpl(this as unknown as WorkspaceRuntimeInternals)
  }

  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  validatePath(path: string): string {
    return validatePathImpl(this as unknown as WorkspaceFileOpsInternals, path)
  }

  async prepareFiles(
    files: string[],
    onProgress?: (file: string, progress: number) => void
  ): Promise<void> {
    return prepareFilesImpl(this as unknown as WorkspaceFileOpsInternals, files, onProgress)
  }

  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  copyFileWithProgress(
    fileHandle: FileSystemFileHandle,
    targetDir: FileSystemDirectoryHandle,
    path: string,
    onProgress: (progress: number) => void
  ): Promise<void> {
    return copyFileWithProgressImpl(this as unknown as WorkspaceFileOpsInternals, fileHandle, targetDir, path, onProgress)
  }

  private async writeFileToOPFS(
    targetDir: FileSystemDirectoryHandle,
    path: string,
    content: ArrayBuffer
  ): Promise<void> {
    return writeFileToOPFSImpl(this as unknown as WorkspaceFileOpsInternals, targetDir, path, content)
  }

  // ============ Dual Storage: Change Detection ============
  //
  // Implementations live in workspace-change-detection.ts as standalone
  // *Impl functions; the class methods below are one-line delegates.
  // Cross-method calls dispatch through the instance (rt.method()) so
  // instance-level overrides keep working exactly as before extraction.

  /**
   * Scan files/ directory for change detection
   * @returns Map of file path -> FileScanItem
   */
  async scanFiles(): Promise<Map<string, FileScanItem>> {
    return scanFilesImpl(this as unknown as WorkspaceChangeDetectionInternals)
  }

  /**
   * Detect changes between two file snapshots
   * @param before Snapshot before Python execution
   * @returns Change detection result
   */
  detectChanges(before: Map<string, FileScanItem>): ChangeDetectionResult {
    return detectChangesImpl(this as unknown as WorkspaceChangeDetectionInternals, before)
  }

  /**
   * Cache for scanFiles result (for performance)
   */
  // Public (underscore-aliased below) — bridge interface for
  // workspace-change-detection.ts needs it. Kept private name via alias to
  // preserve the class's public surface; the Impl functions read/write it
  // through the interface field `scanFilesCache`.
  get scanFilesCache(): Map<string, FileScanItem> | undefined {
    return this._scanFilesCache
  }
  set scanFilesCache(value: Map<string, FileScanItem> | undefined) {
    this._scanFilesCache = value
  }
  private _scanFilesCache?: Map<string, FileScanItem>

  /**
   * Scan files with caching
   * @returns File scan snapshot
   */
  async scanFilesWithCache(): Promise<Map<string, FileScanItem>> {
    return scanFilesWithCacheImpl(this as unknown as WorkspaceChangeDetectionInternals)
  }

  /**
   * Refresh pending changes - independent of Python tool execution
   *
   * This method scans OPFS files/ directory and compares with pending.json
   * to detect any changes made outside of Python tool workflow.
   * Updates pending.json with new changes found.
   *
   * Use cases:
   * - User opens "Pending Sync" panel to see latest changes
   * - Files uploaded/created through non-python tools
   * - Manual file operations in OPFS
   *
   * @returns Change detection result
   */
  async refreshPendingChanges(): Promise<ChangeDetectionResult> {
    return refreshPendingChangesImpl(this as unknown as WorkspaceChangeDetectionInternals)
  }

  async registerDetectedChanges(
    changes: FileChange[],
    directoryHandle?: FileSystemDirectoryHandle | null
  ): Promise<void> {
    return registerDetectedChangesImpl(this as unknown as WorkspaceChangeDetectionInternals, changes, directoryHandle)
  }

  /**
   * Sync selected changes to Native FS
   * @param directoryHandle Native FS directory handle
   * @param changes Changes to sync
   * @returns Sync result
   */
  async syncToNative(
    directoryHandle: FileSystemDirectoryHandle | null,
    changes: FileChange[]
  ): Promise<{ synced: number; failed: number }> {
    if (!this.initialized) await this.initialize()

    const allHandles = await this.getAllNativeDirectoryHandles()

    // No FS Access handles → check native-host roots or fallback
    if (allHandles.size === 0) {
      const hasDiskRoot = await this.hasAnyNativeDirectoryHandle()
      if (hasDiskRoot) {
        // Native-host only: route each change via resolvePath + executor
        return this.syncToNativeDiskRoots(changes)
      }
      if (!directoryHandle) {
        return { synced: 0, failed: changes.length }
      }
      return this.syncToNativeSingleRoot(directoryHandle!, changes)
    }

    // Group changes by root and sync each group
    let synced = 0
    let failed = 0

    const changesByRoot = new Map<string, FileChange[]>()
    for (const change of changes) {
      const resolved = await this.resolvePath(change.path)
      const rootChanges = changesByRoot.get(resolved.rootName) ?? []
      rootChanges.push(change)
      changesByRoot.set(resolved.rootName, rootChanges)
    }

    for (const [rootName, rootChanges] of changesByRoot) {
      const handle = allHandles.get(rootName)
      if (handle) {
        const result = await this.syncToNativeSingleRoot(handle, rootChanges)
        synced += result.synced
        failed += result.failed
      } else {
        // No FS Access handle — might be a native-host root
        const resolved = await this.resolvePath(rootChanges[0].path)
        if (resolved.rootId && resolved.backend === 'native-host') {
          const result = await this.syncToNativeDiskRoot(resolved.rootId, rootChanges)
          synced += result.synced
          failed += result.failed
        } else {
          failed += rootChanges.length
        }
      }
    }

    this.scanFilesCache = undefined
    return { synced, failed }
  }

  /**
   * syncToNative for native-host roots (no FileSystemDirectoryHandle).
   * Routes all changes through a single rootId.
   */
  private async syncToNativeDiskRoot(
    rootId: string,
    changes: FileChange[]
  ): Promise<{ synced: number; failed: number }> {
    let synced = 0
    let failed = 0
    const filesDir = await this.getFilesDir()

    for (const change of changes) {
      try {
        const resolved = await this.resolvePath(change.path)
        const nativePath = resolved.relativePath || change.path

        if (change.type === 'delete') {
          await this.diskExec.delete(rootId, nativePath, {
            recursive: change.deleteMode === 'tree',
          })
        } else {
          await this.copyToNativeDiskRoot(rootId, filesDir, change.path, nativePath)
        }
        synced++
      } catch (err) {
        console.error(`Failed to sync ${change.path}:`, err)
        failed++
      }
    }
    return { synced, failed }
  }

  /**
   * syncToNative for native-host-only projects (all roots are native-host).
   */
  private async syncToNativeDiskRoots(
    changes: FileChange[]
  ): Promise<{ synced: number; failed: number }> {
    let synced = 0
    let failed = 0

    const changesByRoot = new Map<string, { rootId: string; changes: FileChange[] }>()
    for (const change of changes) {
      const resolved = await this.resolvePath(change.path)
      if (!resolved.rootId) {
        failed++
        continue
      }
      const entry = changesByRoot.get(resolved.rootName) ?? { rootId: resolved.rootId, changes: [] }
      entry.changes.push(change)
      changesByRoot.set(resolved.rootName, entry)
    }

    for (const { rootId, changes: rootChanges } of changesByRoot.values()) {
      const result = await this.syncToNativeDiskRoot(rootId, rootChanges)
      synced += result.synced
      failed += result.failed
    }

    this.scanFilesCache = undefined
    return { synced, failed }
  }

  /**
   * Copy file from OPFS to native-host disk root via executor.
   */
  private async copyToNativeDiskRoot(
    rootId: string,
    opfsDir: FileSystemDirectoryHandle,
    path: string,
    diskPath = path,
  ): Promise<void> {
    const parts = path.split('/').filter(Boolean)
    const fileName = parts[parts.length - 1]

    // Read file from OPFS
    let opfsCurrent = opfsDir
    for (let i = 0; i < parts.length - 1; i++) {
      opfsCurrent = await opfsCurrent.getDirectoryHandle(parts[i])
    }
    const opfsFile = await opfsCurrent.getFileHandle(fileName)
    const file = await opfsFile.getFile()
    const content = await file.arrayBuffer()

    await this.diskExec.write(rootId, diskPath, content)
  }

  /**
   * syncToNative for a single directory handle.
   * Used internally by syncToNative per-root, and as fallback.
   */
  private async syncToNativeSingleRoot(
    directoryHandle: FileSystemDirectoryHandle,
    changes: FileChange[]
  ): Promise<{ synced: number; failed: number }> {
    let synced = 0
    let failed = 0
    const filesDir = await this.getFilesDir()

    for (const change of changes) {
      try {
        // For multi-root, strip root prefix when writing to native
        const resolved = await this.resolvePath(change.path)
        const nativePath = resolved.relativePath || change.path

        if (change.type === 'delete') {
          await this.deleteFromNative(directoryHandle, nativePath, change.deleteMode === 'tree')
        } else {
          await this.copyToNative(directoryHandle, filesDir, change.path)
        }
        synced++
      } catch (err) {
        console.error(`Failed to sync ${change.path}:`, err)
        failed++
      }
    }

    this.scanFilesCache = undefined
    return { synced, failed }
  }

  /**
   * Scan OPFS files/ and return paths that don't exist (or differ) in the
   * native directory. Used by the "one-time sync after first mount" flow:
   * when a user has been working in pure OPFS mode and later mounts a local
   * directory, this identifies which OPFS-only files need to be written out.
   *
   * For multi-root setups, paths are returned with their rootName prefix
   * preserved (so callers can route them via syncToDisk/syncToNative).
   */
  async listOpfsOnlyFiles(): Promise<string[]> {
    if (!this.initialized) await this.initialize()
    const filesDir = await this.getFilesDir()
    const opfsFiles = await scanFilesInWorker(filesDir)
    if (opfsFiles.size === 0) return []

    const rootHandles = await this.getAllNativeDirectoryHandles()
    const diffs: string[] = []

    if (rootHandles.size === 0) {
      // No FS Access handles — check if there are native-host roots.
      // If yes, compare OPFS files against native-host roots via executor.
      // If no, every OPFS file is "OPFS-only".
      const hasDiskRoot = await this.hasAnyNativeDirectoryHandle()
      if (!hasDiskRoot) {
        for (const path of opfsFiles.keys()) diffs.push(path)
        return diffs
      }
      // Native-host only: check each file via executor
      for (const path of opfsFiles.keys()) {
        try {
          const resolved = await this.resolvePath(path)
          if (resolved.rootId) {
            const nativePath = resolved.relativePath || path
            const stat = await this.diskExec.stat(resolved.rootId, nativePath)
            if (!stat) diffs.push(path)  // not on disk → OPFS-only
          } else {
            diffs.push(path)
          }
        } catch {
          diffs.push(path)
        }
      }
      return diffs
    }

    // Compare each OPFS file against its routed native root.
    for (const path of opfsFiles.keys()) {
      try {
        const resolved = await this.resolvePath(path)
        const nativePath = resolved.relativePath || path

        if (resolved.backend === 'native-host' && resolved.rootId) {
          // Native-host root: check via executor
          const stat = await this.diskExec.stat(resolved.rootId, nativePath)
          if (!stat) diffs.push(path)
        } else {
          // FS Access root: check via handle
          const handle = rootHandles.get(resolved.rootName)
          if (!handle) {
            diffs.push(path)
            continue
          }
          await this.readFromNativeFS(nativePath, handle)
        }
      } catch {
        // NotFoundError → OPFS-only. Other errors also default to needing sync.
        diffs.push(path)
      }
    }
    return diffs
  }

  /**
   * Batch-write OPFS files to the native filesystem. Used by the one-time
   * sync flow after first mount.
   */
  async syncOpfsFilesToNative(
    directoryHandle: FileSystemDirectoryHandle | null,
    paths: string[]
  ): Promise<{ synced: number; failed: number }> {
    if (!this.initialized) await this.initialize()
    const changes: FileChange[] = paths.map((path) => ({
      type: 'add' as const,
      path,
    }))
    return await this.syncToNative(directoryHandle, changes)
  }

  /**
   * Copy file from OPFS to Native FS
   */
  private async copyToNative(
    nativeDir: FileSystemDirectoryHandle,
    opfsDir: FileSystemDirectoryHandle,
    path: string
  ): Promise<void> {
    const parts = path.split('/').filter(Boolean)
    const fileName = parts[parts.length - 1]

    // Read file from OPFS
    let opfsCurrent = opfsDir
    for (let i = 0; i < parts.length - 1; i++) {
      opfsCurrent = await opfsCurrent.getDirectoryHandle(parts[i])
    }
    const opfsFile = await opfsCurrent.getFileHandle(fileName)
    const file = await opfsFile.getFile()
    const content = await file.arrayBuffer()

    // Write to Native FS via executor
    const rootId = await this.resolveRootIdForHandle(nativeDir)
    await this.diskExec.write(rootId, path, content)
  }

  /**
   * Delete file from Native FS
   */
  private async deleteFromNative(
    nativeDir: FileSystemDirectoryHandle,
    path: string,
    recursive?: boolean
  ): Promise<void> {
    const rootId = await this.resolveRootIdForHandle(nativeDir)
    await this.diskExec.delete(rootId, path, { recursive: recursive === true })
  }

  //=============================================================================
  // Helper Methods
  //=============================================================================

  /**
   * Get file handle from Native FS by path
   * @param nativeDir Root directory handle
   * @param path Relative path from root
   * @returns File handle
   */
  // Public (was private) — bridge interface for workspace-file-ops.ts needs it.
  async getFileHandle(
    nativeDir: FileSystemDirectoryHandle,
    path: string
  ): Promise<FileSystemFileHandle> {
    const parts = path.split('/')
    let current = nativeDir

    // Navigate to parent directory
    for (let i = 0; i < parts.length - 1; i++) {
      if (!parts[i]) continue
      current = await current.getDirectoryHandle(parts[i])
    }

    // Get file handle
    const fileName = parts[parts.length - 1]
    return await current.getFileHandle(fileName)
  }

  //=============================================================================
  // Error Handling
  //=============================================================================

  /**
   * System log storage for debugging
   * In production, this would be sent to a logging service
   */
  private systemLogs: SystemLog[] = []

  /**
   * Add system log entry
   */
  private logError(level: SystemLog['level'], code: ErrorCode, message: string, context?: Record<string, unknown>, stack?: string): void {
    const logEntry: SystemLog = {
      timestamp: Date.now(),
      level,
      code,
      message,
      context,
      stack,
    }
    this.systemLogs.push(logEntry)

    // Keep only last 100 logs to prevent memory overflow
    if (this.systemLogs.length > 100) {
      this.systemLogs = this.systemLogs.slice(-100)
    }

    // In development, log to console
    if (process.env.NODE_ENV !== 'production') {
      console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](
        `[${ErrorCode[code]}]`,
        message,
        context,
        stack,
      )
    }
  }

  /**
   * Unified error handler with user-friendly messages
   *
   * @param error - The error object or error code
   * @param context - Additional context information
   * @returns ErrorDetail with user-friendly message
   */
  handleError(error: unknown | ErrorCode, context?: Record<string, unknown>): ErrorDetail {
    let code: ErrorCode
    let message: string
    let stack: string | undefined

    // If error code is passed directly
    if (typeof error === 'number') {
      code = error
      message = this.getDefaultErrorMessage(error)
      this.logError('info', code, message, context)
      return {
        code,
        message,
        context,
        recoverable: this.isRecoverable(code),
      }
    }

    // Error object or string
    if (error instanceof Error) {
      stack = error.stack
      // Map error message to error code
      code = this.mapMessageToErrorCode(error.message)
      message = this.getDefaultErrorMessage(code)
    } else if (typeof error === 'string') {
      code = this.mapMessageToErrorCode(error)
      message = this.getDefaultErrorMessage(code)
    } else {
      code = ErrorCode.FILE_READ_FAILED
      message = '未知错误'
    }

    // Log the error
    this.logError('error', code, message, context, stack)

    return {
      code,
      message,
      context,
      recoverable: this.isRecoverable(code),
      suggestion: this.getSuggestion(code),
    }
  }

  /**
   * Get default user-friendly error message by error code
   */
  private getDefaultErrorMessage(code: ErrorCode): string {
    const messages: Partial<Record<ErrorCode, string>> = {
      // File operation errors
      [ErrorCode.FILE_NOT_FOUND]: '文件不存在',
      [ErrorCode.FILE_READ_FAILED]: '文件读取失败',
      [ErrorCode.FILE_WRITE_FAILED]: '文件写入失败',
      [ErrorCode.FILE_TOO_LARGE]: '文件太大，无法处理',
      [ErrorCode.INVALID_PATH_FORMAT]: '文件路径格式无效',
      [ErrorCode.PATH_TRAVERSAL_DETECTED]: '检测到路径遍历攻击',

      // Directory operation errors
      [ErrorCode.DIRECTORY_NOT_FOUND]: '目录不存在',
      [ErrorCode.DIRECTORY_CREATE_FAILED]: '目录创建失败',

      // Sync operation errors
      [ErrorCode.SYNC_CONFLICT_DETECTED]: '同步冲突：文件已被修改',
      [ErrorCode.SYNC_OPERATION_FAILED]: '同步操作失败',
      [ErrorCode.SYNC_PARTIAL_SUCCESS]: '部分文件同步成功',

      // Permission and authorization errors
      [ErrorCode.PERMISSION_DENIED]: '权限被拒绝',
      [ErrorCode.AUTHORIZATION_REQUIRED]: '需要授权',
      [ErrorCode.HANDLE_INVALID]: '文件句柄无效',

      // System-level errors
      [ErrorCode.OPFS_NOT_AVAILABLE]: '浏览器不支持 OPFS',
      [ErrorCode.STORAGE_QUOTA_EXCEEDED]: '存储空间不足',
      [ErrorCode.BROWSER_NOT_SUPPORTED]: '浏览器不支持此功能',
    }

    return messages[code] || '未知错误'
  }

  /**
   * Map error message to error code
   */
  private mapMessageToErrorCode(message: string): ErrorCode {
    const lowerMessage = message.toLowerCase()

    // File operation errors
    if (lowerMessage.includes('not found') || lowerMessage.includes('不存在')) {
      return ErrorCode.FILE_NOT_FOUND
    }
    if (lowerMessage.includes('read failed') || lowerMessage.includes('读取失败')) {
      return ErrorCode.FILE_READ_FAILED
    }
    if (lowerMessage.includes('write failed') || lowerMessage.includes('写入失败')) {
      return ErrorCode.FILE_WRITE_FAILED
    }
    if (lowerMessage.includes('too large') || lowerMessage.includes('太大')) {
      return ErrorCode.FILE_TOO_LARGE
    }
    if (lowerMessage.includes('path') && (lowerMessage.includes('invalid') || lowerMessage.includes('格式'))) {
      return ErrorCode.INVALID_PATH_FORMAT
    }
    if (lowerMessage.includes('..') || lowerMessage.includes('path traversal')) {
      return ErrorCode.PATH_TRAVERSAL_DETECTED
    }

    // Directory operation errors
    if (lowerMessage.includes('directory') && lowerMessage.includes('not found')) {
      return ErrorCode.DIRECTORY_NOT_FOUND
    }
    if (lowerMessage.includes('create') && lowerMessage.includes('directory')) {
      return ErrorCode.DIRECTORY_CREATE_FAILED
    }

    // Permission errors
    if (lowerMessage.includes('permission') || lowerMessage.includes('权限')) {
      return ErrorCode.PERMISSION_DENIED
    }
    if (lowerMessage.includes('authorization') || lowerMessage.includes('授权')) {
      return ErrorCode.AUTHORIZATION_REQUIRED
    }
    if (lowerMessage.includes('handle') && lowerMessage.includes('invalid')) {
      return ErrorCode.HANDLE_INVALID
    }

    // System errors
    if (lowerMessage.includes('opfs') || lowerMessage.includes('storage')) {
      return ErrorCode.OPFS_NOT_AVAILABLE
    }
    if (lowerMessage.includes('quota') || lowerMessage.includes('空间')) {
      return ErrorCode.STORAGE_QUOTA_EXCEEDED
    }
    if (lowerMessage.includes('browser') || lowerMessage.includes('浏览器')) {
      return ErrorCode.BROWSER_NOT_SUPPORTED
    }

    // Default
    return ErrorCode.FILE_READ_FAILED
  }

  /**
   * Check if error is recoverable
   */
  private isRecoverable(code: ErrorCode): boolean {
    const recoverableErrors = new Set<ErrorCode>([
      ErrorCode.FILE_NOT_FOUND,
      ErrorCode.FILE_READ_FAILED,
      ErrorCode.DIRECTORY_NOT_FOUND,
      ErrorCode.PERMISSION_DENIED,
      ErrorCode.AUTHORIZATION_REQUIRED,
      ErrorCode.HANDLE_INVALID,
      ErrorCode.SYNC_PARTIAL_SUCCESS,
    ])

    return recoverableErrors.has(code)
  }

  /**
   * Get suggestion for error recovery
   */
  private getSuggestion(code: ErrorCode): string | undefined {
    const suggestions: Partial<Record<ErrorCode, string>> = {
      [ErrorCode.FILE_NOT_FOUND]: '请检查文件路径是否正确',
      [ErrorCode.FILE_READ_FAILED]: '请检查文件权限或重试',
      [ErrorCode.PERMISSION_DENIED]: '请检查文件权限设置',
      [ErrorCode.AUTHORIZATION_REQUIRED]: '请先选择项目目录',
      [ErrorCode.INVALID_PATH_FORMAT]: '路径必须以 /mnt/ 开头',
      [ErrorCode.STORAGE_QUOTA_EXCEEDED]: '请清理缓存或删除不需要的文件',
      [ErrorCode.PATH_TRAVERSAL_DETECTED]: '文件路径不能包含 .. 或 .',
    }

    return suggestions[code]
  }

  /**
   * Get system logs (for debugging)
   */
  getSystemLogs(): SystemLog[] {
    return [...this.systemLogs]
  }

  /**
   * Clear system logs
   */
  clearSystemLogs(): void {
    this.systemLogs = []
  }

  /**
   * Mark a snapshot as synced to disk
   */
  async markSnapshotAsSynced(snapshotId: string): Promise<void> {
    if (!this.initialized) await this.initialize()
    const repo = getFSOverlayRepository()
    await repo.markSnapshotAsSynced(snapshotId)
  }

  /**
   * Get unsynced snapshots for this workspace
   * Returns snapshots that are approved but not yet synced to disk
   */
  async getUnsyncedSnapshots(): Promise<
    Array<{
      snapshotId: string
      summary: string | null
      createdAt: number
      opCount: number
    }>
  > {
    if (!this.initialized) await this.initialize()
    const repo = getFSOverlayRepository()
    return await repo.getUnsyncedSnapshots(this.workspaceId)
  }
}
