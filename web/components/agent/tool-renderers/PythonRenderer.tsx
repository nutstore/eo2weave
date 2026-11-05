/**
 * Renderer for `python` tool — terminal-style stdout/stderr display.
 */

import { Terminal } from 'lucide-react'
import { CopyIconButton } from '../CopyIconButton'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { useT } from '@/i18n'

registerRenderer({
  name: 'run_python',
  icon: <Terminal className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const t = useT()
    const output = extractOutput(ctx)
    const code = typeof ctx.args.code === 'string' ? ctx.args.code : ''
    const codeLines = code ? code.split('\n').length : 0

    if (ctx.isExecuting && !ctx.isStreaming) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">python</code>
          <span className="text-xs text-blue-500">{t('agent.toolStatus.running')}</span>
        </>
      )
    }

    // Streaming — show code line count being composed
    if (ctx.isStreaming) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">python</code>
          {codeLines > 0 && (
            <span className="ml-auto text-xs text-neutral-400 shrink-0">{codeLines} lines…</span>
          )}
        </>
      )
    }

    const stdoutLines = output.stdout ? output.stdout.split('\n').length : 0
    const hasError = output.isError || !!output.stderr

    const parts: string[] = []
    if (codeLines > 0) parts.push(`in ${codeLines}`)
    if (stdoutLines > 0) parts.push(`out ${stdoutLines}`)

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">python</code>
        {hasError ? (
          <span className="ml-auto text-xs text-red-400 shrink-0">error</span>
        ) : parts.length > 0 ? (
          <span className="ml-auto text-xs text-neutral-400 shrink-0">{parts.join(' / ')}</span>
        ) : null}
      </>
    )
  },
  Detail(ctx) {
    const output = extractOutput(ctx)
    const code = typeof ctx.args.code === 'string' ? ctx.args.code : ''
    const codeLines = code ? code.split('\n').length : 0

    // Streaming — show code being composed
    if (ctx.isStreaming) {
      return (
        <div className="px-3 py-2 space-y-2">
          {code && (
            <div>
              <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">
                code{codeLines > 1 ? ` (${codeLines} lines)` : ''}
              </div>
              <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-64">
                <pre className="text-[11px] leading-5 font-mono text-neutral-300 whitespace-pre-wrap">{code}</pre>
              </div>
              <div className="mt-1.5 flex items-center gap-1.5">
                <span className="inline-block h-2 w-0.5 bg-blue-500 animate-pulse" />
                <span className="text-[11px] text-neutral-400">编写中…</span>
              </div>
            </div>
          )}
        </div>
      )
    }

    if (ctx.isExecuting) {
      return (
        <div className="px-3 py-2 space-y-2">
          {/* Code being executed */}
          {code && (
            <div>
              <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">
                code{codeLines > 1 ? ` (${codeLines} lines)` : ''}
              </div>
              <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-64">
                <pre className="text-[11px] leading-5 font-mono text-neutral-300 whitespace-pre-wrap">{code}</pre>
              </div>
            </div>
          )}

          {/* Running indicator */}
          <RunningIndicator />
        </div>
      )
    }

    const hasOutput = output.stdout || output.stderr || output.errorText
    if (!hasOutput) {
      return (
        <div className="px-3 py-2 space-y-2">
          {code && (
            <div>
              <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">
                code{codeLines > 1 ? ` (${codeLines} lines)` : ''}
              </div>
              <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-64">
                <pre className="text-[11px] leading-5 font-mono text-neutral-300 whitespace-pre-wrap">{code}</pre>
              </div>
            </div>
          )}
          <div className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">No output</div>
        </div>
      )
    }

    return (
      <div className="px-3 py-2 space-y-2">
        {/* Executed code */}
        {code && (
          <div>
            <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">
              code{codeLines > 1 ? ` (${codeLines} lines)` : ''}
            </div>
            <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-64">
              <pre className="text-[11px] leading-5 font-mono text-neutral-300 whitespace-pre-wrap">{code}</pre>
            </div>
          </div>
        )}

        {/* Stdout */}
        {output.stdout && (
          <div>
            <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">stdout</div>
            <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-48">
              <pre className="text-[11px] leading-5 font-mono text-emerald-400 whitespace-pre-wrap">{output.stdout}</pre>
            </div>
          </div>
        )}

        {/* Stderr */}
        {output.stderr && (
          <div>
            <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">stderr</div>
            <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-32">
              <pre className="text-[11px] leading-5 font-mono text-red-400 whitespace-pre-wrap">{output.stderr}</pre>
            </div>
          </div>
        )}

        {/* Error */}
        {output.errorText && !output.stderr && (
          <div>
            <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">error</div>
            <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-32">
              <pre className="text-[11px] leading-5 font-mono text-red-300 whitespace-pre-wrap">{output.errorText}</pre>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <CopyIconButton content={[output.stdout, output.stderr, output.errorText].filter(Boolean).join('\n')} />
        </div>
      </div>
    )
  },
})

function extractOutput(ctx: ToolRenderCtx): {
  stdout: string | undefined
  stderr: string | undefined
  errorText: string | undefined
  isError: boolean
} {
  const data = ctx.result?.data as Record<string, unknown> | undefined

  if (data) {
    return {
      stdout: typeof data.stdout === 'string' ? data.stdout : undefined,
      stderr: typeof data.stderr === 'string' ? data.stderr : undefined,
      errorText: typeof data.error === 'string' ? data.error : undefined,
      isError: ctx.isError,
    }
  }

  // V2 envelope error: { ok: false, error: { code, message } }
  if (ctx.result && !ctx.result.ok && ctx.result.error) {
    const err = ctx.result.error as Record<string, unknown>
    const msg = typeof err.message === 'string' ? err.message : String(err)
    return { stdout: undefined, stderr: undefined, errorText: msg, isError: true }
  }

  // Fallback: try rawResult
  if (ctx.rawResult) {
    // If rawResult looks like plain text output
    if (!ctx.rawResult.startsWith('{')) {
      return { stdout: ctx.rawResult, stderr: undefined, errorText: undefined, isError: ctx.isError }
    }
  }

  return { stdout: undefined, stderr: undefined, errorText: undefined, isError: ctx.isError }
}

function RunningIndicator() {
  const t = useT()
  return (
    <div className="flex items-center gap-2 text-xs text-blue-500">
      <span className="relative flex h-2 w-2">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
      </span>
      <span>{t('agent.toolStatus.running')}</span>
    </div>
  )
}
