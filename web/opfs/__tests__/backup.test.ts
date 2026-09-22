/**
 * Full OPFS backup — export & import (restore) unit tests.
 *
 * The import path is exercised end-to-end against a fake OPFS root:
 * validation failures must reject BEFORE any destructive step, and the
 * happy path must write entries + close the SQLite worker.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Zip, ZipDeflate, unzipSync, zipSync, strToU8 } from 'fflate'

const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  initialize: vi.fn(async () => {}),
  execute: vi.fn(async () => {}),
  vacuumDatabase: vi.fn(async () => 0 as number | null),
  exportDeviceEncryptionKey: vi.fn(async () => null as ArrayBuffer | null),
  importDeviceEncryptionKey: vi.fn(async (_rawKey: ArrayBuffer) => {}),
}))

vi.mock('@/sqlite', () => ({
  getSQLiteDB: () => ({
    close: mocks.close,
    initialize: mocks.initialize,
    execute: mocks.execute,
  }),
}))

// Pre-backup vacuum is mocked out: the lifecycle tests below assert exact
// close/initialize call counts; dedicated coverage for the vacuum sequence
// itself lives in storage/__tests__/vacuum.test.ts.
vi.mock('@/storage/vacuum', () => ({
  vacuumDatabase: mocks.vacuumDatabase,
}))

vi.mock('@/sqlite/repositories/api-key.repository', () => ({
  exportDeviceEncryptionKey: mocks.exportDeviceEncryptionKey,
  importDeviceEncryptionKey: mocks.importDeviceEncryptionKey,
}))

vi.mock('@/opfs', () => ({
  resetWorkspaceManager: vi.fn(),
}))

// Import AFTER mocks so dynamic import('@/sqlite') inside importOPFSBackup
// resolves to the mock.
const { importOPFSBackup, downloadOPFSBackup } = await import('../backup')

/** Real SQLite database header (16-byte magic string). */
const SQLITE_HEADER = strToU8('SQLite format 3\0')

/** Build a fake OPFS directory backed by a nested Map. */
function makeFakeDir(map: Map<string, unknown>) {
  const dir = {
    kind: 'directory' as const,
    entries: async function* () {
      for (const [name, entry] of map) {
        // Wrap bare Map children on iteration so directory methods (entries/
        // removeEntry/getDirectoryHandle) always exist for consumers.
        if (entry instanceof Map) {
          const wrapped = makeFakeDir(entry)
          map.set(name, wrapped)
          yield [name, wrapped] as [string, unknown]
        } else {
          yield [name, entry] as [string, unknown]
        }
      }
    },
    removeEntry: vi.fn(async (name: string, _opts?: { recursive?: boolean }) => {
      if (!map.has(name)) throw new DOMException('not found', 'NotFoundError')
      map.delete(name)
    }),
    getDirectoryHandle: async (name: string, opts?: { create?: boolean }) => {
      let child = map.get(name)
      if (child instanceof Map) {
        return makeFakeDir(child)
      }
      if (child && typeof child === 'object' && 'kind' in child && (child as { kind?: string }).kind === 'directory') {
        return child
      }
      if (!opts?.create) {
        throw new DOMException('not found', 'NotFoundError')
      }
      child = new Map()
      map.set(name, child)
      return makeFakeDir(child as Map<string, unknown>)
    },
    getFileHandle: async (name: string, opts?: { create?: boolean }) => {
      const existing = map.get(name)
      if (
        existing &&
        typeof existing === 'object' &&
        'kind' in existing &&
        (existing as { kind?: string }).kind === 'file' &&
        'getFile' in (existing as object)
      ) {
        return existing
      }
      if (!opts?.create) {
        throw new DOMException('not found', 'NotFoundError')
      }
      // File handle that actually accumulates written bytes so the backup
      // spill path (createWritable → write chunks → close → getFile) works
      // end-to-end and the produced zip can be read back.
      const handle = {
        kind: 'file' as const,
        bytes: new Uint8Array(0),
        createWritable: async () => {
          const chunks: Uint8Array[] = []
          return {
            write: async (data: Uint8Array) => {
              chunks.push(
                data instanceof Uint8Array ? new Uint8Array(data) : new Uint8Array(data as ArrayBuffer)
              )
            },
            close: async () => {
              const total = chunks.reduce((s, c) => s + c.byteLength, 0)
              const out = new Uint8Array(total)
              let off = 0
              for (const c of chunks) {
                out.set(c, off)
                off += c.byteLength
              }
              handle.bytes = out
            },
          }
        },
        getFile: async () => new FakeFile(name, handle.bytes),
      }
      map.set(name, handle)
      return handle
    },
  }
  return dir
}

function installFakeOpfs(initialEntries: Record<string, unknown> = {}) {
  const map = new Map<string, unknown>(Object.entries(initialEntries))
  const root = makeFakeDir(map)
  const original = navigator.storage
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: {
      ...navigator.storage,
      getDirectory: async () => root,
    },
  })
  return { root, map, restore: () => Object.defineProperty(navigator, 'storage', { configurable: true, value: original }) }
}

/** Minimal File stand-in (vitest env may lack a real File ctor). */
class FakeFile {
  name: string
  size: number
  private bytes: Uint8Array
  constructor(name: string, bytes: Uint8Array) {
    this.name = name
    this.bytes = bytes
    this.size = bytes.byteLength
  }
  async arrayBuffer() {
    return this.bytes.buffer.slice(
      this.bytes.byteOffset,
      this.bytes.byteOffset + this.bytes.byteLength
    )
  }
  slice(start = 0, end = this.size) {
    return new FakeFile(this.name, this.bytes.slice(start, end))
  }
  /**
   * ReadableStream stand-in for `File.stream()`. The export path consumes
   * it through `getReader()` + `read()` (pull-based, like the real browser
   * ReadableStream), so the fake exposes exactly that surface.
   *
   * IMPORTANT: each call returns a fresh copy of the bytes. fflate's async
   * streams transfer the underlying ArrayBuffer to a worker, detaching it —
   * sharing one buffer across tests would fail with DataCloneError after
   * the first transfer.
   */
  stream(): { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; releaseLock(): void } } {
    const bytes = new Uint8Array(this.bytes) // fresh, exclusive buffer
    return {
      getReader() {
        let done = false
        return {
          async read() {
            if (done) return { done: true, value: undefined }
            done = true
            return { done: false, value: bytes }
          },
          releaseLock() {},
        }
      },
    }
  }
}

function zipOf(entries: Record<string, Uint8Array>): Uint8Array {
  return zipSync(entries)
}

/** Build the same descriptor-based streaming ZIP shape as exportOPFSBackup. */
function streamingZipOf(entries: Record<string, Uint8Array>): Uint8Array {
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, chunk) => {
    if (error) throw error
    if (chunk) chunks.push(new Uint8Array(chunk))
  })
  for (const [path, bytes] of Object.entries(entries)) {
    const deflate = new ZipDeflate(path, { level: 0 })
    zip.add(deflate)
    deflate.push(bytes, false)
    deflate.push(new Uint8Array(0), true)
  }
  zip.end()
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

describe('importOPFSBackup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    window.sessionStorage.clear()
  })

  it('rejects a zip without the SQLite database file', async () => {
    const zipped = zipOf({ 'projects/p1/workspace.json': strToU8('{}') })
    const { restore } = installFakeOpfs()
    try {
      await expect(
        importOPFSBackup(new FakeFile('backup.zip', zipped) as unknown as File)
      ).rejects.toThrow(/SQLite database/)
    } finally {
      restore()
    }
  })

  it('rejects a zip whose db entry lacks the SQLite magic header', async () => {
    const zipped = zipOf({
      'bfosa-unified.sqlite': strToU8('this is definitely not sqlite'),
    })
    const { restore } = installFakeOpfs()
    try {
      await expect(
        importOPFSBackup(new FakeFile('backup.zip', zipped) as unknown as File)
      ).rejects.toThrow(/not a valid SQLite database/)
    } finally {
      restore()
    }
  })

  it('rejects zip-slip entries (absolute / .. paths)', async () => {
    const zipped = zipOf({
      'bfosa-unified.sqlite': SQLITE_HEADER,
      '../evil.txt': strToU8('x'),
    })
    const { restore } = installFakeOpfs()
    try {
      await expect(
        importOPFSBackup(new FakeFile('backup.zip', zipped) as unknown as File)
      ).rejects.toThrow(/Invalid entry/)
    } finally {
      restore()
    }
  })

  it('retries reading the picked file on transient NotReadableError', async () => {
    const zipped = zipOf({ 'bfosa-unified.sqlite': SQLITE_HEADER })
    // First slice().arrayBuffer() read throws Chrome's NotReadableError;
    // the next succeeds. The archive is now range-read so large backups stay
    // bounded in memory while retaining the transient-file retry behavior.
    let reads = 0
    const backing = new FakeFile('backup.zip', zipped)
    const flakyFile = {
      name: 'backup.zip',
      size: zipped.byteLength,
      slice: (start?: number, end?: number) => {
        const slice = backing.slice(start, end)
        return {
          arrayBuffer: async () => {
            reads++
            if (reads === 1) {
              throw new DOMException(
                'The requested file could not be read, typically due to permission problems that have occurred after a reference to a file was acquired',
                'NotReadableError'
              )
            }
            return slice.arrayBuffer()
          },
        }
      },
    } as unknown as File
    const { restore } = installFakeOpfs()
    try {
      const result = await importOPFSBackup(flakyFile)
      expect(result.fileCount).toBeGreaterThan(0)
      // One failed attempt plus bounded range reads for the directory,
      // local header, and entry payload.
      expect(reads).toBeGreaterThan(1)
    } finally {
      restore()
    }
  })

  it('reports a clear error when the file stays unreadable', async () => {
    const alwaysFails = {
      name: 'backup.zip',
      size: 100,
      slice: () => ({
        arrayBuffer: async () => {
          throw new DOMException('unreadable', 'NotReadableError')
        },
      }),
    } as unknown as File
    const { restore } = installFakeOpfs()
    try {
      await expect(importOPFSBackup(alwaysFails)).rejects.toThrow(
        /Could not read "backup\.zip".*unreadable/s
      )
    } finally {
      restore()
    }
  })

  it('rejects an empty file', async () => {
    const { restore } = installFakeOpfs()
    try {
      await expect(
        importOPFSBackup(new FakeFile('empty.zip', new Uint8Array(0)) as unknown as File)
      ).rejects.toThrow(/empty/)
    } finally {
      restore()
    }
  })

  it('restores a descriptor-based stream ZIP even when payload contains the descriptor signature', async () => {
    const db = new Uint8Array(400_000)
    db.set(SQLITE_HEADER)
    db.fill(0x41, SQLITE_HEADER.length)
    // fflate Unzip used to mistake this payload sequence for the entry's
    // data descriptor and terminate the deflate stream with unexpected EOF.
    db.set(new Uint8Array([0x50, 0x4b, 0x07, 0x08]), 200_000)
    const zipped = streamingZipOf({ 'bfosa-unified.sqlite': db })
    const { map, restore } = installFakeOpfs()
    try {
      const result = await importOPFSBackup(
        new FakeFile('backup.zip', zipped) as unknown as File
      )
      expect(result.fileCount).toBe(1)
      const restored = map.get('bfosa-unified.sqlite') as { bytes: Uint8Array }
      expect(restored.bytes).toEqual(db)
    } finally {
      restore()
    }
  })

  it('preserves old data and staging on failure, and uses quarantine on success', async () => {
    const zipped = zipOf({ 'bfosa-unified.sqlite': SQLITE_HEADER })
    const { root, map, restore } = installFakeOpfs({ 'old-file.txt': { kind: 'file' } })
    try {
      await importOPFSBackup(new FakeFile('backup.zip', zipped) as unknown as File)
      const removedNames = root.removeEntry.mock.calls.map(([name]) => name)
      // Success path (two-phase commit): stale-temp cleanup first; then the
      // old data is cleared ONLY after the staged tree has moved into the
      // quarantine dir; finally both temp dirs are cleaned up. The staging
      // dir is never deleted between creation and the move.
      expect(removedNames).toEqual([
        '.eo2weave-backup-tmp',
        '.eo2weave-backup-tmp-old',
        'old-file.txt',
        '.eo2weave-backup-tmp',
        '.eo2weave-backup-tmp-old',
      ])
      expect(map.has('bfosa-unified.sqlite')).toBe(true)
      expect(map.has('old-file.txt')).toBe(false)
    } finally {
      restore()
    }
  })

  it('keeps old data intact when the staged tree fails to move into place', async () => {
    const zipped = zipOf({ 'bfosa-unified.sqlite': SQLITE_HEADER })
    // The move into quarantine copies files via createWritable(); make the
    // quarantine copy of the db fail to simulate a mid-move failure. The
    // fake OPFS map-based handles don't go through the real prototype, so
    // patch the fake root's getDirectoryHandle to return a quarantine dir
    // whose file writes fail for the db entry.
    const { root, map, restore } = installFakeOpfs({ 'old-file.txt': { kind: 'file' } })
    const origGetDirectoryHandle = root.getDirectoryHandle.bind(root)
    const failingQuarantine: Record<string, unknown> = {
      entries: function* () {
        // Empty — nothing staged yet; simulate failure by throwing when the
        // mover asks for the file handle path below via getFile.
      },
      getDirectoryHandle: async () => failingQuarantine,
      removeEntry: async () => {},
      getFileHandle: (_name: string) => {
        throw new Error('QuotaExceededError: simulated mid-move failure')
      },
    }
    ;(root as unknown as { getDirectoryHandle: unknown }).getDirectoryHandle = async (
      name: string,
      opts?: { create?: boolean }
    ) => {
      if (name === '.eo2weave-backup-tmp-old') {
        return failingQuarantine as unknown as FileSystemDirectoryHandle
      }
      return origGetDirectoryHandle(name, opts)
    }
    try {
      await expect(
        importOPFSBackup(new FakeFile('backup.zip', zipped) as unknown as File)
      ).rejects.toThrow(/simulated mid-move failure/)
      // Old data untouched — the whole point of the two-phase commit.
      expect(map.has('old-file.txt')).toBe(true)
      expect(map.has('bfosa-unified.sqlite')).toBe(false)
      // Staging + quarantine preserved for retry (no success cleanup ran).
      // (Quarantine creation happens after the stale-temp cleanup at the top
      // of the flow, so its removeEntry of the tmp dir is the only call.)
      const removedNames = root.removeEntry.mock.calls.map(([name]) => name)
      expect(removedNames).toEqual(['.eo2weave-backup-tmp', '.eo2weave-backup-tmp-old'])
    } finally {
      restore()
    }
  })

  it('restores a valid backup, closes the SQLite worker, and skips noise/legacy entries', async () => {
    const zipped = zipOf({
      'bfosa-unified.sqlite': SQLITE_HEADER,
      'projects/p1/workspaces/w1/files/a.txt': strToU8('hello'),
      'noise/.DS_Store': strToU8('skip'),
      '__MACOSX/junk': strToU8('skip'),
      '.bfosa-pool/legacy': strToU8('skip'),
    })
    // Pre-existing data that the restore must wipe.
    const { map, restore } = installFakeOpfs({ 'old-file.txt': { kind: 'file' } })
    try {
      const result = await importOPFSBackup(
        new FakeFile('backup.zip', zipped) as unknown as File
      )
      expect(result.fileCount).toBe(2)
      expect(mocks.close).toHaveBeenCalledTimes(1)
      // Old data gone, new db + file present
      expect(map.has('old-file.txt')).toBe(false)
      expect(map.has('bfosa-unified.sqlite')).toBe(true)
      const projects = map.get('projects')
      expect(projects).toBeInstanceOf(Map)
      // Legacy pool never written back
      expect(map.has('.bfosa-pool')).toBe(false)
    } finally {
      restore()
    }
  })

  it('restores the device encryption key into IndexedDB, not OPFS, when the backup carries it', async () => {
    const deviceKey = new Uint8Array([1, 2, 3, 4])
    const zipped = zipOf({
      'bfosa-unified.sqlite': SQLITE_HEADER,
      'bfosa-device-key.bin': deviceKey,
    })
    const { map, restore } = installFakeOpfs()
    try {
      const result = await importOPFSBackup(
        new FakeFile('backup.zip', zipped) as unknown as File
      )
      // The key file is NOT written into OPFS
      expect(map.has('bfosa-device-key.bin')).toBe(false)
      expect(result.fileCount).toBe(1)
      // It was routed to IndexedDB instead, with its exact bytes
      expect(mocks.importDeviceEncryptionKey).toHaveBeenCalledTimes(1)
      const transferred = mocks.importDeviceEncryptionKey.mock.calls[0][0]
      expect(new Uint8Array(transferred)).toEqual(deviceKey)
    } finally {
      restore()
    }
  })

  it('skips the IndexedDB key transfer when the backup has no device key (legacy backups)', async () => {
    const zipped = zipOf({ 'bfosa-unified.sqlite': SQLITE_HEADER })
    const { restore } = installFakeOpfs()
    try {
      await importOPFSBackup(new FakeFile('backup.zip', zipped) as unknown as File)
      expect(mocks.importDeviceEncryptionKey).not.toHaveBeenCalled()
    } finally {
      restore()
    }
  })

  it('restores localStorage entries from the backup map and skips excluded keys', async () => {
    localStorage.setItem('bfosa-theme', 'dark')
    localStorage.setItem('creatorweave:input-history', '[]')
    // Pre-existing value that the restore must overwrite
    localStorage.setItem('bfosa-settings', 'OLD')
    // Device-local value that must survive untouched (excluded from both
    // backup and restore)
    localStorage.setItem('panel-ratio-left', '0.3')

    const lsMap = {
      'bfosa-settings': 'NEW-VALUE',
      'bfosa-theme': 'light',
      // Forged exclude-list key inside the backup — restore must skip it
      'preview-content-evil.html': '<script>x</script>',
    }
    const zipped = zipOf({
      'bfosa-unified.sqlite': SQLITE_HEADER,
      'bfosa-localstorage.json': strToU8(JSON.stringify(lsMap)),
    })
    const { map, restore } = installFakeOpfs()
    try {
      await importOPFSBackup(new FakeFile('backup.zip', zipped) as unknown as File)
      // Restored values
      expect(localStorage.getItem('bfosa-settings')).toBe('NEW-VALUE')
      expect(localStorage.getItem('bfosa-theme')).toBe('light')
      // Device-local key untouched
      expect(localStorage.getItem('panel-ratio-left')).toBe('0.3')
      // Excluded key never written, JSON never written into OPFS
      expect(localStorage.getItem('preview-content-evil.html')).toBeNull()
      expect(map.has('bfosa-localstorage.json')).toBe(false)
    } finally {
      restore()
      localStorage.clear()
    }
  })

  it('tolerates a corrupt localStorage JSON entry without failing the restore', async () => {
    const zipped = zipOf({
      'bfosa-unified.sqlite': SQLITE_HEADER,
      'bfosa-localstorage.json': strToU8('{not valid json'),
    })
    const { restore } = installFakeOpfs()
    try {
      // The OPFS restore itself must still succeed; the corrupt local-
      // storage payload only logs.
      const result = await importOPFSBackup(
        new FakeFile('backup.zip', zipped) as unknown as File
      )
      expect(result.fileCount).toBe(1)
    } finally {
      restore()
      localStorage.clear()
    }
  })

  it('reports locked entries as a close-other-tabs failure instead of a raw error', async () => {
    const zipped = zipOf({ 'bfosa-unified.sqlite': SQLITE_HEADER })
    const { restore } = installFakeOpfs()
    // Re-create root whose removeEntry always reports locked. Staging
    // creation needs getDirectoryHandle to work, so it delegates to a real
    // fake dir — only removeEntry is locked (the clear-root step).
    const stagingMap = new Map<string, unknown>()
    const lockedRoot = {
      kind: 'directory' as const,
      entries: async function* () {
        yield ['bfosa-unified.sqlite', { kind: 'file' }] as [string, unknown]
        yield ['.eo2weave-backup-tmp', makeFakeDir(stagingMap)] as [string, unknown]
      },
      removeEntry: async (name: string) => {
        if (name === '.eo2weave-backup-tmp') {
          throw new DOMException('not found', 'NotFoundError')
        }
        throw new DOMException(
          'An attempt was made to modify an object where modifications are not allowed',
          'NoModificationAllowedError'
        )
      },
      getDirectoryHandle: async (_name: string) => makeFakeDir(stagingMap),
      getFileHandle: async () => {
        throw new Error('unused')
      },
    }
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        ...navigator.storage,
        getDirectory: async () => lockedRoot,
      },
    })
    void zipped
    try {
      await expect(
        importOPFSBackup(new FakeFile('backup.zip', zipped) as unknown as File)
      ).rejects.toThrow(/RESET_REQUIRES_TAB_CLOSURE/)
    } finally {
      restore()
    }
  })
})

describe('exportOPFSBackup', () => {
  /**
   * Fake OPFS root holding one real-looking SQLite file. The fake's
   * getFile() returns a FakeFile (with stream()) — the export path now
   * reads every entry through `file.stream()`, so the legacy bare object
   * with only arrayBuffer() no longer works.
   */
  function installFakeOpfsWithDb() {
    return installFakeOpfs({
      'bfosa-unified.sqlite': {
        kind: 'file',
        getFile: async () => new FakeFile('bfosa-unified.sqlite', SQLITE_HEADER),
      },
    })
  }

  /**
   * Fake OPFS root with a few files of varying sizes plus a nested
   * subdirectory, exercising the recursive walker.
   */
  function installFakeOpfsWithMixedFiles() {
    // Build the inner directory through `makeFakeDir` so it has the same
    // entries/removeEntry/getDirectoryHandle/getFileHandle API as the root.
    const nested = makeFakeDir(
      new Map<string, unknown>([
        [
          'inner.txt',
          {
            kind: 'file',
            getFile: async () => new FakeFile('inner.txt', strToU8('inner content')),
          },
        ],
      ])
    )
    return installFakeOpfs({
      'bfosa-unified.sqlite': {
        kind: 'file',
        getFile: async () => new FakeFile('bfosa-unified.sqlite', SQLITE_HEADER),
      },
      'notes.md': {
        kind: 'file',
        getFile: async () => new FakeFile('notes.md', strToU8('# hello')),
      },
      projects: nested,
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('embeds the device encryption key in the zip and reports includesDeviceKey: true', async () => {
    const deviceKey = new Uint8Array(32).fill(0xab)
    mocks.exportDeviceEncryptionKey.mockResolvedValue(deviceKey.buffer.slice(0) as ArrayBuffer)
    const { restore } = installFakeOpfsWithDb()
    try {
      const { exportOPFSBackup } = await import('../backup')
      const { blob, includesDeviceKey } = await exportOPFSBackup()
      expect(includesDeviceKey).toBe(true)
      // Unzip the produced blob and verify the key bytes round-trip exactly
      const zipped = new Uint8Array(await blob.arrayBuffer())
      const entries = unzipSync(zipped)
      expect(entries['bfosa-device-key.bin']).toEqual(deviceKey)
      expect(entries['bfosa-unified.sqlite']).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('omits the key file and reports includesDeviceKey: false when IndexedDB has no key', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    const { restore } = installFakeOpfsWithDb()
    try {
      const { exportOPFSBackup } = await import('../backup')
      const { blob, includesDeviceKey } = await exportOPFSBackup()
      expect(includesDeviceKey).toBe(false)
      const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
      expect(entries['bfosa-device-key.bin']).toBeUndefined()
    } finally {
      restore()
    }
  })

  it('streams every file through fflate (recursive walker, no single ArrayBuffer allocation)', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    const { restore } = installFakeOpfsWithMixedFiles()
    try {
      const { exportOPFSBackup } = await import('../backup')
      const { blob, filename } = await exportOPFSBackup()
      expect(filename).toMatch(/^eo2weave-backup_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/)
      // Every OPFS entry round-trips into the produced zip — including the
      // nested one. If any entry were silently dropped, this fails.
      const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
      expect(entries['bfosa-unified.sqlite']).toBeTruthy()
      expect(entries['notes.md']).toBeTruthy()
      expect(entries['projects/inner.txt']).toBeTruthy()
    } finally {
      restore()
    }
  })

  it('re-slices oversized stream chunks (no single huge push() allocation)', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    // ~2.5 MiB of semi-random data — larger than the 1 MiB PUSH_SLICE cap,
    // so the fake's single-chunk stream() forces the re-slicing path.
    // Compressible on purpose: level-6 deflate produces a tiny output,
    // proving the data actually flowed through the compressor.
    const big = new Uint8Array(2.5 * 1024 * 1024)
    for (let i = 0; i < big.length; i++) big[i] = i % 251
    const { restore } = installFakeOpfs({
      'bfosa-unified.sqlite': {
        kind: 'file',
        getFile: async () => new FakeFile('bfosa-unified.sqlite', SQLITE_HEADER),
      },
      'blob.bin': {
        kind: 'file',
        getFile: async () => new FakeFile('blob.bin', big),
      },
    })
    try {
      const { exportOPFSBackup } = await import('../backup')
      const { blob } = await exportOPFSBackup()
      const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
      const round = entries['blob.bin']
      expect(round?.length).toBe(big.length)
      // Content integrity through the slice/reassemble boundary.
      for (let i = 0; i < big.length; i += 997) {
        expect(round[i]).toBe(big[i])
      }
    } finally {
      restore()
    }
  })

  it('reports the failing path when an OPFS entry cannot be opened', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    const { restore } = installFakeOpfs({
      'bfosa-unified.sqlite': {
        kind: 'file',
        getFile: async () => new FakeFile('bfosa-unified.sqlite', SQLITE_HEADER),
      },
      'projects/huge.bin': {
        kind: 'file',
        getFile: async () => {
          throw new DOMException('NotReadableError', 'NotReadableError')
        },
      },
    })
    try {
      const { exportOPFSBackup } = await import('../backup')
      await expect(exportOPFSBackup()).rejects.toThrow(
        /Backup failed while opening "projects\/huge\.bin"/
      )
    } finally {
      restore()
    }
  })

  it('reports an empty OPFS as a clear error', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    const { restore } = installFakeOpfs({}) // no entries
    try {
      const { exportOPFSBackup } = await import('../backup')
      await expect(exportOPFSBackup()).rejects.toThrow(/OPFS is empty/)
    } finally {
      restore()
    }
  })

  it('exports localStorage entries alongside OPFS when present', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    localStorage.setItem('bfosa-theme', 'dark')
    const { restore } = installFakeOpfsWithDb()
    try {
      const { exportOPFSBackup } = await import('../backup')
      const { blob, includesLocalStorage } = await exportOPFSBackup()
      expect(includesLocalStorage).toBe(true)
      const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()))
      const lsJson = JSON.parse(
        new TextDecoder().decode(entries['bfosa-localstorage.json'])
      )
      expect(lsJson['bfosa-theme']).toBe('dark')
    } finally {
      restore()
      localStorage.clear()
    }
  })
})

describe('downloadOPFSBackup', () => {
  /** Minimal fake OPFS root with just the SQLite db (module-level helpers). */
  function installFakeOpfsWithDb() {
    return installFakeOpfs({
      'bfosa-unified.sqlite': {
        kind: 'file',
        getFile: async () => new FakeFile('bfosa-unified.sqlite', SQLITE_HEADER),
      },
    })
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('closes the SQLite worker before exporting and re-initializes it afterwards', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    const { restore } = installFakeOpfsWithDb()
    const order: string[] = []
    mocks.close.mockImplementation(async () => {
      order.push('close')
    })
    mocks.initialize.mockImplementation(async () => {
      order.push('initialize')
    })
    try {
      const result = await downloadOPFSBackup()
      expect(result.filename).toMatch(/^eo2weave-backup_/)
      expect(mocks.close).toHaveBeenCalledTimes(1)
      expect(mocks.initialize).toHaveBeenCalledTimes(1)
      // close() must happen before the OPFS read (export), initialize() after
      expect(order).toEqual(['close', 'initialize'])
    } finally {
      restore()
    }
  })

  it('runs a pre-backup vacuum between closing the worker and exporting', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    const { restore } = installFakeOpfsWithDb()
    const order: string[] = []
    mocks.close.mockImplementation(async () => {
      order.push('close')
    })
    mocks.initialize.mockImplementation(async () => {
      order.push('initialize')
    })
    mocks.vacuumDatabase.mockImplementation(async () => {
      // The vacuum must observe the worker in the closed state.
      order.push('vacuum')
      return 4096
    })
    try {
      await downloadOPFSBackup()
      // close → vacuum → (internal reopen/close inside vacuum are mocked away
      // at this boundary) → export; finalize re-initializes afterwards.
      expect(order[0]).toBe('close')
      expect(order[1]).toBe('vacuum')
      expect(order).toContain('initialize')
      expect(mocks.vacuumDatabase).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('still backs up when the pre-backup vacuum fails', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    mocks.vacuumDatabase.mockRejectedValue(new Error('vacuum exploded'))
    const { restore } = installFakeOpfsWithDb()
    try {
      const result = await downloadOPFSBackup()
      expect(result.filename).toMatch(/^eo2weave-backup_/)
    } finally {
      restore()
    }
  })

  it('re-initializes the worker even when the export itself fails', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    // Empty OPFS makes exportOPFSBackup throw "OPFS is empty" after close().
    const { restore } = installFakeOpfs({})
    try {
      await expect(downloadOPFSBackup()).rejects.toThrow(/OPFS is empty/)
      expect(mocks.close).toHaveBeenCalledTimes(1)
      expect(mocks.initialize).toHaveBeenCalledTimes(1)
    } finally {
      restore()
    }
  })

  it('still exports when closing the worker fails (worker already dead)', async () => {
    mocks.exportDeviceEncryptionKey.mockResolvedValue(null)
    mocks.close.mockRejectedValueOnce(new Error('worker already terminated'))
    const { restore } = installFakeOpfsWithDb()
    try {
      const result = await downloadOPFSBackup()
      expect(result.filename).toMatch(/^eo2weave-backup_/)
      expect(mocks.initialize).not.toHaveBeenCalled() // close failed → no reopen
    } finally {
      restore()
    }
  })
})
