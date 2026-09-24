/**
 * Folder Access Repository - IndexedDB 持久化封装
 *
 * 负责文件夹句柄的存储、读取、删除
 * 每条记录以 `${projectId}/${rootName}` 为复合键，支持多 root。
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
 * IndexedDB 操作封装
 */
class FolderAccessRepository {
  private db: IDBDatabase | null = null
  private initPromise: Promise<void> | null = null

  /**
   * 初始化数据库
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
        // 迁移旧数据库（如果需要）
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
    })

    return this.initPromise
  }

  /**
   * 从旧数据库迁移数据
   */
  private async migrateFromLegacy(): Promise<void> {
    const LEGACY_DB_NAME = 'app-dir-handle'

    return new Promise((resolve) => {
      // 尝试打开旧数据库
      const request = indexedDB.open(LEGACY_DB_NAME)

      request.onsuccess = async () => {
        const legacyDb = request.result
        if (!legacyDb.objectStoreNames.contains('handles')) {
          legacyDb.close()
          resolve()
          return
        }

        // 读取旧数据
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

            // 写入新数据库
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

            // 删除旧数据库
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
        // 旧数据库不存在，正常流程
        resolve()
      }
    })
  }

  /**
   * 确保数据库已初始化
   */
  private async ensureDB(): Promise<IDBDatabase> {
    await this.initialize()
    if (!this.db) {
      throw new Error('Database not initialized')
    }
    return this.db
  }

  /**
   * 保存记录
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
   * 加载记录（单 root 兼容：不传 rootName 返回该项目的第一条记录）
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
   * 删除记录
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
   * 检查记录是否存在
   */
  async exists(projectId: string, rootName?: string): Promise<boolean> {
    const record = await this.load(projectId, rootName)
    return record !== null
  }

  /**
   * 获取所有项目 ID
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
   * 按 projectId + rootName 查找记录（多 root 支持）
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
   * 按 projectId + rootName 删除记录（多 root 支持）
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
   * The pick tab may open before the user has entered a specific project
   * (e.g. from the root route), so there is no projectId to file the record
   * under. The handle is parked under a well-known compound key; the panel
   * adopts it into the active project on the broadcast and deletes the
   * parked entry immediately.
   */
  async saveParkedHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    const db = await this.ensureDB()
    const PARKED_KEY = '__folder-pick:parked'

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const request = store.put({
        _compoundKey: PARKED_KEY,
        projectId: '',
        rootName: handle.name,
        folderName: handle.name,
        persistedHandle: handle,
        status: 'ready',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })
  }

  /**
   * Take (load + delete) the parked handle written by the folder-pick tab.
   * Returns null when nothing is parked.
   */
  async takeParkedHandle(): Promise<FileSystemDirectoryHandle | null> {
    const db = await this.ensureDB()
    const PARKED_KEY = '__folder-pick:parked'

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const store = tx.objectStore(STORE_NAME)
      const getRequest = store.get(PARKED_KEY)
      getRequest.onsuccess = () => {
        const raw = getRequest.result as any
        store.delete(PARKED_KEY)
        resolve(raw?.persistedHandle ?? null)
      }
      getRequest.onerror = () => reject(getRequest.error)
    })
  }
}

export const folderAccessRepo = new FolderAccessRepository()
