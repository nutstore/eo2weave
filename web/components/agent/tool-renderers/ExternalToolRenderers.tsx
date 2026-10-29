/**
 * Renderers for the unified external tool bridge:
 * - search_tools: keyword / semantic search results with schema previews
 * - call_tool: unified tool execution (MCP + WebMCP) with result preview
 */

import { Plug, Search } from 'lucide-react'
import { CopyIconButton } from '../CopyIconButton'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { formatBytes } from '@/lib/utils'

// ── search_tools ──

registerRenderer({
  name: 'search_tools',
  icon: <Search className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const query = typeof ctx.args.query === 'string' ? ctx.args.query : ''
    const intent = typeof ctx.args.intent === 'string' ? ctx.args.intent : ''
    const results = extractSearchResults(ctx)
    const displayText = intent || query || 'search'
    const { searchMode, searchDurationMs } = extractSearchMeta(ctx)

    return (
      <>
        <code className="shrink-0 font-medium text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300">search_tools</code>
        {displayText && (
          <span className="truncate min-w-0 text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            "{displayText}"
          </span>
        )}
        {!ctx.isExecuting && !ctx.isStreaming && !ctx.isError && (
          <>
            <span className="ml-auto text-xs shrink-0 text-neutral-400">
              {results.length === 0 ? '0 matches' : `${results.length} tool${results.length !== 1 ? 's' : ''}`}
            </span>
            {searchMode && searchDurationMs !== undefined && (
              <span className="ml-2 text-[10px] font-mono shrink-0 text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
                {formatSearchMode(searchMode)} · {formatDuration(searchDurationMs)}
              </span>
            )}
          </>
        )}
        {ctx.isError && (
          <span className="ml-auto text-xs text-red-500 shrink-0">✗ failed</span>
        )}
      </>
    )
  },
  Detail(ctx) {
    const results = extractSearchResults(ctx)
    const query = typeof ctx.args.query === 'string' ? ctx.args.query : ''
    const intent = typeof ctx.args.intent === 'string' ? ctx.args.intent : ''
    const displayText = intent || query || 'search'
    const { searchMode, searchDurationMs } = extractSearchMeta(ctx)

    if (ctx.isExecuting) return <StreamingPlaceholder count={2} />
    if (ctx.isError) return <ErrorDetail ctx={ctx} />

    if (results.length === 0) {
      return (
        <div className="px-3 py-2 text-xs text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
          No tools matched "{displayText}".
        </div>
      )
    }

    return (
      <div className="px-2 py-2 sm:px-3">
        <div className="text-[11px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-2 flex items-center gap-2 flex-wrap">
          <span>
            {results.length} result{results.length !== 1 ? 's' : ''} for "{displayText}"
          </span>
          {searchMode && searchDurationMs !== undefined && (
            <span className="font-mono text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
              · {formatSearchMode(searchMode)} · {formatDuration(searchDurationMs)}
            </span>
          )}
        </div>
        <div className="space-y-3">
          {results.map((tool) => (
            <div key={tool.fullName}>
              {/* Tool name: server.tool format */}
              <div className="text-[13px] font-medium text-neutral-700 dark:text-foreground mb-1">
                <span className="text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 font-normal">
                  {tool.sourceId}.
                </span>
                {tool.name}
              </div>
              {/* Description */}
              {tool.description && (
                <div className="text-[12px] text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300 mb-1.5 leading-relaxed">
                  {tool.description}
                </div>
              )}
              {/* Parameter schema */}
              <SchemaParamsPreview inputSchema={tool.inputSchema} />
            </div>
          ))}
        </div>
      </div>
    )
  },
})

// ── call_tool ──

registerRenderer({
  name: 'call_tool',
  icon: <Plug className="h-3.5 w-3.5 text-violet-400" />,
  Summary(ctx) {
    const fullName = typeof ctx.args.full_tool_name === 'string' ? ctx.args.full_tool_name : ''

    return (
      <>
        <code className="shrink-0 font-medium text-neutral-700 dark:text-foreground">call_tool</code>
        {fullName && (
          <span className="truncate min-w-0 text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            {shortToolName(fullName)}
          </span>
        )}
        {!ctx.isExecuting && !ctx.isStreaming && (
          <span className={`ml-auto text-xs shrink-0 ${ctx.isError ? 'text-red-500' : 'text-emerald-500'}`}>
            {ctx.isError ? '✗ failed' : '✓ done'}
          </span>
        )}
      </>
    )
  },
  Detail(ctx) {
    const fullName = typeof ctx.args.full_tool_name === 'string' ? ctx.args.full_tool_name : ''
    const toolArgs = ctx.args.args as Record<string, unknown> | undefined
    const data = ctx.result?.data as Record<string, unknown> | undefined

    if (ctx.isError) return <ErrorDetail ctx={ctx} />

    const hostname = typeof data?.hostname === 'string' ? data.hostname : ''
    const result = data?.result
    const text = typeof data?.text === 'string' ? data.text : ''
    const pluginDownload = data?.pluginDownload as Record<string, unknown> | undefined

    // Determine source from fullName
    const isMCP = fullName.includes(':') && !fullName.includes('__')
    // Prefer hostname from result; fall back to source derived from fullName so the
    // badge is visible during streaming / executing (before the result is in).
    const sourceForBadge = isMCP ? 'MCP' : (hostname || getSourceLabel(fullName))
    const isDone = !ctx.isExecuting && !ctx.isStreaming

    return (
      <div className="px-2 py-2 space-y-2 sm:px-3">
        {/* Header: source + tool name (shown as soon as fullName is available) */}
        {fullName && (
          <div className="flex items-center gap-1.5 min-w-0">
            {sourceForBadge && (
              <span
                className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                  isMCP
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400'
                    : 'bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400'
                }`}
              >
                {sourceForBadge}
              </span>
            )}
            <span className="text-xs font-medium text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300 truncate">
              {shortToolName(fullName)}
            </span>
          </div>
        )}

        {/* Args preview — visible during streaming + executing + done so the
            user can see parameters as the LLM composes them and while the
            tool runs. */}
        {toolArgs && Object.keys(toolArgs).length > 0 && (
          <ArgsBlock toolArgs={toolArgs} />
        )}

        {/* Streaming: LLM is still composing the tool call */}
        {ctx.isStreaming && (
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-0.5 bg-blue-500 animate-pulse" />
            <span className="text-[11px] text-neutral-400">编写中…</span>
          </div>
        )}

        {/* Executing: tool is running, no result yet */}
        {ctx.isExecuting && (
          <div className="flex items-center gap-2 text-xs text-blue-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
            <span>Running...</span>
          </div>
        )}

        {/* Result sections — only when the tool has finished */}
        {isDone && (
          <>
            {/* Plugin download info */}
            {pluginDownload && (
              <div className="rounded border border-blue-100 dark:border-blue-900/30 bg-blue-50/50 dark:bg-blue-900/10 p-2">
                <div className="text-[10px] text-blue-500 dark:text-blue-400 mb-0.5">File Downloaded</div>
                <div className="text-xs text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300">
                  {typeof pluginDownload.fileName === 'string' ? pluginDownload.fileName : 'file'}
                </div>
                {typeof pluginDownload.size === 'number' && (
                  <div className="text-[10px] text-neutral-400">{formatBytes(pluginDownload.size)}</div>
                )}
              </div>
            )}

            {/* Result preview */}
            {result !== undefined && result !== null && !pluginDownload && (
              <div className="rounded border border-neutral-100 dark:border-neutral-800 p-1.5">
                <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">Result</div>
                <pre className="text-[11px] text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400 overflow-x-auto whitespace-pre-wrap break-all max-h-48">
                  {typeof result === 'string' ? result.slice(0, 800) : JSON.stringify(result, null, 2).slice(0, 800)}
                </pre>
              </div>
            )}

            {/* Text result (MCP tools often return { text }) */}
            {text && !result && !pluginDownload && (
              <div className="rounded border border-neutral-100 dark:border-neutral-800 p-1.5">
                <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">Result</div>
                <pre className="text-[11px] text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400 overflow-x-auto whitespace-pre-wrap break-all max-h-48">
                  {text.slice(0, 800)}
                </pre>
              </div>
            )}

            {/* Copy button */}
            {ctx.rawResult && (
              <div className="flex justify-end">
                <CopyIconButton content={ctx.rawResult} />
              </div>
            )}
          </>
        )}
      </div>
    )
  },
})

// ── Shared Components ──

/** Renders a tool call's arguments as pretty-printed JSON, capped to 500 chars
 *  to avoid layout blow-up on large payloads. */
function ArgsBlock({ toolArgs }: { toolArgs: Record<string, unknown> }) {
  return (
    <div className="rounded border border-neutral-100 dark:border-neutral-800 p-1.5">
      <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">Arguments</div>
      <pre className="text-[11px] text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400 overflow-x-auto whitespace-pre-wrap break-all">
        {JSON.stringify(toolArgs, null, 2).slice(0, 500)}
      </pre>
    </div>
  )
}

function SchemaParamsPreview({ inputSchema }: { inputSchema: Record<string, unknown> }) {
  const properties = inputSchema.properties as Record<string, Record<string, unknown>> | undefined
  if (!properties || Object.keys(properties).length === 0) return null

  const required = new Set((inputSchema.required as string[] | undefined) || [])
  const entries = Object.entries(properties).slice(0, 8)
  const overflow = Object.keys(properties).length - entries.length

  return (
    <div className="space-y-0.5">
      {entries.map(([key, prop]) => {
        const isRequired = required.has(key)
        const type = typeof prop.type === 'string' ? prop.type : ''
        return (
          <div key={key} className="text-[11px] font-mono leading-relaxed">
            <span className="text-neutral-600 text-neutral-300 text-neutral-300 dark:text-neutral-300">
              {key}
              {isRequired && <span className="text-neutral-500">*</span>}
            </span>
            {type && (
              <span className="text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 ml-1.5">: {type}</span>
            )}
            {typeof prop.description === 'string' && prop.description && (
              <span className="text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 ml-2 font-sans">
                — {prop.description.length > 40 ? prop.description.slice(0, 40) + '…' : prop.description}
              </span>
            )}
          </div>
        )
      })}
      {overflow > 0 && (
        <div className="text-[11px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">+ {overflow} more</div>
      )}
    </div>
  )
}

function ErrorDetail({ ctx }: { ctx: ToolRenderCtx }) {
  const error = ctx.result?.error as Record<string, unknown> | undefined
  const code = typeof error?.code === 'string' ? error.code : ''
  const message = typeof error?.message === 'string' ? error.message : ctx.rawResult || 'Unknown error'

  return (
    <div className="px-3 py-2">
      <div className="rounded border border-red-100 dark:border-red-900/30 bg-red-50/50 dark:bg-red-900/10 p-2">
        {code && (
          <div className="text-[10px] font-mono text-red-500 dark:text-red-400 mb-0.5">{code}</div>
        )}
        <div className="text-[11px] text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
          {typeof message === 'string' ? message.slice(0, 500) : String(message).slice(0, 500)}
        </div>
      </div>
    </div>
  )
}

function StreamingPlaceholder({ count = 3 }: { count?: number }) {
  return (
    <div className="px-3 py-2 space-y-2">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-md border border-neutral-100 dark:border-neutral-800 p-2 animate-pulse">
          <div className="h-3 w-1/3 rounded bg-neutral-200 dark:bg-neutral-700 mb-1.5" />
          <div className="h-2.5 w-2/3 rounded bg-neutral-100 dark:bg-neutral-800" />
        </div>
      ))}
    </div>
  )
}

// ── Helpers ──

interface SearchResult {
  fullName: string
  name: string
  source: string
  sourceId: string
  description: string
  inputSchema: Record<string, unknown>
}

function extractSearchResults(ctx: ToolRenderCtx): SearchResult[] {
  const data = ctx.result?.data as Record<string, unknown> | undefined
  const results = data?.results
  if (!Array.isArray(results)) return []
  return results
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null)
    .map(t => ({
      fullName: typeof t.fullName === 'string' ? t.fullName : '',
      name: typeof t.name === 'string' ? t.name : extractNameFromFullName(t.fullName),
      source: typeof t.source === 'string' ? t.source : 'webmcp',
      sourceId: typeof t.sourceId === 'string' ? t.sourceId : '',
      description: typeof t.description === 'string' ? t.description : '',
      inputSchema: (t.inputSchema as Record<string, unknown>) || {},
    }))
    .filter(t => t.fullName)
}

/** Routing-internal searchMode values emitted by search_tools (see external-tool-bridge.ts). */
type SearchMode = 'semantic' | 'keyword' | 'bm25_rerank' | 'fallback'

const SEARCH_MODES: ReadonlyArray<SearchMode> = ['semantic', 'keyword', 'bm25_rerank', 'fallback']

function extractSearchMeta(ctx: ToolRenderCtx): { searchMode?: SearchMode; searchDurationMs?: number } {
  const data = ctx.result?.data as Record<string, unknown> | undefined
  if (!data) return {}
  const rawMode = data.searchMode
  const searchMode = SEARCH_MODES.includes(rawMode as SearchMode) ? (rawMode as SearchMode) : undefined
  const searchDurationMs = typeof data.searchDurationMs === 'number' ? data.searchDurationMs : undefined
  return { searchMode, searchDurationMs }
}

/** Map a routing-internal searchMode to a short user-facing label. */
function formatSearchMode(mode: SearchMode): string {
  switch (mode) {
    case 'semantic': return 'semantic'
    case 'keyword': return 'BM25'
    case 'bm25_rerank': return 'BM25+rerank'
    case 'fallback': return 'fallback'
  }
}

/** Format milliseconds as a short, readable duration. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 10000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 1000).toFixed(1)}s`
}

/** workspace_jianguoyun_com__fetch_ticket_messages → fetch_ticket_messages */
function extractNameFromFullName(fullName: unknown): string {
  if (typeof fullName !== 'string') return ''
  // WebMCP: provider-safe origin__toolName
  const doubleSep = fullName.indexOf('__')
  if (doubleSep !== -1) return fullName.slice(doubleSep + 2)
  // MCP: serverId:toolName
  const colonSep = fullName.lastIndexOf(':')
  if (colonSep !== -1) return fullName.slice(colonSep + 1)
  return fullName
}

/** https_workspace_jianguoyun_com__fetch_ticket_messages → workspace.jianguoyun.com */
function getSourceLabel(fullName: string): string {
  // MCP: openpencil:get_node → openpencil
  if (fullName.includes(':') && !fullName.includes('__')) {
    return fullName.split(':')[0] || ''
  }
  // WebMCP fullNames have no schema hash or duplicate normalized hostname.
  const sepIdx = fullName.indexOf('__')
  if (sepIdx === -1) return ''
  const hostPart = fullName.slice(0, sepIdx)
  // Best-effort display for a sanitized name. Search results retain the raw
  // origin/hostname for callers that need an exact address.
  return hostPart.replace(/^https_/, '').replace(/^http_/, '').replace(/_/g, '.')
}

/** workspace_jianguoyun_com__fetch_ticket_messages → fetch_ticket_messages */
function shortToolName(fullName: string): string {
  // WebMCP
  const doubleSep = fullName.indexOf('__')
  if (doubleSep !== -1) return fullName.slice(doubleSep + 2)
  // MCP: openpencil:get_node → get_node
  const colonSep = fullName.lastIndexOf(':')
  if (colonSep !== -1) return fullName.slice(colonSep + 1)
  return fullName
}

