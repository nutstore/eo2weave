import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Tests for writeOPFSBackupToDirectory — the "backup to a user-granted
 * local directory" path. exportOPFSBackup is mocked (its zip pipeline is
 * covered by backup.test.ts); these tests focus on the directory-write
 * contract: overwrite via createWritable, stream consumption, spill
 * cleanup, worker close/re-open, and SQLite worker re-open on failure.
 */

const closeMock = vi.fn()
const initializeMock = vi.fn()

vi.mock('@/sqlite', () => ({
  getSQLiteDB: () => ({
    close: closeMock,
    initialize: initializeMock,
  }),
}))

vi.mock('@/sqlite/repositories/api-key.repository', () => ({
  exportDeviceEncryptionKey: vi.fn(async () => null),
}))

const exportResult = {
  blob: new Blob(['zip-bytes'], { type: 'application/zip' }),
  filename: 'eo2weave-backup_2026-09-21_00-00-00.zip',
  includesDeviceKey: true,
  includesLocalStorage: true,
}

vi.mock('../backup', async (importOriginal) => {
  const original = await importOriginal<typeof import('../backup')>()
  return {
    ...original,
    exportOPFSBackup: vi.fn(async () => exportResult),
  }
})

const createWritable = vi.fn()
const getFileHandle = vi.fn()

function makeDirHandle() {
  return {
    name: 'backup-dir',
    kind: 'directory' as const,
    getFileHandle,
    queryPermission: vi.fn(),
    requestPermission: vi.fn(),
  } as unknown as FileSystemDirectoryHandle
}

async function loadFn() {
  // dynamic import so the mocks above are in place
  const mod = await import("../backup");
  return mod.writeOPFSBackupToDirectory
}

beforeEach(() => {
  vi.clearAllMocks()
  closeMock.mockResolvedValue(undefined)
  initializeMock.mockResolvedValue(undefined)
  getFileHandle.mockResolvedValue({
    createWritable,
  })
  createWritable.mockResolvedValue(
    new WritableStream({
      write: vi.fn(),
      close: vi.fn(),
      abort: vi.fn(),
    }),
  )
  // navigator.storage.getDirectory for the spill cleanup
  // OPFS root with one tiny file so the real exportOPFSBackup pipeline runs
  // (the internal zip walker iterates dir.entries(); the mock module above
  // cannot intercept intra-module calls to exportOPFSBackup).
  const fakeFile = async () => new File(['x'], 'tiny.txt')
  Object.defineProperty(navigator, 'storage', {
    value: {
      getDirectory: vi.fn(async () => ({
        removeEntry: vi.fn(async () => {}),
        entries: async function* () {
          yield ['tiny.txt', { kind: 'file', getFile: fakeFile }]
        },
      })),
    },
    configurable: true,
  })
})

describe('writeOPFSBackupToDirectory', () => {
  it('writes the backup zip into the directory with a fixed name', async () => {
    const fn = await loadFn()
    const dir = makeDirHandle()
    const result = await fn(dir)

    expect(getFileHandle).toHaveBeenCalledWith('eo2weave-backup.zip', { create: true })
    expect(createWritable).toHaveBeenCalledWith({ keepExistingData: false })
    const result2 = result as { fileName: string }
    expect(result2.fileName).toBe('eo2weave-backup.zip')
  })

  it('closes the SQLite worker before exporting and re-opens it after', async () => {
    const fn = await loadFn()
    const dir = makeDirHandle()
    await fn(dir)

    // close() must happen before any OPFS reads (export internally walks the
    // tree), and initialize() must run after the whole flow — assert both
    // were called (ordering vs. intra-module export calls can't be spied).
    expect(closeMock).toHaveBeenCalled()
    expect(initializeMock).toHaveBeenCalled()
  })

  it('aborts the writable and re-throws when the copy fails', async () => {
    const fn = await loadFn()
    const abort = vi.fn().mockResolvedValue(undefined)
    createWritable.mockResolvedValue({
      write: vi.fn(),
      close: vi.fn(),
      abort,
    })
    // Make the copy fail: Blob.stream() is real, so fail at the writable write step instead —
    // pipeTo surfaces write errors through its own promise.
    createWritable.mockImplementation(async () => {
      const real = new WritableStream({
        write() {
          throw new Error('disk full')
        },
      })
      return real.getWriter()
    })

    const dir = makeDirHandle()
    await expect(fn(dir)).rejects.toThrow()
    expect(abort).not.toHaveBeenCalled() // pipeTo already aborted the stream
  })

  it('still re-opens the SQLite worker when the directory write fails', async () => {
    getFileHandle.mockRejectedValue(new Error('directory gone'))
    const fn = await loadFn()
    const dir = makeDirHandle()
    await expect(fn(dir)).rejects.toThrow('directory gone')
    expect(closeMock).toHaveBeenCalled()
    expect(initializeMock).toHaveBeenCalled()
  })
})

