/**
 * Message Repository
 *
 * Manages individual message records in the `messages` table.
 * Each message is stored as a separate row, keyed by (conversation_id, seq).
 */

import { getSQLiteDB, parseJSON } from '../sqlite-database'
import type { Message, MessageUsage, ToolCall } from '@/agent/message-types'
import type { AssetMeta } from '@/types/asset'

//=============================================================================
// Types
//=============================================================================

export interface MessageRow {
  id: string
  conversation_id: string
  role: string
  content_json: string
  meta_json: string | null
  timestamp: number
  seq: number
  created_at: number
}

/** Fields stored in meta_json */
interface MessageMeta {
  displayContent?: string
  deferredContext?: Message['deferredContext']
  kind?: 'normal' | 'context_summary' | 'run_changes'
  reasoning?: string | null
  reasoningDurationMs?: number
  toolCalls?: ToolCall[]
  toolCallId?: string
  name?: string
  usage?: MessageUsage
  assets?: AssetMeta[]
  images?: Array<{ data: string; mimeType: string }>
  contentParts?: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }>
  runChanges?: { snapshotId: string }
  readImageHandoff?: Message['readImageHandoff']
}

interface AppSessionSerializedMessage {
  id: string
  role: 'user' | 'assistant' | 'tool'
  content: string | null
  reasoning?: string | null
  toolCalls?: Array<{ id: string; name: string; arguments: string }>
  toolResults?: Array<{ toolCallId: string; name: string; content: string }>
  timestamp: number
  usage?: MessageUsage
}

interface AppSessionSerializedConversation {
  id: string
  title: string
  messages: AppSessionSerializedMessage[]
  createdAt: number
  updatedAt: number
}

//=============================================================================
// Message Repository
//=============================================================================

export class MessageRepository {
  /**
   * Insert a single message
   */
  async insert(convId: string, message: Message, seq: number): Promise<void> {
    const db = getSQLiteDB()
    const { contentJson, metaJson } = this.serializeMessage(message)
    await db.execute(
      `INSERT OR IGNORE INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [message.id, convId, message.role, contentJson, metaJson, message.timestamp, seq, message.timestamp || Date.now()]
    )
  }

  /**
   * Insert multiple messages in a transaction
   */
  async insertBatch(convId: string, messages: Message[]): Promise<void> {
    const db = getSQLiteDB()
    await db.transaction(async (tx) => {
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const { contentJson, metaJson } = this.serializeMessage(msg)
        await tx.execute(
          `INSERT OR IGNORE INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [msg.id, convId, msg.role, contentJson, metaJson, msg.timestamp, i, msg.timestamp || Date.now()]
        )
      }
    })
  }

  /**
   * Load all messages for a conversation, ordered by seq
   */
  async findByConversation(convId: string): Promise<Message[]> {
    const db = getSQLiteDB()
    let rows: MessageRow[] = []
    try {
      rows = await db.queryAll<MessageRow>(
        'SELECT id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at FROM messages WHERE conversation_id = ? ORDER BY seq ASC',
        [convId]
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (!msg.includes('no such table: messages')) {
        throw error
      }
    }
    if (rows.length > 0) return rows.map((row) => this.deserializeMessage(row))

    const legacyColumnRow = await db.queryFirst<{ count: number }>(
      "SELECT COUNT(*) as count FROM pragma_table_info('conversations') WHERE name = 'messages_json'"
    )
    const hasLegacyColumn = (legacyColumnRow?.count ?? 0) > 0
    if (!hasLegacyColumn) return []

    const legacy = await db.queryFirst<{ messages_json: string | null }>(
      'SELECT messages_json FROM conversations WHERE id = ?',
      [convId]
    )
    const parsed = parseJSON<Message[]>(legacy?.messages_json || '[]', [])
    if (!Array.isArray(parsed) || parsed.length === 0) return []

    // Best-effort self-healing: backfill normalized rows for future fast reads.
    try {
      await this.insertBatch(convId, parsed)
    } catch {
      // Ignore write failures; caller still gets legacy-parsed messages.
    }
    return parsed
  }

  /**
   * Delete all messages for a conversation
   */
  async deleteByConversation(convId: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM messages WHERE conversation_id = ?', [convId])
  }

  /**
   * Delete messages with seq >= the given value (used for deleting agent loops)
   */
  async deleteFromSeq(convId: string, seq: number): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM messages WHERE conversation_id = ? AND seq >= ?', [convId, seq])
  }

  /**
   * Replace all messages for a conversation (delete old + insert new, in a transaction)
   */
  async replaceAll(convId: string, messages: Message[]): Promise<void> {
    const db = getSQLiteDB()
    await db.transaction(async (tx) => {
      await tx.execute('DELETE FROM messages WHERE conversation_id = ?', [convId])
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        const { contentJson, metaJson } = this.serializeMessage(msg)
        await tx.execute(
          `INSERT INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [msg.id, convId, msg.role, contentJson, metaJson, msg.timestamp, i, msg.timestamp || Date.now()]
        )
      }
    })
  }

  /**
   * Update a single message (by message id)
   */
  async updateMessage(message: Message): Promise<void> {
    const db = getSQLiteDB()
    const { contentJson, metaJson } = this.serializeMessage(message)
    await db.execute(
      `UPDATE messages SET role = ?, content_json = ?, meta_json = ?, timestamp = ? WHERE id = ?`,
      [message.role, contentJson, metaJson, message.timestamp, message.id]
    )
  }

  /**
   * Count messages for a conversation
   */
  async count(convId: string): Promise<number> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<{ count: number }>(
      'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?',
      [convId]
    )
    return row?.count || 0
  }

  /**
   * Count all rows in messages table.
   */
  async countAll(): Promise<number> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<{ count: number }>('SELECT COUNT(*) as count FROM messages')
    return row?.count || 0
  }

  /**
   * Serialize a Message into content_json and meta_json
   */
  private serializeMessage(message: Message): { contentJson: string; metaJson: string | null } {
    const contentJson = JSON.stringify(message.content)
    const meta: MessageMeta = {}
    let hasMeta = false

    if (message.kind) {
      meta.kind = message.kind
      hasMeta = true
    }
    if (message.reasoning !== undefined) {
      meta.reasoning = message.reasoning
      hasMeta = true
    }
    if (message.reasoningDurationMs !== undefined) {
      meta.reasoningDurationMs = message.reasoningDurationMs
      hasMeta = true
    }
    if (message.toolCalls !== undefined) {
      meta.toolCalls = message.toolCalls
      hasMeta = true
    }
    if (message.toolCallId !== undefined) {
      meta.toolCallId = message.toolCallId
      hasMeta = true
    }
    if (message.name !== undefined) {
      meta.name = message.name
      hasMeta = true
    }
    if (message.usage !== undefined) {
      meta.usage = message.usage
      hasMeta = true
    }
    if (message.assets !== undefined) {
      meta.assets = message.assets
      hasMeta = true
    }
    if (message.images !== undefined) {
      meta.images = message.images
      hasMeta = true
    }
    if (message.displayContent !== undefined) {
      meta.displayContent = message.displayContent
      hasMeta = true
    }
    if (message.deferredContext !== undefined) {
      meta.deferredContext = message.deferredContext
      hasMeta = true
    }
    if (message.contentParts !== undefined) {
      meta.contentParts = message.contentParts
      hasMeta = true
    }
    if (message.runChanges !== undefined) {
      meta.runChanges = message.runChanges
      hasMeta = true
    }
    if (message.readImageHandoff !== undefined) {
      meta.readImageHandoff = message.readImageHandoff
      hasMeta = true
    }

    return {
      contentJson,
      metaJson: hasMeta ? JSON.stringify(meta) : null,
    }
  }

  /**
   * Deserialize a database row into a Message
   */
  private deserializeMessage(row: MessageRow): Message {
    const meta: MessageMeta = row.meta_json ? JSON.parse(row.meta_json) : {}

    return {
      id: row.id,
      role: row.role as Message['role'],
      content: parseJSON<string | null>(row.content_json, null),
      kind: meta.kind,
      reasoning: meta.reasoning,
      reasoningDurationMs: meta.reasoningDurationMs,
      toolCalls: meta.toolCalls,
      toolCallId: meta.toolCallId,
      name: meta.name,
      timestamp: row.timestamp,
      usage: meta.usage,
      assets: meta.assets,
      images: meta.images,
      contentParts: meta.contentParts,
      displayContent: meta.displayContent,
      deferredContext: meta.deferredContext,
      runChanges: meta.runChanges,
      readImageHandoff: meta.readImageHandoff,
    }
  }

  // ==========================================================================
  // Migration helper: migrate messages_json blob to messages table
  // ==========================================================================

  /**
   * Migrate all messages from conversations.messages_json to the messages table.
   * Safe to call multiple times — inserts are idempotent via INSERT OR IGNORE.
   */
  async migrateFromJsonBlob(): Promise<{ conversations: number; messages: number }> {
    const db = getSQLiteDB()

    const columnRow = await db.queryFirst<{ count: number }>(
      "SELECT COUNT(*) as count FROM pragma_table_info('conversations') WHERE name = 'messages_json'"
    )
    const hasLegacyColumn = (columnRow?.count ?? 0) > 0
    if (!hasLegacyColumn) {
      return { conversations: 0, messages: 0 }
    }

    const rows = await db.queryAll<{ id: string; messages_json: string }>(
      `SELECT c.id, c.messages_json
       FROM conversations c
       WHERE COALESCE(c.messages_json, '[]') != '[]'`
    )

    let totalMessages = 0
    let totalConversations = 0

    for (const row of rows) {
      const messages: Message[] = parseJSON<Message[]>(row.messages_json, [])
      if (messages.length === 0) continue

      await db.transaction(async (tx) => {
        const before = await tx.queryFirst<{ count: number }>(
          'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?',
          [row.id]
        )
        const beforeCount = before?.count || 0

        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i]
          if (!msg.id) continue // skip malformed
          const { contentJson, metaJson } = this.serializeMessage(msg)
          await tx.execute(
            `INSERT OR IGNORE INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [msg.id, row.id, msg.role, contentJson, metaJson, msg.timestamp, i, msg.timestamp || Date.now()]
          )
        }
        const after = await tx.queryFirst<{ count: number }>(
          'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?',
          [row.id]
        )
        const afterCount = after?.count || 0

        const added = Math.max(0, afterCount - beforeCount)
        if (added > 0) {
          totalMessages += added
          totalConversations++
        }
      })
    }

    console.log(
      `[MessageRepo] Migration complete: ${totalMessages} messages from ${totalConversations} conversations`
    )
    return { conversations: totalConversations, messages: totalMessages }
  }

  /**
   * Recovery fallback: import conversations/messages from legacy AppSessions IndexedDB snapshots.
   * This fills missing rows conversation-by-conversation and is safe to re-run.
   */
  async recoverFromAppSessions(): Promise<{ sessions: number; conversations: number; messages: number }> {
    if (typeof indexedDB === 'undefined') {
      return { sessions: 0, conversations: 0, messages: 0 }
    }

    const sessions = await this.readAllAppSessions()
    if (sessions.length === 0) return { sessions: 0, conversations: 0, messages: 0 }

    const db = getSQLiteDB()
    let restoredConversations = 0
    let restoredMessages = 0

    for (const session of sessions) {
      const conversations = (session as { conversations?: AppSessionSerializedConversation[] }).conversations
      if (!Array.isArray(conversations)) continue

      for (const conv of conversations) {
        if (!conv?.id || !Array.isArray(conv.messages) || conv.messages.length === 0) continue

        const existing = await db.queryFirst<{ count: number }>(
          'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?',
          [conv.id]
        )
        const existingCount = existing?.count ?? 0
        if (existingCount >= conv.messages.length) continue

        await db.transaction(async (tx) => {
          await tx.execute(
            `INSERT INTO conversations (id, title, title_mode, context_usage_json, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET
               title = excluded.title,
               updated_at = excluded.updated_at`,
            [
              conv.id,
              conv.title || 'New Chat',
              'manual',
              null,
              conv.createdAt || Date.now(),
              conv.updatedAt || Date.now(),
            ]
          )

          for (let i = 0; i < conv.messages.length; i++) {
            const msg = conv.messages[i]
            if (!msg?.id || !msg.role) continue

            const normalized = this.deserializeAppSessionMessage(msg)
            const { contentJson, metaJson } = this.serializeMessage(normalized)
            await tx.execute(
              `INSERT OR IGNORE INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                normalized.id,
                conv.id,
                normalized.role,
                contentJson,
                metaJson,
                normalized.timestamp,
                i,
                normalized.timestamp || Date.now(),
              ]
            )
          }

          const finalCount = await tx.queryFirst<{ count: number }>(
            'SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?',
            [conv.id]
          )
          const added = Math.max(0, (finalCount?.count || 0) - existingCount)
          if (added > 0) {
            restoredConversations++
            restoredMessages += added
          }
        }).catch((error) => {
          console.warn('[MessageRepo] AppSessions recovery failed for conversation', conv.id, error)
        })
      }
    }

    return { sessions: sessions.length, conversations: restoredConversations, messages: restoredMessages }
  }

  private deserializeAppSessionMessage(data: AppSessionSerializedMessage): Message {
    const msg: Message = {
      id: data.id,
      role: data.role,
      content: data.content ?? null,
      timestamp: data.timestamp || Date.now(),
    }

    if (data.reasoning !== undefined) msg.reasoning = data.reasoning
    if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
      msg.toolCalls = data.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.arguments,
        },
      }))
    }
    if (Array.isArray(data.toolResults) && data.toolResults.length > 0) {
      msg.toolCallId = data.toolResults[0]?.toolCallId
      msg.name = data.toolResults[0]?.name
    }
    if (data.usage) msg.usage = data.usage
    return msg
  }

  private readAllAppSessions(): Promise<unknown[]> {
    return new Promise((resolve) => {
      try {
        const request = indexedDB.open('AppSessions', 1)
        request.onerror = () => resolve([])
        request.onupgradeneeded = () => resolve([])
        request.onsuccess = () => {
          const db = request.result
          if (!db.objectStoreNames.contains('sessions')) {
            resolve([])
            return
          }
          const tx = db.transaction(['sessions'], 'readonly')
          const store = tx.objectStore('sessions')
          const getAllReq = store.getAll()
          getAllReq.onerror = () => resolve([])
          getAllReq.onsuccess = () => resolve(Array.isArray(getAllReq.result) ? getAllReq.result : [])
        }
      } catch {
        resolve([])
      }
    })
  }
}

//=============================================================================
// Singleton Instance
//=============================================================================

let messageRepoInstance: MessageRepository | null = null

export function getMessageRepository(): MessageRepository {
  if (!messageRepoInstance) {
    messageRepoInstance = new MessageRepository()
  }
  return messageRepoInstance
}
