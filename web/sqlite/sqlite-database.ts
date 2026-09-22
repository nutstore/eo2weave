/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * SQLite Database Manager
 *
 * Unified storage using official SQLite WASM (@sqlite.org/sqlite-wasm) for:
 * - Conversations (chat history)
 * - Skills (skill definitions)
 * - API Keys (encrypted)
 * - Sessions (OPFS workspace metadata)
 *
 * Uses native OPFS VFS for automatic persistence - no manual serialization needed.
 * Runs in a Worker thread because OPFS VFS requires Atomics.wait().
 *
 * @see https://sqlite.org/wasm/doc/trunk/index.md
 * @see https://sqlite.org/wasm/doc/trunk/persistence.md
 * @see https://github.com/sqlite/sqlite-wasm
 */

import type { WorkerRequest, WorkerResponse } from './sqlite-worker'

//=============================================================================
// Constants
//=============================================================================

/**
 * OPFS filename (no leading slash) for the unified SQLite database.
 * `sqlite-worker.ts` opens this same file via the SQLite VFS path
 * `/bfosa-unified.sqlite` — keep both in sync when renaming.
 */
export const SQLITE_DB_FILENAME = 'bfosa-unified.sqlite'

//=============================================================================
// Types
//=============================================================================

export interface ConversationRow {
  id: string
  title: string
  title_mode?: string
  context_usage_json?: string | null
  compressed_context_summary?: string | null
  compressed_context_cutoff_ts?: number | null
  flow_instance_json?: string | null
  created_at: number
  updated_at: number
}

export interface SkillRow {
  id: string
  name: string
  version: string
  description: string | null
  author: string | null
  category: string
  tags: string // JSON array
  source: string
  triggers: string // JSON array
  instruction: string | null
  examples: string | null // JSON array
  templates: string | null // JSON array
  raw_content: string | null
  enabled: number // BOOLEAN (0 or 1)
  created_at: number
  updated_at: number
}

export interface ApiKeyRow {
  provider: string
  key_name: string
  iv: Uint8Array // BLOB stored as Uint8Array
  ciphertext: Uint8Array // BLOB stored as Uint8Array
  created_at: number
  updated_at: number
}

export interface WorkspaceRow {
  id: string
  project_id: string
  root_directory: string
  name: string
  status: 'active' | 'archived'
  cache_size: number
  undo_count: number
  modified_files: number
  created_at: number
  last_accessed_at: number
}

export interface FileMetadataRow {
  id: string
  workspace_id: string
  path: string
  mtime: number
  size: number
  content_type: 'text' | 'binary'
  hash: string | null
  created_at: number
  updated_at: number
}

export interface PendingChangeRow {
  id: string
  workspace_id: string
  path: string
  type: 'create' | 'modify' | 'delete'
  fs_mtime: number
  agent_message_id: string | null
  timestamp: number
}

export interface SQLiteTransaction {
  queryAll<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  queryFirst<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>
  execute(sql: string, params?: unknown[]): Promise<void>
}

//=============================================================================
// SQLite Worker Client
//=============================================================================

class SQLiteWorkerClient {
  private worker: Worker | null = null
  private initialized = false
  private initPromise: Promise<void> | null = null
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      request?: WorkerRequest // Store original request for retry
    }
  >()
  private requestId = 0
  private initializing = false // Guard for StrictMode double init
  private dbMode: 'opfs' | 'memory' | null = null
  private recovering = false // Recovery in progress flag
  private recoveryCount = 0 // Track number of recovery attempts for diagnostics
  private lastRecoveryTime = 0 // Track when last recovery occurred
  private readonly RECOVERY_COOLDOWN = 5000 // Minimum 5 seconds between recoveries
  private readonly MAX_RECOVERIES_PER_HOUR = 5 // Prevent excessive recovery attempts
  private transactionTail: Promise<void> = Promise.resolve()
  private onMigrationProgress?: (progress: {
    step: string
    details: string
    current: number
    total: number
  }) => void

  private resetClientState(reason?: Error): void {
    const resetReason = reason || new Error('SQLite worker state reset')
    for (const pending of this.pendingRequests.values()) {
      try {
        pending.reject(resetReason)
      } catch {
        // Ignore individual rejection handler errors during teardown.
      }
    }
    this.pendingRequests.clear()
    this.initialized = false
    this.initPromise = null
    this.initializing = false
    this.dbMode = null
    this.recovering = false
    this.transactionTail = Promise.resolve()
  }

  private terminateWorker(): void {
    if (!this.worker) return
    try {
      this.worker.terminate()
    } catch (error) {
      console.warn('[SQLite] Failed to terminate worker cleanly:', error)
    } finally {
      this.worker = null
    }
  }

  private invalidateWorker(reason: Error): void {
    // A timed-out message can still complete in the worker later. Terminating it
    // is the only reliable way to prevent a late BEGIN/COMMIT from corrupting
    // the transaction state of a replacement connection.
    this.terminateWorker()
    this.resetClientState(reason)
  }

  isReady(): boolean {
    return this.initialized && this.worker !== null
  }

  async initialize(
    onMigrationProgress?: (progress: {
      step: string
      details: string
      current: number
      total: number
    }) => void
  ): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise
    if (this.initializing) {
      // Wait for ongoing initialization
      while (this.initializing) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return this.initPromise!
    }

    // Set guard immediately to prevent race conditions
    this.initializing = true

    this.initPromise = (async () => {
      try {
        // Wait for crossOriginIsolated to be true before creating worker
        if (!self.crossOriginIsolated) {
          const maxWait = 5000 // 5 seconds max
          const startTime = Date.now()
          while (!self.crossOriginIsolated && Date.now() - startTime < maxWait) {
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          if (!self.crossOriginIsolated) {
            console.warn(
              '[SQLite] crossOriginIsolated is still false after waiting. OPFS VFS may not work.'
            )
          }
        }

        // Use the separate worker file instead of inline blob worker
        // Blob workers cannot resolve bare import specifiers like @sqlite.org/sqlite-wasm
        this.worker = new Worker(new URL('./sqlite-worker.ts', import.meta.url), {
          type: 'module',
        })

        // Set up message handler
        this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
          const response = e.data

          // Handle migration progress messages (not tied to a specific request)
          if (response.type === 'migrationProgress') {
            const progress = response as {
              type: 'migrationProgress'
              step: string
              details: string
              current: number
              total: number
            }
            this.onMigrationProgress?.(progress)
            return
          }

          const pending = this.pendingRequests.get(response.id)

          if (pending) {
            if (response.error) {
              // Check if this is a recoverable database error
              const isGetSyncHandleError = response.error.includes('GetSyncHandleError')
              const isCantOpen = response.error.includes('CANTOPEN')

              // Do not recursively recover a failed recovery request. Its caller
              // needs the error so it can release the original request cleanly.
              const canRecover = response.type !== 'recover' && response.type !== 'init'
              if (canRecover && (isGetSyncHandleError || isCantOpen)) {
                const errorType = isGetSyncHandleError
                  ? 'GetSyncHandleError (stale handle)'
                  : 'CANTOPEN'
                console.warn(`[SQLite] Database error: ${errorType}. Attempting recovery...`)

                // Try to recover and retry the request
                // Note: handleRecovery now tries reconnection first before deleting
                this.handleRecovery()
                  .then(() => {
                    // Retry the original request after recovery
                    this.retryRequest(response.id)
                  })
                  .catch((recoveryError) => {
                    console.error('[SQLite] Recovery failed:', recoveryError)
                    if (this.pendingRequests.delete(response.id)) {
                      pending.reject(new Error(response.error))
                    }
                  })
                return
              }
              this.pendingRequests.delete(response.id)
              pending.reject(new Error(response.error))
            } else {
              this.pendingRequests.delete(response.id)
              switch (response.type) {
                case 'init':
                  // Init response has success property and mode
                  this.dbMode = response.mode
                  pending.resolve(undefined)
                  break
                case 'queryAll':
                  pending.resolve((response as { type: 'queryAll'; rows: unknown[] }).rows)
                  break
                case 'queryFirst':
                  pending.resolve((response as { type: 'queryFirst'; row: unknown | null }).row)
                  break
                case 'execute':
                case 'beginTransaction':
                case 'commit':
                case 'rollback':
                case 'close':
                case 'recover':
                  pending.resolve(undefined)
                  break
                case 'getMode':
                  pending.resolve(response.mode)
                  break
                default:
                  // Unknown response type - resolve anyway
                  pending.resolve(undefined)
              }
            }
          }
        }

        // Enhanced error handler with more details
        this.worker.onerror = (error) => {
          const errorMessage = error.message || 'Unknown worker error'
          console.error('[SQLite] Worker error:', {
            message: errorMessage,
            filename: error.filename,
            lineno: error.lineno,
            colno: error.colno,
            error: error.error,
          })
          // Prevent the error from propagating to the global error handler
          error.preventDefault()
        }

        // Store migration progress callback
        this.onMigrationProgress = onMigrationProgress

        // Initialize the worker with extended timeout
        // Note: schemaSQL is no longer passed - migration system imports it directly
        await this.sendRequest<unknown>(
          { type: 'init', reportProgress: !!onMigrationProgress },
          120000
        ) // 2 minutes

        this.initialized = true
        this.initializing = false
      } catch (error) {
        console.error('[SQLite] Failed to initialize worker:', error)
        const reason = error instanceof Error ? error : new Error(String(error))
        this.terminateWorker()
        this.resetClientState(reason)
        throw error
      }
    })()

    return this.initPromise
  }

  private sendRequest<T>(request: WorkerRequest, timeout: number = 30000): Promise<T> {
    if (!this.worker) {
      return Promise.reject(new Error('Worker not initialized'))
    }

    const id = request.id ?? `req-${++this.requestId}`

    return new Promise<T>((resolve, reject) => {
      // Store original request for potential retry after recovery
      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        request: { ...request, id },
      })
      this.worker!.postMessage({ ...request, id })

      // Use the provided timeout or default to 30 seconds
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          const reason = new Error(`Request timeout: ${request.type}`)
          console.error(`[SQLite] ${reason.message}; terminating stale worker`)
          this.invalidateWorker(reason)
        }
      }, timeout)
    })
  }

  private nextRequestId(prefix: string): string {
    this.requestId += 1
    return `${prefix}-${this.requestId}`
  }

  private sendQueryAll<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.sendRequest<T[]>({
      type: 'queryAll',
      sql,
      params,
      id: this.nextRequestId('queryAll'),
    })
  }

  private sendQueryFirst<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    return this.sendRequest<T | null>({
      type: 'queryFirst',
      sql,
      params,
      id: this.nextRequestId('queryFirst'),
    })
  }

  private sendExecute(sql: string, params: unknown[] = [], timeout?: number): Promise<void> {
    return this.sendRequest<void>(
      {
        type: 'execute',
        sql,
        params,
        id: this.nextRequestId('execute'),
      },
      timeout
    )
  }

  private async acquireTransactionSlot(): Promise<() => void> {
    const previous = this.transactionTail.catch(() => undefined)
    let release!: () => void
    this.transactionTail = previous.then(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    await previous
    return release
  }

  private async runOutsideTransaction<T>(operation: () => Promise<T>): Promise<T> {
    let currentTail: Promise<void>
    do {
      currentTail = this.transactionTail
      await currentTail.catch(() => undefined)
    } while (currentTail !== this.transactionTail)
    return operation()
  }

  queryAll<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.runOutsideTransaction(() => this.sendQueryAll<T>(sql, params))
  }

  queryFirst<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    return this.runOutsideTransaction(() => this.sendQueryFirst<T>(sql, params))
  }

  execute(sql: string, params: unknown[] = [], timeout?: number): Promise<void> {
    return this.runOutsideTransaction(() => this.sendExecute(sql, params, timeout))
  }

  async transaction<T>(callback: (tx: SQLiteTransaction) => Promise<T>): Promise<T> {
    const release = await this.acquireTransactionSlot()
    let began = false
    try {
      await this.sendRequest<void>({
        type: 'beginTransaction',
        id: this.nextRequestId('txn-begin'),
      })
      began = true
      const tx: SQLiteTransaction = {
        queryAll: <U = unknown>(sql: string, params: unknown[] = []) => this.sendQueryAll<U>(sql, params),
        queryFirst: <U = unknown>(sql: string, params: unknown[] = []) => this.sendQueryFirst<U>(sql, params),
        execute: (sql: string, params: unknown[] = []) => this.sendExecute(sql, params),
      }
      const result = await callback(tx)
      await this.sendRequest<void>({ type: 'commit', id: this.nextRequestId('txn-commit') })
      return result
    } catch (error) {
      if (began) {
        try {
          await this.sendRequest<void>({ type: 'rollback', id: this.nextRequestId('txn-rollback') })
        } catch (rollbackError) {
          console.warn('[SQLite] Rollback failed after transaction error:', rollbackError)
        }
      }
      throw error
    } finally {
      release()
    }
  }

  async close(): Promise<void> {
    if (this.worker) {
      try {
        await this.sendRequest<void>({ type: 'close', id: this.nextRequestId('close') })
      } catch (error) {
        // Worker may be unresponsive after init/query failures; terminate anyway.
        console.warn('[SQLite] close request failed, forcing worker termination:', error)
      }
      this.terminateWorker()
      this.resetClientState(new Error('SQLite worker closed'))
      console.log('[SQLite] Worker closed')
    }
  }

  dispose(): void {
    this.invalidateWorker(new Error('SQLite worker disposed'))
  }

  /** Get the current database mode (opfs or memory) */
  getMode(): 'opfs' | 'memory' | null {
    return this.dbMode
  }

  /**
   * Handle database recovery when CANTOPEN errors occur
   *
   * Recovery strategy with cooldown and limits:
   * 1. Check cooldown period to prevent rapid successive recoveries
   * 2. Check recovery count to detect chronic issues
   * 3. Send recover request to worker (which tries reconnection first)
   */
  private async handleRecovery(): Promise<void> {
    if (this.recovering) {
      // Already recovering, wait for it to complete
      while (this.recovering) {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return
    }

    // Check cooldown period
    const now = Date.now()
    const timeSinceLastRecovery = now - this.lastRecoveryTime
    if (timeSinceLastRecovery < this.RECOVERY_COOLDOWN) {
      const waitTime = this.RECOVERY_COOLDOWN - timeSinceLastRecovery
      console.warn(`[SQLite] Recovery cooldown active, waiting ${waitTime}ms...`)
      await new Promise((resolve) => setTimeout(resolve, waitTime))
    }

    // Check recovery count - prevent excessive recovery attempts
    const oneHourAgo = now - 3600000
    if (this.lastRecoveryTime > oneHourAgo && this.recoveryCount >= this.MAX_RECOVERIES_PER_HOUR) {
      console.error(
        `[SQLite] Too many recovery attempts (${this.recoveryCount} in the last hour). ` +
          'This may indicate a chronic issue. Please refresh the page or check browser console.'
      )
      throw new Error('Excessive recovery attempts detected. Please refresh the page.')
    }

    this.recovering = true
    this.recoveryCount++
    this.lastRecoveryTime = Date.now()

    console.log(`[SQLite] Starting database recovery (attempt #${this.recoveryCount})...`)

    try {
      // Send recover request to worker
      // Note: Worker now tries reconnection first before deleting database
      // The migration system handles schema initialization
      await this.sendRequest<void>({
        type: 'recover',
        id: this.nextRequestId('recover'),
      })
      console.log('[SQLite] Database recovery completed')
    } catch (error) {
      console.error('[SQLite] Database recovery failed:', error)
      throw error
    } finally {
      this.recovering = false
    }
  }

  /** Get recovery statistics for diagnostics */
  getRecoveryStats(): {
    count: number
    lastRecoveryTime: number
    lastRecoveryDate: Date | null
    cooldownRemaining: number
  } {
    const now = Date.now()
    const cooldownRemaining = Math.max(0, this.RECOVERY_COOLDOWN - (now - this.lastRecoveryTime))
    return {
      count: this.recoveryCount,
      lastRecoveryTime: this.lastRecoveryTime,
      lastRecoveryDate: this.lastRecoveryTime > 0 ? new Date(this.lastRecoveryTime) : null,
      cooldownRemaining,
    }
  }

  /**
   * Retry a request after recovery
   */
  private retryRequest(id: string): void {
    const pending = this.pendingRequests.get(id)
    if (!pending || !pending.request) return

    // Resend the original request
    this.worker!.postMessage({ ...pending.request, id })
  }
}

//=============================================================================
// Singleton Database Manager
//=============================================================================

class SQLiteDatabaseManager {
  private static instance: SQLiteDatabaseManager | null = null
  private workerClient: SQLiteWorkerClient | null = null
  private initialized = false
  private initPromise: Promise<void> | null = null
  private initializing = false // Guard for StrictMode double init
  /**
   * Retry tracking to prevent worker-spawn storms after transient failures
   * (e.g. OPFS sync-handle contention when multiple tabs init simultaneously).
   *
   * Without backoff, every component that lazily calls initSQLiteDB() (settings
   * store, project store, conversation store, ...) creates its own worker on
   * the heels of the previous failure. The old worker's OPFS handle hasn't been
   * released yet, so the new worker fails too — a cascade.
   */
  private initRetryCount = 0
  private readonly MAX_INIT_RETRIES = 2

  private constructor() {}

  static getInstance(): SQLiteDatabaseManager {
    if (!SQLiteDatabaseManager.instance) {
      SQLiteDatabaseManager.instance = new SQLiteDatabaseManager()
    }
    return SQLiteDatabaseManager.instance
  }

  async initialize(
    onMigrationProgress?: (progress: {
      step: string
      details: string
      current: number
      total: number
    }) => void
  ): Promise<void> {
    if (this.initialized) return
    if (this.initPromise) return this.initPromise
    if (this.initializing) {
      // Wait for ongoing initialization
      while (this.initializing) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return this.initPromise!
    }

    this.initializing = true

    this.initPromise = (async () => {
      try {
        if (!this.workerClient) {
          this.workerClient = new SQLiteWorkerClient()
        }
        await this.workerClient.initialize(onMigrationProgress)
        this.initialized = true
        this.initializing = false
        this.initRetryCount = 0 // Reset on success
      } catch (error) {
        console.error('[SQLite] Failed to initialize:', error)
        try {
          await this.workerClient?.close()
        } catch {
          // Ignore cleanup failures; we'll recreate worker on next init.
        }

        // CRITICAL: keep `initPromise`/`initializing` set across the backoff so
        // that callers arriving during the window join THIS in-flight promise
        // instead of bypassing the gate and spawning their own worker. Clear
        // state AFTER the backoff completes (or after max retries). Failing
        // to do this re-creates the exact cascade we're trying to prevent.
        if (this.initRetryCount < this.MAX_INIT_RETRIES) {
          this.initRetryCount++
          const backoff = Math.min(500 * Math.pow(2, this.initRetryCount - 1), 4000)
          console.warn(
            `[SQLite] Init failed (attempt ${this.initRetryCount}/${this.MAX_INIT_RETRIES}). ` +
              `Waiting ${backoff}ms before allowing retry...`
          )
          await new Promise((resolve) => setTimeout(resolve, backoff))
        } else {
          console.error(
            `[SQLite] Max init retries (${this.MAX_INIT_RETRIES}) exhausted. ` +
              'Deferring to caller for user-facing error handling.'
          )
          this.initRetryCount = 0 // Reset so user-triggered retries get a fresh budget
        }

        this.workerClient = null
        this.initPromise = null
        this.initializing = false

        throw error
      }
    })()

    return this.initPromise
  }

  private async getReadyWorkerClient(): Promise<SQLiteWorkerClient> {
    if (!this.workerClient) {
      throw new Error('Database not initialized')
    }
    if (this.initializing && this.initPromise) {
      await this.initPromise
    } else if (!this.workerClient.isReady()) {
      // A timed-out worker resets its own state. Reinitialize that same client
      // so an in-progress initialization cannot leave an orphaned OPFS handle.
      this.initialized = false
      this.initPromise = null
      await this.initialize()
    }
    if (!this.workerClient) throw new Error('Database not initialized')
    return this.workerClient
  }

  /**
   * Execute a query and return all rows
   */
  async queryAll<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
    return (await this.getReadyWorkerClient()).queryAll<T>(sql, params)
  }

  /**
   * Execute a query and return first row
   */
  async queryFirst<T = unknown>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (await this.getReadyWorkerClient()).queryFirst<T>(sql, params)
  }

  /**
   * Execute a statement (INSERT, UPDATE, DELETE)
   */
  async execute(sql: string, params: unknown[] = []): Promise<void> {
    return (await this.getReadyWorkerClient()).execute(sql, params)
  }

  /**
   * Execute a statement with a custom request timeout. Use for long-running
   * statements (e.g. VACUUM on a large database) that exceed the default
   * 30s worker request timeout — hitting that timeout hard-terminates the
   * worker mid-request.
   */
  async executeWithTimeout(sql: string, timeoutMs: number): Promise<void> {
    return (await this.getReadyWorkerClient()).execute(sql, [], timeoutMs)
  }

  /**
   * Execute multiple statements in a transaction
   */
  async transaction<T>(callback: (tx: SQLiteTransaction) => Promise<T>): Promise<T> {
    return (await this.getReadyWorkerClient()).transaction(callback)
  }

  /**
   * Close database
   */
  async close(): Promise<void> {
    if (this.workerClient) {
      await this.workerClient.close()
      this.workerClient = null
      this.initialized = false
      this.initPromise = null
    }
  }

  /** Synchronously release OPFS handles before a Vite HMR module replacement. */
  dispose(): void {
    this.workerClient?.dispose()
    this.workerClient = null
    this.initialized = false
    this.initPromise = null
    this.initializing = false
  }

  /**
   * Delete the OPFS database file and reset state
   * Call this to clear all data and start fresh
   */
  async deleteDatabase(): Promise<void> {
    await this.close()

    // Use the SQLite WASM OPFS API to delete the database
    try {
      const sqlite3 = await import('@sqlite.org/sqlite-wasm').then((m) => m.default())
      // @ts-ignore - opfs may not be in types
      if (sqlite3.opfs && sqlite3.opfs.deleteDatabase) {
        // @ts-ignore
        await sqlite3.opfs.deleteDatabase('/bfosa-unified.sqlite')
        console.log('[SQLite] Database deleted via OPFS API')
      }
    } catch (error) {
      console.warn('[SQLite] Error deleting database via OPFS API:', error)
    }

    // Also reset in-memory fallback
    this.initialized = false
    this.initPromise = null
  }

  /**
   * Get the current database mode (opfs or memory)
   */
  getMode(): 'opfs' | 'memory' | null {
    return this.workerClient?.getMode() ?? null
  }

  /**
   * Get recovery statistics for diagnostics
   * Useful for debugging database connection issues
   */
  getRecoveryStats(): {
    count: number
    lastRecoveryTime: number
    lastRecoveryDate: Date | null
    cooldownRemaining: number
  } | null {
    return this.workerClient?.getRecoveryStats() ?? null
  }
}

//=============================================================================
// Helper Functions
//=============================================================================

/**
 * Get the SQLite database manager instance
 */
export function getSQLiteDB(): SQLiteDatabaseManager {
  return SQLiteDatabaseManager.getInstance()
}

/**
 * Initialize SQLite database
 */
export async function initSQLiteDB(
  onMigrationProgress?: (progress: {
    step: string
    details: string
    current: number
    total: number
  }) => void
): Promise<void> {
  return getSQLiteDB().initialize(onMigrationProgress)
}

/**
 * Reset SQLite database - deletes all data and recreates schema
 * Call this from browser console to fix schema errors: window.__resetSQLiteDB()
 */
export async function resetSQLiteDB(): Promise<void> {
  console.log('[SQLite] Resetting database...')
  await getSQLiteDB().deleteDatabase()
  console.log('[SQLite] Database deleted. Reloading page to recreate...')
  window.location.reload()
}

/**
 * Export the OPFS database file as a downloadable Blob.
 *
 * This runs on the main thread and reads the file directly from OPFS, which means
 * it works even when the SQLite worker failed to initialize (the error case that
 * triggers this export UI). The user gets whatever bytes are on disk — a corrupted
 * file is still better than nothing right before a reset.
 *
 * Returns a `Blob` plus a suggested filename. The caller is responsible for
 * turning this into a download (via `URL.createObjectURL` + a temporary `<a>`).
 *
 * Throws if the file is missing (NotFoundError) or any other read failure. The
 * caller should surface the error message to the user.
 */
export async function exportSQLiteDB(): Promise<{ blob: Blob; filename: string }> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new Error('OPFS is not available in this environment')
  }

  const opfsRoot = await navigator.storage.getDirectory()
  const fileHandle = await opfsRoot.getFileHandle(SQLITE_DB_FILENAME, { create: false })
  const file = await fileHandle.getFile()

  // Use lastModified so the user can tell multiple exports apart in their Downloads
  const ts = new Date(file.lastModified || Date.now())
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19) // YYYY-MM-DD_HH-MM-SS
  const stem = SQLITE_DB_FILENAME.replace(/\.sqlite$/, '')
  const filename = `${stem}_${ts}.sqlite`

  console.log(
    `[SQLite] Exported database: ${file.size} bytes → ${filename}`
  )

  // file is already a Blob, just return it
  return { blob: file, filename }
}

/**
 * Export the OPFS database file and trigger a browser download.
 *
 * Wrapper around `exportSQLiteDB()` that handles the createObjectURL +
 * temporary `<a>` + revoke dance. Returns the filename on success so the
 * caller can show a success toast; throws on failure so the caller can
 * surface the error.
 */
export async function downloadSQLiteDBBackup(): Promise<string> {
  const { blob, filename } = await exportSQLiteDB()
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    // Append + click + remove is the most reliable cross-browser pattern
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Defer revoke so the download has time to start in all browsers
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
  return filename
}

function quoteSQLiteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQLite identifier: ${identifier}`)
  }
  return `"${identifier}"`
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

function isPoolLockError(error: unknown): boolean {
  const message = toErrorMessage(error).toLowerCase()
  return (
    message.includes(
      'an attempt was made to modify an object where modifications are not allowed'
    ) || message.includes('nomodificationallowederror')
  )
}

/**
 * Remove legacy SAH pool storage so it cannot rehydrate cleared databases.
 * Returns true when the entry is removed or already absent.
 */
export async function clearLegacySahPoolFromOPFSRoot(): Promise<boolean> {
  const opfsRoot = await navigator.storage.getDirectory()
  try {
    await opfsRoot.removeEntry('.bfosa-pool', { recursive: true })
    console.log('[SQLite] Removed legacy SAH pool entry: .bfosa-pool')
    return true
  } catch (error) {
    if (isNotFoundError(error)) {
      console.log('[SQLite] Legacy SAH pool entry already missing: .bfosa-pool')
      return true
    }
    if (isPoolLockError(error)) {
      throw new Error(
        `Legacy SAH pool entry ".bfosa-pool" is locked by another context: ${toErrorMessage(error)}`
      )
    }
    throw new Error(
      `Failed to remove legacy SAH pool entry ".bfosa-pool": ${toErrorMessage(error)}`
    )
  }
}

async function forceDeleteSQLiteFilesFromOPFSRoot(): Promise<void> {
  const opfsRoot = await navigator.storage.getDirectory()

  try {
    await opfsRoot.removeEntry('bfosa-unified.sqlite', { recursive: true })
    console.log('[SQLite] Removed OPFS database file directly: bfosa-unified.sqlite')
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw new Error(`Failed to remove "bfosa-unified.sqlite" directly: ${toErrorMessage(error)}`)
    }
    console.log('[SQLite] OPFS database file already missing: bfosa-unified.sqlite')
  }

  try {
    await opfsRoot.removeEntry('.bfosa-pool', { recursive: true })
    console.log('[SQLite] Removed OPFS pool entry directly: .bfosa-pool')
  } catch (error) {
    if (isNotFoundError(error)) {
      console.log('[SQLite] OPFS pool entry already missing: .bfosa-pool')
      return
    }
    if (isPoolLockError(error)) {
      console.warn(
        `[SQLite] Pool entry ".bfosa-pool" is currently locked by another context and cannot be removed: ${toErrorMessage(error)}`
      )
      return
    }
    throw new Error(`Failed to remove ".bfosa-pool" directly: ${toErrorMessage(error)}`)
  }
}

/**
 * Drop all user tables/views and rebuild schema without reloading the page.
 * Useful when schema drift blocks initialization but a full page refresh is undesired.
 *
 * Call from browser console: window.__clearAllSQLiteTables()
 */
export interface ClearAllSQLiteTablesOptions {
  preserveTables?: string[]
  allowOpfsFileResetFallback?: boolean
}

export async function clearAllSQLiteTables(
  options: ClearAllSQLiteTablesOptions = {}
): Promise<void> {
  const preserveTableSet = new Set(
    (options.preserveTables || []).map((name) => name.trim().toLowerCase()).filter(Boolean)
  )
  const allowOpfsFileResetFallback = options.allowOpfsFileResetFallback ?? true
  const manager = getSQLiteDB()
  try {
    await manager.initialize()

    const [tables, views] = await Promise.all([
      manager.queryAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      ),
      manager.queryAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type='view'"),
    ])

    const statements: string[] = ['PRAGMA foreign_keys = OFF']
    for (const view of views) {
      if (!view?.name) continue
      statements.push(`DROP VIEW IF EXISTS ${quoteSQLiteIdentifier(view.name)}`)
    }
    for (const table of tables) {
      if (!table?.name) continue
      if (preserveTableSet.has(table.name.toLowerCase())) continue
      statements.push(`DROP TABLE IF EXISTS ${quoteSQLiteIdentifier(table.name)}`)
    }
    statements.push('PRAGMA foreign_keys = ON')

    await manager.execute(`${statements.join(';\n')};`)
    await manager.close()
    await manager.initialize()
    console.log('[SQLite] Cleared all user tables and rebuilt schema without page reload')
    return
  } catch (error) {
    if (!allowOpfsFileResetFallback) {
      throw new Error(
        `clearAllSQLiteTables failed and OPFS file-reset fallback is disabled: ${toErrorMessage(error)}`
      )
    }
    console.warn(
      '[SQLite] clearAllSQLiteTables failed, falling back to direct OPFS file cleanup:',
      error
    )
  }

  await manager.close().catch(() => undefined)
  await forceDeleteSQLiteFilesFromOPFSRoot()
  await manager.initialize()
  console.log('[SQLite] Cleared SQLite via direct OPFS cleanup fallback')
}

/**
 * Get SQLite recovery statistics for diagnostics
 * Call this from browser console: window.__getSQLiteRecoveryStats()
 */
export function getSQLiteRecoveryStats(): {
  count: number
  lastRecoveryTime: number
  lastRecoveryDate: Date | null
  cooldownRemaining: number
} | null {
  return getSQLiteDB().getRecoveryStats()
}

// Make functions available globally for debugging
if (typeof window !== 'undefined') {
  // @ts-ignore
  window.__resetSQLiteDB = resetSQLiteDB
  // @ts-ignore
  window.__clearAllSQLiteTables = clearAllSQLiteTables
  // @ts-ignore
  window.__getSQLiteRecoveryStats = getSQLiteRecoveryStats
  // @ts-ignore
  window.__getSQLiteMode = () => getSQLiteDB().getMode()
  // @ts-ignore
  window.__checkSQLiteHealth = async () => {
    try {
      const db = getSQLiteDB()
      await db.queryFirst('SELECT 1')
      return { healthy: true, mode: db.getMode() }
    } catch (error) {
      return { healthy: false, error: (error as Error).message }
    }
  }
  // @ts-ignore
  window.__listSQLiteTables = async () => {
    try {
      const db = getSQLiteDB()
      const rows = await db.queryAll("SELECT name FROM sqlite_master WHERE type='table'")
      return rows.map((r: any) => r.name)
    } catch (error) {
      return `Error: ${(error as Error).message}`
    }
  }
  // @ts-ignore
  window.__checkDataIntegrity = async () => {
    try {
      const db = getSQLiteDB()

      // Get table counts
      const tables = await db.queryAll<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )

      const recordCounts: Record<string, number> = {}
      let totalRecords = 0

      for (const table of tables) {
        try {
          const result = await db.queryFirst<{ count: number }>(
            `SELECT COUNT(*) as count FROM ${table.name}`
          )
          const count = result?.count || 0
          recordCounts[table.name] = count
          totalRecords += count
        } catch {
          recordCounts[table.name] = -1 // Error querying this table
        }
      }

      return {
        healthy: totalRecords > 0,
        tableCount: tables.length,
        totalRecords,
        recordCounts,
        warning:
          totalRecords === 0
            ? 'Database schema exists but contains NO DATA! This may indicate data loss.'
            : undefined,
      }
    } catch (error) {
      return {
        healthy: false,
        error: (error as Error).message,
      }
    }
  }

  // SQL Logging control
  // @ts-ignore
  window.__enableSQLiteSQLLogging = (enabled = true) => {
    try {
      const db = getSQLiteDB()
      // @ts-ignore - access internal worker
      db.worker!.postMessage({ type: 'setSQLLogging', enabled })
      console.log(`[SQLite] SQL logging ${enabled ? 'ENABLED' : 'DISABLED'}`)
    } catch (error) {
      console.error('[SQLite] Failed to set SQL logging:', error)
    }
  }

  // @ts-ignore
  window.__queryPendingOps = async () => {
    try {
      const db = getSQLiteDB()
      const rows = await db.queryAll(
        `SELECT id, path, op_type, status, review_status, changeset_id FROM fs_ops ORDER BY updated_at DESC LIMIT 20`,
        []
      )
      console.table(rows)
      return rows
    } catch (error) {
      console.error('Error querying fs_ops:', error)
      return []
    }
  }

  // @ts-ignore
  window.__queryPendingCounts = async () => {
    try {
      const db = getSQLiteDB()
      const rows = await db.queryAll(
        `SELECT workspace_id, COUNT(*) as count, review_status
         FROM fs_ops
         WHERE status = 'pending'
         GROUP BY workspace_id, review_status`,
        []
      )
      console.table(rows)
      return rows
    } catch (error) {
      console.error('Error querying pending counts:', error)
      return []
    }
  }

  console.log(
    '[SQLite] Diagnostic functions available: window.__resetSQLiteDB(), window.__clearAllSQLiteTables(), window.__getSQLiteRecoveryStats(), window.__getSQLiteMode(), window.__checkSQLiteHealth(), window.__listSQLiteTables(), window.__checkDataIntegrity(), window.__enableSQLiteSQLLogging(), window.__queryPendingOps(), window.__queryPendingCounts()'
  )
}

/**
 * Parse JSON column safely
 */
export function parseJSON<T = unknown>(value: string | null, defaultValue: T): T {
  if (!value) return defaultValue
  try {
    return JSON.parse(value) as T
  } catch {
    return defaultValue
  }
}

/**
 * Serialize to JSON
 */
export function toJSON(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Boolean to integer
 */
export function boolToInt(value: boolean): number {
  return value ? 1 : 0
}

/**
 * Integer to boolean
 */
export function intToBool(value: number): boolean {
  return value !== 0
}

/**
 * Generate ID
 */
export function generateId(prefix: string = ''): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 9)
  return prefix ? `${prefix}_${timestamp}${random}` : `${timestamp}${random}`
}

export { SQLiteDatabaseManager }

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    SQLiteDatabaseManager.getInstance().dispose()
  })
}
