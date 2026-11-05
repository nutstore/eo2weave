/**
 * Renderer for `exec` tool — terminal-style command + output display.
 *
 * Summary: command + exit code / status badge
 * Detail: command block + stdout/stderr in terminal style + exit footer
 *
 * Result envelope (V2):
 *   { ok: true, data: { command, exit_code, stdout, stderr, timed_out, truncated, ... } }
 *   { ok: false, error: { code, message } }  (forbidden / user_denied / etc.)
 */

import { Terminal } from 'lucide-react'
import { CopyIconButton } from '../CopyIconButton'
import { registerRenderer } from './registry'
import type { ToolRenderCtx } from './types'
import { useT } from '@/i18n'

registerRenderer({
  name: 'exec',
  icon: <Terminal className="h-3.5 w-3.5 text-neutral-400" />,
  Summary(ctx) {
    const cmd = extractCommand(ctx)
    const output = extractOutput(ctx)

    // Streaming — args still coming in
    if (ctx.isStreaming) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">exec</code>
          {cmd && (
            <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 max-w-[200px] inline-block align-bottom">
              {cmd}
            </span>
          )}
          <span className="text-xs text-blue-500">…</span>
        </>
      )
    }

    // Executing — waiting for result
    if (ctx.isExecuting) {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">exec</code>
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
            <span className="text-xs text-blue-500">running</span>
          </span>
        </>
      )
    }

    // Completed — check for error states
    const errCode = ctx.result?.error as Record<string, unknown> | undefined
    const errorCode = typeof errCode?.code === 'string' ? errCode.code : undefined

    // Forbidden
    if (errorCode === 'forbidden') {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">exec</code>
          {cmd && (
            <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 max-w-[200px] inline-block align-bottom">
              {cmd}
            </span>
          )}
          <span className="ml-auto text-xs text-red-400 dark:text-red-500 shrink-0">forbidden</span>
        </>
      )
    }

    // User denied
    if (errorCode === 'user_denied') {
      return (
        <>
          <code className="font-medium text-neutral-700 dark:text-foreground">exec</code>
          {cmd && (
            <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 max-w-[200px] inline-block align-bottom">
              {cmd}
            </span>
          )}
          <span className="ml-auto text-xs text-amber-500 shrink-0">denied</span>
        </>
      )
    }

    // Normal completion
    const hasError = output.exitCode !== undefined && output.exitCode !== 0

    return (
      <>
        <code className="font-medium text-neutral-700 dark:text-foreground">exec</code>
        {cmd && (
          <span className="truncate text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500 max-w-[200px] inline-block align-bottom">
            {cmd}
          </span>
        )}
        {hasError ? (
          <span className="ml-auto text-xs text-red-400 dark:text-red-500 shrink-0">
            exit {output.exitCode}
          </span>
        ) : output.exitCode === 0 ? (
          <span className="ml-auto text-xs text-emerald-500 shrink-0">exit 0</span>
        ) : (
          ctx.isError && (
            <span className="ml-auto text-xs text-red-400 dark:text-red-500 shrink-0">error</span>
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
          <CommandBlock command={cmd} cwd={extractCwd(ctx)} args={ctx.args} rawArgs={ctx.rawArgs} />
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-0.5 bg-blue-500 animate-pulse" />
            <span className="text-[11px] text-neutral-400">composing…</span>
          </div>
        </div>
      )
    }

    // Executing — show command + spinner
    if (ctx.isExecuting) {
      return (
        <div className="px-3 py-2 space-y-2">
          <CommandBlock command={cmd} cwd={extractCwd(ctx)} args={ctx.args} rawArgs={ctx.rawArgs} />
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

    // Error envelope (forbidden / user_denied / execution_error)
    if (ctx.isError || (ctx.result && !ctx.result.ok)) {
      const errObj = ctx.result?.error as Record<string, unknown> | undefined
      const errMsg = typeof errObj?.message === 'string' ? errObj.message : 'Command failed'
      const errCode = typeof errObj?.code === 'string' ? errObj.code : 'error'
      const errHint = typeof errObj?.hint === 'string' ? errObj.hint : undefined

      return (
        <div className="px-3 py-2 space-y-2">
          <CommandBlock command={cmd} cwd={extractCwd(ctx)} args={ctx.args} rawArgs={ctx.rawArgs} />
          <div className="rounded-md bg-red-50 dark:bg-red-900/20 border border-red-100 dark:border-red-900/30 p-2">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[10px] font-medium uppercase tracking-wide text-red-500">{errCode}</span>
            </div>
            <p className="text-xs text-red-600 dark:text-red-400">{errMsg}</p>
            {errHint && (
              <p className="mt-1 text-[11px] text-red-400 dark:text-red-500/70">{errHint}</p>
            )}
          </div>
        </div>
      )
    }

    // Completed with output
    const hasOutput = output.stdout || output.stderr
    const bg = extractBackground(ctx)

    // Background-process result: dedicated card
    if (bg) {
      return (
        <div className="px-3 py-2 space-y-2">
          <CommandBlock command={cmd} cwd={extractCwd(ctx)} args={ctx.args} rawArgs={ctx.rawArgs} />
          <div className="rounded-md border border-neutral-200 dark:border-neutral-800 p-2 space-y-1.5">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-medium text-neutral-700 dark:text-foreground">{bg.name ?? bg.processId}</span>
              {bg.state === 'ready' && (
                <span className="flex items-center gap-1 text-emerald-500">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  running
                </span>
              )}
              {bg.state === 'timeout' && <span className="text-amber-500">starting (port not ready yet)</span>}
              {bg.state === 'exited' && <span className="text-red-400">exited{bg.exitCode != null ? ` (${bg.exitCode})` : ''}</span>}
              {bg.state === 'stopped' && <span className="text-neutral-400">stopped</span>}
              {bg.url && (
                <a href={bg.url} target="_blank" rel="noreferrer" className="ml-auto text-sky-500 hover:underline font-mono text-[11px]">
                  {bg.url}
                </a>
              )}
            </div>
            {bg.logTail && (
              <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-40">
                <pre className="text-[11px] leading-5 font-mono text-neutral-300 whitespace-pre-wrap">{bg.logTail}</pre>
              </div>
            )}
          </div>
        </div>
      )
    }

    return (
      <div className="px-3 py-2 space-y-2">
        <CommandBlock command={cmd} cwd={extractCwd(ctx)} args={ctx.args} rawArgs={ctx.rawArgs} />

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

        {/* No output */}
        {!hasOutput && (
          <div className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">No output</div>
        )}

        {/* Footer: exit code + signal + timeout + truncated + copy */}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-3 text-[10px] text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            {output.exitCode !== undefined && output.exitCode !== null && (
              <span className={output.exitCode === 0 ? 'text-emerald-500' : 'text-red-400'}>
                exit {output.exitCode}
              </span>
            )}
            {output.signal !== undefined && output.signal !== null && (
              <span className="text-red-400">signal {output.signal}</span>
            )}
            {output.timedOut && (
              <span className="text-amber-500">timed out</span>
            )}
            {output.truncated && (
              <span className="text-amber-500">truncated</span>
            )}
          </span>
          {hasOutput && (
            <CopyIconButton content={[output.stdout, output.stderr].filter(Boolean).join('\n')} />
          )}
        </div>
      </div>
    )
  },
})

// ── Sub-components ──────────────────────────────────────────────────

function CommandBlock({
  command,
  cwd,
  args,
  rawArgs,
}: {
  command: string
  cwd?: { root?: string; cwd?: string }
  args: Record<string, unknown>
  rawArgs: string
}) {
  const parameters = formatParameters(args, rawArgs)

  return (
    <div className="space-y-2">
      {command && (
        <div>
          <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-1">command</div>
          <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto">
            <pre className="text-[11px] leading-5 font-mono text-sky-300 whitespace-pre-wrap">{command}</pre>
          </div>
        </div>
      )}
      <div>
        <div className="text-[10px] text-neutral-400 dark:text-neutral-500 mb-1">parameters</div>
        <div className="rounded-md bg-black dark:bg-neutral-950 p-2 overflow-x-auto max-h-52">
          <pre className="text-[11px] leading-5 font-mono text-neutral-200 whitespace-pre-wrap">{parameters}</pre>
        </div>
      </div>
      {(cwd?.root || cwd?.cwd) && (
        <div className="flex items-center gap-1 text-[10px] text-neutral-500 dark:text-neutral-500">
          <span className="text-neutral-400">cwd:</span>
          <code className="font-mono">
            {cwd.root ?? '~'}
            {cwd.cwd ? `/${cwd.cwd}` : ''}
          </code>
        </div>
      )}
    </div>
  )
}

function formatParameters(args: Record<string, unknown>, rawArgs: string): string {
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return rawArgs || '[Unable to serialize parameters]'
  }
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
  // exec command is an array: ["echo", "hello"] → "echo hello"
  const cmd = ctx.args.command
  if (Array.isArray(cmd)) {
    return cmd.map(String).join(' ')
  }
  return typeof cmd === 'string' ? cmd : ''
}

function extractCwd(ctx: ToolRenderCtx): { root: string | undefined; cwd: string | undefined } {
  const argsRoot = typeof ctx.args.root === 'string' ? ctx.args.root : undefined
  const argsCwd = typeof ctx.args.cwd === 'string' ? ctx.args.cwd : undefined
  const data = ctx.result?.data as Record<string, unknown> | undefined
  const dataRoot = typeof data?.root === 'string' ? data.root : undefined
  const dataCwd = typeof data?.cwd === 'string' ? data.cwd : undefined
  return { root: dataRoot ?? argsRoot, cwd: dataCwd ?? argsCwd }
}

function extractBackground(ctx: ToolRenderCtx): {
  background: true
  name: string | undefined
  processId: string | undefined
  state: 'ready' | 'timeout' | 'exited' | 'stopped' | string
  url: string | undefined
  port: number | undefined
  exitCode: number | null | undefined
  logTail: string | undefined
} | null {
  const data = ctx.result?.data as Record<string, unknown> | undefined
  if (!data || data.background !== true) return null
  return {
    background: true,
    name: typeof data.name === 'string' ? data.name : undefined,
    processId: typeof data.process_id === 'string' ? data.process_id : undefined,
    state: typeof data.state === 'string' ? data.state : 'unknown',
    url: typeof data.url === 'string' ? data.url : undefined,
    port: typeof data.port === 'number' ? data.port : undefined,
    exitCode: data.exit_code as number | null | undefined,
    logTail: typeof data.log_tail === 'string' ? data.log_tail : undefined,
  }
}


function extractOutput(ctx: ToolRenderCtx): {
  stdout: string | undefined
  stderr: string | undefined
  exitCode: number | null | undefined
  signal: number | null | undefined
  timedOut: boolean
  truncated: boolean
} {
  const data = ctx.result?.data as Record<string, unknown> | undefined

  if (data) {
    return {
      stdout: typeof data.stdout === 'string' ? data.stdout : undefined,
      stderr: typeof data.stderr === 'string' ? data.stderr : undefined,
      exitCode: data.exit_code as number | null | undefined,
      signal: data.signal as number | null | undefined,
      timedOut: data.timed_out === true,
      truncated: data.truncated === true,
    }
  }

  return {
    stdout: undefined,
    stderr: undefined,
    exitCode: undefined,
    signal: undefined,
    timedOut: false,
    truncated: false,
  }
}
