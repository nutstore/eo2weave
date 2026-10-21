/**
 * Conversation Batch Export Service
 *
 * UI-facing counterpart of the agent's `search_conversations` tool:
 * - `listConversationsForExport` — filterable cross-project conversation list
 *   (projects multi-select, time window, keyword) straight from SQLite
 * - `exportConversationsBatch` — render N selected conversations through the
 *   shared `prepareConversationExport` pipeline and pack everything into a
 *   single downloadable zip:
 *
 *     eo2weave-conversations_20260821_153000/
 *     ├── index.md            ← human-readable table of contents
 *     ├── manifest.json       ← machine-readable metadata
 *     ├── 01-Title One/conversation.md (+ images/ attachments/)
 *     ├── 02-Title Two/conversation.json
 *     └── …
 *
 * @module conversation-batch-export
 */

import { saveAs } from 'file-saver'
import { strToU8, zipSync, type Zippable } from 'fflate'
import type { Conversation, Message } from '@/agent/message-types'
import { getSQLiteDB } from '@/sqlite/sqlite-database'
import { READABLE_HISTORY_MESSAGE_SQL } from '@/sqlite/message-projections'
import { getMessageRepository } from '@/sqlite'
import {
  prepareConversationExport,
  type ConversationExportFormat,
  type ConversationExportOptions,
} from './conversation-export'

// ============================================================================
// List query
// ============================================================================

export interface ConversationListItem {
  conversationId: string
  title: string
  workspaceName: string
  projectName: string | null
  updatedAt: number
  createdAt: number
  messageCount: number
}

export interface ConversationListFilter {
  /** Only include conversations of these projects (by NAME — legacy agent-tool path). Empty = all projects. */
  projects?: string[]
  /**
   * Only include conversations of these projects (by ID — UI path). Empty =
   * all projects. `null` entries select conversations with no project link.
   */
  projectIds?: Array<string | null>
  /** Unix epoch ms — only conversations updated at/after this. */
  updatedAfter?: number
  /** Unix epoch ms — only conversations updated at/before this. */
  updatedBefore?: number
  /** Case-insensitive substring match on title (and keyword search on message content when keywordSearch=true). */
  query?: string
  /** When true, `query` also matches message content. Default false (title only). */
  keywordSearch?: boolean
  /** Max rows. Default 500. */
  limit?: number
}

/**
 * Cross-project conversation list for the batch-export picker.
 *
 * Same JOIN shape as the search_conversations tool (conversations ⋈ workspaces
 * ⋈ projects) plus a message-count aggregate so the table can show it.
 */
export async function listConversationsForExport(
  filter: ConversationListFilter = {},
): Promise<ConversationListItem[]> {
  const {
    projects,
    projectIds,
    updatedAfter,
    updatedBefore,
    query,
    keywordSearch = false,
    limit = 500,
  } = filter

  const conditions: string[] = []
  const params: unknown[] = []

  if (projects && projects.length > 0) {
    conditions.push(`p.name IN (${projects.map(() => '?').join(',')})`)
    params.push(...projects)
  }
  if (projectIds && projectIds.length > 0) {
    // NULL projectId selects conversations with no project link (p.id IS NULL
    // after the LEFT JOINs), matching the synthetic untitled dropdown entry.
    const nonNull = projectIds.filter((id): id is string => id !== null)
    const parts: string[] = []
    if (nonNull.length > 0) {
      parts.push(`p.id IN (${nonNull.map(() => '?').join(',')})`)
      params.push(...nonNull)
    }
    if (nonNull.length !== projectIds.length) {
      parts.push('p.id IS NULL')
    }
    conditions.push(`(${parts.join(' OR ')})`)
  }
  if (typeof updatedAfter === 'number') {
    conditions.push('c.updated_at >= ?')
    params.push(updatedAfter)
  }
  if (typeof updatedBefore === 'number') {
    conditions.push('c.updated_at <= ?')
    params.push(updatedBefore)
  }
  if (query && query.trim()) {
    const likePattern = `%${query.trim()}%`
    if (keywordSearch) {
      conditions.push(
        `(c.title LIKE ? OR EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND ${READABLE_HISTORY_MESSAGE_SQL} AND lower(m.content_json) LIKE lower(?)))`,
      )
      params.push(likePattern, likePattern)
    } else {
      conditions.push('c.title LIKE ?')
      params.push(likePattern)
    }
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const sql = `
    SELECT
      c.id AS conversationId,
      c.title,
      COALESCE(w.name, '') AS workspaceName,
      p.name AS projectName,
      c.updated_at AS updatedAt,
      c.created_at AS createdAt,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND ${READABLE_HISTORY_MESSAGE_SQL}) AS messageCount
    FROM conversations c
    LEFT JOIN workspaces w ON c.id = w.id
    LEFT JOIN projects p ON w.project_id = p.id
    ${where}
    ORDER BY c.updated_at DESC
    LIMIT ?
  `
  params.push(limit)

  const db = getSQLiteDB()
  const rows = await db.queryAll<ConversationListItem>(sql, params)
  return rows
}

/** All projects that have at least one conversation (for the filter dropdown). */
export interface ProjectWithCount {
  /** Project id; null = conversations with no project link (shown as untitled). */
  projectId: string | null
  /** Raw project name; null = no project link (callers localize the display label). */
  name: string | null
  conversationCount: number
}

/**
 * Per-project conversation counts for the batch-export filter dropdown.
 * Shows counts inline so users can predict what a filter yields before
 * selecting it; id-based so same-named projects never collide and the
 * untitled (NULL) group is selectable via the null id.
 *
 * No COALESCE on `name`: the untitled label is a UI concern (must be
 * localized), so the service returns raw null and callers render
 * `t('...untitledProject')` for `projectId === null` rows.
 */
export async function listProjectsWithCounts(): Promise<ProjectWithCount[]> {
  const db = getSQLiteDB()
  return db.queryAll<ProjectWithCount>(
    `SELECT p.id AS projectId, p.name AS name, COUNT(*) AS conversationCount
     FROM conversations c
     LEFT JOIN workspaces w ON c.id = w.id
     LEFT JOIN projects p ON w.project_id = p.id
     GROUP BY p.id, p.name
     ORDER BY name`,
  )
}

// ============================================================================
// Batch export
// ============================================================================

export interface BatchExportProgress {
  /** 0..100 */
  percent: number
  /** e.g. "3/12" */
  step: string
  /** conversation title currently being exported */
  title: string
}

export interface BatchExportItemResult {
  conversationId: string
  title: string
  dirName: string
  success: boolean
  messageCount: number
  bundledFileCount: number
  error?: string
}

export interface BatchExportResult {
  success: boolean
  filename: string
  size: number
  exportedCount: number
  skippedCount: number
  items: BatchExportItemResult[]
  error?: string
}

export interface BatchExportOptions
  extends Omit<ConversationExportOptions, 'filename' | 'addTimestamp' | 'onProgress'> {
  /** zip base name (without extension) */
  basename?: string
  /** progress callback (per-conversation granularity) */
  onProgress?: (progress: BatchExportProgress) => void
}

/**
 * Load a conversation (with all messages) from SQLite for export.
 * Falls back gracefully when the conversation is missing.
 */
async function loadConversation(conversationId: string, title: string): Promise<Conversation> {
  const repo = getMessageRepository()
  const messages = await repo.findByConversation(conversationId)

  const db = getSQLiteDB()
  const row = await db.queryFirst<{ created_at: number; updated_at: number }>(
    'SELECT created_at, updated_at FROM conversations WHERE id = ?',
    [conversationId],
  )

  return {
    id: conversationId,
    title,
    messages: messages as Message[],
    createdAt: row?.created_at ?? Date.now(),
    updatedAt: row?.updated_at ?? Date.now(),
  } as unknown as Conversation
}

/** Turn a conversation title into a safe zip directory name. */
function sanitizeDirName(title: string): string {
  const cleaned = title
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return cleaned || 'untitled'
}

/** yyyyMMdd_HHmmss in local time. */
function formatTimestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** Row-level info carried from the picker into index.md / manifest.json. */
export interface BatchExportSelection {
  conversationId: string
  title: string
  projectName?: string
  updatedAt?: number
}

/**
 * Build the human-readable index.md for the bundle.
 */
function buildIndexMarkdown(
  items: Array<BatchExportItemResult & Pick<BatchExportSelection, 'projectName' | 'updatedAt'>>,
  format: ConversationExportFormat,
  exportedAt: Date,
): string {
  const lines: string[] = []
  lines.push(`# ${items.filter((i) => i.success).length} conversations`)
  lines.push('')
  lines.push(`> Exported on ${exportedAt.toLocaleString()} · Format: ${format.toUpperCase()}`)
  lines.push('')
  lines.push('| # | Conversation | Project | Updated | Messages | Files |')
  lines.push('|---|---|---|---|---|---|')
  items.forEach((item, i) => {
    const flag = item.success ? '' : ' ⚠️'
    const updated = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : ''
    const titleCell = item.success
      ? `[${item.title.replace(/[[\]|]/g, '')}](${encodeURIComponent(item.dirName)}/)`
      : item.title.replace(/[|]/g, '')
    lines.push(
      `| ${i + 1} | ${titleCell}${flag} | ${(item.projectName ?? '').replace(/[|]/g, '')} | ${updated} | ${item.messageCount} | ${item.bundledFileCount} |`,
    )
  })
  lines.push('')
  if (items.some((i) => !i.success)) {
    lines.push('> ⚠️ Items marked above were skipped (no messages or export error).')
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Export multiple conversations into a single zip and trigger download.
 *
 * Conversations are processed serially (OPFS asset reads are more reliable
 * that way, and it gives clean per-conversation progress). A single failed
 * conversation does not abort the batch — it is recorded as skipped.
 */
export async function exportConversationsBatch(
  selections: BatchExportSelection[],
  options: BatchExportOptions,
): Promise<BatchExportResult> {
  const { basename, onProgress } = options
  const format = options.format
  const total = selections.length
  const stamp = formatTimestamp()
  const fallbackName = `eo2weave-conversations_${stamp}`
  const zipName = basename || fallbackName

  if (total === 0) {
    return {
      success: false,
      filename: '',
      size: 0,
      exportedCount: 0,
      skippedCount: 0,
      items: [],
      error: 'No conversations selected',
    }
  }

  const zipped: Zippable = {}
  const items: Array<BatchExportItemResult & Pick<BatchExportSelection, 'projectName' | 'updatedAt'>> = []
  const usedDirs = new Set<string>()
  let exportedCount = 0
  let skippedCount = 0

  for (let i = 0; i < total; i++) {
    const { conversationId, title, projectName, updatedAt } = selections[i]
    onProgress?.({
      percent: Math.round(((i) / total) * 100),
      step: `${i + 1}/${total}`,
      title,
    })

    // Unique directory name: "01-Title", "02-Title", … (dedupe identical titles)
    let dirName = `${String(i + 1).padStart(2, '0')}-${sanitizeDirName(title)}`
    while (usedDirs.has(dirName)) {
      dirName = `${String(i + 1).padStart(2, '0')}-${sanitizeDirName(title)}-${Math.random().toString(36).slice(2, 6)}`
    }
    usedDirs.add(dirName)

    const item: BatchExportItemResult & Pick<BatchExportSelection, 'projectName' | 'updatedAt'> = {
      conversationId,
      title,
      dirName,
      success: false,
      messageCount: 0,
      bundledFileCount: 0,
      projectName,
      updatedAt,
    }

    try {
      const conversation = await loadConversation(conversationId, title)
      // Strip batch-only fields before handing options to the per-conversation pipeline.
      const { format: fmt, includeToolCalls, includeReasoning, includeUsage, includeSystemMessages, includeImages } = options
      const prepared = await prepareConversationExport(conversation, {
        format: fmt,
        includeToolCalls,
        includeReasoning,
        includeUsage,
        includeSystemMessages,
        includeImages,
      }, dirName)

      if ('error' in prepared) {
        item.error = prepared.error
        skippedCount += 1
      } else {
        for (const [path, bytes] of prepared.files) {
          zipped[path] = [bytes, { level: path.endsWith('.md') || path.endsWith('.json') || path.endsWith('.html') ? 6 : 0 }]
        }
        item.success = true
        item.messageCount = prepared.messageCount
        item.bundledFileCount = prepared.bundledFileCount
        exportedCount += 1
      }
    } catch (error) {
      item.error = error instanceof Error ? error.message : String(error)
      skippedCount += 1
    }

    items.push(item)
  }

  // Nothing exported at all → fail without download.
  if (exportedCount === 0) {
    return {
      success: false,
      filename: '',
      size: 0,
      exportedCount: 0,
      skippedCount,
      items,
      error: items[0]?.error || 'All conversations failed to export',
    }
  }

  onProgress?.({ percent: 95, step: `${total}/${total}`, title: '' })

  // index.md + manifest.json
  const exportedAt = new Date()
  zipped['index.md'] = [strToU8(buildIndexMarkdown(items, format, exportedAt)), { level: 6 }]
  zipped['manifest.json'] = [
    strToU8(
      JSON.stringify(
        {
          meta: {
            exportedAt: exportedAt.toISOString(),
            format,
            version: '1.0.0',
            generator: 'EO2Weave batch conversation export',
          },
          items: items.map(({ conversationId, title, dirName, success, messageCount, bundledFileCount, error }) => ({
            conversationId,
            title,
            dir: dirName,
            success,
            messageCount,
            bundledFileCount,
            error: error ?? null,
          })),
        },
        null,
        2,
      ),
    ),
    { level: 6 },
  ]

  const zippedBytes = zipSync(zipped)
  const blob = new Blob([zippedBytes], { type: 'application/zip' })
  const finalFilename = `${zipName}.zip`
  saveAs(blob, finalFilename)

  onProgress?.({ percent: 100, step: `${total}/${total}`, title: '' })

  return {
    success: true,
    filename: finalFilename,
    size: blob.size,
    exportedCount,
    skippedCount,
    items,
  }
}
