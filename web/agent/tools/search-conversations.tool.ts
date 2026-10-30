/**
 * Search Conversations Tool
 *
 * Searches across all workspaces' chat history for a keyword/phrase, with optional
 * time-window and project filters. Supports two modes:
 *
 *   - Keyword mode  (query is non-empty): LIKE search on messages.content_json/meta_json
 *                                          (existing behavior, plus optional time/project filters).
 *   - List mode    (query is empty)     : pure time-window/project listing of conversations
 *                                          — useful for daily briefings like "最近 3 天".
 *
 * Time parameters use Unix epoch milliseconds.
 */

import type { ToolDefinition, ToolExecutor, ToolPromptDoc } from './tool-types'
import { getSQLiteDB } from '@/sqlite/sqlite-database'
import { READABLE_HISTORY_MESSAGE_SQL } from '@/sqlite/message-projections'
import { toolOkJson, toolErrorJson } from './tool-envelope'

export const searchConversationsDefinition: ToolDefinition = {
  type: 'function',
  function: {
    name: 'search_conversations',
    description:
      'Search across all workspaces chat history for a keyword or phrase. ' +
      'Returns matching conversation titles, workspace names, and project names. ' +
      'Use this when the user asks about a topic they discussed before but cannot remember which workspace it was in. ' +
      'Supports optional time-window filters (updated_after / updated_before, Unix epoch ms) and project filter — ' +
      'which together enable "最近 N 天"、"今天"、"本周" type conversation briefings without multi-query fan-out.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'The keyword or phrase to search for in chat messages. ' +
            'Pass an empty string (or omit) to list conversations purely by time/project filters.',
        },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description: 'Maximum number of results to return. Default 20.',
        },
        updated_after: {
          type: 'number',
          description:
            'Optional Unix epoch milliseconds (e.g. 1784995200000). ' +
            'Only return conversations whose updated_at is >= this value. Useful for "今天" / "最近 3 天" briefings.',
        },
        updated_before: {
          type: 'number',
          description:
            'Optional Unix epoch milliseconds. Only return conversations whose updated_at is <= this value.',
        },
        project: {
          type: 'string',
          description:
            'Optional project name filter (exact match against `projects.name`).',
        },
        projects: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional multi-project filter (exact match, OR semantics). ' +
            'Equivalent to `project` but for several projects at once — use this to ' +
            'include a known set of projects (which implicitly excludes all others).',
        },
        sort_by: {
          type: 'string',
          enum: ['updated_desc', 'updated_asc'],
          description:
            'Sort order. Default "updated_desc" (most recent first). ' +
            'When query is non-empty, only updated_desc / updated_asc are supported.',
        },
      },
      // All parameters are optional. The executor enforces that at least one
      // of {query, updated_after, updated_before, project, projects} is provided.
      required: [],
    },
  },
}

interface SearchResultRow {
  conversationId: string
  title: string
  workspaceName: string | null
  projectName: string | null
  updatedAt: number
  matchedContentJson?: string
  // JSON-encoded content_json of the most recent assistant message in the conversation.
  // Lets the LLM judge the conversation's status (awaiting input / wrapping up / done)
  // without fetching every message. Decoded by the renderer + caller.
  lastAssistantContentJson?: string | null
}

interface ProjectBreakdownRow {
  // COALESCE handles orphan conversations (no associated project); never null at this layer.
  projectName: string
  conversationCount: number
  lastActivityAt: number
}

/**
 * Extract a short snippet around the first occurrence of the query in plain message text.
 */
function extractSnippet(text: string, query: string, contextChars = 300): string | null {
  const lowerJson = text.toLowerCase()
  const lowerQuery = query.toLowerCase()
  const idx = lowerJson.indexOf(lowerQuery)
  if (idx === -1) return null

  const start = Math.max(0, idx - contextChars)
  const end = Math.min(text.length, idx + query.length + contextChars)

  let snippet = text.slice(start, end)

  // Trim punctuation artifacts at boundaries
  snippet = snippet.replace(/^[^"'`\w\u4e00-\u9fff]+/, '').replace(/[^"'`\w\u4e00-\u9fff]+$/, '')

  if (start > 0) snippet = '...' + snippet
  if (end < text.length) snippet = snippet + '...'

  return snippet
}

function extractSnippetFromContentJson(contentJson: string, query: string): string | null {
  try {
    const parsed = JSON.parse(contentJson) as unknown
    const text = typeof parsed === 'string' ? parsed : ''
    if (!text) return null
    return extractSnippet(text, query)
  } catch {
    return null
  }
}

/**
 * SQL fragment (subquery in SELECT) that returns the content_json of the most
 * recent assistant message in the outer conversation row. Used directly in the
 * outer SELECT list so the executor can ship the final assistant message
 * alongside each conversation row in a single round-trip.
 *
 * Why a correlated subquery (not a CTE or LEFT JOIN-derived table):
 *   - SQLite refuses to reference an outer alias (`c.id`) inside a derived
 *     table, so `LEFT JOIN (SELECT ... WHERE m.conversation_id = c.id) la`
 *     errors with "no such column: c.id".
 *   - CTEs would work but the dev `db_query` tool's response shaper drops rows
 *     for `WITH` queries in observed tests.
 *   - A correlated subquery in the SELECT list is the simplest portable form;
 *     the SQLite planner turns it into a per-row index lookup, which is fast
 *     for the indexed `(conversation_id, seq)` path.
 */
function buildLastAssistantColumn(): string {
  return `(
    SELECT m.content_json
    FROM messages m
    WHERE m.role = 'assistant'
      AND m.conversation_id = c.id
    ORDER BY m.seq DESC
    LIMIT 1
  ) AS lastAssistantContentJson`
}

/**
 * Decode the JSON-encoded content_json of a message into a plain string.
 * Returns null if the field is absent or the JSON is malformed.
 *
 * The `messages.content_json` column is always a JSON string (e.g. `"hello"` or
 * `"{\"ok\":true,\"tool\":...}"`). For assistant text this is just a plain string;
 * for tool messages it would be a JSON object, but we only attach assistant
 * messages here, so a single decode is enough.
 */
function decodeMessageContent(raw: string | null | undefined): string | null {
  if (!raw) return null
  try {
    const decoded = JSON.parse(raw) as unknown
    return typeof decoded === 'string' ? decoded : null
  } catch {
    return null
  }
}

/**
 * Build the WHERE clause for the messages-table sub-query (only used in keyword mode).
 *
 * Note: The `messages` table only has `timestamp` (per-message time), not `updated_at`.
 * Time-window filtering is therefore applied at the *conversation* level (c.updated_at)
 * which represents "when the conversation was last active" — that's what users actually
 * care about for "最近 3 天 / 今天" briefings.
 */
function buildMessageWhere(query: string): { sql: string; params: unknown[] } {
  if (!query) {
    return { sql: '', params: [] }
  }
  const likePattern = `%${query}%`
  return {
    sql: `WHERE ${READABLE_HISTORY_MESSAGE_SQL} AND (lower(m.content_json) LIKE lower(?) OR lower(COALESCE(m.meta_json, '') ) LIKE lower(?))`,
    params: [likePattern, likePattern],
  }
}

export const searchConversationsExecutor: ToolExecutor = async (args) => {
  const rawQuery = typeof args.query === 'string' ? args.query : ''
  const query = rawQuery.trim()
  const hasQuery = query.length > 0

  const limit =
    typeof args.limit === 'number' && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(Math.floor(args.limit), 50))
      : 20
  const updatedAfter =
    typeof args.updated_after === 'number' && Number.isFinite(args.updated_after) ? args.updated_after : null
  const updatedBefore =
    typeof args.updated_before === 'number' && Number.isFinite(args.updated_before)
      ? args.updated_before
      : null
  const projectFilter =
    typeof args.project === 'string' && args.project.trim().length > 0 ? args.project.trim() : ''
  // Multi-project filter (OR semantics). Mutually exclusive with `project` —
  // when both are given, `project` wins (single filter is the stricter intent).
  const projectsFilter: string[] = Array.isArray(args.projects)
    ? args.projects.filter((p: unknown): p is string => typeof p === 'string' && p.trim().length > 0).map((p: string) => p.trim())
    : []
  const hasProjectScope = !!projectFilter || projectsFilter.length > 0
  const sortBy = args.sort_by === 'updated_asc' ? 'updated_asc' : 'updated_desc'

  // At least one filter is required: keyword OR time OR project(s).
  if (!hasQuery && updatedAfter === null && updatedBefore === null && !hasProjectScope) {
    return toolErrorJson(
      'search_conversations',
      'invalid_arguments',
      'at least one of query, updated_after, updated_before, project, projects is required'
    )
  }

  try {
    const db = getSQLiteDB()
    let rows: SearchResultRow[] = []
    let projectsBreakdown: ProjectBreakdownRow[] = []

    if (hasQuery) {
      // ── Keyword mode ────────────────────────────────────────────────────────
      // Strategy: filter `messages` first (optionally by time AND keyword), collapse
      // down to (conversation_id, max(seq)) so we keep the latest matching message
      // per conversation for snippet extraction. Then join `conversations` and apply
      // the *conversation-level* filters (project, overall updated_at).
      const msgWhere = buildMessageWhere(query)

      const conversationConditions: string[] = []
      const conversationParams: unknown[] = []
      if (updatedAfter !== null) {
        conversationConditions.push('c.updated_at >= ?')
        conversationParams.push(updatedAfter)
      }
      if (updatedBefore !== null) {
        conversationConditions.push('c.updated_at <= ?')
        conversationParams.push(updatedBefore)
      }
      if (projectFilter) {
        conversationConditions.push('p.name = ?')
        conversationParams.push(projectFilter)
      } else if (projectsFilter.length > 0) {
        conversationConditions.push(`p.name IN (${projectsFilter.map(() => '?').join(',')})`)
        conversationParams.push(...projectsFilter)
      }
      if (conversationConditions.length > 0) {
        // A project filter must not sweep in standalone chats merely because
        // their hidden host workspace carries that project's id.
        conversationConditions.push(`c.kind IS NOT 'direct'`)
      }
      const conversationWhere =
        conversationConditions.length > 0 ? `WHERE ${conversationConditions.join(' AND ')}` : ''

      const orderBy = sortBy === 'updated_asc' ? 'ORDER BY c.updated_at ASC' : 'ORDER BY c.updated_at DESC'

      const sql = `
        WITH matched AS (
          SELECT m_msg.conversation_id AS conversationId, MAX(m_msg.seq) AS matchedSeq
          FROM messages m_msg
          ${msgWhere.sql.replace(/m\./g, 'm_msg.')}
          GROUP BY m_msg.conversation_id
        )
        SELECT
          c.id AS conversationId,
          c.title,
          w.name AS workspaceName,
          p.name AS projectName,
          c.updated_at AS updatedAt,
          m_match.content_json AS matchedContentJson,
          ${buildLastAssistantColumn()}
        FROM conversations c
        INNER JOIN matched mt ON mt.conversationId = c.id
        INNER JOIN messages m_match ON m_match.conversation_id = mt.conversationId
                                    AND m_match.seq = mt.matchedSeq
        LEFT JOIN workspaces w ON c.id = w.id
        LEFT JOIN projects p ON w.project_id = p.id
        ${conversationWhere}
        ${orderBy}
        LIMIT ?
      `

      rows = await db.queryAll<SearchResultRow>(sql, [
        ...msgWhere.params,
        ...conversationParams,
        limit + 1,
      ])
    } else {
      // ── List mode (no keyword) ──────────────────────────────────────────────
      // Pure time/project filter: directly query `conversations`.
      const conditions: string[] = []
      const params: unknown[] = []
      if (updatedAfter !== null) {
        conditions.push('c.updated_at >= ?')
        params.push(updatedAfter)
      }
      if (updatedBefore !== null) {
        conditions.push('c.updated_at <= ?')
        params.push(updatedBefore)
      }
      if (projectFilter) {
        conditions.push('p.name = ?')
        params.push(projectFilter)
      } else if (projectsFilter.length > 0) {
        conditions.push(`p.name IN (${projectsFilter.map(() => '?').join(',')})`)
        params.push(...projectsFilter)
      }
      if (conditions.length > 0) {
        // Same standalone-chat exclusion as keyword mode.
        conditions.push(`c.kind IS NOT 'direct'`)
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

      const orderBy = sortBy === 'updated_asc' ? 'ORDER BY c.updated_at ASC' : 'ORDER BY c.updated_at DESC'

      const conversationsSql = `
        SELECT
          c.id AS conversationId,
          c.title,
          w.name AS workspaceName,
          p.name AS projectName,
          c.updated_at AS updatedAt,
          '' AS matchedContentJson,
          ${buildLastAssistantColumn()}
        FROM conversations c
        LEFT JOIN workspaces w ON c.id = w.id
        LEFT JOIN projects p ON w.project_id = p.id
        ${where}
        ${orderBy}
        LIMIT ?
      `
      rows = await db.queryAll<SearchResultRow>(conversationsSql, [...params, limit + 1])

      // ── Project breakdown (only meaningful when no project filter is set) ─
      // Reuses the same WHERE so the breakdown reflects the same time window as the results.
      // Skipped when caller already passed `project=`/`projects=` (breakdown would
      // mirror the filter and add no information).
      if (!hasProjectScope) {
        const breakdownSql = `
          SELECT
            COALESCE(p.name, '(未命名项目)') AS projectName,
            COUNT(*) AS conversationCount,
            MAX(c.updated_at) AS lastActivityAt
          FROM conversations c
          LEFT JOIN workspaces w ON c.id = w.id
          LEFT JOIN projects p ON w.project_id = p.id
          ${where}
          GROUP BY p.name
          ORDER BY conversationCount DESC, lastActivityAt DESC
        `
        projectsBreakdown = await db.queryAll<ProjectBreakdownRow>(breakdownSql, params)
      }
    }

    const hasMore = rows.length > limit
    const results = rows.slice(0, limit).map((row) => ({
      conversationId: row.conversationId,
      title: row.title,
      workspaceName: row.workspaceName || '(未命名工作区)',
      projectName: row.projectName || '(未命名项目)',
      updatedAt: row.updatedAt,
      snippet:
        hasQuery && row.matchedContentJson
          ? extractSnippetFromContentJson(row.matchedContentJson, query)
          : null,
      // The last assistant message in the conversation. Lets the calling model
      // judge status (awaiting input / wrapping up / done) without re-querying.
      lastAssistantMessage: decodeMessageContent(row.lastAssistantContentJson),
    }))

    return toolOkJson('search_conversations', {
      query: hasQuery ? query : '*',
      totalMatches: results.length,
      hasMore,
      filters: {
        updated_after: updatedAfter,
        updated_before: updatedBefore,
        project: projectFilter || null,
        projects: projectsFilter.length > 0 ? projectsFilter : null,
        sort_by: sortBy,
      },
      mode: hasQuery ? 'keyword' : 'list',
      results,
      // Project activity breakdown (list mode only; empty array in keyword mode).
      // Lets the model see which projects have activity without requiring a separate
      // listProjects tool — perfect for "which project should I focus on today?".
      projects_breakdown: projectsBreakdown,
    })
  } catch (error) {
    return toolErrorJson(
      'search_conversations',
      'internal_error',
      `Search failed: ${error instanceof Error ? error.message : String(error)}`,
      { retryable: true }
    )
  }
}

export const searchConversationsPromptDoc: ToolPromptDoc = {
  category: 'search',
  section: '### Cross-Workspace Search',
  lines: [
    '- `search_conversations(query, limit?)` - Keyword search across all workspaces chat history.',
    '- `search_conversations("", updated_after=<ms>, updated_before=<ms>)` - List conversations in a time window (Unix epoch ms). Useful for "最近 3 天" / "今天" / "本周" briefings.',
    '- `search_conversations(query, project="<name>", updated_after=<ms>)` - Combine keyword + project + time filters.',
    '- `search_conversations("", projects=["A", "B"], updated_after=<ms>)` - Multi-project include filter (OR semantics) — selects a known set of projects, implicitly excluding all others.',
  ],
}
