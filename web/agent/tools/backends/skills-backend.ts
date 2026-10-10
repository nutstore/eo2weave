import { fromFileSystemHandle } from '@creatorweave/fs-provider/file-system-handle'

/**
 * SkillsBackend — VfsBackend adapter for the skills namespace.
 *
 * Routes `vfs://skills/...` paths to the OPFS `.skills/` directory,
 * the same directory used by builtin skills (skills-platform-adapter.ts).
 *
 * Layout:
 *   opfs-root/.skills/
 *     builtin/<skill-name>/SKILL.md        ← builtin skills (read-only)
 *     user/<skill-name>/SKILL.md           ← user skills (read/write)
 *     user/<skill-name>/scripts/*.py
 *     manifest.json
 *
 * The backend is stateless — each operation resolves the OPFS directory
 * handle fresh, so external changes (e.g. materialize sync) are immediately
 * visible.
 */

import type {
  VfsBackend,
  VfsReadResult,
  VfsReadOptions,
  VfsDirEntry,
  VfsListOptions,
} from '../vfs-backend'

/** OPFS root directory name for all skills */
const SKILLS_ROOT = '.skills'

function inferMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    md: 'text/markdown',
    txt: 'text/plain',
    py: 'text/x-python',
    ts: 'text/typescript',
    js: 'text/javascript',
    json: 'application/json',
    yaml: 'text/yaml',
    yml: 'text/yaml',
  }
  return map[ext] ?? 'text/plain'
}

/**
 * Get or create the `.skills` directory handle in OPFS root.
 * This is the same directory used by skills-platform-adapter.ts.
 */
async function getSkillsRoot(): Promise<FileSystemDirectoryHandle> {
  const opfsRoot = await navigator.storage.getDirectory()
  return opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: true })
}

/**
 * Resolve a relative path (e.g. "user/my-skill/SKILL.md") to
 * a parent directory handle + final file name.
 */
async function resolveFilePath(
  relativePath: string,
  create: boolean = false
): Promise<{ dir: FileSystemDirectoryHandle; fileName: string }> {
  const parts = relativePath.split('/').filter(Boolean)
  if (parts.length === 0) {
    throw new Error('Skills path cannot be empty')
  }
  const fileName = parts.pop()!
  let dir = await getSkillsRoot()

  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create })
  }

  return { dir, fileName }
}

/**
 * Navigate to a directory at the given relative path (or return root if empty).
 */
async function resolveDirPath(
  relativePath: string
): Promise<FileSystemDirectoryHandle> {
  let dir = await getSkillsRoot()
  for (const part of relativePath.split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(part)
  }
  return dir
}

export class SkillsBackend implements VfsBackend {
  readonly label = 'skills' as const

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

  async readFile(path: string, _options?: VfsReadOptions): Promise<VfsReadResult> {
    const { dir, fileName } = await resolveFilePath(path)
    const fileHandle = await dir.getFileHandle(fileName)
    const file = await fileHandle.getFile()
    const content = await file.text()
    return {
      content,
      size: file.size,
      mimeType: inferMimeType(path),
      source: 'skills',
      mtime: file.lastModified,
    }
  }

  async writeFile(path: string, content: string | ArrayBuffer | Blob): Promise<void> {
    const { dir, fileName } = await resolveFilePath(path, true)
    const handle = await dir.getFileHandle(fileName, { create: true })
    const writable = await handle.createWritable()
    await writable.write(content)
    await writable.close()
  }

  async deleteFile(path: string): Promise<void> {
    const { dir, fileName } = await resolveFilePath(path)
    await dir.removeEntry(fileName)
  }

  async deleteDir(path: string): Promise<{ deletedFiles: string[]; deletedDirs: string[] }> {
    const deletedFiles: string[] = []
    const deletedDirs: string[] = []

    // Collect all entries recursively
    const collectAndDelete = async (dirPath: string, parentDir: FileSystemDirectoryHandle, dirName: string) => {
      let dirHandle: FileSystemDirectoryHandle
      try {
        dirHandle = await parentDir.getDirectoryHandle(dirName)
      } catch {
        return // Directory doesn't exist
      }

      const entries: Array<[string, FileSystemHandle]> = []
      for await (const entry of dirHandle.entries()) {
        entries.push(entry)
      }

      for (const [name, handle] of entries) {
        const fullPath = dirPath ? `${dirPath}/${name}` : name
        if (handle.kind === 'file') {
          try {
            await dirHandle.removeEntry(name)
            deletedFiles.push(fullPath)
          } catch {
            // skip
          }
        } else {
          await collectAndDelete(fullPath, dirHandle, name)
        }
      }

      // Remove the directory itself
      try {
        await parentDir.removeEntry(dirName)
        deletedDirs.push(dirPath)
      } catch {
        // skip
      }
    }

    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) {
      throw new Error('Cannot delete skills root directory')
    }

    // Navigate to parent
    const root = await getSkillsRoot()
    const dirName = parts.pop()!
    let parentDir = root
    for (const part of parts) {
      parentDir = await parentDir.getDirectoryHandle(part)
    }

    await collectAndDelete(path, parentDir, dirName)
    return { deletedFiles, deletedDirs }
  }

  async listDir(path: string, _options?: VfsListOptions): Promise<VfsDirEntry[]> {
    let dir: FileSystemDirectoryHandle
    try {
      dir = await resolveDirPath(path)
    } catch {
      return []
    }

    const entries: VfsDirEntry[] = []
    for await (const [name, handle] of dir.entries()) {
      entries.push({
        name,
        path: path ? `${path}/${name}` : name,
        kind: handle.kind === 'directory' ? 'directory' : 'file',
      })
    }
    return entries
  }

  /**
   * Rename / move a file or directory.
   *
   * OPFS doesn't have a standard `move()` across all browsers, so we use
   * copy-then-delete. For skill files (typically small) this is fast enough.
   *
   * - File: read content → write to newPath → delete oldPath
   * - Directory: recursively copy all entries → delete old dir
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    if (oldPath === newPath) return

    // Determine if oldPath is a file or directory
    const parts = oldPath.split('/').filter(Boolean)
    if (parts.length === 0) throw new Error('Cannot rename skills root')

    const root = await getSkillsRoot()
    const lastName = parts.pop()!
    let parentDir = root
    for (const part of parts) {
      parentDir = await parentDir.getDirectoryHandle(part)
    }

    // Check if it's a file or directory
    let isDir = false
    try {
      await parentDir.getFileHandle(lastName)
    } catch {
      isDir = true // Not a file → must be a directory
    }

    if (!isDir) {
      // File rename: read → write new → delete old
      const { dir: oldDir, fileName } = await resolveFilePath(oldPath)
      const fileHandle = await oldDir.getFileHandle(fileName)
      const file = await fileHandle.getFile()
      const content = await file.text()
      await this.writeFile(newPath, content)
      await this.deleteFile(oldPath)
    } else {
      // Directory rename: recursive copy → delete old
      await this._copyDirRecursive(oldPath, newPath)
      await this.deleteDir(oldPath)
    }
  }

  /** Helper: recursively copy a directory's contents to a new path */
  private async _copyDirRecursive(srcPath: string, destPath: string): Promise<void> {
    const srcDir = await resolveDirPath(srcPath)
    // Create destination directory chain
    const destParts = destPath.split('/').filter(Boolean)
    let destDir = await getSkillsRoot()
    for (const part of destParts) {
      destDir = await destDir.getDirectoryHandle(part, { create: true })
    }

    for await (const [name, handle] of srcDir.entries()) {
      if (handle.kind === 'file') {
        const fileHandle = await srcDir.getFileHandle(name)
        const file = await fileHandle.getFile()
        const content = await file.text()
        const newFileHandle = await destDir.getFileHandle(name, { create: true })
        const writable = await newFileHandle.createWritable()
        await writable.write(content)
        await writable.close()
      } else {
        // Recursively copy subdirectory
        await this._copyDirRecursive(`${srcPath}/${name}`, `${destPath}/${name}`)
      }
    }
  }

  async getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await getSkillsRoot()
    } catch {
      return null
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { dir, fileName } = await resolveFilePath(path)
      await dir.getFileHandle(fileName)
      return true
    } catch {
      return false
    }
  }
}
