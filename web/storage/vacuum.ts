/**
 * SQLite storage reclamation (VACUUM) helper.
 *
 * SQLite in WAL mode does not shrink the database file on DELETE — freed
 * pages are only marked reusable. `vacuumDatabase()` rebuilds the file so
 * space actually returns to the OPFS quota. Used by:
 *
 * - `web/opfs/backup.ts` — pre-backup VACUUM so archives don't carry
 *   megabytes of free pages (failure is non-fatal: the backup proceeds).
 * - `ProjectHome` Storage panel — explicit "reclaim space" button for
 *   net-deleter users whose db file is stuck at its historical peak.
 *
 * Contract (mirrors the backup path's close/reopen dance):
 * 1. close() the SQLite worker — releases its OPFS sync-access handles and
 *    flushes pending WAL frames.
 * 2. lazily re-open via getSQLiteDB().initialize() and run
 *    `PRAGMA wal_checkpoint(TRUNCATE)` (fold WAL back into the main db and
 *    truncate the -wal file) followed by `VACUUM` (full page-level rebuild).
 * 3. close() again so the caller sees the same "worker released" contract
 *    the backup path expects before walking the OPFS tree.
 *
 * The returned byte delta is (sizeBefore - sizeAfter) of the main database
 * file measured while the worker is closed (no lock, data flushed). WAL-file
 * shrinkage is not included in the delta but does happen on disk via the
 * TRUNCATE checkpoint.
 */

import { SQLITE_DB_FILENAME } from '../sqlite/sqlite-database'

/** Measure the main database file's size via OPFS (worker must be closed). */
async function measureDbSize(): Promise<number | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const handle = await root.getFileHandle(SQLITE_DB_FILENAME)
    const file = await handle.getFile()
    return file.size
  } catch {
    // DB file absent (fresh profile) or OPFS unavailable — nothing to vacuum.
    return null
  }
}

/**
 * Run wal_checkpoint(TRUNCATE) + VACUUM on the unified database.
 *
 * @returns bytes reclaimed (sizeBefore - sizeAfter of the main db file),
 *   or null when the vacuum could not run (no db file, worker failure,
 *   quota exhaustion during the rebuild). Never throws.
 */
export async function vacuumDatabase(): Promise<number | null> {
  const sizeBefore = await measureDbSize()
  if (sizeBefore === null) return null

  try {
    const { getSQLiteDB } = await import('@/sqlite')

    // 1. Release OPFS sync-access handles + flush WAL.
    await getSQLiteDB().close()

    // 2. Lazily re-open and compact. PRAGMAs run on the dedicated worker.
    await getSQLiteDB().initialize()
    try {
      // Skip the expensive rebuild when there is little free space to
      // reclaim — VACUUM cost scales with total db size, not free-page count.
      try {
        const freelistRow = await getSQLiteDB().queryFirst<{ c: number }>(
          'PRAGMA freelist_count'
        )
        const totalRow = await getSQLiteDB().queryFirst<{ c: number }>(
          'PRAGMA page_count'
        )
        const freelist = freelistRow?.c ?? 0
        const total = totalRow?.c ?? 0
        if (total > 0 && freelist / total < 0.2) {
          console.log(
            `[Storage] VACUUM skipped: freelist ${freelist}/${total} pages below 20% threshold`
          )
          // return from inside the try: the finally below still closes the
          // worker, restoring the released-worker contract exactly once.
          return 0
        }
      } catch (pragmaError) {
        console.warn('[Storage] freelist probe failed (running VACUUM anyway):', pragmaError)
      }
      // VACUUM on a large database can take minutes — the default 30s
      // request timeout would hard-terminate the worker mid-rebuild.
      await getSQLiteDB().executeWithTimeout('PRAGMA wal_checkpoint(TRUNCATE)', 60_000)
      await getSQLiteDB().executeWithTimeout('VACUUM', 5 * 60_000)
    } finally {
      // 3. Restore the "worker released" contract for the caller (backup
      //    path walks OPFS right after this; the panel shows fresh sizes).
      await getSQLiteDB().close()
    }

    const sizeAfter = await measureDbSize()
    if (sizeAfter === null) return null
    return Math.max(0, sizeBefore - sizeAfter)
  } catch (error) {
    console.warn('[Storage] VACUUM failed (non-fatal):', error)
    // Best-effort: leave the worker closed like the backup path expects.
    // The next SQL call re-initializes lazily either way.
    return null
  }
}
