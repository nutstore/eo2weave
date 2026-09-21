/**
 * Backup Settings Repository - IndexedDB persistence for the
 * "backup to local directory" feature.
 *
 * Stores the File System Access directory handle (persisted so the user
 * grants permission once), a display name (handle.name — the browser never
 * exposes full paths), and the last successful backup timestamp.
 *
 * Deliberately separate from folder-access.repository.ts: that store holds
 * workspace folder handles (semantic: project roots); this one holds the
 * backup TARGET directory (semantic: where archives are written).
 */

const DB_NAME = 'bfosa-backup-settings'
const STORE_NAME = 'backupSettings'
const DB_VERSION = 1
const RECORD_ID = 'backup-dir'

export interface BackupSettingsRecord {
  id: string
  /** FileSystemDirectoryHandle (persisted in IndexedDB; structured-cloneable) */
  dirHandle: FileSystemDirectoryHandle | null
  /** handle.name at grant time — last path segment only (browser security model) */
  dirName: string | null
  /** Timestamp of the last SUCCESSFUL backup write; null until one succeeds */
  lastBackupAt: number | null
}

class BackupSettingsRepository {
  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null

  async initialize(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        reject(request.error)
      }

      request.onsuccess = () => {
        this.db = request.result
        resolve()
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        }
      }
    })

    return this.initPromise
  }

  /**
   * Load the backup settings record (handle + dirName + lastBackupAt).
   * Returns null when nothing has been persisted yet.
   */
  async load(): Promise<BackupSettingsRecord | null> {
    await this.initialize()
    const db = this.db!
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.get(RECORD_ID)
      request.onsuccess = () => {
        resolve((request.result as BackupSettingsRecord) ?? null)
      }
      request.onerror = () => reject(request.error)
    })
  }

  /**
   * Persist settings. Handles are structured-cloneable so they can be stored
   * directly; the record is written as a whole (single-key store).
   */
  async save(record: BackupSettingsRecord): Promise<void> {
    await this.initialize()
    const db = this.db!
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.put({ ...record, id: RECORD_ID })
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  /** Drop the record entirely (directory deleted / user cleared / logout). */
  async clear(): Promise<void> {
    await this.initialize()
    const db = this.db!
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.delete(RECORD_ID)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  /** Update ONLY the lastBackupAt timestamp, preserving handle/dirName. */
  async updateLastBackupAt(timestamp: number): Promise<void> {
    const existing = await this.load()
    await this.save({
      id: 'backup-dir',
      dirHandle: existing?.dirHandle ?? null,
      dirName: existing?.dirName ?? null,
      lastBackupAt: timestamp,
    })
  }
}

export const backupSettingsRepo = new BackupSettingsRepository()
export { RECORD_ID as BACKUP_SETTINGS_RECORD_ID }
