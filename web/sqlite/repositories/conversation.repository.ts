/**
 * Conversation Repository
 *
 * SQLite-based storage for conversations (metadata only).
 * Messages are stored in the independent `messages` table via MessageRepository.
 */

import { getSQLiteDB, type ConversationRow, parseJSON, toJSON } from '../sqlite-database'
import type { ContextWindowUsage } from '@/agent/message-types'
import type { FlowInstance } from '@/agent/flow/types'

export interface StoredConversation {
  id: string
  title: string
  titleMode?: 'auto' | 'manual'
  messages: unknown[] // Message[] — populated by MessageRepository, not this table
  lastContextWindowUsage?: ContextWindowUsage | null
  createdAt: number
  updatedAt: number
}

/** Lightweight conversation metadata without messages */
export interface ConversationMeta {
  id: string
  title: string
  titleMode?: 'auto' | 'manual'
  lastContextWindowUsage?: ContextWindowUsage | null
  compressedContextSummary?: string | null
  compressedContextCutoffTimestamp?: number | null
  flowInstance?: FlowInstance | null
  /** 'project' | 'direct' — undefined ≡ 'project' (legacy rows, zero migration) */
  kind?: 'project' | 'direct'
  createdAt: number
  updatedAt: number
}

/** Base columns that always exist in the conversations table */
type BaseMetaColumns = Pick<
  ConversationRow,
  'id' | 'title' | 'title_mode' | 'context_usage_json' | 'created_at' | 'updated_at'
>

/** Extended columns including compression baseline (added by migration v8) */
type ExtendedMetaColumns = Pick<
  ConversationRow,
  'id' | 'title' | 'title_mode' | 'context_usage_json' |
  'compressed_context_summary' | 'compressed_context_cutoff_ts' |
  'created_at' | 'updated_at'
>

type FlowInstanceMetaColumns = ExtendedMetaColumns & Pick<ConversationRow, 'flow_instance_json'>
type FlowInstanceBaseMetaColumns = BaseMetaColumns & Pick<ConversationRow, 'flow_instance_json'>

const BASE_SELECT = `SELECT id, title, title_mode, context_usage_json, created_at, updated_at FROM conversations`
const EXTENDED_SELECT = `SELECT id, title, title_mode, context_usage_json, compressed_context_summary, compressed_context_cutoff_ts, created_at, updated_at FROM conversations`
const FLOW_INSTANCE_SELECT = `SELECT id, title, title_mode, context_usage_json, compressed_context_summary, compressed_context_cutoff_ts, flow_instance_json, created_at, updated_at FROM conversations`
const FLOW_INSTANCE_BASE_SELECT = `SELECT id, title, title_mode, context_usage_json, flow_instance_json, created_at, updated_at FROM conversations`
const KIND_SELECT = `SELECT id, title, title_mode, context_usage_json, compressed_context_summary, compressed_context_cutoff_ts, flow_instance_json, kind, created_at, updated_at FROM conversations`
// Kind-inclusive fallbacks for schemas that have `kind` but not every other
// extended column — the row converters read kind off the row when present,
// so these selects keep standalone chats loading as kind='direct' even on
// legacy tiers (otherwise they reload as project conversations and vanish
// from /chats).
const EXTENDED_KIND_SELECT = `SELECT id, title, title_mode, context_usage_json, compressed_context_summary, compressed_context_cutoff_ts, kind, created_at, updated_at FROM conversations`
const BASE_KIND_SELECT = `SELECT id, title, title_mode, context_usage_json, kind, created_at, updated_at FROM conversations`

/**
 * True only for schema-shape errors: a missing column/table is a PERMANENT
 * property of the database, so the probe may cache it. Anything else (worker
 * restart, DB busy, transient backend failure) must NOT be cached as "column
 * absent" — a cached false makes saveMeta() drop `kind` from INSERTs and turns
 * updateKind() into a permanent no-op, silently reloading standalone chats as
 * project conversations.
 */
function isMissingColumnError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes('no such column') || msg.includes('no such table')
}

//=============================================================================
// Conversation Repository
//=============================================================================

export class ConversationRepository {
  private _hasCompressionColumns: boolean | null = null
  private _hasFlowInstanceColumn: boolean | null = null
  private _hasKindColumn: boolean | null = null

  private async hasKindColumn(): Promise<boolean> {
    if (this._hasKindColumn !== null) return this._hasKindColumn
    try {
      await getSQLiteDB().queryFirst('SELECT kind FROM conversations LIMIT 0')
      this._hasKindColumn = true
    } catch (error) {
      if (!isMissingColumnError(error)) {
        // Transient failure — leave uncached so the next call re-probes.
        throw error
      }
      this._hasKindColumn = false
    }
    return this._hasKindColumn
  }

  private async hasFlowInstanceColumn(): Promise<boolean> {
    if (this._hasFlowInstanceColumn !== null) return this._hasFlowInstanceColumn
    try {
      await getSQLiteDB().queryFirst('SELECT flow_instance_json FROM conversations LIMIT 0')
      this._hasFlowInstanceColumn = true
    } catch (error) {
      if (!isMissingColumnError(error)) {
        // Transient failure — leave uncached so the next call re-probes.
        throw error
      }
      this._hasFlowInstanceColumn = false
    }
    return this._hasFlowInstanceColumn
  }

  /**
   * Check whether the compression baseline columns exist in the conversations
   * table.  Cached after first check.
   */
  private async hasCompressionColumns(): Promise<boolean> {
    if (this._hasCompressionColumns !== null) return this._hasCompressionColumns
    try {
      const db = getSQLiteDB()
      await db.queryFirst(
        'SELECT compressed_context_summary, compressed_context_cutoff_ts FROM conversations LIMIT 0'
      )
      this._hasCompressionColumns = true
    } catch (error) {
      if (!isMissingColumnError(error)) {
        // Transient failure — leave uncached so the next call re-probes.
        throw error
      }
      this._hasCompressionColumns = false
    }
    return this._hasCompressionColumns
  }

  /**
   * Execute a SELECT query, using extended columns if available, falling back
   * to base columns if the migration hasn't been applied yet.
   */
  private async queryMetaAll(orderBy: string): Promise<ConversationMeta[]> {
    const db = getSQLiteDB()
    const [hasFlowInstance, hasCompression, hasKind] = await Promise.all([
      this.hasFlowInstanceColumn(),
      this.hasCompressionColumns(),
      this.hasKindColumn(),
    ])
    if (hasFlowInstance && hasCompression && hasKind) {
      const rows = await db.queryAll<FlowInstanceMetaColumns>(`${KIND_SELECT} ${orderBy}`)
      return rows.map((row) => this.flowInstanceRowToMeta(row))
    }
    if (hasFlowInstance && hasCompression) {
      const rows = await db.queryAll<FlowInstanceMetaColumns>(
        `${FLOW_INSTANCE_SELECT} ${orderBy}`
      )
      return rows.map((row) => this.flowInstanceRowToMeta(row))
    }
    if (hasFlowInstance) {
      // Pre-compression DB that already has the flow column: base select plus
      // flow parsing (the kind-tier probe rejects independently above).
      const rows = await db.queryAll<FlowInstanceBaseMetaColumns>(
        `${FLOW_INSTANCE_BASE_SELECT} ${orderBy}`
      )
      return rows.map((row) => this.flowInstanceBaseRowToMeta(row))
    }
    if (hasCompression && hasKind) {
      // Compression without the flow column, kind present: keep kind so
      // standalone chats don't reload as project conversations.
      const rows = await db.queryAll<ExtendedMetaColumns>(
        `${EXTENDED_KIND_SELECT} ${orderBy}`
      )
      return rows.map((row) => this.extendedRowToMeta(row))
    }
    if (hasCompression) {
      const rows = await db.queryAll<ExtendedMetaColumns>(
        `${EXTENDED_SELECT} ${orderBy}`
      )
      return rows.map((row) => this.extendedRowToMeta(row))
    }
    if (hasKind) {
      // Legacy base schema that already gained the kind column: include kind
      // independently of the flow-instance column.
      const rows = await db.queryAll<BaseMetaColumns>(`${BASE_KIND_SELECT} ${orderBy}`)
      return rows.map((row) => this.baseRowToMeta(row))
    }
    const rows = await db.queryAll<BaseMetaColumns>(`${BASE_SELECT} ${orderBy}`)
    return rows.map((row) => this.baseRowToMeta(row))
  }

  private async queryMetaFirst(where: string, params: unknown[]): Promise<ConversationMeta | null> {
    const db = getSQLiteDB()
    const [hasFlowInstance, hasCompression, hasKind] = await Promise.all([
      this.hasFlowInstanceColumn(),
      this.hasCompressionColumns(),
      this.hasKindColumn(),
    ])
    if (hasFlowInstance && hasCompression && hasKind) {
      const row = await db.queryFirst<FlowInstanceMetaColumns>(`${KIND_SELECT} ${where}`, params)
      return row ? this.flowInstanceRowToMeta(row) : null
    }
    if (hasFlowInstance && hasCompression) {
      const row = await db.queryFirst<FlowInstanceMetaColumns>(`${FLOW_INSTANCE_SELECT} ${where}`, params)
      return row ? this.flowInstanceRowToMeta(row) : null
    }
    if (hasFlowInstance) {
      const row = await db.queryFirst<FlowInstanceBaseMetaColumns>(
        `${FLOW_INSTANCE_BASE_SELECT} ${where}`,
        params,
      )
      return row ? this.flowInstanceBaseRowToMeta(row) : null
    }
    if (hasCompression && hasKind) {
      const row = await db.queryFirst<ExtendedMetaColumns>(
        `${EXTENDED_KIND_SELECT} ${where}`, params
      )
      return row ? this.extendedRowToMeta(row) : null
    }
    if (hasCompression) {
      const row = await db.queryFirst<ExtendedMetaColumns>(
        `${EXTENDED_SELECT} ${where}`, params
      )
      return row ? this.extendedRowToMeta(row) : null
    }
    if (hasKind) {
      const row = await db.queryFirst<BaseMetaColumns>(
        `${BASE_KIND_SELECT} ${where}`, params
      )
      return row ? this.baseRowToMeta(row) : null
    }
    const row = await db.queryFirst<BaseMetaColumns>(
      `${BASE_SELECT} ${where}`, params
    )
    return row ? this.baseRowToMeta(row) : null
  }

  /**
   * Get all conversations metadata (without messages) ordered by updated_at desc.
   */
  async findAll(): Promise<ConversationMeta[]> {
    return this.queryMetaAll('ORDER BY updated_at DESC')
  }

  /**
   * Alias for findAll() — returns conversation metadata.
   */
  async findAllMeta(): Promise<ConversationMeta[]> {
    return this.findAll()
  }

  /**
   * Find conversation metadata by ID (without messages).
   */
  async findById(id: string): Promise<ConversationMeta | null> {
    return this.queryMetaFirst('WHERE id = ?', [id])
  }

  /**
   * Insert or update conversation metadata (no messages).
   * Messages are managed by MessageRepository.
   */
  async save(conversation: StoredConversation): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `INSERT INTO conversations (id, title, title_mode, context_usage_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         title_mode = excluded.title_mode,
         context_usage_json = excluded.context_usage_json,
         updated_at = excluded.updated_at`,
      [
        conversation.id,
        conversation.title,
        conversation.titleMode || 'manual',
        toJSON(conversation.lastContextWindowUsage || null),
        conversation.createdAt,
        conversation.updatedAt,
      ]
    )
  }

  /**
   * Delete a conversation by ID.
   * Messages are cascade-deleted via FOREIGN KEY ON DELETE CASCADE.
   */
  async delete(id: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM conversations WHERE id = ?', [id])
  }

  /**
   * Delete all conversations
   */
  async deleteAll(): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM conversations')
  }

  /**
   * Count conversations
   */
  async count(): Promise<number> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<{ count: number }>(
      'SELECT COUNT(*) as count FROM conversations'
    )
    return row?.count || 0
  }

  /**
   * Get most recently updated conversation metadata
   */
  async findMostRecent(): Promise<ConversationMeta | null> {
    return this.queryMetaFirst('ORDER BY updated_at DESC LIMIT 1', [])
  }

  /**
   * Update conversation title
   */
  async updateTitle(id: string, title: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ?', [title, Date.now(), id])
  }

  /**
   * Touch conversation's updated_at timestamp without changing other fields.
   */
  async touch(id: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('UPDATE conversations SET updated_at = ? WHERE id = ?', [Date.now(), id])
  }

  async loadFlowInstance(conversationId: string): Promise<FlowInstance | null> {
    if (!await this.hasFlowInstanceColumn()) return null
    const row = await getSQLiteDB().queryFirst<{ flow_instance_json: string | null }>(
      'SELECT flow_instance_json FROM conversations WHERE id = ?', [conversationId]
    )
    return row?.flow_instance_json
      ? parseJSON<FlowInstance | null>(row.flow_instance_json, null)
      : null
  }

  async saveFlowInstance(conversationId: string, instance: FlowInstance): Promise<void> {
    if (!await this.hasFlowInstanceColumn()) return
    await getSQLiteDB().execute(
      'UPDATE conversations SET flow_instance_json = ?, updated_at = ? WHERE id = ?',
      [toJSON(instance), Date.now(), conversationId]
    )
  }

  /**
   * Save only the metadata fields (no messages).
   * Used by persistConversationMeta().
   *
   * Gracefully handles the case where compression columns don't exist yet
   * (migration v8 not applied) by falling back to the base SQL.
   */
  async saveMeta(meta: {
    id: string
    title: string
    titleMode?: 'auto' | 'manual'
    contextUsage?: ContextWindowUsage | null
    compressedContextSummary?: string | null
    compressedContextCutoffTimestamp?: number | null
    kind?: 'project' | 'direct'
    createdAt: number
    updatedAt: number
  }): Promise<void> {
    const db = getSQLiteDB()
    const useExtended = await this.hasCompressionColumns()
    const useKind = await this.hasKindColumn()
    // kind is written on INSERT (creating a 'direct' conversation row must
    // persist its kind) but NEVER on CONFLICT UPDATE: persistConversationMeta()
    // snapshots `kind` from in-memory state when the save STARTS; if that write
    // lands after a concurrent direct→project transition has committed, an
    // `kind = excluded.kind` clause would silently revert the conversion (the
    // in-memory conversation stays 'project' while the row reloads as 'direct'
    // after a refresh). Kind changes go through the dedicated updateKind()
    // transition path instead. (The non-kind branches always behaved this way:
    // the DB default 'project' applies on INSERT.)
    const normalizedKind = meta.kind === 'direct' ? 'direct' : 'project'

    if (useExtended && useKind) {
      await db.execute(
        `INSERT INTO conversations (id, title, title_mode, context_usage_json, compressed_context_summary, compressed_context_cutoff_ts, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           title_mode = excluded.title_mode,
           context_usage_json = excluded.context_usage_json,
           compressed_context_summary = excluded.compressed_context_summary,
           compressed_context_cutoff_ts = excluded.compressed_context_cutoff_ts,
           updated_at = excluded.updated_at`,
        [
          meta.id,
          meta.title,
          meta.titleMode || 'manual',
          toJSON(meta.contextUsage || null),
          meta.compressedContextSummary || null,
          meta.compressedContextCutoffTimestamp ?? null,
          normalizedKind,
          meta.createdAt,
          meta.updatedAt,
        ]
      )
    } else if (useExtended) {
      await db.execute(
        `INSERT INTO conversations (id, title, title_mode, context_usage_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           title_mode = excluded.title_mode,
           context_usage_json = excluded.context_usage_json,
           updated_at = excluded.updated_at`,
        [
          meta.id,
          meta.title,
          meta.titleMode || 'manual',
          toJSON(meta.contextUsage || null),
          meta.createdAt,
          meta.updatedAt,
        ]
      )
    } else {
      // Pre-compression schema (migration v8 not applied): persist the base
      // columns so titles (and other metadata) are not silently dropped.
      await db.execute(
        `INSERT INTO conversations (id, title, title_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           title_mode = excluded.title_mode,
           updated_at = excluded.updated_at`,
        [
          meta.id,
          meta.title,
          meta.titleMode || 'manual',
          meta.createdAt,
          meta.updatedAt,
        ]
      )
    }
  }

  /**
   * Dedicated kind-transition write (direct ↔ project).
   *
   * This is the ONLY path allowed to change an existing row's kind: generic
   * meta saves (saveMeta) deliberately leave the kind column untouched on
   * conflict so a stale 'direct' snapshot cannot revert a committed
   * conversion that raced ahead of them.
   */
  async updateKind(id: string, kind: 'project' | 'direct'): Promise<void> {
    if (!await this.hasKindColumn()) return
    await getSQLiteDB().execute(
      'UPDATE conversations SET kind = ?, updated_at = ? WHERE id = ?',
      [kind, Date.now(), id]
    )
  }

  private baseRowToMeta(row: BaseMetaColumns): ConversationMeta {
    return {
      id: row.id,
      title: row.title,
      titleMode: row.title_mode === 'auto' ? 'auto' : 'manual',
      lastContextWindowUsage: parseJSON(row.context_usage_json || '', null),
      compressedContextSummary: null,
      compressedContextCutoffTimestamp: null,
      // BASE_KIND_SELECT already includes kind on the legacy tier; keep it so
      // standalone chats don't reload as project conversations there either.
      kind: (row as { kind?: 'project' | 'direct' }).kind === 'direct' ? 'direct' : 'project',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private extendedRowToMeta(row: ExtendedMetaColumns): ConversationMeta {
    return {
      id: row.id,
      title: row.title,
      titleMode: row.title_mode === 'auto' ? 'auto' : 'manual',
      lastContextWindowUsage: parseJSON(row.context_usage_json || '', null),
      compressedContextSummary: row.compressed_context_summary || null,
      compressedContextCutoffTimestamp: row.compressed_context_cutoff_ts ?? null,
      flowInstance: null,
      kind: (row as { kind?: 'project' | 'direct' }).kind === 'direct' ? 'direct' : 'project',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private flowInstanceRowToMeta(row: FlowInstanceMetaColumns): ConversationMeta {
    return {
      ...this.extendedRowToMeta(row),
      flowInstance: parseJSON<FlowInstance | null>(row.flow_instance_json || '', null),
    }
  }

  private flowInstanceBaseRowToMeta(row: FlowInstanceBaseMetaColumns): ConversationMeta {
    return {
      ...this.baseRowToMeta(row),
      kind: (row as { kind?: 'project' | 'direct' }).kind === 'direct' ? 'direct' : 'project',
      flowInstance: parseJSON<FlowInstance | null>(row.flow_instance_json || '', null),
    }
  }
}

//=============================================================================
// Singleton Instance
//=============================================================================

let conversationRepoInstance: ConversationRepository | null = null

export function getConversationRepository(): ConversationRepository {
  if (!conversationRepoInstance) {
    conversationRepoInstance = new ConversationRepository()
  }
  return conversationRepoInstance
}
