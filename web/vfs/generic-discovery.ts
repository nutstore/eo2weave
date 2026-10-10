import micromatch from 'micromatch'
import type { VfsBackend } from '@/agent/tools/vfs-backend'
import type { ToolContext } from '@/agent/tools/tool-types'
import { toolOkJson } from '@/agent/tools/tool-envelope'
import { getStaticGlobPrefix, parseBoundedInt, parseStringList } from '@/agent/tools/file-discovery.helpers'
import type { SearchHit, SearchInDirectoryResult } from '@/workers/search-worker-manager'
import { walkBackend } from './walk'

export async function listBackend(backend: VfsBackend, path: string, args: Record<string, unknown>, context: ToolContext, pattern?: string): Promise<string> {
  const maxDepth = parseBoundedInt(args.max_depth ?? args.maxDepth, pattern ? 20 : 2, 1, pattern ? 64 : 10)
  const rawLimit = pattern ? args.max_results ?? args.maxResults ?? args.max_entries ?? args.maxEntries : args.max_entries ?? args.maxEntries
  const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? parseBoundedInt(rawLimit, 1, 1, 100000) : Infinity
  const effectiveRoot = pattern && !path ? getStaticGlobPrefix(pattern) : path
  if (pattern && effectiveRoot && backend.stat) {
    try { await backend.stat(effectiveRoot) }
    catch (error) {
      if ((error as { code?: string }).code === 'ENOENT' || (error as { name?: string }).name === 'NotFoundError') return toolOkJson('ls', [])
      throw error
    }
  }
  const entries = []
  let truncated = false
  const includeSizes = !pattern && (args.include_sizes === true || args.includeSizes === true)
  for await (const entry of walkBackend(backend, effectiveRoot, {
    maxDepth, deadlineAt: Date.now() + parseBoundedInt(args.deadline_ms ?? args.deadlineMs, 25000, 1000, 28000),
    signal: context.abortSignal, includeSizes,
    includeIgnored: args.include_ignored === true || args.includeIgnored === true,
    excludeDirs: parseStringList(args.exclude_dirs ?? args.excludeDirs),
  })) {
    const fullPath = effectiveRoot ? `${effectiveRoot}/${entry.relativePath}` : entry.relativePath
    if (pattern && (entry.kind !== 'file' || (!micromatch.isMatch(fullPath, pattern, { dot: true }) && !micromatch.isMatch(entry.relativePath, pattern, { dot: true })))) continue
    if (entries.length >= limit) { truncated = true; break }
    entries.push({ name: entry.name, path: pattern ? fullPath : entry.relativePath, kind: entry.kind, ...(includeSizes && entry.size ? { size: entry.size } : {}) })
  }
  return toolOkJson('ls', entries, truncated ? { truncated: true, ...(pattern ? { maxResults: limit } : { maxEntries: limit }) } : {})
}

export async function searchBackend(
  backend: VfsBackend, path: string, args: Record<string, unknown>, context: ToolContext,
  findMatches: (path: string, text: string) => SearchHit[],
): Promise<SearchInDirectoryResult> {
  const result: SearchInDirectoryResult = { results: [], files: [], totalMatches: 0, scannedFiles: 0, skippedFiles: 0, truncated: false, deadlineExceeded: false }
  const deadlineAt = Date.now() + parseBoundedInt(args.deadline_ms, 25000, 1, 60000)
  const maxSize = typeof args.max_file_size === 'number' && Number.isFinite(args.max_file_size) ? Math.max(1, args.max_file_size) : 1024 * 1024
  const scan = async (entryPath: string, relativePath: string, size?: number) => {
    context.abortSignal?.throwIfAborted()
    if (Date.now() > deadlineAt) throw Object.assign(new Error('Search deadline exceeded'), { code: 'ETIMEDOUT' })
    if (typeof args.glob === 'string' && !micromatch.isMatch(relativePath, args.glob, { dot: true })) return
    if (size !== undefined && size > maxSize) { result.skippedFiles++; return }
    const read = await backend.readFile(entryPath, { encoding: 'binary' })
    if (read.size > maxSize) { result.skippedFiles++; return }
    const bytes = typeof read.content === 'string' ? new TextEncoder().encode(read.content) :
      read.content instanceof Blob ? new Uint8Array(await read.content.arrayBuffer()) :
      read.content instanceof ArrayBuffer ? new Uint8Array(read.content) : read.content
    if (bytes.includes(0)) { result.skippedFiles++; return }
    result.scannedFiles++
    const hits = findMatches(relativePath, new TextDecoder().decode(bytes)).slice(0, Math.max(0, 10000 - result.results.length))
    result.results.push(...hits)
    result.totalMatches += hits.length
    if (result.results.length >= 10000) result.truncated = true
  }
  try {
    const stat = await backend.stat?.(path)
    if (stat?.kind === 'file') await scan(path, path.split('/').pop()!, stat.size)
    else {
      for await (const entry of walkBackend(backend, path, {
        maxDepth: 50, deadlineAt, signal: context.abortSignal, includeSizes: true,
        includeIgnored: args.include_ignored === true, excludeDirs: parseStringList(args.exclude_dirs),
      })) {
        if (entry.kind === 'file') await scan(entry.path, entry.relativePath, entry.size)
        if (result.truncated) break
      }
    }
  } catch (error) {
    if ((error as { code?: string }).code !== 'ETIMEDOUT') throw error
    result.deadlineExceeded = true
  }
  return result
}
