import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for backupSettingsRepository — pure IDB-shape mocking (the project
 * has no fake-indexeddb dependency, so a minimal in-memory indexeDB stub is
 * installed and the repository's promise-based API is exercised against it).
 */

type StoredRecord = Record<string, unknown>

let store: Map<string, StoredRecord>

vi.stubGlobal('indexedDB', {
  open: (_name: string, _version?: number) => {
    // Synchronous-looking success path: the repo only needs onsuccess to
    // fire with a db-like object exposing transaction().
    const request: any = {}
    queueMicrotask(() => {
      const db: any = {
        objectStoreNames: { contains: () => true },
        transaction: (_stores: string[], _mode: string) => {
          const tx: any = {}
          tx.objectStore = () => ({
            get: (key: string) => {
              const r: any = {}
              queueMicrotask(() => {
                r.result = store.get(key as string) ?? null
                r.onsuccess?.()
              })
              return r
            },
            put: (value: StoredRecord) => {
              const r: any = {}
              queueMicrotask(() => {
                store.set(value.id as string, value)
                r.onsuccess?.()
              })
              return r
            },
            delete: (key: string) => {
              const r: any = {}
              queueMicrotask(() => {
                store.delete(key)
                r.onsuccess?.()
              })
              return r
            },
          })
          return tx
        },
      }
      request.result = db
      request.onsuccess?.()
    })
    return request
  },
})

import { backupSettingsRepo } from '@/services/backup-settings.repository'

const fakeHandle = {
  name: 'backup-dir',
  kind: 'directory',
} as unknown as FileSystemDirectoryHandle

beforeEach(() => {
  store = new Map()
})

describe('backupSettingsRepository', () => {
  it('returns null when nothing is persisted', async () => {
    expect(await backupSettingsRepo.load()).toBeNull()
  })

  it('saves and loads a record round-trip', async () => {
    const record = {
      id: 'backup-dir',
      dirHandle: fakeHandle,
      dirName: 'backup-dir',
      lastBackupAt: 1758400000000,
    }
    await backupSettingsRepo.save(record)
    const loaded = await backupSettingsRepo.load()
    expect(loaded?.dirName).toBe('backup-dir')
    expect(loaded?.lastBackupAt).toBe(1758400000000)
  })

  it('updateLastBackupAt preserves handle and dirName', async () => {
    await backupSettingsRepo.save({
      id: 'backup-dir',
      dirHandle: fakeHandle,
      dirName: 'backup-dir',
      lastBackupAt: null,
    })
    await backupSettingsRepo.updateLastBackupAt(12345)
    const loaded = await backupSettingsRepo.load()
    expect(loaded?.lastBackupAt).toBe(12345)
    expect(loaded?.dirName).toBe('backup-dir')
    expect(loaded?.dirHandle).toEqual({ name: 'backup-dir', kind: 'directory' })
  })

  it('clear removes the record', async () => {
    await backupSettingsRepo.save({
      id: 'backup-dir',
      dirHandle: null,
      dirName: 'x',
      lastBackupAt: 1,
    })
    await backupSettingsRepo.clear()
    expect(await backupSettingsRepo.load()).toBeNull()
  })
})
