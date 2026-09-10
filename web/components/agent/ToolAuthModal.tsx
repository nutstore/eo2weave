/**
 * ToolAuthModal — the single floating confirmation dialog for all prompt-level
 * tool authorizations (replaces ExecAuthModal + PageWriteAuthModal).
 *
 * Not part of the conversation flow: overlays the whole app and blocks until
 * the user clicks an explicit action button. There is deliberately NO way to
 * dismiss via backdrop click or Esc — authorization modals often pop up while
 * the user is away (e.g. during long background commands); an accidental
 * backdrop-deny would send a misleading refusal to the LLM and silently
 * derail the run (redesign doc §3.3 interaction constraint).
 *
 * Buttons:
 *   - Allow once
 *   - Always allow for this conversation (only when memoryKey is non-null)
 *   - Deny (+ Deny all when more requests are queued)
 */

import React, { useEffect, useRef, useState } from 'react'
import { useToolAuthStore, type ToolAuthDescriptionInput } from '@/store/tool-auth.store'
import type { FileChange } from '@/opfs/types/opfs-types'
import { useT } from '@/i18n'

/** Max files rendered in the file-change list (rest collapses into "+N more"). */
const FILE_LIST_LIMIT = 50
/** Max characters of pretty-printed args before truncating. */
const ARGS_DISPLAY_LIMIT = 2000

/**
 * Collapsible block showing the raw tool arguments as pretty-printed JSON.
 * Collapsed by default so the modal stays compact for large payloads.
 */
function ArgsBlock({ toolArgs }: { toolArgs: unknown }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  let text: string
  try {
    text = JSON.stringify(toolArgs, null, 2) ?? String(toolArgs)
  } catch {
    text = String(toolArgs)
  }
  const truncated = text.length > ARGS_DISPLAY_LIMIT
  if (truncated) text = text.slice(0, ARGS_DISPLAY_LIMIT) + '\n…'

  return (
    <div className="mt-3">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="text-xs font-medium text-primary-600 hover:underline dark:text-primary-400"
      >
        {expanded ? t('agent.toolAuth.hideArgs') : t('agent.toolAuth.viewArgs')}
      </button>
      {expanded && (
        <pre className="mt-1.5 max-h-48 overflow-auto rounded-lg border border-border bg-muted/50 px-3 py-2 font-mono text-xs text-foreground/80 whitespace-pre-wrap break-all">
          {text}
        </pre>
      )}
    </div>
  )
}

/**
 * Collapsible block showing the tool's own description from its provider
 * (MCP server / WebMCP page). Clamped to a few lines by default — long
 * provider descriptions must not blow up the modal — with an expand toggle
 * that only appears when the text actually overflows (measured, not
 * guessed from character count).
 */
function ToolDescriptionBlock({ description }: { description: string }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const textRef = useRef<HTMLParagraphElement>(null)

  // Measured once on mount while the text is still clamped: scrollHeight
  // reflects the full content, clientHeight the clamped box.
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    setOverflowing(el.scrollHeight > el.clientHeight + 1)
  }, [description])

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <p className="text-xs font-medium text-muted-foreground">
        {t('agent.toolAuth.toolDescriptionTitle')}
      </p>
      <p
        ref={textRef}
        className={`mt-1 break-words text-xs leading-relaxed text-foreground/70 ${
          expanded ? '' : 'line-clamp-3'
        }`}
      >
        {description}
      </p>
      {overflowing && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-xs font-medium text-primary-600 hover:underline dark:text-primary-400"
        >
          {expanded
            ? t('agent.toolAuth.toolDescriptionCollapse')
            : t('agent.toolAuth.toolDescriptionExpand')}
        </button>
      )}
    </div>
  )
}

const FILE_TYPE_BADGE: Record<FileChange['type'], string> = {
  add: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400',
  modify: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400',
  delete: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400',
}

/**
 * Lightweight file-change list: type badge + path per row. Clicking a row
 * opens a near-fullscreen diff viewer overlay (large window — the auth modal
 * itself stays compact).
 */
function FileChangeListBlock({ changes }: { changes: FileChange[] }) {
  const t = useT()
  const [selected, setSelected] = useState<FileChange | null>(null)
  const shown = changes.slice(0, FILE_LIST_LIMIT)
  const overflow = changes.length - shown.length

  // Esc closes the diff viewer window. This is a read-only review overlay
  // (NOT the authorization modal — which must stay Esc-immune), so a
  // keyboard dismiss is safe. Capture phase so it wins over the modal's
  // own prevent-only Esc handler.
  useEffect(() => {
    if (!selected) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [selected])

  return (
    <div className="mt-3 rounded-lg border border-border bg-muted/30">
      <p className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
        {t('agent.toolAuth.fileChangesTitle', { count: changes.length })}
        {' · '}
        {t('agent.toolAuth.clickToPreview')}
      </p>
      <ul className="max-h-48 overflow-y-auto py-1">
        {shown.map((c) => (
          <li key={c.path}>
            <button
              onClick={() => setSelected(c)}
              className="flex w-full items-center gap-2 px-3 py-1 text-left transition-colors hover:bg-muted"
            >
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                  FILE_TYPE_BADGE[c.type] ?? ''
                }`}
              >
                {c.type}
              </span>
              <span className="truncate font-mono text-xs text-foreground/80" title={c.path}>
                {c.path}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {overflow > 0 && (
        <p className="px-3 py-1.5 text-xs text-muted-foreground">
          {t('agent.toolAuth.moreFiles', { count: overflow })}
        </p>
      )}

      {/* Near-fullscreen diff viewer overlay (large review window). */}
      {selected && (
        <div
          className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setSelected(null)}
        >
          <div
            className="flex h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <span
                className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                  FILE_TYPE_BADGE[selected.type] ?? ''
                }`}
              >
                {selected.type}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" title={selected.path}>
                {selected.path}
              </span>
              <button
                onClick={() => setSelected(null)}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <LazyFileDiffViewer fileChange={selected} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Lazily resolved FileDiffViewer host (one shared module promise — avoids
 * pulling Monaco into the modal bundle until a file is expanded). A real
 * React component so its hooks live in a component (rules-of-hooks);
 * renders nothing until the lazy module has loaded.
 */
type FileDiffViewerModule = {
  FileDiffViewer: React.ComponentType<{ fileChange: FileChange | null }>
}

let fileDiffViewerPromise: Promise<FileDiffViewerModule | null> | null = null
function LazyFileDiffViewer({ fileChange }: { fileChange: FileChange | null }) {
  const [Comp, setComp] = useState<FileDiffViewerModule['FileDiffViewer'] | null>(null)
  useEffect(() => {
    if (!fileDiffViewerPromise) {
      fileDiffViewerPromise = import('@/components/sync/FileDiffViewer')
        .then((m) => ({ FileDiffViewer: m.FileDiffViewer }) as FileDiffViewerModule)
        .catch(() => null)
    }
    let cancelled = false
    void fileDiffViewerPromise.then((m) => {
      // Wrap in an updater: passing a component function directly to setState makes
      // React treat it as an updater (basicStateReducer) and CALL it with the previous
      // state (null), crashing inside the component ("Cannot destructure 'fileChange'").
      if (!cancelled) setComp(() => m?.FileDiffViewer ?? null)
    })
    return () => {
      cancelled = true
    }
  }, [])
  if (!Comp) return null
  return <Comp fileChange={fileChange} />
}

/**
 * Render the modal body: i18n descriptors are translated (locale-aware),
 * plain strings (exec context) render as-is.
 */
function useDescriptionText(description: ToolAuthDescriptionInput): string | null {
  const t = useT()
  if (!description) return null
  if (typeof description === 'string') return description
  return t(`agent.toolAuth.${description.key}`, description.params)
}

export function ToolAuthModal() {
  const pending = useToolAuthStore((s) => s.pending)
  const queueLength = useToolAuthStore((s) => s.queue.length)
  const approve = useToolAuthStore((s) => s.approve)
  const deny = useToolAuthStore((s) => s.deny)
  const denyAll = useToolAuthStore((s) => s.denyAll)
  const t = useT()
  const descriptionText = useDescriptionText(pending?.description ?? null)

  // Hard block: the modal must stay up until an explicit button is clicked.
  // Backdrop clicks and Esc intentionally do nothing.
  useEffect(() => {
    if (!pending) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pending])

  if (!pending) return null

  const isExecLike = Boolean(pending.detail)
  const queuePosition = queueLength > 1 ? ` · 1/${queueLength}` : ''

  return (
    // Backdrop: no onClick handler on purpose — clicking outside must NOT
    // deny or dismiss the request.
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('agent.toolAuth.title')}
    >
      <div
        className="mx-4 flex max-h-[85vh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-100 dark:bg-primary-50/50">
              <svg
                className="h-5 w-5 text-primary-600 dark:text-primary-500"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M10 1.944A11.954 11.954 0 012.166 5C2.057 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM11 14a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-base font-semibold text-foreground">
                {t('agent.toolAuth.title')}
              </h2>
              <p className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-primary-600 dark:text-primary-500">
                  {pending.toolName}
                </code>
                {isExecLike && t('agent.toolAuth.subtitle')}
                {queuePosition}
              </p>
            </div>
          </div>
        </div>

        {/* Body — scrolls independently so the action buttons stay reachable
            even when the command/context is very long */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {descriptionText && (
            <p className="break-words text-sm leading-relaxed text-foreground/80">
              {descriptionText}
            </p>
          )}
          {pending.toolDescription && <ToolDescriptionBlock description={pending.toolDescription} />}
          {isExecLike && (
            <div className="mt-3 rounded-lg border border-border bg-muted/50 px-3 py-2">
              <code className="block max-h-48 overflow-y-auto break-all whitespace-pre-wrap font-mono text-sm text-primary-600 dark:text-primary-500">
                $ {pending.detail}
              </code>
            </div>
          )}
          {pending.toolArgs !== undefined && <ArgsBlock toolArgs={pending.toolArgs} />}
          {pending.fileChanges && pending.fileChanges.length > 0 && (
            <FileChangeListBlock changes={pending.fileChanges} />
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-2 border-t border-border px-5 py-4">
          {pending.memoryKey !== null && (
            <button
              onClick={() => approve(true)}
              className="w-full rounded-lg border border-primary-300 px-4 py-2 text-sm font-medium text-primary-600 transition-colors hover:bg-primary-50 dark:border-primary-800 dark:text-primary-400 dark:hover:bg-primary-950/40"
            >
              {t('agent.toolAuth.alwaysAllow')}
            </button>
          )}
          <div className="flex gap-2">
            {queueLength > 1 && (
              <button
                onClick={denyAll}
                className="rounded-lg border border-border px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
                title={t('agent.toolAuth.denyAllHint')}
              >
                {t('agent.toolAuth.denyAll')}
              </button>
            )}
            <button
              onClick={deny}
              className="flex-1 rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted"
            >
              {t('agent.toolAuth.deny')}
            </button>
            <button
              onClick={() => approve(false)}
              className="flex-1 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary-700"
            >
              {t('agent.toolAuth.allow')}
            </button>
          </div>
        </div>

        {/* Settings guide (exec-specific hint kept from ExecAuthModal) */}
        {isExecLike && (
          <div className="border-t border-border bg-muted/30 px-5 py-2.5">
            <p className="text-center text-[11px] text-muted-foreground">
              {t('execPolicy.authGuide')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
