import { fromFileSystemHandle } from '@creatorweave/fs-provider/file-system-handle'
import { getFileContentType } from '@/opfs/utils/opfs-utils'
import type { VfsBackend, VfsReadResult, VfsReadOptions, VfsDirEntry, VfsListOptions } from '../tools/vfs-backend'

/**
 * TeamBackend — VfsBackend adapter for one run's board directory.
 *
 * The directory handle is resolved by the caller (vfs-resolver), because the
 * access decision happens there: this class only does I/O, and only inside a
 * handle it was handed. That split is deliberate — a backend that could resolve
 * its own path would be one bug away from writing outside the run.
 *
 * Boards are plain OPFS directories with no pending tracking, no native FS
 * fallback and no conflict detection: they are scratch space for one run, not
 * documents the user owns.
 */

function inferMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    csv: 'text/csv',
    json: 'application/json',
    txt: 'text/plain',
    md: 'text/markdown',
    jsonl: 'application/x-ndjson',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  }
  return map[ext] ?? 'application/octet-stream'
}

function splitPath(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  if (parts.some(part => part === '.' || part === '..')) {
    throw new Error('Team board paths may not contain "." or ".."')
  }
  return parts
}

async function resolveFile(
  root: FileSystemDirectoryHandle,
  path: string,
  options?: { create?: boolean },
): Promise<FileSystemFileHandle> {
  const parts = splitPath(path)
  const fileName = parts.pop()
  if (!fileName) throw new Error('Path must point to a file')
  let dir = root
  for (const segment of parts) {
    dir = await dir.getDirectoryHandle(segment, { create: options?.create ?? false })
  }
  return dir.getFileHandle(fileName, { create: options?.create ?? false })
}

export class TeamBackend implements VfsBackend {
  readonly label = 'team' as const

  private constructor(private readonly root: FileSystemDirectoryHandle) {}

  /** The resolver hands over an already-authorized run directory. */
  static fromDirectory(directory: FileSystemDirectoryHandle): TeamBackend {
    return new TeamBackend(directory)
  }

  async stat(path: string) {
    return fromFileSystemHandle(this.root).stat(path)
  }

  async mkdir(path: string, options?: { recursive?: boolean }) {
    await fromFileSystemHandle(this.root).mkdir(path, options)
  }

  async readFile(path: string, options?: VfsReadOptions): Promise<VfsReadResult> {
    const fileHandle = await resolveFile(this.root, path)
    const file = await fileHandle.getFile()
    const encoding = options?.encoding ?? (getFileContentType(path) === 'text' ? 'text' : 'binary')
    return {
      content: encoding === 'binary' ? await file.arrayBuffer() : await file.text(),
      size: file.size,
      mimeType: file.type || inferMimeType(path),
      source: 'team',
      mtime: file.lastModified,
    }
  }

  async writeFile(path: string, content: string | ArrayBuffer | Blob): Promise<void> {
    const fileHandle = await resolveFile(this.root, path, { create: true })
    const writable = await fileHandle.createWritable()
    try {
      await writable.write(content)
    } finally {
      await writable.close()
    }
  }

  async deleteFile(path: string): Promise<void> {
    const parts = splitPath(path)
    const fileName = parts.pop()
    if (!fileName) throw new Error('Path must point to a file')
    let dir = this.root
    for (const segment of parts) {
      dir = await dir.getDirectoryHandle(segment)
    }
    await dir.removeEntry(fileName)
  }

  async deleteDir(path: string): Promise<{ deletedFiles: string[]; deletedDirs: string[] }> {
    const normalized = splitPath(path).join('/')
    if (!normalized) {
      // Empty-root delete = retire this run's board: clear every entry but keep
      // the run directory handle itself (OPFS cannot remove the directory this
      // backend was handed). The lead does this when a run reaches its terminal
      // state; the shared `team/` parent is never reachable through a run
      // backend, so other runs' boards are untouched.
      const provider = fromFileSystemHandle(this.root)
      const entries = await this.listDir('', { recursive: true })
      for (const entry of entries.filter(e => e.kind === 'file').map(e => e.path)) {
        await provider.remove(entry)
      }
      for (const dir of entries.filter(e => e.kind === 'directory')
        .sort((a, b) => b.path.split('/').length - a.path.split('/').length)
        .map(e => e.path)) {
        await provider.remove(dir)
      }
      return { deletedFiles: entries.filter(e => e.kind === 'file').map(e => e.path), deletedDirs: [''] }
    }

    const provider = fromFileSystemHandle(this.root)
    if ((await provider.stat(normalized)).kind === 'file') {
      await this.deleteFile(normalized)
      return { deletedFiles: [normalized], deletedDirs: [] }
    }

    const entries = await this.listDir(normalized, { recursive: true })
    await provider.remove(normalized, { recursive: true })
    return {
      deletedFiles: entries.filter(entry => entry.kind === 'file').map(entry => entry.path),
      deletedDirs: [
        ...entries.filter(entry => entry.kind === 'directory')
          .sort((a, b) => b.path.split('/').length - a.path.split('/').length)
          .map(entry => entry.path),
        normalized,
      ],
    }
  }

  async listDir(path: string, options?: VfsListOptions): Promise<VfsDirEntry[]> {
    const normalized = splitPath(path).join('/')
    const provider = fromFileSystemHandle(this.root)
    const maxDepth = options?.maxDepth ?? Infinity
    const entries: VfsDirEntry[] = []

    const collect = async (currentPath: string, depth: number): Promise<void> => {
      for (const entry of await provider.readdir(currentPath)) {
        const entryPath = currentPath ? `${currentPath}/${entry.name}` : entry.name
        entries.push({ ...entry, path: entryPath })
        if (entry.kind === 'directory' && options?.recursive && depth < maxDepth) {
          await collect(entryPath, depth + 1)
        }
      }
    }

    await collect(normalized, 1)
    return entries
  }

  async getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
    return this.root
  }

  async exists(path: string): Promise<boolean> {
    try {
      await resolveFile(this.root, path)
      return true
    } catch {
      return false
    }
  }
}
