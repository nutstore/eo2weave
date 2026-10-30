/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Application Storage Initialization
 *
 * Handles SQLite initialization on app startup.
 *
 * Usage:
 * ```ts
 * import { initStorage } from '@/storage/init'
 *
 * await initStorage({ onProgress: (p) => console.log(p) })
 * ```
 */

import {
  initSQLiteDB,
  getSQLiteDB,
  clearAllSQLiteTables,
  clearLegacySahPoolFromOPFSRoot,
} from '@/sqlite'
import { clearStorageResetMarker, getStorageResetMarker, setStorageResetMarker } from './reset-marker'
import { beginReset, endReset } from './reset-coordinator'

//=============================================================================
// Types
//=============================================================================

export type StorageMode = 'sqlite-opfs' | 'sqlite-memory' | 'indexeddb-fallback'

export interface InitStorageOptions {
  /**
   * Progress callback for initialization
   */
  onProgress?: (progress: { step: string; total: number; current: number; details: string }) => void

  /**
   * Allow fallback to IndexedDB if SQLite fails
   *
   * @deprecated 新架构下 SQLite 是唯一数据源，IndexedDB 中只有 legacy AppSessions。
   * 静默回退会让 UI 显示空状态却伪装成初始化成功，导致用户感知为"数据丢失"。
   * 保留参数仅为向后兼容，请显式传 `false`，未来版本会移除。
   *
   * 传 `true` 时只影响 `mode` 字段，不会再把 `success` 从 false 改成 true。
   *
   * @default false
   */
  allowFallback?: boolean
}

export interface InitStorageResult {
  success: boolean
  mode: StorageMode
  error?: string
}

export const RESET_REQUIRES_TAB_CLOSURE = 'RESET_REQUIRES_TAB_CLOSURE'

//=============================================================================
// OPFS Detection
//=============================================================================

/**
 * Check if OPFS (Origin Private File System) is available
 */
export function isOPFSAvailable(): boolean {
  return 'opfs' in navigator && 'getDirectory' in (navigator as any).opfs
}

/**
 * Check if SharedArrayBuffer is available (required for SQLite WASM OPFS VFS)
 */
export function isSharedArrayBufferAvailable(): boolean {
  return typeof SharedArrayBuffer !== 'undefined'
}

/**
 * Check if SQLite WASM can run with OPFS VFS
 */
export function canUseOPFSVFS(): boolean {
  return true
}

//=============================================================================
// Storage Mode State
//=============================================================================

let currentStorageMode: StorageMode = 'sqlite-opfs'
let storageInitPromise: Promise<InitStorageResult> | undefined = undefined

function isDatabaseInaccessibleError(errorMsg: string): boolean {
  const msg = errorMsg.toLowerCase()
  return (
    msg.includes('database_inaccessible') ||
    msg.includes('cantopen') ||
    msg.includes('getsynchandleerror') ||
    msg.includes('sqlite_busy') ||
    msg.includes('database is locked')
  )
}

function buildPostResetInaccessibleMessage(rawError: string): string {
  return `DATABASE_INACCESSIBLE_AFTER_RESET: ${rawError}. 请关闭同源的其他标签页/窗口后重试。`
}

function buildDatabaseInaccessibleMessage(rawError: string): string {
  return `DATABASE_INACCESSIBLE: ${rawError}. 请关闭同源的其他标签页/窗口后刷新重试。`
}

function isSchemaMigrationError(errorMsg: string): boolean {
  const msg = errorMsg.toLowerCase()
  return msg.includes('schema_incompatible') || msg.includes('migration failed')
}

function buildSchemaMigrationFailureMessage(rawError: string): string {
  return (
    `DATABASE_SCHEMA_MIGRATION_FAILED: ${rawError}. ` +
    'Existing data has not been deleted. Export the database before resetting, then refresh to retry.'
  )
}

function buildResetRequiresTabClosureMessage(rawError: string): string {
  return `${RESET_REQUIRES_TAB_CLOSURE}: ${rawError}. Please close other tabs/windows for this app and retry.`
}

/**
 * Get the current storage mode
 */
export function getStorageMode(): StorageMode {
  return currentStorageMode
}

//=============================================================================
// Initialization
//=============================================================================

/**
 * Initialize application storage
 *
 * 1. Checks if OPFS VFS is available
 * 2. Initializes SQLite database with OPFS VFS or falls back to in-memory
 *
 * Note: With @sqlite.org/sqlite-wasm OpfsDb, all changes are
 * automatically persisted to OPFS - no manual save needed.
 */
export async function initStorage(options: InitStorageOptions = {}): Promise<InitStorageResult> {
  // StrictMode guard: return existing promise if already initializing
  if (storageInitPromise !== undefined) {
    return storageInitPromise
  }

  const { onProgress, allowFallback = false } = options
  const resetMarker = getStorageResetMarker()
  const initAfterReset = !!resetMarker

  onProgress?.({ step: 'init', total: 1, current: 0, details: 'Initializing SQLite...' })

  // Default to OPFS mode - worker will confirm or fallback
  currentStorageMode = 'sqlite-opfs'

  storageInitPromise = (async () => {
    try {
      // Request persistent storage as early as possible — before any OPFS
      // writes happen. Without persistent grant, browsers may evict OPFS
      // data under storage pressure, which is the most common cause of
      // "refresh and all data is gone" reports.
      // This is best-effort: Chromium may grant even without user interaction
      // for installed PWAs / high-engagement sites; Firefox requires gesture.
      try {
        if ('storage' in navigator && 'persist' in navigator.storage) {
          const persisted = await navigator.storage.persist()
          console.log(
            `[Storage] navigator.storage.persist() → ${persisted ? 'GRANTED ✅' : 'DENIED ❌ (will retry on user interaction)'}`
          )
        }
      } catch (persistError) {
        // Don't let persist() failure abort initialization.
        console.warn('[Storage] persist() request failed (non-fatal):', persistError)
      }

      // Initialize SQLite (worker will determine actual OPFS availability)
      await initSQLiteDB(onProgress)
      await getSQLiteDB().queryFirst('SELECT 1')

      // Get actual mode from SQLite worker after initialization
      const actualMode = getSQLiteDB().getMode()
      if (actualMode === 'memory') {
        currentStorageMode = 'sqlite-memory'
      } else if (actualMode === 'opfs') {
        currentStorageMode = 'sqlite-opfs'
      }
      // If actualMode is null (not initialized yet), keep default 'sqlite-opfs'

      onProgress?.({
        step: 'complete',
        total: 1,
        current: 1,
        details: `Storage ready (${currentStorageMode})`,
      })

      if (initAfterReset) {
        clearStorageResetMarker()
        console.log('[Storage] Cleared storage reset marker after healthy initialization')
      }

      return { success: true, mode: currentStorageMode }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      const inaccessibleAfterReset = initAfterReset && isDatabaseInaccessibleError(errorMsg)

      if (inaccessibleAfterReset) {
        const actionableError = buildPostResetInaccessibleMessage(errorMsg)
        onProgress?.({
          step: 'error',
          total: 1,
          current: 0,
          details: actionableError,
        })
        storageInitPromise = undefined
        return {
          success: false,
          mode: currentStorageMode,
          error: actionableError,
        }
      }

      if (isDatabaseInaccessibleError(errorMsg)) {
        const actionableError = buildDatabaseInaccessibleMessage(errorMsg)
        onProgress?.({
          step: 'error',
          total: 1,
          current: 0,
          details: actionableError,
        })
        storageInitPromise = undefined
        return {
          success: false,
          mode: currentStorageMode,
          error: actionableError,
        }
      }

      if (isSchemaMigrationError(errorMsg)) {
        const actionableError = buildSchemaMigrationFailureMessage(errorMsg)
        onProgress?.({
          step: 'error',
          total: 1,
          current: 0,
          details: actionableError,
        })
        storageInitPromise = undefined
        return {
          success: false,
          mode: currentStorageMode,
          error: actionableError,
        }
      }

      // SQLite 是唯一数据源，失败时永远返回 success: false。
      // 保留 allowFallback 只是为了让 mode 字段反映"假如回退会走哪条路"，
      // 供诊断 UI 使用，但不会再把失败假装成成功。
      if (allowFallback) {
        currentStorageMode = 'indexeddb-fallback'
        console.warn(
          '[Storage] SQLite initialization failed. allowFallback=true 仅影响 mode 字段，success 仍为 false。',
          errorMsg
        )
      } else {
        currentStorageMode = 'sqlite-opfs'
      }

      onProgress?.({
        step: 'error',
        total: 1,
        current: 0,
        details: 'Initialization failed: ' + errorMsg,
      })
      storageInitPromise = undefined // Allow retry on failure
      return {
        success: false,
        mode: currentStorageMode,
        error: errorMsg,
      }
    }
  })()

  return storageInitPromise
}

export const __test__ = {
  resetForTests() {
    currentStorageMode = 'sqlite-opfs'
    storageInitPromise = undefined
  },
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function isNotFoundError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'NotFoundError'
  }
  const message = toErrorMessage(error).toLowerCase()
  return message.includes('not found') || message.includes('could not be found')
}

function isOpfsLockError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === 'NoModificationAllowedError'
  }
  const message = toErrorMessage(error).toLowerCase()
  return (
    message.includes('modifications are not allowed') ||
    message.includes('nomodificationallowederror') ||
    message.includes('locked')
  )
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, ms))
}

function isSQLiteResetRetryableError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase()
  return (
    isDatabaseInaccessibleError(message) ||
    message.includes('locked') ||
    message.includes('busy') ||
    message.includes('cantopen') ||
    message.includes('no modification allowed') ||
    message.includes('modifications are not allowed') ||
    message.includes('nomodificationallowederror')
  )
}

async function clearSQLiteTablesWithRetry(): Promise<void> {
  const preservedTables = ['api_keys', 'encryption_metadata']
  const maxAttempts = 3
  let lastError: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Remove legacy SAH pool before table clear. Otherwise an empty DB can be
      // immediately rehydrated by legacy migration during worker re-init.
      await clearLegacySahPoolFromOPFSRoot()
      await clearAllSQLiteTables({
        preserveTables: preservedTables,
        allowOpfsFileResetFallback: false,
      })
      return
    } catch (error) {
      if (!isSQLiteResetRetryableError(error)) {
        throw error
      }
      lastError = error

      if (attempt === maxAttempts) {
        break
      }

      const delayMs = attempt * 120
      console.warn(
        `[Storage] SQLite clear failed with retryable error (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms:`,
        error
      )
      try {
        await getSQLiteDB().close()
      } catch {
        // best-effort reset before retry
      }
      await sleep(delayMs)
    }
  }

  if (lastError instanceof Error) {
    throw lastError
  }
  throw new Error('Failed to clear SQLite tables after retries')
}

async function removeProjectsDirectoryWithRetry(opfsRoot: FileSystemDirectoryHandle): Promise<void> {
  const maxAttempts = 3
  let lastLockError: unknown = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await opfsRoot.removeEntry('projects', { recursive: true })
      return
    } catch (error) {
      if (isNotFoundError(error)) {
        return
      }
      if (!isOpfsLockError(error)) {
        throw error
      }

      lastLockError = error
      if (attempt === maxAttempts) {
        break
      }

      const delayMs = attempt * 100
      console.warn(
        `[Storage] OPFS projects/ directory appears locked (attempt ${attempt}/${maxAttempts}), retrying in ${delayMs}ms`
      )
      await sleep(delayMs)
    }
  }

  throw new Error(
    `OPFS projects/ directory is locked by another context: ${toErrorMessage(lastLockError)}`
  )
}

/**
 * Clear SQLite data and remove OPFS projects/ directory without page reload.
 * Keeps encrypted API keys and encryption metadata.
 * Recreates an empty projects/ directory after cleanup.
 */
export async function clearSQLiteAndProjectsDirectory(): Promise<void> {
  const { token } = beginReset()
  setStorageResetMarker(token)

  try {
    const errors: string[] = []

    try {
      await clearSQLiteTablesWithRetry()
    } catch (error) {
      const baseMessage = `Failed to clear SQLite tables: ${toErrorMessage(error)}`
      if (isDatabaseInaccessibleError(baseMessage)) {
        errors.push(buildResetRequiresTabClosureMessage(baseMessage))
      } else {
        errors.push(baseMessage)
      }
    }

    const { resetWorkspaceManager } = await import('@/opfs')
    resetWorkspaceManager()

    const opfsRoot = await navigator.storage.getDirectory()
    try {
      await removeProjectsDirectoryWithRetry(opfsRoot)
    } catch (error) {
      if (isNotFoundError(error)) {
        // no-op
      } else if (isOpfsLockError(error)) {
        errors.push(
          buildResetRequiresTabClosureMessage(
            `Failed to clear OPFS projects/ directory: ${toErrorMessage(error)}`
          )
        )
      } else {
        errors.push(`Failed to clear OPFS projects/ directory: ${toErrorMessage(error)}`)
      }
    }

    try {
      await opfsRoot.getDirectoryHandle('projects', { create: true })
    } catch (error) {
      errors.push(`Failed to recreate OPFS projects/ directory: ${toErrorMessage(error)}`)
    }

    resetWorkspaceManager()

    if (errors.length > 0) {
      throw new Error(errors.join(' | '))
    }
  } finally {
    clearStorageResetMarker()
    endReset(token)
  }
}

/**
 * Set up auto-save on page unload
 *
 * Note: With @sqlite.org/sqlite-wasm OpfsDb, all writes are automatically
 * persisted to OPFS.
 */
export function setupAutoSave(): void {
  console.log('[Storage] Auto-save not needed - OpfsDb handles persistence automatically')
}

/**
 * Check storage status
 */
export interface StorageStatus {
  initialized: boolean
  conversationCount: number
  skillCount: number
  pluginCount: number
}

export async function getStorageStatus(): Promise<StorageStatus> {
  try {
    const db = getSQLiteDB()

    const conversationCount =
      (await db.queryFirst<{ count: number }>('SELECT COUNT(*) as count FROM conversations'))
        ?.count || 0

    const skillCount =
      (await db.queryFirst<{ count: number }>('SELECT COUNT(*) as count FROM skills'))?.count || 0

    const pluginCount =
      (await db.queryFirst<{ count: number }>('SELECT COUNT(*) as count FROM plugins'))?.count || 0

    return {
      initialized: true,
      conversationCount,
      skillCount,
      pluginCount,
    }
  } catch {
    return {
      initialized: false,
      conversationCount: 0,
      skillCount: 0,
      pluginCount: 0,
    }
  }
}

/**
 * Clear all storage (for testing/reset)
 */
export async function clearAllStorage(): Promise<void> {
  try {
    const db = getSQLiteDB()

    await db.execute('DELETE FROM conversations')
    await db.execute('DELETE FROM skills')
    await db.execute('DELETE FROM plugins')
    await db.execute('DELETE FROM api_keys')
    await db.execute('DELETE FROM workspaces')
    await db.execute('DELETE FROM file_metadata')
    await db.execute('DELETE FROM pending_changes')
    await db.execute('DELETE FROM undo_records')

    console.log('[Storage] All data cleared')
  } catch (error) {
    console.error('[Storage] Failed to clear storage:', error)
    throw error
  }
}

/**
 * Export storage to JSON (for backup)
 */
export async function exportStorage(): Promise<{
  conversations: unknown[]
  messages: unknown[]
  skills: unknown[]
  plugins: unknown[]
  workspaces: unknown[]
}> {
  const db = getSQLiteDB()

  const [conversations, messages, skills, plugins, workspaces] = await Promise.all([
    db.queryAll('SELECT * FROM conversations'),
    db.queryAll('SELECT * FROM messages'),
    db.queryAll('SELECT * FROM skills'),
    db.queryAll('SELECT * FROM plugins'),
    db.queryAll('SELECT * FROM workspaces'),
  ])

  return {
    conversations,
    messages,
    skills,
    plugins,
    workspaces,
  }
}

/**
 * Import storage from JSON (for restore)
 */
export async function importStorage(data: {
  conversations?: unknown[]
  messages?: unknown[]
  skills?: unknown[]
  plugins?: unknown[]
  workspaces?: unknown[]
}): Promise<void> {
  const db = getSQLiteDB()

  // Import in a transaction so callers never observe a partial restore.
  await db.transaction(async (tx) => {
    if (data.conversations) {
      for (const row of data.conversations) {
        const conv = row as any
        // kind travels with the backup; older exports without the column
        // default to 'project' so restored standalone chats stay standalone.
        const convKind = conv.kind === 'direct' ? 'direct' : 'project'
        await tx.execute(
          'INSERT OR REPLACE INTO conversations (id, title, title_mode, context_usage_json, kind, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
          [
            conv.id,
            conv.title,
            conv.title_mode || 'manual',
            conv.context_usage_json || null,
            convKind,
            conv.created_at,
            conv.updated_at,
          ]
        )
        // Split messages from JSON blob into independent rows
        if (conv.messages_json) {
          try {
            const messages = JSON.parse(conv.messages_json)
            if (Array.isArray(messages)) {
              for (let i = 0; i < messages.length; i++) {
                const msg = messages[i]
                if (!msg || !msg.id) continue
                const contentJson = JSON.stringify(msg.content ?? null)
                const meta: Record<string, unknown> = {}
                let hasMeta = false
                const metaFields = ['kind', 'reasoning', 'toolCalls', 'toolCallId', 'name', 'usage', 'assets'] as const
                for (const field of metaFields) {
                  if (msg[field] !== undefined) { meta[field] = msg[field]; hasMeta = true }
                }
                await tx.execute(
                  'INSERT OR IGNORE INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
                  [msg.id, conv.id, msg.role, contentJson, hasMeta ? JSON.stringify(meta) : null, msg.timestamp, i, msg.timestamp || Date.now()]
                )
              }
            }
          } catch { /* skip malformed messages */ }
        }
      }
    }

    if (data.messages) {
      for (const row of data.messages) {
        const msg = row as any
        await tx.execute(
          'INSERT OR IGNORE INTO messages (id, conversation_id, role, content_json, meta_json, timestamp, seq, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
          [
            msg.id,
            msg.conversation_id || msg.conversationId,
            msg.role,
            msg.content_json || msg.contentJson || 'null',
            msg.meta_json || msg.metaJson || null,
            msg.timestamp,
            msg.seq,
            msg.created_at || msg.createdAt || Date.now(),
          ]
        )
      }
    }

    if (data.skills) {
      for (const row of data.skills) {
        const skill = row as any
        await tx.execute(
          `INSERT OR REPLACE INTO skills
           (id, name, version, description, author, category, tags, source, triggers,
            instruction, examples, templates, raw_content, enabled, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
          [
            skill.id,
            skill.name,
            skill.version,
            skill.description,
            skill.author,
            skill.category,
            skill.tags,
            skill.source,
            skill.triggers,
            skill.instruction,
            skill.examples,
            skill.templates,
            skill.raw_content,
            skill.enabled,
            skill.created_at,
            skill.updated_at,
          ]
        )
      }
    }

    if (data.plugins) {
      for (const row of data.plugins) {
        const plugin = row as any
        await tx.execute(
          `INSERT OR REPLACE INTO plugins
           (id, name, version, api_version, description, author, capabilities_json,
            resource_limits_json, state, wasm_bytes, loaded_at, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
          [
            plugin.id,
            plugin.name,
            plugin.version,
            plugin.api_version,
            plugin.description,
            plugin.author,
            plugin.capabilities_json,
            plugin.resource_limits_json,
            plugin.state,
            plugin.wasm_bytes,
            plugin.loaded_at,
            plugin.created_at,
          ]
        )
      }
    }

    if (data.workspaces) {
      for (const row of data.workspaces) {
        const workspace = row as any
        const projectId = workspace.project_id || workspace.projectId
        if (!projectId) {
          throw new Error(`Workspace ${workspace.id || '(unknown)'} missing required project_id`)
        }
        await tx.execute(
          `INSERT OR REPLACE INTO workspaces
           (id, project_id, root_directory, name, status, cache_size, undo_count,
            modified_files, created_at, last_accessed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
          [
            workspace.id,
            projectId,
            workspace.root_directory || workspace.rootDirectory,
            workspace.name,
            workspace.status,
            workspace.cache_size || workspace.cacheSize || 0,
            workspace.undo_count || workspace.undoCount || 0,
            workspace.modified_files || workspace.modifiedFiles || 0,
            workspace.created_at || workspace.createdAt || Date.now(),
            workspace.last_accessed_at || workspace.lastAccessedAt || Date.now(),
          ]
        )
      }
    }

  })
  console.log('[Storage] Import complete')
}
