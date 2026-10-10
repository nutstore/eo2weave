import type { VfsBackend, VfsDirEntry } from '@/agent/tools/vfs-backend'
import { shouldSkipDirectory } from '@/agent/tools/file-discovery.helpers'

export interface WalkOptions {
  maxDepth: number
  includeIgnored?: boolean
  excludeDirs?: string[]
  deadlineAt: number
  signal?: AbortSignal
  includeSizes?: boolean
}

/** Shared fallback for every backend without a native discovery implementation. */
export async function* walkBackend(backend: VfsBackend, path: string, options: WalkOptions): AsyncGenerator<VfsDirEntry & { relativePath: string }> {
  const queue = [{ path, relativePath: '', depth: 0 }]
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    if (current.depth >= options.maxDepth) continue
    checkWalkBudget(options)
    const entries = await backend.listDir(current.path)
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      checkWalkBudget(options)
      if (entry.kind === 'directory' && shouldSkipDirectory(entry.name, options.includeIgnored ?? false, options.excludeDirs ?? [])) continue
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name
      let size = entry.size
      if (options.includeSizes && entry.kind === 'file' && size === undefined && backend.stat) size = (await backend.stat(entry.path)).size
      yield { ...entry, size, relativePath }
      if (entry.kind === 'directory') queue.push({ path: entry.path, relativePath, depth: current.depth + 1 })
    }
  }
}

function checkWalkBudget(options: WalkOptions): void {
  options.signal?.throwIfAborted()
  if (Date.now() > options.deadlineAt) throw Object.assign(new Error('Discovery deadline exceeded'), { code: 'ETIMEDOUT' })
}
