/**
 * Renderer for `bash` tool — terminal-style command + output display.
 *
 * Summary: command name + exit code / elapsed time
 * Detail: command block + stdout/stderr in terminal style
 */

import { Terminal } from 'lucide-react'
import { CopyIconButton } from '../CopyIconButton'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { useT } from '@/i18n'

registerRenderer({
  name: 'bash',
  icon: <Terminal className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const t = useT()
    const cmd = extractCommand(ctx)
    const output = extractOutput(ctx)

    if (ctx.isStreaming) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">bash</code>
          {cmd && (
            <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 max-w-[200px] inline-block align-bottom">
              {cmd}
            </span>
          )}
          <span className="text-xs text-blue-500">…</span>
        </>
      )
    }

    if (ctx.isExecuting) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">bash</code>
          {cmd && (
            <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 max-w-[200px] inline-block align-bottom">
              {cmd}
            </span>
          )}
          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
            <span className="text-xs text-blue-500">{t('agent.toolStatus.stateRunning')}</span>
          </span>
        </>
      )
    }

    // Completed
    const hasError = output.exitCode !== 0 || !!output.stderr || ctx.isError
    const parts: string[] = []
    if (output.elapsedMs !== undefined) {
      parts.push(output.elapsedMs < 1000 ? `${output.elapsedMs}ms` : `${(output.elapsedMs / 1000).toFixed(1)}s`)
    }

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">bash</code>
        {cmd && (
          <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 max-w-[200px] inline-block align-bottom">
            {cmd}
          </span>
        )}
        {hasError ? (
          <span className="ml-auto text-xs text-red-400 dark:text-red-500 shrink-0">
            exit {output.exitCode ?? 1}
          </span>
        ) : (
          parts.length > 0 && (
            <span className="ml-auto text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 shrink-0">
              {parts.join(' · ')}
            </span>
          )
        )}
      </>
    )
  },
  Detail(ctx) {
    const t = useT()
    const cmd = extractCommand(ctx)
    const output = extractOutput(ctx)

    // Streaming — command being composed
    if (ctx.isStreaming) {
      return (
        <div className="px-3 py-2 space-y-2">
          {cmd && <CommandBlock command={cmd} />}
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-0.5 bg-blue-500 animate-pulse" />
            <span className="text-[11px] text-neutral-400">编写中…</span>
          </div>
        </div>
      )
    }

    // Executing — show command + spinner
    if (ctx.isExecuting) {
      return (
        <div className="px-3 py-2 space-y-2">
          {cmd && <CommandBlock command={cmd} />}
          <div className="flex items-center gap-2 text-xs text-blue-500">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-400 opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-blue-500" />
            </span>
            <span>{t('agent.toolStatus.running')}</span>
          </div>
        </div>
      )
    }

    // Completed
    const hasOutput = output.stdout || output.stderr || output.errorText
    if (!hasOutput) {
      return (
        <div className="px-3 py-2 space-y-2">
          {cmd && <CommandBlock command={cmd} />}
          <div className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">No output</div>
        </div>
      )
    }

    return (
      <div className="px-3 py-2 space-y-2">
        {cmd && <CommandBlock command={cmd} />}

        {/* Stdout */}
        {output.stdout && (
          <div>
            <OutputHeader label="stdout" lineCount={output.stdout.split('\n').length} />
            <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-72">
              <pre className="text-[11px] leading-5 font-mono text-emerald-400 whitespace-pre-wrap">{output.stdout}</pre>
            </div>
          </div>
        )}

        {/* Stderr */}
        {output.stderr && (
          <div>
            <OutputHeader label="stderr" lineCount={output.stderr.split('\n').length} />
            <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-32">
              <pre className="text-[11px] leading-5 font-mono text-red-400 whitespace-pre-wrap">{output.stderr}</pre>
            </div>
          </div>
        )}

        {/* Error from envelope */}
        {output.errorText && !output.stderr && (
          <div>
            <OutputHeader label="error" />
            <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-32">
              <pre className="text-[11px] leading-5 font-mono text-red-300 whitespace-pre-wrap">{output.errorText}</pre>
            </div>
          </div>
        )}

        {/* Footer: exit code + elapsed + copy */}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-3 text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            {output.exitCode !== undefined && (
              <span className={output.exitCode === 0 ? 'text-emerald-500' : 'text-red-400'}>
                exit {output.exitCode}
              </span>
            )}
            {output.elapsedMs !== undefined && (
              <span>{output.elapsedMs < 1000 ? `${output.elapsedMs}ms` : `${(output.elapsedMs / 1000).toFixed(1)}s`}</span>
            )}
            {output.truncated && (
              <span className="text-amber-500">truncated</span>
            )}
          </span>
          <CopyIconButton content={[output.stdout, output.stderr, output.errorText].filter(Boolean).join('\n')} />
        </div>
      </div>
    )
  },
})

// ── Sub-components ──────────────────────────────────────────────────

function CommandBlock({ command }: { command: string }) {
  // Show first line as the command, collapse multi-line
  const lines = command.split('\n')
  const firstLine = lines[0] ?? ''
  const isMultiline = lines.length > 1

  return (
    <div>
      <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">command</div>
      <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-32">
        <pre className="text-[11px] leading-5 font-mono text-sky-300 whitespace-pre-wrap">
          {isMultiline ? command : firstLine}
        </pre>
      </div>
    </div>
  )
}

function OutputHeader({ label, lineCount }: { label: string; lineCount?: number }) {
  return (
    <div className="text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 mb-1">
      {label}
      {lineCount !== undefined && lineCount > 1 && ` (${lineCount} lines)`}
    </div>
  )
}

// ── Extract helpers ──────────────────────────────────────────────────

function extractCommand(ctx: ToolRenderCtx): string {
  return typeof ctx.args.command === 'string' ? ctx.args.command : ''
}

function extractOutput(ctx: ToolRenderCtx): {
  stdout: string | undefined
  stderr: string | undefined
  errorText: string | undefined
  exitCode: number | undefined
  elapsedMs: number | undefined
  truncated: boolean
} {
  const data = ctx.result?.data as Record<string, unknown> | undefined

  if (data) {
    return {
      stdout: typeof data.stdout === 'string' ? data.stdout : undefined,
      stderr: typeof data.stderr === 'string' ? data.stderr : undefined,
      errorText: typeof data.error === 'string' ? data.error : undefined,
      exitCode: typeof data.exitCode === 'number' ? data.exitCode : undefined,
      elapsedMs: typeof data.elapsedMs === 'number' ? data.elapsedMs : undefined,
      truncated: data.truncated === true,
    }
  }

  // V2 envelope error: { ok: false, error: { code, message } }
  if (ctx.result && !ctx.result.ok && ctx.result.error) {
    const err = ctx.result.error as Record<string, unknown>
    const msg = typeof err.message === 'string' ? err.message : String(err)
    return {
      stdout: undefined,
      stderr: undefined,
      errorText: msg,
      exitCode: 1,
      elapsedMs: undefined,
      truncated: false,
    }
  }

  return {
    stdout: undefined,
    stderr: undefined,
    errorText: undefined,
    exitCode: undefined,
    elapsedMs: undefined,
    truncated: false,
  }
}
