'use client'

import { useT } from '@/i18n'
import { AlertTriangle } from 'lucide-react'

/**
 * Persistent degraded-mode banner for sqlite-memory storage (issue #131,
 * Sourcery: "Memory mode still succeeds").
 *
 * When OPFS is unavailable the app falls back to an in-memory SQLite
 * database: everything "works", but ALL data is lost on refresh. The old
 * 8-second auto-dismissing toast never conveyed that severity. This banner
 * mounts at the app root (inside AppBootstrap's ready tree) and stays for
 * the whole session — there is no dismiss action, because the condition
 * never resolves without a browser-level fix (SharedArrayBuffer / OPFS
 * availability, often a cross-origin-embedder or private-mode restriction).
 */
export function MemoryModeBanner() {
  const t = useT()

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="memory-mode-banner"
      className="sticky top-0 z-50 flex w-full items-center gap-2 border-b border-amber-300 bg-amber-100 px-4 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <span>{t('app.memoryModeWarning')}</span>
    </div>
  )
}
