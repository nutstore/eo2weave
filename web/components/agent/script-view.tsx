'use client'

import { useMemo, useState } from 'react'
import { Copy } from 'lucide-react'
import { useT } from '@/i18n'

/**
 * Readable rendering helpers for script-bearing tool cards (run_code and
 * anything that reuses it). Neither of these ever dumps a raw payload: the
 * script is highlighted line-preserving code, and results are prose or a
 * key/value list.
 */

const MAX_INLINE_CHARS = 600

/**
 * Minimal JS tokenizer for script display.
 *
 * The product has no client-side syntax highlighter, and a script only needs
 * string / comment / keyword / number emphasis to be skimmable. Ordering
 * matters: strings and comments are matched before keywords so "await" inside
 * a string stays a string.
 */
const SCRIPT_TOKEN = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|\b(await|async|const|let|var|function|return|if|else|for|while|of|in|new|try|catch|finally|throw|typeof|null|undefined|true|false)\b|\b(\d+(?:\.\d+)?)\b/g

export function ScriptBlock({ code }: { code: string }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  const parts = useMemo(() => {
    const out: Array<{ text: string; kind: 'comment' | 'string' | 'keyword' | 'number' | 'plain' }> = []
    let last = 0
    for (const match of code.matchAll(SCRIPT_TOKEN)) {
      const start = match.index ?? 0
      if (start > last) out.push({ text: code.slice(last, start), kind: 'plain' })
      const kind = match[1] ? 'comment' : match[2] ? 'string' : match[3] ? 'keyword' : 'number'
      out.push({ text: match[0], kind })
      last = start + match[0].length
    }
    if (last < code.length) out.push({ text: code.slice(last), kind: 'plain' })
    return out
  }, [code])

  const color = (kind: string) => kind === 'comment'
    ? 'text-neutral-400 italic'
    : kind === 'string'
      ? 'text-emerald-700 dark:text-emerald-400'
      : kind === 'keyword'
        ? 'text-violet-700 dark:text-violet-400'
        : kind === 'number'
          ? 'text-amber-700 dark:text-amber-400'
          : 'text-neutral-700 dark:text-neutral-200'

  return (
    <div className="overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center justify-between bg-neutral-100 px-2 py-1 dark:bg-neutral-800">
        <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400">javascript</span>
        <button
          type="button"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-neutral-500 hover:bg-neutral-200 dark:text-neutral-400 dark:hover:bg-neutral-700"
          onClick={() => {
            void navigator.clipboard.writeText(code).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }).catch(() => undefined)
          }}
        >
          <Copy className="h-3 w-3" aria-hidden="true" />
          {copied ? t('toolCallDisplay.workflowCopied') : t('toolCallDisplay.workflowCopy')}
        </button>
      </div>
      <pre className="max-h-64 overflow-auto bg-neutral-50 p-2 text-[12px] leading-relaxed dark:bg-bg-tertiary">
        <code>
          {parts.map((part, index) => (
            <span key={index} className={color(part.kind)}>{part.text}</span>
          ))}
        </code>
      </pre>
    </div>
  )
}

/** Renders a script result as readable output instead of JSON. */
export function ValueView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const t = useT()
  const [showAll, setShowAll] = useState(false)

  if (value === null || value === undefined) {
    return <span className="text-neutral-400">—</span>
  }
  if (typeof value === 'string') {
    if (!value.trim()) return <span className="text-neutral-400">—</span>
    const clipped = value.length > MAX_INLINE_CHARS && !showAll
    const content = clipped ? `${value.slice(0, MAX_INLINE_CHARS)}…` : value
    return (
      <div className="min-w-0">
        <div className="whitespace-pre-wrap break-words text-neutral-700 dark:text-neutral-200">{content}</div>
        {clipped && (
          <button type="button" className="mt-0.5 text-[11px] text-primary-600 hover:underline dark:text-primary-400"
            onClick={() => setShowAll(true)}>
            {t('toolCallDisplay.workflowShowAll', { count: value.length })}
          </button>
        )}
      </div>
    )
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="tabular-nums text-neutral-700 dark:text-neutral-200">{String(value)}</span>
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-neutral-400">—</span>
    return (
      <ol className="min-w-0 space-y-1">
        {value.map((item, index) => (
          <li key={index} className="flex min-w-0 gap-2">
            <span className="shrink-0 text-neutral-400">{index + 1}.</span>
            <div className="min-w-0 flex-1"><ValueView value={item} depth={depth + 1} /></div>
          </li>
        ))}
      </ol>
    )
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return <span className="text-neutral-400">—</span>
  if (depth >= 3) {
    return <span className="break-words text-neutral-500 dark:text-neutral-400">{t('toolCallDisplay.workflowItems', { count: entries.length })}</span>
  }
  return (
    <dl className="min-w-0 space-y-1">
      {entries.map(([key, item]) => (
        <div key={key} className="flex min-w-0 gap-2">
          <dt className="shrink-0 text-neutral-500 dark:text-neutral-400">{key}</dt>
          <dd className="min-w-0 flex-1"><ValueView value={item} depth={depth + 1} /></dd>
        </div>
      ))}
    </dl>
  )
}
