/**
 * WorkspaceBackend — VfsBackend adapter for OPFS workspace files.
 *
 * Thin wrapper around useOPFSStore / WorkspaceRuntime.
 * Tools call backend.readFile() instead of directly calling opfsStore.readFile().
 *
 * Multi-root: passes null as directoryHandle to WorkspaceRuntime methods,
 * allowing the runtime to resolve the correct root via resolvePath() internally.
 */

import { useOPFSStore } from '@/store/opfs.store'
import type { VfsBackend, VfsReadResult, VfsReadOptions, VfsDirEntry, VfsListOptions } from '../vfs-backend'
import { resolveNativeDirectoryHandle } from '../tool-utils'
import type { ReadPolicy } from '@/opfs/types/opfs-types'
import { getWorkspaceManager } from '@/opfs'
import { fromFileSystemHandle } from '@creatorweave/fs-provider/file-system-handle'
import { FsError } from '@creatorweave/fs-provider'

function inferMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    ts: 'text/typescript', tsx: 'text/typescript',
    js: 'text/javascript', jsx: 'text/javascript', mjs: 'text/javascript',
    json: 'application/json', css: 'text/css', html: 'text/html',
    md: 'text/markdown', txt: 'text/plain', svg: 'image/svg+xml',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
    py: 'text/x-python', rs: 'text/rust', go: 'text/go',
    toml: 'text/toml', yaml: 'text/yaml', yml: 'text/yaml',
    xml: 'text/xml', csv: 'text/csv', pdf: 'application/pdf',
    wasm: 'application/wasm', nol: 'application/zip', zip: 'application/zip',
  }
  return map[ext] ?? 'application/octet-stream'
}

export class WorkspaceBackend implements VfsBackend {
  readonly label = 'workspace' as const

  constructor(
    private workspaceId?: string | null,
    private directoryHandle?: FileSystemDirectoryHandle | null,
    private projectId?: string | null,
    private onWorkspacePathsChanged?: (paths: readonly string[]) => void,
  ) {}

  async stat(path: string) {
    if (!path) return { kind: 'directory' as const }
    const { workspace } = await this.getWorkspaceForBackend()
    const changes = workspace?.getPendingChanges?.() ?? useOPFSStore.getState().getPendingChanges()
    const pending = changes.find((change: { path: string; type: string }) => change.path === path ||
      (change.type === 'delete' && path.startsWith(`${change.path}/`)))
    if (pending?.type === 'delete') throw new FsError('ENOENT', path)
    if (workspace) {
      if (!pending) {
        const resolved = await workspace.resolvePath(path, this.projectId)
        if (resolved.rootId) {
          const stat = await workspace.diskExec.stat(resolved.rootId, resolved.relativePath)
          if (stat) return { kind: stat.isFile ? 'file' as const : 'directory' as const, size: stat.size, mtime: stat.mtime }
        }
      }
      return fromFileSystemHandle(await workspace.getFilesDir()).stat(path)
    }
    const handle = await this.resolveDirHandle()
    if (handle) return fromFileSystemHandle(handle).stat(path)
    throw new FsError('ENOENT', path)
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    const { workspace } = await this.getWorkspaceForBackend()
    if (!workspace) throw new Error('ENOENT: workspace unavailable')
    const resolved = await workspace.resolvePath(path, this.projectId)
    if (resolved.readOnly) throw new FsError('EROFS', path)
    // Empty directories live in the workspace staging tree. Native directory
    // creation is not part of the file-only apply pipeline.
    await fromFileSystemHandle(await workspace.getFilesDir()).mkdir(path, options)
    this.onWorkspacePathsChanged?.([path])
  }

  async readFile(path: string, options?: VfsReadOptions): Promise<VfsReadResult> {
    const { readFile } = useOPFSStore.getState()
    // Pass null as directoryHandle to let WorkspaceRuntime resolve the correct root via resolvePath()
    const readPolicy = options?.readPolicy as ReadPolicy | undefined
    const requestedEncoding = options?.encoding

    const result = readPolicy
      ? await readFile(path, null, this.workspaceId, readPolicy, this.projectId)
      : await readFile(path, null, this.workspaceId, undefined, this.projectId)

    let content: string | Uint8Array | ArrayBuffer | Blob = result.content
    const { metadata, source } = result

    // VfsReadOptions.encoding is part of the public backend contract used by
    // just-bash bridge and other tools. WorkspaceRuntime currently auto-detects
    // text vs binary by file extension, so adapt the payload here to honor the
    // caller's requested encoding.
    if (requestedEncoding === 'binary') {
      if (typeof content === 'string') {
        content = new TextEncoder().encode(content)
      } else if (content instanceof ArrayBuffer) {
        content = new Uint8Array(content)
      } else if (content instanceof Blob) {
        content = new Uint8Array(await content.arrayBuffer())
      }
    } else if (requestedEncoding === 'text') {
      if (content instanceof Uint8Array) {
        content = new TextDecoder().decode(content)
      } else if (content instanceof ArrayBuffer) {
        content = new TextDecoder().decode(content)
      } else if (content instanceof Blob) {
        content = await content.text()
      }
    }

    return {
      content,
      size: metadata.size,
      mimeType: metadata.contentType === 'binary' ? inferMimeType(path) : metadata.contentType,
      source: source === 'opfs' ? 'opfs' : 'native',
      mtime: metadata.mtime,
    }
  }

  async writeFile(path: string, content: string | ArrayBuffer | Blob): Promise<void> {
    const { writeFile } = useOPFSStore.getState()
    // Pass null to let WorkspaceRuntime resolve the correct root
    await writeFile(path, content, null, this.workspaceId, this.projectId)
    this.onWorkspacePathsChanged?.([path])
  }

  async deleteFile(path: string): Promise<void> {
    const { deleteFile } = useOPFSStore.getState()
    // Pass null to let WorkspaceRuntime resolve the correct root
    await deleteFile(path, null, this.workspaceId, this.projectId)
    this.onWorkspacePathsChanged?.([path])
  }

  async deleteDir(path: string): Promise<{ deletedFiles: string[]; deletedDirs: string[] }> {
    const deletedFiles: string[] = []
    const deletedDirs: string[] = []

    // Collect all file paths under this directory.
    // listDir() now merges native + OPFS-only entries, so discoveredFiles covers both.
    // We still do a separate OPFS-only scan as a safety net for any edge cases.

    let discoveredFiles = new Set<string>()
    let nativeDirs: VfsDirEntry[] = []

    try {
      const nativeEntries = await this.listDir(path, { recursive: true, maxDepth: 100 })
      discoveredFiles = new Set(
        nativeEntries.filter((e) => e.kind === 'file').map((e) => e.path)
      )
      nativeDirs = nativeEntries
        .filter((e) => e.kind === 'directory')
        .sort((a, b) => b.path.split('/').length - a.path.split('/').length)
    } catch {
      // Directory doesn't exist on native filesystem — OPFS-only, that's OK
    }

    // Also collect OPFS-only files that might have been missed by listDir (safety net)
    const prefix = path ? path + '/' : ''
    const opfsOnlyFiles = new Set<string>()

    // From cached paths (files written to OPFS but not on native disk)
    const { getCachedPaths } = useOPFSStore.getState()
    const cachedPaths = getCachedPaths()
    for (const cachedPath of cachedPaths) {
      if (cachedPath.startsWith(prefix) && !discoveredFiles.has(cachedPath)) {
        opfsOnlyFiles.add(cachedPath)
      }
    }

    // From pending changes — collect files to delete AND stale pending entries to clean up
    const { getPendingChanges } = useOPFSStore.getState()
    const pendingChanges = getPendingChanges()

    // Collect create/modify files for actual deletion
    for (const change of pendingChanges) {
      if (
        (change.type === 'create' || change.type === 'modify') &&
        change.path.startsWith(prefix) &&
        !discoveredFiles.has(change.path) &&
        !opfsOnlyFiles.has(change.path)
      ) {
        opfsOnlyFiles.add(change.path)
      }
    }

    // Delete all files: discovered + OPFS-only
    const allFiles = [...discoveredFiles, ...opfsOnlyFiles.keys()]
    for (const filePath of allFiles) {
      try {
        await this.deleteFile(filePath)
        deletedFiles.push(filePath)
      } catch {
        // Skip files that fail to delete
      }
    }

    // Clean up stale pending entries under this directory that were NOT already handled above.
    // This covers leftover 'delete' entries from previous partial deletions where the file
    // data was already removed from OPFS but the pending record was never synced/discarded.
    const staleDeletePaths = pendingChanges
      .filter(
        (change) =>
          change.type === 'delete' &&
          change.path.startsWith(prefix) &&
          !allFiles.includes(change.path)
      )
      .map((change) => change.path)

    if (staleDeletePaths.length > 0) {
      try {
        await this.discardPendingPaths(staleDeletePaths)
      } catch {
        // Fall back to one-by-one if batch fails
        for (const p of staleDeletePaths) {
          try {
            await this.discardPendingPath(p)
          } catch {
            // Skip entries that fail to discard
          }
        }
      }

      // Refresh OPFS store state once after batch discard
      try {
        const state = useOPFSStore.getState()
        if (state.refresh) await state.refresh()
      } catch {
        // Non-critical — store will refresh on next interaction
      }
    }

    // Record directories that were emptied
    for (const dir of nativeDirs) {
      deletedDirs.push(dir.path)
    }
    deletedDirs.push(path)

    // NOTE: The directory itself is NOT removed from the native filesystem here.
    // In manual-apply mode, deletions must only be recorded as pending changes
    // (via deleteFile → markForDeletion) so the user can review them before they
    // affect real disk. Removing native entries directly here would bypass the
    // pending pipeline — see the regression in deleteDir that wiped real files.

    // Record the emptied directories as pending deletes too — deepest-first so
    // sync removes children before parents. Without this, a directory tree with
    // no files (e.g. web/src with 153 empty dirs) produces zero pending records
    // and the empty dirs can never be cleaned from disk: pruneEmptyParents only
    // runs when a FILE delete record anchors it, and there are no file records.
    // The sync executors handle directory paths idempotently (FS Access
    // removeEntry / native-host delete_file both delete empty dirs), so a
    // directory pending record executes as an empty-dir removal.
    //
    // Dedupe against file records already marked above, so a directory that
    // also exists as a file entry isn't recorded twice.
    try {
      const { deleteDirPending } = useOPFSStore.getState()
      const fileRecorded = new Set(deletedFiles)
      for (const dirPath of deletedDirs) {
        if (fileRecorded.has(dirPath)) continue
        // Mirror deleteFile's store call convention (null handle → runtime
        // resolves the root; workspaceId + projectId for multi-root routing).
        await deleteDirPending(dirPath, null, this.workspaceId, this.projectId)
      }
    } catch {
      // Directory pending records are best-effort — file records above remain
      // the source of truth for actual deletions.
    }

    return { deletedFiles, deletedDirs }
  }

  async listDir(path: string, options?: VfsListOptions): Promise<VfsDirEntry[]> {
    const recursive = options?.recursive ?? false
    const maxDepth = options?.maxDepth ?? 1

    // Phase 1: Collect native filesystem entries (may fail for OPFS-only directories)
    const nativeEntries: VfsDirEntry[] = []
    const nativePathSet = new Set<string>()

    // Multi-root: resolve the correct root handle for this path.
    // Try multi-root routing first (uses resolvePath to find the right root),
    // fall back to the legacy single-root resolveDirHandle().
    let nativeDirHandle: FileSystemDirectoryHandle | null = null
    let nativeRelativePath = path
    let workspace: any = null // hoisted for Phase 1b (native-host disk scan)
    let resolved: any = null
    try {
      const wsResult = await this.getWorkspaceForBackend()
      workspace = wsResult.workspace
      if (workspace) {
        resolved = await workspace.resolvePath(path)
        // Always derive nativeRelativePath from resolved, even when no FS Access
        // handle is available — Phase 1b (native-host diskExec.listDir) needs
        // the root-relative path, not the original path with rootName prefix.
        // Previously this assignment was guarded behind `if (rootHandle)`, which
        // left nativeRelativePath = path for native-host roots and broke
        // diskExec.listDir calls.
        nativeRelativePath = resolved.relativePath || ''
        const rootHandle = await workspace.getNativeDirectoryHandleForPath(path)
        if (rootHandle) {
          nativeDirHandle = rootHandle
        }
      }
    } catch {
      // Multi-root resolution failed — fall back to legacy handle
    }
    if (!nativeDirHandle) {
      nativeDirHandle = await this.resolveDirHandle()
    }

    if (nativeDirHandle) {
      try {
        let dirHandle: FileSystemDirectoryHandle = nativeDirHandle
        if (nativeRelativePath) {
          const segments = nativeRelativePath.split('/').filter(Boolean)
          for (let i = 0; i < segments.length; i++) {
            try {
              dirHandle = await dirHandle.getDirectoryHandle(segments[i]!)
            } catch (dirErr) {
              // Check if this segment is a file — if so, the path points to a file, not a directory
              const isLast = i === segments.length - 1
              if (isLast) {
                try {
                  await dirHandle.getFileHandle(segments[i]!)
                  // It's a file — listDir on a file path is an error
                  throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
                } catch (fileErr) {
                  // getFileHandle also failed — re-throw as ENOTDIR or let it propagate
                  if (fileErr instanceof Error && fileErr.message.startsWith('ENOTDIR')) throw fileErr
                  throw dirErr
                }
              }
              // Not the last segment — a parent path component is not a directory
              throw dirErr
            }
          }
        }

        if (!recursive || maxDepth <= 1) {
          for await (const [name, entry] of (dirHandle as any).entries()) {
            const entryPath = path ? `${path}/${name}` : name
            nativeEntries.push({ name, path: entryPath, kind: entry.kind })
            nativePathSet.add(entryPath)
          }
        } else {
          await this._listDirRecursive(dirHandle, path, nativeEntries, maxDepth, 1)
          for (const e of nativeEntries) nativePathSet.add(e.path)
        }
      } catch {
        // Directory doesn't exist on native filesystem — OPFS-only, that's OK
      }
    }

    // Phase 1b: Native-host disk scan. For native-host-backed roots, the
    // FileSystemDirectoryHandle from Phase 1a is null (no FS Access API
    // handle exists) — diskExec.listDir is the only way to enumerate files
    // that live only on disk via the Rust native host. Without this, `ls`,
    // `find`, and tree traversal all miss native-host-only directories.
    if (workspace && resolved && resolved.backend === 'native-host' && resolved.rootId) {
      try {
        if (!recursive || maxDepth <= 1) {
          const diskEntries = await workspace.diskExec.listDir(resolved.rootId, nativeRelativePath)
          for (const e of diskEntries) {
            const entryPath = path ? `${path}/${e.name}` : e.name
            if (!nativePathSet.has(entryPath)) {
              nativeEntries.push({ name: e.name, path: entryPath, kind: e.kind })
              nativePathSet.add(entryPath)
            }
          }
        } else {
          await this._listDirDiskRecursive(
            workspace.diskExec,
            resolved.rootId,
            nativeRelativePath,
            path,
            nativeEntries,
            maxDepth,
            1,
            nativePathSet,
          )
        }
      } catch {
        // Disk dir not accessible (no permission, ENOENT, etc.) — skip
      }
    }

    // Phase 2: Merge OPFS-only files that are invisible to native filesystem
    // These are files created by Python (Pyodide) writes that never hit native disk.
    const prefix = path ? path + '/' : ''
    const opfsExtraEntries: VfsDirEntry[] = []
    const opfsExtraPaths = new Set<string>()

    // Helper: add a file entry and its parent directories (if under our path)
    const addOpfsFile = (filePath: string) => {
      if (nativePathSet.has(filePath) || opfsExtraPaths.has(filePath)) return
      if (prefix && !filePath.startsWith(prefix)) return

      opfsExtraEntries.push({
        name: filePath.split('/').pop()!,
        path: filePath,
        kind: 'file',
      })
      opfsExtraPaths.add(filePath)
    }

    // Helper: ensure directory entries exist for all intermediate directories
    const ensureDirEntries = (filePath: string) => {
      if (!prefix) return
      // filePath = "rootName/a/b/c/file.txt", prefix = "rootName/a/"
      // Need directory entries for: "rootName/a/b", "rootName/a/b/c" (if recursive)
      const relativePath = filePath.slice(prefix.length) // "b/c/file.txt"
      const segments = relativePath.split('/')
      for (let i = 1; i < segments.length; i++) {
        const dirPath = prefix + segments.slice(0, i).join('/')
        if (!nativePathSet.has(dirPath) && !opfsExtraPaths.has(dirPath)) {
          opfsExtraEntries.push({
            name: segments[i - 1],
            path: dirPath,
            kind: 'directory',
          })
          opfsExtraPaths.add(dirPath)
        }
      }
    }

    // Collect from OPFS cached paths (files in OPFS files/ directory)
    const { getCachedPaths } = useOPFSStore.getState()
    const cachedPaths = getCachedPaths()
    // Collect from pending creates/modifies (not yet in filesIndex but still OPFS-only)
    const { getPendingChanges } = useOPFSStore.getState()
    const pendingChanges = getPendingChanges()
    const allOpfsPaths = [
      ...cachedPaths,
      ...pendingChanges
        .filter((c) => c.type === 'create' || c.type === 'modify')
        .map((c) => c.path),
    ]

    for (const filePath of allOpfsPaths) {
      if (prefix && !filePath.startsWith(prefix)) continue
      if (!prefix && filePath.includes('/')) {
        // Root-level listing (path=''): skip deeply nested paths.
        // OPFS-only root-level files without '/' will still be listed.
        // Note: in multi-root mode, root-level OPFS directories (e.g. "rootName/")
        // are discovered through native filesystem, so this is not a problem.
        continue
      }

      if (recursive) {
        // Recursive: add the file itself + all intermediate directories
        ensureDirEntries(filePath)
        addOpfsFile(filePath)
      } else {
        // Non-recursive: only add the immediate child entry (file or directory)
        const relativePath = prefix ? filePath.slice(prefix.length) : filePath
        const firstSlash = relativePath.indexOf('/')
        if (firstSlash === -1) {
          // Direct child — it's a file
          addOpfsFile(filePath)
        } else {
          // Nested — only add the first directory segment as a directory entry
          const childName = relativePath.slice(0, firstSlash)
          const childPath = prefix ? prefix + childName : childName
          if (!nativePathSet.has(childPath) && !opfsExtraPaths.has(childPath)) {
            opfsExtraEntries.push({
              name: childName,
              path: childPath,
              kind: 'directory',
            })
            opfsExtraPaths.add(childPath)
          }
        }
      }
    }

    // Physical OPFS directories can be empty and therefore have no cached file
    // or pending-file record. Include them in the staging view used by bash.
    if (workspace) {
      try {
        const files = await workspace.getFilesDir()
        let dir = files
        for (const part of path.split('/').filter(Boolean)) dir = await dir.getDirectoryHandle(part)
        const physical: VfsDirEntry[] = []
        await this._listDirRecursive(dir, path, physical, recursive ? maxDepth : 1, 1)
        for (const entry of physical) {
          if (entry.kind !== 'directory' || nativePathSet.has(entry.path) || opfsExtraPaths.has(entry.path)) continue
          if (pendingChanges.some(change => change.type === 'delete' && (change.path === entry.path || entry.path.startsWith(`${change.path}/`)))) continue
          opfsExtraEntries.push(entry)
          opfsExtraPaths.add(entry.path)
        }
      } catch {
        // The path may exist only on native disk.
      }
    }

    // Merge: native entries first, then OPFS-only extras
    const merged = [...nativeEntries, ...opfsExtraEntries]

    // If nothing found, check if the path itself is an OPFS-only file
    // (e.g. a file written by Python/Pyodide that never hit native disk)
    if (merged.length === 0 && path) {
      const isOpfsFile = allOpfsPaths.includes(path)
        || cachedPaths.includes(path)
        || pendingChanges.some(c => c.path === path && (c.type === 'create' || c.type === 'modify'))
      if (isOpfsFile) {
        throw new Error(`ENOTDIR: not a directory, scandir '${path}'`)
      }
    }

    return merged
  }

  private async _listDirRecursive(
    dirHandle: FileSystemDirectoryHandle,
    currentPath: string,
    acc: VfsDirEntry[],
    maxDepth: number,
    currentDepth: number,
  ): Promise<void> {
    for await (const [name, entry] of (dirHandle as any).entries()) {
      const entryPath = currentPath ? `${currentPath}/${name}` : name
      acc.push({
        name,
        path: entryPath,
        kind: entry.kind,
      })
      if (entry.kind === 'directory' && currentDepth < maxDepth) {
        try {
          const subDir = await dirHandle.getDirectoryHandle(name)
          await this._listDirRecursive(subDir, entryPath, acc, maxDepth, currentDepth + 1)
        } catch {
          // Skip directories we can't access
        }
      }
    }
  }

  /**
   * Recursive scanner for native-host disk directories — mirrors
   * `_listDirRecursive` but uses `diskExec.listDir(rootId, relativePath)`
   * instead of `FileSystemDirectoryHandle.entries()`. Native-host scopes
   * have no FS Access API handle, so the FS Access API path is unreachable.
   *
   * Both `currentRelativePath` (root-relative) and `currentFullPath` (with
   * rootName prefix) are tracked so returned entries match the caller's
   * original path namespace — same convention as the FS Access API scanner.
   */
  private async _listDirDiskRecursive(
    diskExec: { listDir(rootId: string, relativePath: string): Promise<Array<{ name: string; kind: 'file' | 'directory' }>> },
    rootId: string,
    currentRelativePath: string,
    currentFullPath: string,
    acc: VfsDirEntry[],
    maxDepth: number,
    currentDepth: number,
    pathSet: Set<string>,
  ): Promise<void> {
    let entries: Array<{ name: string; kind: 'file' | 'directory' }>
    try {
      entries = await diskExec.listDir(rootId, currentRelativePath)
    } catch {
      return // dir not accessible
    }
    for (const e of entries) {
      const childRelativePath = currentRelativePath ? `${currentRelativePath}/${e.name}` : e.name
      const childFullPath = currentFullPath ? `${currentFullPath}/${e.name}` : e.name
      acc.push({ name: e.name, path: childFullPath, kind: e.kind })
      pathSet.add(childFullPath)
      if (e.kind === 'directory' && currentDepth < maxDepth) {
        await this._listDirDiskRecursive(
          diskExec,
          rootId,
          childRelativePath,
          childFullPath,
          acc,
          maxDepth,
          currentDepth + 1,
          pathSet,
        )
      }
    }
  }

  async getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
    return this.resolveDirHandle()
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { readFile } = useOPFSStore.getState()
      // Pass null to let WorkspaceRuntime resolve the correct root
      await readFile(path, null, this.workspaceId)
      return true
    } catch {
      return false
    }
  }

  /**
   * Get the WorkspaceRuntime instance for this backend.
   * Used by listDir and deleteDir for multi-root path resolution.
   */
  private async getWorkspaceForBackend(): Promise<{ workspace: any; workspaceId: string | null }> {
    const { useWorkspaceStore } = await import('@/store/workspace.store')
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
    const targetWorkspaceId = this.workspaceId || activeWorkspaceId
    if (!targetWorkspaceId) {
      return { workspace: null, workspaceId: targetWorkspaceId }
    }

    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(targetWorkspaceId)
    return { workspace, workspaceId: targetWorkspaceId }
  }

  /**
   * Resolve a directory handle for callers that need a single handle (listDir, getDirectoryHandle).
   * Not used by readFile/writeFile/deleteFile which go through WorkspaceRuntime's multi-root routing.
   */
  private async resolveDirHandle(): Promise<FileSystemDirectoryHandle | null> {
    if (this.directoryHandle) return this.directoryHandle
    return resolveNativeDirectoryHandle(this.directoryHandle, this.workspaceId)
  }

  /**
   * Discard a stale pending entry by path (removes from pending DB without touching file data).
   * Used by deleteDir to clean up orphaned 'delete' pending records for files whose OPFS data
   * was already removed but the pending record was never synced/discarded.
   * Note: Caller is responsible for refreshing OPFS store state after batch discards.
   */
  private async discardPendingPath(path: string): Promise<void> {
    const { useWorkspaceStore } = await import('@/store/workspace.store')
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
    const targetWorkspaceId = this.workspaceId || activeWorkspaceId
    if (!targetWorkspaceId) return

    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(targetWorkspaceId)
    if (!workspace) return

    await workspace.discardPendingPath(path)
  }

  /**
   * Batch-discard stale pending entries. More efficient than one-by-one
   * because it saves metadata once and avoids repeated store refreshes.
   */
  private async discardPendingPaths(paths: string[]): Promise<void> {
    const { useWorkspaceStore } = await import('@/store/workspace.store')
    const activeWorkspaceId = useWorkspaceStore.getState().activeWorkspaceId
    const targetWorkspaceId = this.workspaceId || activeWorkspaceId
    if (!targetWorkspaceId) return

    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(targetWorkspaceId)
    if (!workspace) return

    await workspace.discardPendingPaths(paths)
  }
}
