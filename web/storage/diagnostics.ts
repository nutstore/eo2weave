/**
 * Storage Diagnostics
 *
 * Collects all runtime information that helps debug "data is missing" reports:
 *   - SQLite mode / health / recovery stats / table counts
 *   - OPFS / IndexedDB / Service Worker availability
 *   - Persistent storage grant status and quota usage
 *   - Cross-origin isolation (required for SQLite WASM OPFS VFS)
 *   - Active Service Worker version
 *   - Recent SQLite-related console warnings
 *
 * The output is a plain markdown string so users can paste it into feedback
 * channels without needing DevTools.
 *
 * @module storage/diagnostics
 */

import { getSQLiteDB } from '@/sqlite'
import { formatBytes } from '@/lib/utils'

export interface DiagnosticSection {
  label: string
  status: 'ok' | 'warn' | 'error' | 'info'
  lines: string[]
  /** Optional flat key-value signals to merge into the report summary. */
  summary?: Record<string, string | number | boolean | null | undefined>
}

export interface DiagnosticReport {
  generatedAt: string
  sections: DiagnosticSection[]
  markdown: string
  /** Plain key-value summary for quick machine parsing */
  summary: Record<string, string | number | boolean | null | undefined>
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn()
  } catch {
    return fallback
  }
}

async function safeAsync<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

/**
 * Format a possibly-missing/invalid byte count, preserving the legacy
 * 'unknown' fallback that the canonical formatter does not provide.
 */
function formatSize(bytes?: number): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return 'unknown'
  return formatBytes(bytes)
}

async function collectSQLiteSection(): Promise<DiagnosticSection> {
  const lines: string[] = []
  const summary: Record<string, string | number | boolean | null | undefined> = {}
  let status: DiagnosticSection['status'] = 'ok'

  const db = getSQLiteDB()

  const mode = safe(() => db.getMode(), null)
  summary.sqliteMode = mode
  lines.push(`- Mode: ${mode ?? 'not initialized'}`)
  if (mode !== 'opfs') {
    status = 'warn'
    lines.push(`  ⚠️ Expected 'opfs', got '${mode}'. Data may be inaccessible.`)
  }

  const recovery = safe(() => db.getRecoveryStats(), null)
  summary.sqliteRecoveryCount = recovery?.count ?? 0
  if (recovery) {
    lines.push(`- Recovery attempts: ${recovery.count}`)
    if (recovery.lastRecoveryDate) {
      lines.push(`  Last recovery: ${recovery.lastRecoveryDate.toISOString()}`)
    }
    if (recovery.count > 0) {
      status = 'warn'
      lines.push('  ⚠️ Recoveries indicate OPFS handle/file access issues.')
    }
  }

  // Health check
  const health = await safeAsync(async () => {
    await db.queryFirst('SELECT 1')
    return true
  }, false)
  summary.sqliteHealthy = health
  if (!health) {
    status = 'error'
    lines.push('- Health check: ❌ FAILED (SELECT 1 threw)')
  } else {
    lines.push('- Health check: ✅ passed')
  }

  // Table counts
  if (health) {
    const tables = await safeAsync(
      async () =>
        db.queryAll<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ),
      []
    )
    summary.sqliteTableCount = tables.length
    lines.push(`- Tables: ${tables.length}`)

    const counts: Record<string, number> = {}
    let totalRows = 0
    for (const { name } of tables) {
      const result = await safeAsync(
        async () => db.queryFirst<{ count: number }>(`SELECT COUNT(*) as count FROM "${name}"`),
        null
      )
      const c = typeof result?.count === 'number' ? result.count : -1
      counts[name] = c
      if (c > 0) totalRows += c
    }
    summary.sqliteTotalRows = totalRows

    const interesting = ['conversations', 'messages', 'projects', 'workspaces', 'skills', 'api_keys']
    const present = interesting.filter((t) => t in counts)
    if (present.length > 0) {
      lines.push(`- Key tables: ${present.map((t) => `${t}=${counts[t]}`).join(', ')}`)
    }
    if (totalRows === 0) {
      status = 'error'
      lines.push('  🚨 Database is EMPTY — all tables have 0 rows.')
    } else if (counts.conversations === 0 && counts.messages === 0) {
      status = 'warn'
      lines.push('  ⚠️ No conversations or messages — user may perceive this as data loss.')
    }
  }

  // Schema version
  if (health) {
    const versionRow = await safeAsync(
      async () => db.queryFirst<{ user_version: number }>('PRAGMA user_version'),
      null
    )
    summary.sqliteSchemaVersion = versionRow?.user_version ?? null
    lines.push(`- Schema version: ${versionRow?.user_version ?? 'unknown'}`)
  }

  return { label: 'SQLite', status, lines, summary }
}

function collectBrowserStorageSection(): DiagnosticSection {
  const lines: string[] = []
  const summary: Record<string, string | number | boolean | null | undefined> = {}
  let status: DiagnosticSection['status'] = 'ok'

  const crossOriginIsolated = safe(() => self.crossOriginIsolated, false)
  summary.crossOriginIsolated = crossOriginIsolated
  lines.push(`- crossOriginIsolated: ${crossOriginIsolated ? '✅ true' : '❌ false'}`)
  if (!crossOriginIsolated) {
    status = 'error'
    lines.push('  🚨 Required for SQLite WASM OPFS VFS. Without it, OPFS access fails.')
  }

  // OPFS is exposed via navigator.storage.getDirectory() — the 'opfs' flag on
  // navigator is non-standard and absent even in browsers that fully support OPFS.
  const hasOpfs = safe(
    () => typeof navigator.storage?.getDirectory === 'function',
    false
  )
  summary.opfsAvailable = hasOpfs
  lines.push(`- OPFS available: ${hasOpfs ? '✅' : '❌'}`)

  const hasSAB = safe(() => typeof SharedArrayBuffer !== 'undefined', false)
  summary.sharedArrayBuffer = hasSAB
  lines.push(`- SharedArrayBuffer: ${hasSAB ? '✅' : '❌'}`)

  return { label: 'Browser Runtime', status, lines, summary }
}

async function collectStorageQuotaSection(): Promise<DiagnosticSection> {
  const lines: string[] = []
  let status: DiagnosticSection['status'] = 'ok'

  const estimate = await safeAsync(() => navigator.storage.estimate(), null)
  const persisted = await safeAsync(() => navigator.storage.persisted(), false)

  if (estimate) {
    const usage = estimate.usage ?? 0
    const quota = estimate.quota ?? 0
    const pct = quota > 0 ? (usage / quota) * 100 : 0
    lines.push(`- Usage: ${formatSize(usage)} / ${formatSize(quota)} (${pct.toFixed(1)}%)`)
    if (pct > 90) {
      status = 'warn'
      lines.push('  ⚠️ Near quota — browser may evict OPFS data.')
    } else if (pct > 70) {
      status = 'warn'
      lines.push('  ⚠️ Storage usage elevated.')
    }
  } else {
    lines.push('- Usage: unavailable')
  }

  lines.push(`- Persisted: ${persisted ? '✅ granted' : '❌ not granted'}`)
  if (!persisted) {
    status = 'warn'
    lines.push('  ⚠️ Without persistence, browser may clear OPFS under storage pressure.')
  }

  return { label: 'Storage Quota', status, lines }
}

function collectServiceWorkerSection(): DiagnosticSection {
  const lines: string[] = []
  let status: DiagnosticSection['status'] = 'ok'

  const supported = 'serviceWorker' in navigator
  if (!supported) {
    lines.push('- ServiceWorker: not supported')
    return { label: 'Service Worker', status: 'info', lines }
  }

  const controller = navigator.serviceWorker.controller
  lines.push(`- Controller: ${controller ? 'active' : 'none (uncontrolled)'}`)
  if (!controller) {
    status = 'warn'
    lines.push('  ⚠️ No active SW — offline cache and update push will not work.')
  }

  const swUrl = safe(() => controller?.scriptURL, null)
  if (swUrl) lines.push(`- Script: ${swUrl}`)

  const buildId = safe(() => {
    const meta = document.querySelector('meta[name="app-build-id"]')
    return meta?.getAttribute('content') || null
  }, null)
  if (buildId) lines.push(`- Build: ${buildId}`)

  return { label: 'Service Worker', status, lines }
}

function collectEnvironmentSection(): DiagnosticSection {
  const lines: string[] = []

  lines.push(`- URL: ${location.href}`)
  lines.push(`- UA: ${navigator.userAgent}`)
  lines.push(`- Online: ${navigator.onLine ? 'yes' : 'no'}`)
  lines.push(`- Cookies enabled: ${navigator.cookieEnabled}`)
  lines.push(`- DNT: ${navigator.doNotTrack ?? 'unset'}`)

  const standalone = safe(
    () => window.matchMedia('(display-mode: standalone)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true,
    false
  )
  lines.push(`- Installed PWA: ${standalone ? 'yes' : 'no'}`)

  return { label: 'Environment', status: 'info', lines }
}

function detectRecentErrors(): { sqliteErrors: number; recoveryLog: string[] } {
  // We can't intercept console history directly, but the recovery stats
  // from SQLiteWorkerClient tracks recent attempts.
  const db = getSQLiteDB()
  const stats = safe(() => db.getRecoveryStats(), null)
  return {
    sqliteErrors: stats?.count ?? 0,
    recoveryLog: [],
  }
}

/**
 * Run all diagnostic checks and return a structured report.
 */
export async function runDiagnostics(): Promise<DiagnosticReport> {
  const sections: DiagnosticSection[] = []

  sections.push(await collectSQLiteSection())
  sections.push(collectBrowserStorageSection())
  sections.push(await collectStorageQuotaSection())
  sections.push(collectServiceWorkerSection())
  sections.push(collectEnvironmentSection())

  const { sqliteErrors } = detectRecentErrors()

  // Merge per-section summary signals into a flat top-level summary.
  const summary: Record<string, string | number | boolean | null | undefined> = {}
  for (const section of sections) {
    if (section.summary) {
      Object.assign(summary, section.summary)
    }
  }
  summary.sqliteRecoveryCount = sqliteErrors

  // Build markdown
  const generatedAt = new Date().toISOString()
  const md: string[] = []
  md.push(`# 怡氧知知诊断报告`)
  md.push(`生成时间：${generatedAt}`)
  md.push('')

  const overall: Record<DiagnosticSection['status'], string> = {
    ok: '✅ 正常',
    warn: '⚠️ 需关注',
    error: '❌ 异常',
    info: 'ℹ️ 信息',
  }

  for (const section of sections) {
    md.push(`## ${section.label} ${overall[section.status]}`)
    for (const line of section.lines) md.push(line)
    md.push('')
  }

  md.push('---')
  md.push('请把以上内容完整复制给开发者。')

  return {
    generatedAt,
    sections,
    markdown: md.join('\n'),
    summary,
  }
}

/**
 * Copy arbitrary markdown text to the clipboard.
 * Returns true on success, false if clipboard API was unavailable or rejected.
 */
export async function copyMarkdownToClipboard(markdown: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(markdown)
      return true
    }
  } catch (err) {
    console.warn('[diagnostics] clipboard.writeText failed, falling back to execCommand', err)
  }
  // Legacy fallback
  try {
    const textarea = document.createElement('textarea')
    textarea.value = markdown
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(textarea)
    return ok
  } catch (err) {
    console.error('[diagnostics] execCommand fallback failed', err)
    return false
  }
}

/**
 * Copy a full diagnostic report to the clipboard.
 * Convenience wrapper around {@link copyMarkdownToClipboard}.
 */
export async function copyReportToClipboard(report: DiagnosticReport): Promise<boolean> {
  return copyMarkdownToClipboard(report.markdown)
}
