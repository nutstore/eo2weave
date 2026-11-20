/**
 * Folder Access Repository - IndexedDB persistence wrapper
 *
 * Owns storage, loading and deletion of folder handles.
 * Each record is keyed by `${projectId}/${rootName}`, supporting multiple roots.
 */

import type { FolderAccessRecord } from '@/types/folder-access'

const DB_NAME = 'bfosa-folder-access'
const STORE_NAME = 'folderAccess'
const DB_VERSION = 2

/** Build a compound storage key from projectId and rootName */
function compoundKey(projectId: string, rootName?: string): string {
  return rootName ? `${projectId}/${rootName}` : projectId
}

/**
 * IndexedDB operation wrapper
 */
class FolderAccessRepository {
  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null

  /**
   * Initialize the database
   */
  async initialize(): Promise<void> {
    if (this.db) return
    if (this.initPromise) return this.initPromise

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION)

      request.onerror = () => {
        console.error('[FolderAccessRepo] Failed to open database:', request.error)
        reject(request.error)
      }

      request.onsuccess = async () => {
        this.db = request.result
        // Migrate the legacy database (if needed)
        this.migrateFromLegacy().then(resolve).catch(reject)
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        const oldVersion = event.oldVersion

        if (!db.objectStoreNames.contains(STORE_NAME)) {
          // Fresh install: create with compound key
          db.createObjectStore(STORE_NAME, { keyPath: '_compoundKey' })
        } else if (oldVersion < 2) {
          // Upgrade from v1 (keyPath=projectId) to v2 (compound key)
          // We need to migrate existing data
          const tx = (event.target as IDBOpenDBRequest).transaction!
          const oldStore = tx.objectStore(STORE_NAME)

          const getAll = oldStore.getAll()
          getAll.onsuccess = () => {
            const records = getAll.result as any[]
            // Delete old store and recreate with new keyPath
            db.deleteObjectStore(STORE_NAME)
            const newStore = db.createObjectStore(STORE_NAME, { keyPath: '_compoundKey' })

            // Re-add records with compound key
            for (const record of records) {
              record._compoundKey = compoundKey(record.projectId, record.rootName)
              newStore.put(record)
            }
          }
        }
      }

      // Issue #316: `onblocked` is the one open event this promise never
      // listened for. When another tab/connection holds an older open
      // version, `indexedDB.open` blocks indefinitely without firing
      // `onsuccess` or `onerror` — the await never settles and project
      // activation stalls with no log line. Naming the blocker turns that
      // silent wait into an observable event.
      request.onblocked = () => {
        console.warn(
          '[FolderAccessRepo] IndexedDB open blocked by another connection holding an older version — waiting for it to close.'
        )
      }
    })

    return this.initPromise
  }

  /**
   * Migrate data from the legacy database
   */
  private async migrateFromLegacy(): Promise<void> {
    const LEGACY_DB_NAME = 'app-dir-handle'

    return new Promise((resolve) => {
      // Try to open the legacy database
      const request = indexedDB.open(LEGACY_DB_NAME)

      request.onsuccess = async () => {
        const legacyDb = request.result
        if (!legacyDb.objectStoreNames.contains('handles')) {
          legacyDb.close()
          resolve()
          return
        }

        // Read legacy data
        const tx = legacyDb.transaction('handles', 'readonly')
        const store = tx.objectStore('handles')
        const getAll = store.getAll()

        getAll.onsuccess = async () => {
          const legacyRecords = getAll.result

          if (legacyRecords && legacyRecords.length > 0) {
            console.log(
              '[FolderAccessRepository] Migrating',
              legacyRecords.length,
              'records from legacy DB'
            )

            // Write to the new database
            for (const record of legacyRecords) {
              await this.save({
                projectId: record.projectId,
                folderName: record.folderName || null,
                handle: null, // handle 不能序列化，保持 null
                persistedHandle: record.handle || null,
                status: 'needs_user_activation',
                createdAt: Date.now(),
                updatedAt: Date.now(),
              })
            }

            // Delete the legacy database
            indexedDB.deleteDatabase(LEGACY_DB_NAME)
            console.log('[FolderAccessRepository] Legacy DB migration complete')
          }

          legacyDb.close()
          resolve()
        }

        getAll.onerror = () => {
          legacyDb.close()
          resolve()
        }
      }

      request.onerror = () => {
        // Legacy database absent - normal flow
        resolve()
      }
    })
  }

  /**
   * Ensure the database is initialized
   */
  private async ensureDB(): Promise<IDBDatabase> {
    await this.initialize()
    if (!this.db) {
      throw new Error('Database not initialized')
    }
    return this.db
  }

  /**
   * Save a record
   */
  async save(record: FolderAccessRecord): Promise<void> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)

      const persistedRecord = {
        _compoundKey: compoundKey(record.projectId, record.rootName),
        projectId: record.projectId,
        rootName: record.rootName,
        folderName: record.folderName,
        persistedHandle: record.persistedHandle, // FileSystemDirectoryHandle 可被结构化克隆
        status: record.status,
        error: record.error,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }

      const request = store.put(persistedRecord)
      request.onsuccess = () => {
        console.log(
          '[FolderAccessRepo] Saved record for project:',
          record.projectId,
          'root:',
          record.rootName
        )
        resolve()
      }
      request.onerror = () => {
        console.error('[FolderAccessRepo] Failed to save record:', request.error)
        reject(request.error)
      }
    })
  }

  /**
   * Load a record (single-root compatible: omitting rootName returns the project's first record)
   */
  async load(projectId: string, rootName?: string): Promise<FolderAccessRecord | null> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)

      if (rootName) {
        // Direct lookup by compound key
        const request = store.get(compoundKey(projectId, rootName))
        request.onsuccess = () => {
          resolve(request.result ? this.toRecord(request.result) : null)
        }
        request.onerror = () => reject(request.error)
      } else {
        // Find first record for this project
        const request = store.getAll()
        request.onsuccess = () => {
          const results = request.result as any[]
          const match = results.find((r) => r.projectId === projectId)
          resolve(match ? this.toRecord(match) : null)
        }
        request.onerror = () => reject(request.error)
      }
    })
  }

  /**
   * Delete a record
   */
  async delete(projectId: string, rootName?: string): Promise<void> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)

      if (rootName) {
        const request = store.delete(compoundKey(projectId, rootName))
        request.onsuccess = () => resolve()
        request.onerror = () => reject(request.error)
      } else {
        // Delete all records for this project
        const getAll = store.getAll()
        getAll.onsuccess = () => {
          const results = getAll.result as any[]
          const toDelete = results.filter((r) => r.projectId === projectId)
          let deleted = 0
          if (toDelete.length === 0) { resolve(); return }
          for (const record of toDelete) {
            const del = store.delete(record._compoundKey)
            del.onsuccess = () => { deleted++; if (deleted === toDelete.length) resolve() }
            del.onerror = () => reject(del.error)
          }
        }
        getAll.onerror = () => reject(getAll.error)
      }
    })
  }

  /**
   * Check whether a record exists
   */
  async exists(projectId: string, rootName?: string): Promise<boolean> {
    const record = await this.load(projectId, rootName)
    return record !== null
  }

  /**
   * List all project IDs
   */
  async getAllProjectIds(): Promise<string[]> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.getAll()

      request.onsuccess = () => {
        const results = request.result as any[]
        const ids = [...new Set(results.map((r) => r.projectId as string))]
        resolve(ids)
      }

      request.onerror = () => {
        reject(request.error)
      }
    })
  }

  /**
   * Find a record by projectId + rootName (multi-root)
   */
  async findByProjectAndRoot(
    projectId: string,
    rootName: string
  ): Promise<FolderAccessRecord | null> {
    return this.load(projectId, rootName)
  }

  /**
   * Load ALL records for a project (multi-root support).
   * Returns every FolderAccessRecord whose projectId matches.
   */
  async loadAllForProject(projectId: string): Promise<FolderAccessRecord[]> {
    const db = await this.ensureDB()

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const request = store.getAll()
      request.onsuccess = () => {
        const results = request.result as any[]
        const matches = results.filter((r) => r.projectId === projectId)
        resolve(matches.map((r) => this.toRecord(r)))
      }
      request.onerror = () => reject(request.error)
    })
  }

  /**
   * Delete a record by projectId + rootName (multi-root)
   */
  async deleteByProjectAndRoot(projectId: string, rootName: string): Promise<void> {
    return this.delete(projectId, rootName)
  }

  /**
   * Convert raw IDB record to FolderAccessRecord (strip internal _compoundKey)
   */
  private toRecord(raw: any): FolderAccessRecord {
    return {
      projectId: raw.projectId,
      rootName: raw.rootName,
      folderName: raw.folderName,
      handle: null,
      persistedHandle: raw.persistedHandle,
      status: raw.status,
      error: raw.error,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    }
  }

  /**
   * Park a handle picked in the standalone folder-pick tab.
   *
   * Pending entries never share a mounted root's key. A unique handoff ID
   * prevents simultaneous pick tabs from overwriting each other's handles.
   * A null project is adopted into the active project on the root route.
   */
  async saveParkedHandle(handle: FileSystemDirectoryHandle, projectId: string | null): Promise<string> {
    const db = await this.ensureDB()
    const pickId = crypto.randomUUID()
    const parkedKey = `__folder-pick:pending:${pickId}`

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.put({
        _compoundKey: parkedKey,
        projectId: '',
        pickedProjectId: projectId,
        rootName: handle.name,
        folderName: handle.name,
        persistedHandle: handle,
        status: 'ready',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      tx.oncomplete = () => resolve(pickId)
      tx.onabort = () => reject(tx.error ?? new Error('Folder handoff storage aborted'))
      tx.onerror = () => reject(tx.error)
      request.onerror = () => reject(request.error)
    })
  }

  /**
   * Take (load + delete) the parked handle written by the folder-pick tab.
   * Returns null when nothing is parked.
   */
  async takeParkedHandle(pickId: string, projectId: string | null, name: string): Promise<FileSystemDirectoryHandle | null> {
    const db = await this.ensureDB()
    const parkedKey = `__folder-pick:pending:${pickId}`

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      let handle: FileSystemDirectoryHandle | null = null
      const getRequest = store.get(parkedKey)
      getRequest.onsuccess = () => {
        const raw = getRequest.result as any
        if (raw?.pickedProjectId !== projectId || raw?.rootName !== name || raw?.persistedHandle?.name !== name) return
        handle = raw.persistedHandle
        store.delete(parkedKey)
      }
      tx.oncomplete = () => resolve(handle)
      tx.onabort = () => reject(tx.error ?? new Error('Folder handoff consumption aborted'))
      tx.onerror = () => reject(tx.error)
      getRequest.onerror = () => reject(getRequest.error)
    })
  }
}

export const folderAccessRepo = new FolderAccessRepository()
