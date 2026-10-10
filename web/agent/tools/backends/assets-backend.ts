import { fromFileSystemHandle } from '@creatorweave/fs-provider/file-system-handle'

/**
 * AssetsBackend — VfsBackend adapter for the assets/ directory.
 *
 * Assets are user-uploaded and agent-generated files stored in a dedicated
 * OPFS directory alongside the workspace's files/ directory.
 *
 * Unlike workspace files, assets have no pending tracking, no native FS
 * fallback, and no conflict detection — simple direct I/O.
 */

import { getWorkspaceManager } from '@/opfs'
import { getFileContentType } from '@/opfs/utils/opfs-utils'
import type { VfsBackend, VfsReadResult, VfsReadOptions, VfsDirEntry, VfsListOptions } from '../vfs-backend'

function inferMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    csv: 'text/csv', tsv: 'text/tab-separated-values',
    json: 'application/json', xml: 'text/xml',
    txt: 'text/plain', md: 'text/markdown',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls: 'application/vnd.ms-excel',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    nol: 'application/zip',
    zip: 'application/zip',
  }
  return map[ext] ?? 'application/octet-stream'
}

/**
 * Navigate to a file/directory within a root directory handle,
 * creating parent directories as needed (for writes).
 */
async function navigateTo(
  root: FileSystemDirectoryHandle,
  path: string,
  options?: { create?: boolean; createParents?: boolean }
): Promise<FileSystemFileHandle> {
  const parts = path.split('/').filter(Boolean)
  const fileName = parts.pop()
  if (!fileName) throw new Error('Path must point to a file')

  let dir = root
  for (const segment of parts) {
    dir = await dir.getDirectoryHandle(segment, { create: options?.createParents ?? options?.create ?? false })
  }
  return dir.getFileHandle(fileName, { create: options?.create ?? false })
}

/**
 * Navigate to the parent directory of a file path.
 * Creates parent directories if needed.
 */
async function navigateToParent(
  root: FileSystemDirectoryHandle,
  path: string,
): Promise<{ dir: FileSystemDirectoryHandle; fileName: string }> {
  const parts = path.split('/').filter(Boolean)
  const fileName = parts.pop()
  if (!fileName) throw new Error('Path must point to a file')

  let dir = root
  for (const segment of parts) {
    dir = await dir.getDirectoryHandle(segment, { create: true })
  }
  return { dir, fileName }
}

export class AssetsBackend implements VfsBackend {
  readonly label = 'assets' as const

  private dirHandle: FileSystemDirectoryHandle | null = null
  private workspaceId: string | null

  constructor(workspaceId?: string | null) {
    this.workspaceId = workspaceId ?? null
  }

  async stat(path: string) {
    const root = await this.getDirectoryHandle()
    if (!root) throw new Error('ENOENT: directory unavailable')
    return fromFileSystemHandle(root).stat(path)
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    const root = await this.getDirectoryHandle()
    if (!root) throw new Error('ENOENT: directory unavailable')
    await fromFileSystemHandle(root).mkdir(path, options)
  }

  async readFile(path: string, options?: VfsReadOptions): Promise<VfsReadResult> {
    const dir = await this.getDir()
    const fileHandle = await navigateTo(dir, path)
    const file = await fileHandle.getFile()

    // Auto-detect encoding from file extension (same logic as WorkspaceBackend).
    // Default to 'binary' to preserve binary files (docx/images/etc.).
    const encoding = options?.encoding
      ?? (getFileContentType(path) === 'text' ? 'text' : 'binary')
    const content = encoding === 'binary'
      ? await file.arrayBuffer()
      : await file.text()

    return {
      content,
      size: file.size,
      mimeType: file.type || inferMimeType(path),
      source: 'assets',
      mtime: file.lastModified,
    }
  }

  async writeFile(path: string, content: string | ArrayBuffer | Blob): Promise<void> {
    const dir = await this.getDir()
    const { dir: parentDir, fileName } = await navigateToParent(dir, path)
    const fileHandle = await parentDir.getFileHandle(fileName, { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(content)
    } finally {
      await writable.close()
    }
  }

  async deleteFile(path: string): Promise<void> {
    const dir = await this.getDir()
    const { dir: parentDir, fileName } = await navigateToParent(dir, path)
    await parentDir.removeEntry(fileName)
  }

  async deleteDir(path: string): Promise<{ deletedFiles: string[]; deletedDirs: string[] }> {
    const dir = await this.getDir()
    const deletedFiles: string[] = []
    const deletedDirs: string[] = []

    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) {
      // Cannot delete the root assets directory
      return { deletedFiles, deletedDirs }
    }

    // Navigate to the target directory
    let targetDir = dir
    for (const segment of parts) {
      targetDir = await targetDir.getDirectoryHandle(segment)
    }

    // Collect all entries recursively
    const collectEntries = async (currentDir: FileSystemDirectoryHandle, currentPath: string) => {
      for await (const [name, entry] of (currentDir as any).entries()) {
        const entryPath = currentPath ? `${currentPath}/${name}` : name
        if (entry.kind === 'file') {
          deletedFiles.push(entryPath)
        } else {
          await collectEntries(entry, entryPath)
          deletedDirs.push(entryPath)
        }
      }
    }

    await collectEntries(targetDir, path)

    // Remove the directory recursively
    let parentDir = dir
    for (let i = 0; i < parts.length - 1; i++) {
      parentDir = await parentDir.getDirectoryHandle(parts[i])
    }
    const dirName = parts[parts.length - 1]
    await parentDir.removeEntry(dirName, { recursive: true })
    deletedDirs.push(path)

    return { deletedFiles, deletedDirs }
  }

  async listDir(path: string, _options?: VfsListOptions): Promise<VfsDirEntry[]> {
    const dir = await this.getDir()
    let targetDir = dir
    if (path) {
      for (const segment of path.split('/').filter(Boolean)) {
        targetDir = await targetDir.getDirectoryHandle(segment)
      }
    }

    const entries: VfsDirEntry[] = []
    for await (const [name, entry] of (targetDir as any).entries()) {
      entries.push({
        name,
        path: path ? `${path}/${name}` : name,
        kind: entry.kind,
      })
    }
    return entries
  }

  async getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
    return this.getDir()
  }

  async exists(path: string): Promise<boolean> {
    try {
      const dir = await this.getDir()
      await navigateTo(dir, path)
      return true
    } catch {
      return false
    }
  }

  /**
   * Resolve the assets directory handle.
   * workspaceId is always provided at construction. If missing, throws (caller bug).
   */
  private async getDir(): Promise<FileSystemDirectoryHandle> {
    if (this.dirHandle) return this.dirHandle

    if (!this.workspaceId) {
      throw new Error('workspaceId is required for assets (caller bug)')
    }

    const manager = await getWorkspaceManager()
    const workspace = await manager.getWorkspace(this.workspaceId)
    if (!workspace) {
      throw new Error(`Workspace not found for assets: ${this.workspaceId}`)
    }

    this.dirHandle = await workspace.getAssetsDir()
    return this.dirHandle
  }
}
