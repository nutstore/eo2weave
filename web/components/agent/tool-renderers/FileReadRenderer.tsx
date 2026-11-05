/**
 * Renderer for `read` tool — file content preview with line numbers.
 */

import { FileText } from 'lucide-react'
import { CopyIconButton } from '../CopyIconButton'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { useT } from '@/i18n'

registerRenderer({
  name: 'read',
  icon: <FileText className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const t = useT()
    const path = extractPath(ctx.args)
    const content = extractContent(ctx)
    const lineCount = content ? content.split('\n').length : 0

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">read</code>
        {path && (
          <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">{shortPath(path)}</span>
        )}
        {ctx.isExecuting ? (
          <span className="ml-auto text-blue-500 text-xs shrink-0">{t('agent.toolStatus.reading')}</span>
        ) : ctx.isError ? null : (
          <span className="ml-auto text-neutral-400 text-xs shrink-0">{lineCount} lines</span>
        )}
      </>
    )
  },
  Detail(ctx) {
    const content = extractContent(ctx)
    const path = extractPath(ctx.args)

    if (ctx.isError) {
      return <ErrorDetail ctx={ctx} />
    }

    if (!content) {
      if (ctx.isExecuting) return <StreamingPlaceholder />
      return <NoResultDetail ctx={ctx} />
    }

    const lines = content.split('\n')
    const maxPreview = 50
    const headCount = 20
    const tailCount = 5
    const truncated = lines.length > maxPreview
    const head = truncated ? lines.slice(0, headCount) : lines
    const tail = truncated ? lines.slice(-tailCount) : []
    const hidden = lines.length - headCount - tailCount
    const lnWidth = String(lines.length).length

    return (
      <div className="px-3 py-2 space-y-2">
        {path && (
          <div className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 font-mono">{path}</div>
        )}
        <div className="rounded-md bg-white dark:bg-neutral-900 border border-neutral-100 dark:border-neutral-800 overflow-x-auto">
          <pre className="p-2 text-xs leading-5 text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400 font-mono">
            {head.map((line, i) => (
              <Line key={i} num={i + 1} width={lnWidth}>{line}</Line>
            ))}
            {truncated && (
              <div className="text-neutral-300 text-neutral-700 text-neutral-700 dark:text-neutral-700 select-none py-0.5">
                {' '.repeat(lnWidth + 1)}... {hidden} lines hidden
              </div>
            )}
            {truncated && tail.map((line, i) => (
              <Line key={headCount + hidden + i} num={headCount + hidden + i + 1} width={lnWidth}>{line}</Line>
            ))}
          </pre>
        </div>
        <div className="flex justify-end">
          <CopyIconButton content={content} />
        </div>
      </div>
    )
  },
})

function Line({ num, width, children }: { num: number; width: number; children: string }) {
  return (
    <div>
      <span className="select-none text-neutral-300 text-neutral-700 text-neutral-700 dark:text-neutral-700" style={{ minWidth: width + 'ch', display: 'inline-block', textAlign: 'right', marginRight: '12px' }}>{num}</span>
      {children}
    </div>
  )
}

function extractPath(args: Record<string, unknown>): string | undefined {
  return typeof args.path === 'string' ? args.path : undefined
}

function extractContent(ctx: ToolRenderCtx): string | undefined {
  const data = ctx.result?.data as Record<string, unknown> | undefined
  if (data && typeof data.content === 'string') return data.content
  return undefined
}

function shortPath(p: string): string {
  const parts = p.split('/')
  return parts.length > 3 ? '...' + parts.slice(-3).join('/') : p
}

function StreamingPlaceholder() {
  return (
    <div className="px-3 py-2">
      <div className="h-3 w-24 animate-pulse rounded bg-neutral-200 dark:bg-neutral-700 mb-2" />
      <div className="space-y-1.5">
        {[48, 60, 40, 55, 35].map((w, i) => (
          <div key={i} className="h-3 rounded bg-neutral-100 dark:bg-neutral-800" style={{ width: w + '%' }} />
        ))}
      </div>
    </div>
  )
}

function ErrorDetail({ ctx }: { ctx: ToolRenderCtx }) {
  const errMsg = extractErrorMessage(ctx.result?.error)
  return (
    <div className="px-3 py-2">
      <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 p-2 text-xs text-red-600 dark:text-red-400">
        {errMsg}
      </div>
    </div>
  )
}

/** Extract a human-readable error message from V2 envelope error (object) or legacy string. */
function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && typeof (error as Record<string, unknown>).message === 'string') {
    return (error as Record<string, unknown>).message as string
  }
  return 'Error'
}

function NoResultDetail({ ctx }: { ctx: ToolRenderCtx }) {
  return (
    <div className="px-3 py-2">
      <div className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">No content returned</div>
      <RawJsonFallback args={ctx.args} rawResult={ctx.rawResult} />
    </div>
  )
}

function RawJsonFallback({ args, rawResult }: { args: Record<string, unknown>; rawResult?: string }) {
  return (
    <div className="space-y-2 mt-2">
      <div>
        <div className="text-[10px] text-neutral-400 mb-1">Arguments</div>
        <pre className="max-h-32 overflow-auto rounded bg-neutral-50 dark:bg-neutral-900 p-2 text-[11px] text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">{JSON.stringify(args, null, 2)}</pre>
      </div>
      {rawResult && (
        <div>
          <div className="text-[10px] text-neutral-400 mb-1">Result</div>
          <pre className="max-h-32 overflow-auto rounded bg-neutral-50 dark:bg-neutral-900 p-2 text-[11px] text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">{rawResult}</pre>
        </div>
      )}
    </div>
  )
}
