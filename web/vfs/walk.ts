import type { VfsBackend, VfsDirEntry } from '@/agent/tools/vfs-backend'
import { shouldSkipDirectory } from '@/agent/tools/file-discovery.helpers'
import { isGitIgnored, parseGitIgnore, type GitIgnoreRule } from '@/opfs/native-disk/gitignore-policy'

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
  const initialRules: GitIgnoreRule[] = []
  if (!options.includeIgnored && path) {
    let parent = ''
    for (const segment of path.split('/').filter(Boolean)) {
      try {
        const file = await backend.readFile(parent ? `${parent}/.gitignore` : '.gitignore', { encoding: 'text' })
        if (typeof file.content === 'string') initialRules.push(...parseGitIgnore(file.content, parent))
      } catch { /* Optional ignore file. */ }
      parent = parent ? `${parent}/${segment}` : segment
    }
  }
  const queue: Array<{ path: string; relativePath: string; depth: number; rules: GitIgnoreRule[] }> = [{ path, relativePath: '', depth: 0, rules: initialRules }]
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]
    if (current.depth >= options.maxDepth) continue
    checkWalkBudget(options)
    const entries = await backend.listDir(current.path)
    let rules = current.rules
    const ignoreFile = !options.includeIgnored && entries.find((entry) => entry.name === '.gitignore' && entry.kind === 'file')
    if (ignoreFile) {
      try {
        const result = await backend.readFile(ignoreFile.path, { encoding: 'text' })
        if (typeof result.content === 'string') rules = [...rules, ...parseGitIgnore(result.content, current.path)]
      } catch { /* An unreadable .gitignore must not prevent discovery. */ }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      checkWalkBudget(options)
      if (entry.kind === 'directory' && shouldSkipDirectory(entry.name, options.includeIgnored ?? false, options.excludeDirs ?? [])) continue
      const relativePath = current.relativePath ? `${current.relativePath}/${entry.name}` : entry.name
      if (!options.includeIgnored && isGitIgnored(entry.path, rules)) continue
      let size = entry.size
      if (options.includeSizes && entry.kind === 'file' && size === undefined && backend.stat) size = (await backend.stat(entry.path)).size
      yield { ...entry, size, relativePath }
      if (entry.kind === 'directory') queue.push({ path: entry.path, relativePath, depth: current.depth + 1, rules })
    }
  }
}

function checkWalkBudget(options: WalkOptions): void {
  options.signal?.throwIfAborted()
  if (Date.now() > options.deadlineAt) throw Object.assign(new Error('Discovery deadline exceeded'), { code: 'ETIMEDOUT' })
}
