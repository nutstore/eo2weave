/** OPFS-backed files under the origin-wide webmcp/ directory. */
import { getFileContentType } from '@/opfs/utils/opfs-utils'
import type { VfsBackend, VfsDirEntry, VfsListOptions, VfsReadOptions, VfsReadResult } from '../vfs-backend'

function segments(path: string): string[] {
  const parts = path.split('/')
  if (parts.some((part) => part === '.' || part === '..' || part === '' || part.includes('\\'))) {
    throw new Error(`Invalid WebMCP path: ${path}`)
  }
  return parts
}

export class WebMcpBackend implements VfsBackend {
  readonly label = 'webmcp' as const

  async getDirectoryHandle(): Promise<FileSystemDirectoryHandle> {
    const root = await navigator.storage.getDirectory()
    return root.getDirectoryHandle('webmcp', { create: true })
  }

  private async directory(path: string, create = false): Promise<FileSystemDirectoryHandle> {
    let dir = await this.getDirectoryHandle()
    if (!path) return dir
    for (const part of segments(path)) {
      dir = await dir.getDirectoryHandle(part, { create })
    }
    return dir
  }

  private async parent(path: string, create = false): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = segments(path)
    const name = parts.pop()!
    return { dir: await this.directory(parts.join('/'), create), name }
  }

  async readFile(path: string, options?: VfsReadOptions): Promise<VfsReadResult> {
    const { dir, name } = await this.parent(path)
    const file = await (await dir.getFileHandle(name)).getFile()
    const isText = getFileContentType(path) === 'text'
    const encoding = options?.encoding ?? (isText ? 'text' : 'binary')
    return {
      content: encoding === 'text' ? await file.text() : await file.arrayBuffer(),
      size: file.size,
      mimeType: file.type || (isText ? 'text/plain' : 'application/octet-stream'),
      source: 'webmcp',
      mtime: file.lastModified,
    }
  }

  async writeFile(path: string, content: string | ArrayBuffer | Blob): Promise<void> {
    const { dir, name } = await this.parent(path, true)
    const writable = await (await dir.getFileHandle(name, { create: true })).createWritable()
    try {
      await writable.write(content)
    } finally {
      await writable.close()
    }
  }

  async deleteFile(path: string): Promise<void> {
    const { dir, name } = await this.parent(path)
    await dir.removeEntry(name)
  }

  async deleteDir(path: string): Promise<{ deletedFiles: string[]; deletedDirs: string[] }> {
    if (!path) throw new Error('Cannot delete WebMCP root directory')
    const { dir: parent, name } = await this.parent(path)
    const isFile = await parent.getFileHandle(name).then(
      () => true,
      (error) => {
        // NotFound/TypeMismatch mean "not a file here"; fall through to directory deletion.
        if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) return false
        throw error
      }
    )
    if (isFile) {
      await parent.removeEntry(name)
      return { deletedFiles: [path], deletedDirs: [] }
    }
    const deletedFiles: string[] = []
    const deletedDirs: string[] = []
    const collect = async (dirPath: string): Promise<void> => {
      const dir = await this.directory(dirPath)
      for await (const [name, entry] of dir.entries()) {
        const entryPath = `${dirPath}/${name}`
        if (entry.kind === 'file') deletedFiles.push(entryPath)
        else await collect(entryPath)
      }
      deletedDirs.push(dirPath)
    }
    await collect(path)
    await parent.removeEntry(name, { recursive: true })
    return { deletedFiles, deletedDirs }
  }

  async listDir(path: string, _options?: VfsListOptions): Promise<VfsDirEntry[]> {
    const dir = await this.directory(path)
    const entries: VfsDirEntry[] = []
    for await (const [name, entry] of dir.entries()) {
      entries.push({ name, path: path ? `${path}/${name}` : name, kind: entry.kind })
    }
    return entries
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { dir, name } = await this.parent(path)
      await dir.getFileHandle(name)
      return true
    } catch {
      return false
    }
  }
}
