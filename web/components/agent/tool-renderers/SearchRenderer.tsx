/**
 * Renderer for `search` tool — grouped results by file with line numbers.
 * Supports expand/collapse for both file-level and line-level results.
 * Line-level details are loaded on demand via the search worker to keep
 * the stored message compact.
 */

import { useState, useCallback, useEffect } from 'react'
import { Search } from 'lucide-react'
import { CopyIconButton } from '../CopyIconButton'
import type { ToolEnvelopeError } from '@/agent/tools/tool-envelope'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { getSearchWorkerManager } from '@/workers/search-worker-manager'
import type { SearchHit } from '@/workers/search-worker-manager'
import { getRuntimeHandlesForProject } from '@/native-fs'
import { useProjectStore } from '@/store/project.store'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { readAssetBlob } from '../asset-utils'

/** Matches SearchHit from search-worker-manager.ts */
interface SearchResult {
  path: string
  line?: number
  column?: number
  match?: string
  preview?: string
  [key: string]: unknown
}

/** Matches FileSearchResult from search-worker-manager.ts */
interface FileResult {
  path: string
  matchCount: number
  titleMatch: 'exact' | 'partial' | false
  bestPreview: string
  bestLine: number
  hits?: SearchResult[]
  /** True when file has more hits than included in hits[] */
  hasMoreHits?: boolean
  [key: string]: unknown
}

/** Default number of files shown before collapse */
const INITIAL_FILES_SHOWN = 10

/** Max lines to show per file when expanded (fetched from worker). */
const MAX_LINES_PER_FILE = 50

registerRenderer({
  name: 'search',
  icon: <Search className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const query = typeof ctx.args.query === 'string' ? ctx.args.query : ''
    const { files, loading: overflowLoading } = useOverflowFiles(ctx)
    const fileCount = files.length
    const totalMatches = files.reduce((sum, f) => sum + f.matchCount, 0)
    const titleMatchCount = files.filter(f => f.titleMatch).length
    const hasMoreHits = files.some(f => f.hasMoreHits)

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">search</code>
        {query && (
          <span
            className="truncate max-w-[320px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500"
            title={query}
          >
            &quot;{query}&quot;
          </span>
        )}
        {!ctx.isExecuting && !ctx.isStreaming && fileCount > 0 && (
          <span className="ml-auto text-xs text-neutral-400 shrink-0">
            {totalMatches} match{totalMatches !== 1 ? 'es' : ''} in {fileCount} file{fileCount !== 1 ? 's' : ''}
            {hasMoreHits && (
              <span className="text-blue-500 dark:text-blue-400 ml-1">· compact</span>
            )}
            {titleMatchCount > 0 && (
              <span className="text-yellow-600 dark:text-yellow-400 ml-1">· {titleMatchCount} title</span>
            )}
          </span>
        )}
        {!ctx.isExecuting && !ctx.isStreaming && fileCount === 0 && !ctx.isError && !overflowLoading && (
          <span className="ml-auto text-xs text-neutral-400 shrink-0">no results</span>
        )}
        {overflowLoading && (
          <span className="ml-auto text-xs text-neutral-400 shrink-0 animate-pulse">loading...</span>
        )}
        {ctx.isError && (
          <ErrorSummary ctx={ctx} />
        )}
      </>
    )
  },
  Detail(ctx) {
    // Hooks must run unconditionally (rules-of-hooks) — early returns stay below.
    const { files: fileResults, loading: overflowLoading, error: overflowError } = useOverflowFiles(ctx)
    if (ctx.isError) {
      return <ErrorDetail ctx={ctx} />
    }

    const query = typeof ctx.args.query === 'string' ? ctx.args.query : ''
    const params = extractSearchParams(ctx)

    // Show loading state while overflow asset is being fetched
    if (overflowLoading && fileResults.length === 0) {
      return (
        <div className="px-3 py-2 space-y-2">
          <StreamingPlaceholder />
          <div className="text-[10px] text-neutral-400 animate-pulse">Loading large result set...</div>
        </div>
      )
    }

    // Show overflow error if loading failed
    if (overflowError && fileResults.length === 0) {
      return (
        <div className="px-3 py-2 space-y-2">
          <div className="text-xs text-red-500">
            Failed to load overflow results: {overflowError}
          </div>
          {params.length > 0 && <SearchParamsBar params={params} />}
        </div>
      )
    }

    const hasNoResults = fileResults.length === 0
    if (hasNoResults) {
      if (ctx.isExecuting) return <StreamingPlaceholder />
      return (
        <div className="px-3 py-2 space-y-2">
          <div className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            No matches found for &quot;{query}&quot;
          </div>
          {params.length > 0 && <SearchParamsBar params={params} />}
        </div>
      )
    }

    // Build a compact copy text from files metadata (no raw hits)
    const copyText = fileResults.map(f => `${f.path}:${f.bestLine} · ${f.matchCount} matches`).join('\n')

    const hasMoreHits = fileResults.some(f => f.hasMoreHits)

    return (
      <div className="px-3 py-2 space-y-2">
        {params.length > 0 && <SearchParamsBar params={params} />}
        <FileResultList files={fileResults} searchCtx={ctx} query={query} />
        {hasMoreHits && (
          <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 px-0.5">
            Each file shows only the best match. Click "+N more" to expand, or use the read tool for full context.
          </div>
        )}
        <div className="flex justify-end">
          <CopyIconButton content={copyText} />
        </div>
      </div>
    )
  },
})

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Renders the file-level aggregated result list with expand to show all files. */
function FileResultList({ files, searchCtx, query }: { files: FileResult[]; searchCtx: ToolRenderCtx; query: string }) {
  const [expanded, setExpanded] = useState(false)
  const showAll = expanded || files.length <= INITIAL_FILES_SHOWN
  const shownFiles = showAll ? files : files.slice(0, INITIAL_FILES_SHOWN)
  const hiddenCount = files.length - INITIAL_FILES_SHOWN

  return (
    <div className="space-y-2">
      {shownFiles.map((file) => (
        <FileResultItem key={file.path} file={file} searchCtx={searchCtx} query={query} />
      ))}
      {!showAll && hiddenCount > 0 && (
        <button
          type="button"
          className="text-[10px] text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 pl-5 cursor-pointer"
          onClick={() => setExpanded(true)}
        >
          +{hiddenCount} more file{hiddenCount !== 1 ? 's' : ''}
        </button>
      )}
      {showAll && files.length > INITIAL_FILES_SHOWN && (
        <button
          type="button"
          className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 hover:text-neutral-500 dark:hover:text-neutral-400 pl-5 cursor-pointer"
          onClick={() => setExpanded(false)}
        >
          Show less
        </button>
      )}
    </div>
  )
}

/** State for on-demand line loading per file. */
interface FileExpandState {
  /** Whether extra detail lines have been fetched from the worker. */
  loaded: boolean
  /** Whether we are currently fetching. */
  loading: boolean
  /** Whether extra lines are visually expanded (collapsed keeps cached data). */
  expanded: boolean
  /** The loaded hits (excluding the best line already shown). */
  extraHits: SearchHit[]
  /** Error message if loading failed. */
  error?: string
}

/**
 * Renders a single file's search results.
 * - Always shows the best preview line (from file.bestPreview/bestLine).
 * - On click "N more lines", calls the search worker to load all hits for this single file.
 */
function FileResultItem({ file, searchCtx, query }: { file: FileResult; searchCtx: ToolRenderCtx; query: string }) {
  const [expandState, setExpandState] = useState<FileExpandState>({ loaded: false, loading: false, expanded: false, extraHits: [] })

  const loadMore = useCallback(async () => {
    if (expandState.loading || expandState.loaded) return
    setExpandState(prev => ({ ...prev, loading: true, error: undefined }))

    try {
      const args = searchCtx.args
      const useRegex = args.mode === 'regex'
      const caseSensitive = args.case_sensitive === true
      const wholeWord = args.whole_word === true

      // Resolve the directory handle for the file's root
      // Use project store (has activeProjectId) and folder-access store (has handle map)
      const projectId = useProjectStore.getState().activeProjectId
      const allHandles = projectId ? getRuntimeHandlesForProject(projectId) : new Map<string, FileSystemDirectoryHandle>()

      // Determine root name and sub-path from the file path
      const segments = file.path.split('/')
      let dirHandle: FileSystemDirectoryHandle | null = null
      let filePath: string = file.path

      if (allHandles.size > 0 && segments.length > 0) {
        const maybeRoot = segments[0]
        if (allHandles.has(maybeRoot)) {
          dirHandle = allHandles.get(maybeRoot)!
          filePath = segments.slice(1).join('/')
        }
      }

      // Fallback: try single-root handle from folder-access store
      if (!dirHandle) {
        const dh = useFolderAccessStore.getState().getCurrentHandle()
        if (dh) dirHandle = dh
      }

      if (!dirHandle) {
        setExpandState(prev => ({ ...prev, loading: false, error: 'No workspace handle' }))
        return
      }

      const manager = getSearchWorkerManager()
      const result = await manager.searchInDirectory(dirHandle, {
        query: typeof args.query === 'string' ? args.query : '',
        path: filePath,
        regex: useRegex,
        caseSensitive,
        wholeWord,
        maxResults: MAX_LINES_PER_FILE,
        contextLines: 0,
        deadlineMs: 15000,
      })

      // Filter out the best line (already shown)
      const extra = result.results.filter(h => h.line !== file.bestLine)
      setExpandState({ loaded: true, loading: false, expanded: true, extraHits: extra })
    } catch (err) {
      setExpandState(prev => ({
        ...prev,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load',
      }))
    }
  }, [expandState.loading, expandState.loaded, file.path, file.bestLine, searchCtx.args, query])

  const titleBadge = file.titleMatch === 'exact'
    ? <span className="text-[10px] bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-400 px-1 rounded">exact title</span>
    : file.titleMatch === 'partial'
      ? <span className="text-[10px] bg-yellow-50 dark:bg-yellow-900/20 text-yellow-600 dark:text-yellow-500 px-1 rounded">title match</span>
      : null

  // How many extra lines beyond the one we already show?
  // Cap to MAX_LINES_PER_FILE to avoid misleading count when worker truncates.
  const extraCount = Math.min(file.matchCount - 1, MAX_LINES_PER_FILE - 1)

  // If the tool already gave us all hits (single-file search), show them directly
  // instead of requiring a load-more click.
  const preloadedHits = (!file.hasMoreHits && file.hits && file.hits.length > 1)
    ? file.hits.filter(h => h.line !== file.bestLine)
    : []

  return (
    <div>
      <div className="flex items-center gap-1.5 text-xs text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400 mb-1">
        <FileIcon />
        <span className="font-mono truncate">{file.path}</span>
        <span className="text-neutral-300 text-neutral-600 text-neutral-600 dark:text-neutral-600">·</span>
        <span className="text-neutral-400">{file.matchCount} match{file.matchCount !== 1 ? 'es' : ''}</span>
        {titleBadge}
      </div>
      <div className="ml-5 space-y-0.5">
        {/* Best preview line (always visible) */}
        <div className="text-xs font-mono text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 flex">
          {file.bestLine > 0 && (
            <span className="select-none text-neutral-300 text-neutral-700 text-neutral-700 dark:text-neutral-700 w-8 text-right mr-2 shrink-0">L{file.bestLine}</span>
          )}
          <span className="truncate">{highlightMatch(file.bestPreview, query)}</span>
        </div>

        {/* Preloaded extra lines (single-file search: tool gave all hits) */}
        {preloadedHits.map((m, i) => (
          <div key={`pre-${i}`} className="text-xs font-mono text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 flex">
            {m.line != null && (
              <span className="select-none text-neutral-300 text-neutral-700 text-neutral-700 dark:text-neutral-700 w-8 text-right mr-2 shrink-0">L{m.line}</span>
            )}
            <span className="truncate">{highlightMatch(m.preview ?? m.match ?? '', query)}</span>
          </div>
        ))}

        {/* Extra lines loaded on demand (multi-file: only best hit was kept) */}
        {expandState.loaded && expandState.expanded && expandState.extraHits.map((m, i) => (
          <div key={i} className="text-xs font-mono text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 flex">
            {m.line != null && (
              <span className="select-none text-neutral-300 text-neutral-700 text-neutral-700 dark:text-neutral-700 w-8 text-right mr-2 shrink-0">L{m.line}</span>
            )}
            <span className="truncate">{highlightMatch(m.preview ?? m.match ?? '', query)}</span>
          </div>
        ))}

        {/* Loading indicator */}
        {expandState.loading && (
          <span className="text-[10px] text-neutral-400 animate-pulse">Loading...</span>
        )}

        {/* Error */}
        {expandState.error && (
          <span className="text-[10px] text-red-400">{expandState.error}</span>
        )}

        {/* Expand button: load more lines on demand (only when hits were compacted) */}
        {file.hasMoreHits && extraCount > 0 && !expandState.loaded && !expandState.loading && (
          <button
            type="button"
            className="text-[10px] text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer"
            onClick={loadMore}
          >
            +{extraCount} more line{extraCount !== 1 ? 's' : ''}
          </button>
        )}

        {/* Collapse: hide extra lines but keep cached data */}
        {expandState.loaded && expandState.expanded && extraCount > 0 && (
          <button
            type="button"
            className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 hover:text-neutral-500 dark:hover:text-neutral-400 cursor-pointer"
            onClick={() => setExpandState(prev => ({ ...prev, expanded: false }))}
          >
            Show less
          </button>
        )}
        {/* Re-expand button (data already loaded) */}
        {expandState.loaded && !expandState.expanded && extraCount > 0 && (
          <button
            type="button"
            className="text-[10px] text-blue-500 dark:text-blue-400 hover:text-blue-600 dark:hover:text-blue-300 cursor-pointer"
            onClick={() => setExpandState(prev => ({ ...prev, expanded: true }))}
          >
            +{expandState.extraHits.length} more line{expandState.extraHits.length !== 1 ? 's' : ''}
          </button>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

/** Extract non-default search parameters for display. */
interface SearchParam {
  label: string
  value: unknown
  display?: string
}

function extractSearchParams(ctx: ToolRenderCtx): SearchParam[] {
  const args = ctx.args
  const params: SearchParam[] = []

  if (typeof args.mode === 'string' && args.mode) {
    params.push({ label: 'mode', value: args.mode })
  }
  if (typeof args.path === 'string' && args.path) {
    params.push({ label: 'path', value: args.path })
  }
  if (typeof args.glob === 'string' && args.glob) {
    params.push({ label: 'glob', value: args.glob })
  }
  if (args.case_sensitive === true) {
    params.push({ label: 'case_sensitive', value: true })
  }
  if (args.whole_word === true) {
    params.push({ label: 'whole_word', value: true })
  }
  if (typeof args.max_results === 'number' && args.max_results !== 50) {
    params.push({ label: 'max_results', value: args.max_results })
  }
  if (typeof args.context_lines === 'number' && args.context_lines !== 0) {
    params.push({ label: 'context_lines', value: args.context_lines })
  }
  if (typeof args.max_file_size === 'number') {
    params.push({ label: 'max_file_size', value: args.max_file_size, display: formatBytes(args.max_file_size) })
  }
  if (typeof args.deadline_ms === 'number' && args.deadline_ms !== 25000) {
    params.push({ label: 'deadline_ms', value: args.deadline_ms, display: `${args.deadline_ms}ms` })
  }
  if (args.include_ignored === true) {
    params.push({ label: 'include_ignored', value: true })
  }
  if (Array.isArray(args.exclude_dirs) && args.exclude_dirs.length > 0) {
    params.push({ label: 'exclude_dirs', value: args.exclude_dirs, display: (args.exclude_dirs as string[]).join(', ') })
  }

  return params
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function SearchParamsBar({ params }: { params: SearchParam[] }) {
  return (
    <div className="flex flex-wrap gap-1.5 text-[10px]">
      {params.map((p) => (
        <span key={p.label} className="bg-neutral-100 dark:bg-neutral-800 text-neutral-500 px-1.5 py-0.5 rounded">
          {p.label}{p.value !== true ? `=${p.display ?? String(p.value)}` : ''}
        </span>
      ))}
    </div>
  )
}

/** Extract file-level aggregated results from the response data. */
function extractFileResults(ctx: ToolRenderCtx): FileResult[] {
  const data = ctx.result?.data
  if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>).files)) {
    return (data as Record<string, unknown>).files as FileResult[]
  }
  return []
}

/** Check if the result was overflowed to an asset file. Returns the relative asset path or null. */
function extractOverflowAssetPath(ctx: ToolRenderCtx): string | null {
  const data = ctx.result?.data
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (d.overflow === true && typeof d.contentSavedTo === 'string') {
      // contentSavedTo looks like "vfs://assets/overflow_search_xxx.txt"
      const path = d.contentSavedTo
      const match = path.match(/^vfs:\/\/assets\/(.+)$/)
      if (match) return match[1]
    }
  }
  return null
}

function useOverflowFiles(ctx: ToolRenderCtx): {
  files: FileResult[]
  loading: boolean
  error: string | null
} {
  const directFiles = extractFileResults(ctx)
  const assetPath = extractOverflowAssetPath(ctx)

  const [loadedFiles, setLoadedFiles] = useState<FileResult[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // Direct results available — no need to load
    if (directFiles.length > 0 || !assetPath) {
      return
    }

    let cancelled = false
    setLoading(true)
    setError(null)

    ;(async () => {
      try {
        const blob = await readAssetBlob(assetPath)
        if (cancelled) return
        if (!blob) {
          setError('Failed to load overflow data')
          setLoading(false)
          return
        }
        const text = await blob.text()
        if (cancelled) return

        // The asset file contains the raw JSON string of the original V2 envelope
        // or just the data.content field. Try parsing as envelope first.
        const parsed = JSON.parse(text) as unknown
        let filesArray: unknown = undefined

        if (
          typeof parsed === 'object' && parsed !== null &&
          'ok' in parsed && 'data' in parsed &&
          typeof (parsed as Record<string, unknown>).data === 'object'
        ) {
          // Full V2 envelope
          const data = (parsed as Record<string, unknown>).data as Record<string, unknown>
          filesArray = data.files
        } else if (typeof parsed === 'object' && parsed !== null && 'files' in parsed) {
          // Just the data object
          filesArray = (parsed as Record<string, unknown>).files
        }

        if (Array.isArray(filesArray)) {
          setLoadedFiles(filesArray as FileResult[])
        } else {
          setError('No file results found in overflow data')
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to parse overflow data')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => { cancelled = true }
  }, [assetPath, directFiles.length])

  // If direct results exist, use those (they're always authoritative)
  if (directFiles.length > 0) {
    return { files: directFiles, loading: false, error: null }
  }

  return { files: loadedFiles, loading, error }
}

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-neutral-400 shrink-0">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query) return text
  const idx = text.toLowerCase().indexOf(query.toLowerCase())
  if (idx === -1) return text
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-yellow-600 dark:text-yellow-400 bg-yellow-50 dark:bg-yellow-900/20 rounded-sm px-0.5">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  )
}

function ErrorSummary({ ctx }: { ctx: ToolRenderCtx }) {
  const error = extractError(ctx)
  return (
    <span className="ml-auto text-xs text-red-500 dark:text-red-400 shrink-0 truncate max-w-[200px]">
      {error.message}
    </span>
  )
}

function ErrorDetail({ ctx }: { ctx: ToolRenderCtx }) {
  const error = extractError(ctx)
  const { message, hint, details } = error

  return (
    <div className="px-3 py-2">
      <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 p-2 space-y-1.5 text-xs text-red-600 dark:text-red-400">
        <div>{message}</div>
        {details && Object.keys(details).length > 0 && (
          <div className="text-[10px] font-mono text-red-400/70 space-y-0.5">
            {Object.entries(details).map(([k, v]) =>
              v != null ? <div key={k}>{k}: {String(v)}</div> : null
            )}
          </div>
        )}
        {hint && (
          <div className="text-[11px] text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
            💡 {hint}
          </div>
        )}
      </div>
    </div>
  )
}

/** Extract structured error from V2 envelope, with fallback for legacy format. */
function extractError(ctx: ToolRenderCtx): ToolEnvelopeError & { details?: Record<string, unknown> } {
  const raw = ctx.result?.error
  if (raw && typeof raw === 'object' && typeof (raw as Record<string, unknown>).message === 'string') {
    return raw as ToolEnvelopeError & { details?: Record<string, unknown> }
  }
  // Legacy fallback
  const message = typeof raw === 'string' ? raw : 'Search failed'
  return { code: 'unknown', message, retryable: false }
}

function StreamingPlaceholder() {
  return (
    <div className="px-3 py-2 space-y-2">
      <div className="flex items-center gap-1.5">
        <div className="h-3 w-3 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
        <div className="h-3 w-32 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700" />
      </div>
      <div className="ml-5 space-y-1">
        <div className="h-3 w-48 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
        <div className="h-3 w-36 animate-pulse rounded bg-neutral-100 dark:bg-neutral-800" />
      </div>
    </div>
  )
}
