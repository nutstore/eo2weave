import { fromFileSystemHandle } from '@creatorweave/fs-provider/file-system-handle'

/**
 * AgentBackend — VfsBackend adapter for agent namespace files.
 *
 * Thin wrapper around AgentManager.
 * Agent files are simpler than workspace: no pending tracking, no native FS fallback.
 */

import type { AgentManager } from '@/opfs'
import type { VfsBackend, VfsReadResult, VfsReadOptions, VfsDirEntry, VfsListOptions } from '../vfs-backend'

function inferMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  const map: Record<string, string> = {
    md: 'text/markdown', txt: 'text/plain',
    ts: 'text/typescript', js: 'text/javascript',
    json: 'application/json',
  }
  return map[ext] ?? 'text/plain'
}

export class AgentBackend implements VfsBackend {
  readonly label = 'agent' as const

  constructor(
    private agentManager: AgentManager,
    private agentId: string,
  ) {}

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
    const content = await this.agentManager.readPath(this.agentId, path)
    if (content == null) {
      throw new Error(`File not found: vfs://agents/${this.agentId}/${path}`)
    }
    const size = new TextEncoder().encode(content).length
    return {
      content: options?.encoding === 'binary' ? new TextEncoder().encode(content) : content,
      size,
      mimeType: inferMimeType(path),
      source: 'agent',
    }
  }

  async writeFile(path: string, content: string | ArrayBuffer | Blob): Promise<void> {
    let text: string
    if (typeof content === 'string') {
      text = content
    } else if (content instanceof Blob) {
      text = await content.text()
    } else {
      text = new TextDecoder().decode(content)
    }
    // Auto-create agent if it doesn't exist yet
    const exists = await this.agentManager.hasAgent(this.agentId)
    if (!exists) {
      await this.agentManager.createAgent(this.agentId)
    }
    await this.agentManager.writePath(this.agentId, path, text)
  }

  async deleteFile(path: string): Promise<void> {
    await this.agentManager.deletePath(this.agentId, path)
  }

  async deleteDir(path: string): Promise<{ deletedFiles: string[]; deletedDirs: string[] }> {
    const deletedFiles: string[] = []
    const deletedDirs: string[] = []

    // Collect all file/dir paths recursively (for deletion, not reporting)
    const filePaths: string[] = []
    const collectEntries = async (dirPath: string) => {
      const entries = await this.listDir(dirPath)
      for (const entry of entries) {
        if (entry.kind === 'file') {
          filePaths.push(entry.path)
        } else {
          await collectEntries(entry.path)
        }
      }
    }

    await collectEntries(path)

    // Delete files, only report successful deletions
    for (const filePath of filePaths) {
      try {
        await this.agentManager.deletePath(this.agentId, filePath)
        deletedFiles.push(filePath)
      } catch {
        // Skip files that fail to delete
      }
    }

    // Remove the directory recursively via OPFS
    const handle = await this.agentManager.getDirectoryHandle(this.agentId, path, { allowMissing: true })
    if (handle.exists && handle.handle) {
      // Get parent and remove
      const parts = path.split('/').filter(Boolean)
      if (parts.length > 0) {
        const parentPath = parts.slice(0, -1).join('/')
        const parentResult = await this.agentManager.getDirectoryHandle(this.agentId, parentPath, { allowMissing: true })
        if (parentResult.handle) {
          await parentResult.handle.removeEntry(parts[parts.length - 1], { recursive: true })
        }
      }
    }
    deletedDirs.push(path)

    return { deletedFiles, deletedDirs }
  }

  async listDir(path: string, _options?: VfsListOptions): Promise<VfsDirEntry[]> {
    const handle = await this.agentManager.getDirectoryHandle(this.agentId, path, { allowMissing: true })
    if (!handle.exists || !handle.handle) return []

    const entries: VfsDirEntry[] = []
    for await (const [name, entry] of (handle.handle as any).entries()) {
      entries.push({
        name,
        path: path ? `${path}/${name}` : name,
        kind: entry.kind,
      })
    }
    return entries
  }

  async getDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
    const result = await this.agentManager.getDirectoryHandle(this.agentId, '', { allowMissing: true })
    return result.handle ?? null
  }

  async exists(path: string): Promise<boolean> {
    try {
      const content = await this.agentManager.readPath(this.agentId, path)
      return content != null
    } catch {
      // Agent directory or file does not exist — not an error, just "not found"
      return false
    }
  }
}
