/**
 * User Skills Scanner — scans OPFS `.skills/user/` directory for user skills.
 *
 * User skills are stored as SKILL.md files (same format as project skills)
 * under `.skills/user/<skill-name>/SKILL.md` in OPFS. This module reads them
 * at runtime and returns Skill objects with `source: 'user'`.
 *
 * Unlike persistent SQLite skills, these are NOT stored in the database —
 * the OPFS files are the single source of truth. The SkillManager loads
 * them into its runtime cache on initialization.
 */

import type { Skill, SkillResource } from './skill-types'
import { parseSkillMd, slugify } from './skill-parser'
import { copyDirectoryRecursive } from './skill-folder-utils'
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import {
  getResourceType,
  getMimeType,
  generateResourceId,
  isTextFile,
} from './skill-resources'
import { RESOURCE_LIMITS } from './skill-types'

/** OPFS root directory name for all skills */
const SKILLS_ROOT = '.skills'
/** Subdirectory under SKILLS_ROOT for user skills */
const USER_SKILLS_DIR = 'user'
/**
 * Subdirectory under SKILLS_ROOT for durable import backups. Before an
 * import removes an existing skill directory, the previous content is
 * staged here (one unique run folder per import) so a tab close between
 * removal and rollback cannot lose the skill. Cleaned up when the import
 * finishes; a crashed import leaves the backup behind as recovery data.
 */
const IMPORT_BACKUPS_DIR = '.import-backups'
const IMPORT_OWNER_FILE = '.eo2weave-import-owner'
const IMPORT_LOCK_GLOBAL = 'eo2weave-skill-import-recovery'

/**
 * Minimal structural typing for the Web Locks API (not every TS lib target
 * ships `navigator.locks`): used to serialize same-skill imports across
 * tabs and to fence import-backup recovery away from runs that are still
 * actively importing.
 */
interface WebLockLike { name?: string }
interface WebLocksLike {
  request(
    name: string,
    callback: (lock: WebLockLike | null) => void | Promise<unknown>,
  ): Promise<unknown>
  request(
    name: string,
    options: { ifAvailable: boolean },
    callback: (lock: WebLockLike | null) => void | Promise<unknown>,
  ): Promise<unknown>
}

/** All imports and recovery hold the global lock. Directory and run locks
 * additionally preserve the existing per-target and liveness contracts. */
const IMPORT_LOCK_DIR_PREFIX = 'eo2weave-skill-import-dir:'
const IMPORT_LOCK_RUN_PREFIX = 'eo2weave-skill-import-run:'

function getWebLocks(): WebLocksLike | null {
  if (typeof navigator === 'undefined') return null
  return (navigator as Navigator & { locks?: WebLocksLike }).locks ?? null
}

// Runs of imports currently executing in THIS tab. Their staged backup is
// the live rollback copy — recovery (which may run in a concurrent scan)
// must never restore/consume it mid-import.
const activeImportRunIds = new Set<string>()

// In-tab serialization chains keyed by SINGLE target directory: two
// concurrent imports sharing ANY skill directory run strictly one after
// the other in this tab — even when their overall target sets only
// partially overlap (keying by the whole sorted set would let imports
// with different sets interleave writes to the same skill).
const importMutexChains = new Map<string, Promise<unknown>>()

/**
 * Run `fn` as a serialized import of `dirNames` (sorted unique dirNames):
 *  - in-tab: chained behind any prior import sharing ANY target
 *    directory (per-directory chains, reserved synchronously so later
 *    overlapping imports queue behind THIS import);
 *  - cross-tab: holding an exclusive Web Lock on EVERY `dir:<name>` for
 *    the whole import — acquired in the canonical (sorted) order, so no
 *    lock-ordering deadlock — so imports of the same skill in two tabs
 *    cannot interleave their remove/write phases;
 *  - fencing: holding `run:<runId>` so recovery (either tab) skips this
 *    run's staging while the import is in flight, and registering the
 *    run in `activeImportRunIds` for environments without Web Locks.
 */
async function withImportSerialization<T>(
  runId: string,
  dirNames: string[],
  fn: () => Promise<T>,
): Promise<T> {
  activeImportRunIds.add(runId)
  try {
    // Reserve our slot in EVERY target directory's in-tab chain FIRST —
    // synchronously, before any await: a later import sharing one of
    // these directories must queue behind THIS import, not behind an
    // earlier import that may already have finished.
    const prevs = dirNames.map(
      (d) => (importMutexChains.get(d) ?? Promise.resolve()).catch(() => {}),
    )
    let release!: () => void
    const slot = new Promise<void>((resolve) => {
      release = resolve
    })
    dirNames.forEach((d, i) => {
      importMutexChains.set(d, prevs[i].then(() => slot))
    })
    // Wait for prior imports that share any of our target directories.
    await Promise.all(prevs)
    const locks = getWebLocks()
    if (!locks) {
      release()
      throw new Error('Web Locks are required for safe cross-tab skill imports.')
    }
    let result!: T
    try {
      // Acquire every per-directory Web Lock (canonical sorted order —
      // resource-hierarchy ordering, so no circular wait is possible),
      // then the run lock. Acquisition order (dir → run) is consistent
      // everywhere.
      const holdDirLocks = (
        i: number,
        body: () => Promise<unknown>,
      ): Promise<unknown> =>
        i >= dirNames.length
          ? body()
          : locks.request(`${IMPORT_LOCK_DIR_PREFIX}${dirNames[i]}`, () =>
              holdDirLocks(i + 1, body),
            )
      await locks.request(IMPORT_LOCK_GLOBAL, async () => {
        await holdDirLocks(0, async () => {
          await locks.request(`${IMPORT_LOCK_RUN_PREFIX}${runId}`, async () => {
            result = await fn()
          })
        })
      })
    } finally {
      release()
    }
    return result
  } finally {
    activeImportRunIds.delete(runId)
  }
}

/** True when `runId` belongs to an import that is still executing — in this
 * tab (registry) or another (its `run:<runId>` Web Lock is held). */
async function isImportRunActive(runId: string): Promise<boolean> {
  if (activeImportRunIds.has(runId)) return true
  const locks = getWebLocks()
  if (!locks) {
    // No Web Locks: another tab's liveness CANNOT be established. A run
    // that is neither this tab's registry nor provably finished must be
    // treated as ACTIVE — consuming its staged backup here would strip a
    // live import of its rollback copy (a later write failure would then
    // delete the old skill permanently). Leave it for a later scan.
    return await isImportRunUnfinished(runId)
  }
  try {
    return await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (v: boolean): void => {
        if (!settled) {
          settled = true
          resolve(v)
        }
      }
      locks
        .request(`${IMPORT_LOCK_RUN_PREFIX}${runId}`, { ifAvailable: true }, (lock) => {
          if (lock) {
            // Lock acquired → the import is NOT running elsewhere.
            done(false)
            // Web Locks release automatically when this callback returns.
          } else {
            // Held by someone else → an import is in flight.
            done(true)
          }
        })
        .catch(() => done(true))
    })
  } catch {
    return true
  }
}

/**
 * Conservative liveness fallback for environments WITHOUT Web Locks: a run
 * that has not durably recorded a terminal state or
 * been fully consumed is treated as still in flight in another tab. Only
 * proven-finished runs may be recovered; unproven ones stay untouched.
 */
async function isImportRunUnfinished(runId: string): Promise<boolean> {
  let backupsRoot: FileSystemDirectoryHandle
  try {
    const opfsRoot = await navigator.storage.getDirectory()
    const skillsDir = await opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: false })
    backupsRoot = await skillsDir.getDirectoryHandle(IMPORT_BACKUPS_DIR, { create: false })
  } catch {
    return true
  }
  try {
    const runDir = await backupsRoot.getDirectoryHandle(runId)
    const state = await readImportRunState(runDir)
    // Successful imports and failed rollbacks have both stopped writing.
    // Runs without a terminal state may still be live in another tab.
    return state?.status !== 'import-complete' && state?.status !== 'failed-rollback'
  } catch {
    // Unreadable run state: cannot prove the import finished — treat as
    // active rather than risking consumption of a live rollback copy.
    return true
  }
}

/** True when the error is an OPFS "not found" (absence — not a failure). */
function isNotFoundError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === 'NotFoundError') return true
  // Test doubles and polyfills may not produce real DOMExceptions.
  return e instanceof Error && e.message.includes('NotFoundError')
}

/** Concatenate streamed decoder chunks into a single buffer. */
function concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const merged = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    merged.set(c, off)
    off += c.length
  }
  return merged
}

/** Scan result */
export interface UserSkillScanResult {
  skills: Skill[]
  resources: SkillResource[]
  errors: string[]
}

/**
 * Hard caps enforced DURING zip extraction (before/during unzip), so a
 * decompression-bomb archive cannot exhaust browser memory: every entry is
 * rejected and its data discarded as soon as any cap is exceeded.
 */
export const ZIP_IMPORT_LIMITS = {
  /** Max compressed size of a single zip entry (bytes). */
  MAX_ENTRY_COMPRESSED_SIZE: 10 * 1024 * 1024,
  /** Max expanded size of a single zip entry (bytes). */
  MAX_ENTRY_SIZE: 10 * 1024 * 1024,
  /** Max total expanded size across the whole archive (bytes). */
  MAX_TOTAL_SIZE: 64 * 1024 * 1024,
  /** Max number of file entries in the archive. */
  MAX_ENTRIES: 2000,
} as const

/**
 * Extract zip entries incrementally with hard size caps (memory-bomb guard).
 *
 * Unlike `unzipSync` — which buffers the entire archive before any limit
 * can be checked — this streams each entry through fflate's `Unzip` and
 * discards data as soon as a cap trips, then aborts the extraction.
 *
 * @returns the accepted entries (path → data), or throws when a cap is hit.
 */
async function unzipWithLimits(data: Uint8Array): Promise<Record<string, Uint8Array>> {
  const limits = ZIP_IMPORT_LIMITS
  const files: Record<string, Uint8Array> = {}
  let entryCount = 0
  let totalSize = 0
  let failure: Error | null = null

  const unzipper = new Unzip()
  // UnzipPassThrough handles entries stored WITHOUT compression (method 0);
  // without it a valid STORE archive fails with "unknown compression type".
  unzipper.register(UnzipInflate)
  unzipper.register(UnzipPassThrough)
  unzipper.onfile = (file) => {
    // Directory entries carry no payload in practice, but a crafted archive
    // can attach data to them (or ship an enormous number of them) — count
    // them against MAX_ENTRIES and enforce the size caps on their decoded
    // output before discarding it.
    if (file.name.endsWith('/')) {
      entryCount++
      if (entryCount > limits.MAX_ENTRIES) {
        failure = new Error(
          `ZIP archive has too many entries (limit: ${limits.MAX_ENTRIES}).`,
        )
        file.terminate()
        return
      }
      let dirEntrySize = 0
      file.ondata = (err, data) => {
        if (err) {
          failure = err instanceof Error ? err : new Error(String(err))
          return
        }
        if (failure) return
        totalSize += data.length
        dirEntrySize += data.length
        if (
          dirEntrySize > limits.MAX_ENTRY_SIZE ||
          totalSize > limits.MAX_TOTAL_SIZE
        ) {
          failure = new Error(
            'ZIP archive expands beyond the import size limit — it may be a decompression bomb.',
          )
          file.terminate()
          return
        }
        // Decoded directory payload is discarded (not buffered).
      }
      file.start()
      return
    }
    entryCount++
    if (entryCount > limits.MAX_ENTRIES) {
      failure = new Error(
        `ZIP archive has too many entries (limit: ${limits.MAX_ENTRIES}).`,
      )
      file.terminate()
      return
    }
    // Pre-check the compressed size from the central directory when present.
    if (typeof file.size === 'number' && file.size > limits.MAX_ENTRY_COMPRESSED_SIZE) {
      failure = new Error(
        `ZIP entry "${file.name}" is too large (${file.size} bytes compressed).`,
      )
      file.terminate()
      return
    }
    // Cumulative expanded size for THIS entry (the decoder may deliver a
    // large entry in several chunks — checking each chunk alone would let
    // a single oversized entry slip through chunk by chunk). Chunks are
    // buffered and concatenated once, on the entry's final chunk.
    let entrySize = 0
    let entryChunks: Uint8Array[] = []
    file.ondata = (err, data, final) => {
      if (err) {
        failure = err instanceof Error ? err : new Error(String(err))
        return
      }
      // Once failed, discard the rest instead of buffering it.
      if (failure) return
      totalSize += data.length
      entrySize += data.length
      if (
        entrySize > limits.MAX_ENTRY_SIZE ||
        totalSize > limits.MAX_TOTAL_SIZE
      ) {
        failure = new Error(
          'ZIP archive expands beyond the import size limit — it may be a decompression bomb.',
        )
        // Stop feeding the decoder NOW: fflate keeps inflating the current
        // compressed chunk after ondata returns, so a highly compressible
        // entry would keep burning CPU on the rest of this chunk (and every
        // later push) until the outer loop observes the failure.
        file.terminate()
        entryChunks = []
        return
      }
      entryChunks.push(data)
      if (final) {
        files[file.name] = concatChunks(entryChunks)
        entryChunks = []
      }
    }
    file.start()
  }

  const CHUNK_SIZE = 65_536
  for (let offset = 0; offset < data.length; offset += CHUNK_SIZE) {
    if (failure) throw failure
    unzipper.push(data.subarray(offset, offset + CHUNK_SIZE), false)
    // Yield so the (synchronous) decoder callbacks for this chunk run and
    // any limit trip is observed before feeding more compressed data.
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  unzipper.push(new Uint8Array(0), true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (failure) throw failure
  if (entryCount === 0) {
    throw new Error('ZIP archive is empty')
  }
  return files
}

/**
 * Get the user skills directory handle from OPFS root.
 * Returns null if `.skills/user/` does not exist (not an error).
 */
async function getUserSkillsDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const opfsRoot = await navigator.storage.getDirectory()
    const skillsDir = await opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: false })
    return await skillsDir.getDirectoryHandle(USER_SKILLS_DIR, { create: false })
  } catch {
    // .skills/user/ doesn't exist yet — no user skills
    return null
  }
}

/**
 * Recover import backups staged by an import that never finished.
 *
 * `importUserSkillZip` removes an existing skill only after its previous
 * content is staged under `.skills/.import-backups/<runId>/<dirName>/`. If
 * the tab dies after the removal but before the import completes or rolls
 * back, that in-process rollback never runs and the skill stays missing.
 * This scans the backups root and restores every staged skill, then drops
 * the consumed run directory, so a crashed import cannot leave a skill
 * permanently absent.
 *
 * Called before scanning installed skills, so recovery lands in the
 * manager cache on the same refresh. Best-effort: a recovery failure must
 * not break the scan. The shared global Web Lock fences concurrent imports.
 */
/**
 * Import-backup run bookkeeping (see `importUserSkillZip`):
 *  - `<dirName>.done` marker file: that skill's backup was fully staged
 *    before target removal — only marked entries are considered for restore.
 *  - `state.json` with status `import-complete`: the import finished
 *    successfully but its cleanup crashed — recovery must DROP the backups
 *    (restoring them would revert a good import).
 *  - `state.json` with status `failed-rollback`: rollback ran but some
 *    restores failed — recovery must (re)try the marked restores.
 *  - No state file: staging or the import was interrupted — restore the
 *    marked entries (their targets were removed) and drop the rest.
 */
const RUN_STATE_FILE = 'state.json'

type ImportRunState = {
  status: 'import-complete' | 'failed-rollback'
}

/** Read a run's state.json; null when absent/unparseable. */
async function readImportRunState(
  runDir: FileSystemDirectoryHandle,
): Promise<ImportRunState | null> {
  let handle: FileSystemFileHandle
  try {
    handle = await runDir.getFileHandle(RUN_STATE_FILE)
  } catch (e) {
    // Absence = no state file (normal for an interrupted import). Any other
    // error is a REAL read failure and must propagate: recovery deciding
    // "no state" on a transient failure could misclassify the run and
    // delete its staged backups.
    if (isNotFoundError(e)) return null
    throw e
  }
  let file
  try {
    file = await handle.getFile()
  } catch (e) {
    if (isNotFoundError(e)) return null
    throw e
  }
  let text: string
  try {
    text = await file.text()
  } catch (e) {
    if (isNotFoundError(e)) return null
    throw e
  }
  try {
    const parsed = JSON.parse(text) as Partial<ImportRunState>
    if (parsed.status === 'import-complete' || parsed.status === 'failed-rollback') {
      return { status: parsed.status }
    }
    return null
  } catch {
    // Written but unparseable — the file EXISTS and was readable, so this
    // is corruption, not a transient failure; treat as "no state".
    return null
  }
}

async function writeImportRunState(
  runDir: FileSystemDirectoryHandle,
  state: ImportRunState,
): Promise<void> {
  const handle = await runDir.getFileHandle(RUN_STATE_FILE, { create: true })
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(state))
  await writable.close()
}

/** Marker written once a skill's backup is fully staged, before target removal. */
const stagedMarkerName = (dirName: string): string => `${dirName}.done`

async function markStaged(runDir: FileSystemDirectoryHandle, dirName: string): Promise<void> {
  const handle = await runDir.getFileHandle(stagedMarkerName(dirName), { create: true })
  const writable = await handle.createWritable()
  await writable.write('1')
  await writable.close()
}

async function isStagedMarked(runDir: FileSystemDirectoryHandle, dirName: string): Promise<boolean> {
  try {
    await runDir.getFileHandle(stagedMarkerName(dirName))
    return true
  } catch (e) {
    // Absence = not marked. A real read failure must propagate: treating it
    // as "unmarked" would make recovery DROP a staged backup that is the
    // only remaining copy of the skill.
    if (isNotFoundError(e)) return false
    throw e
  }
}

/** Rewrite a run's fresh-targets.json with `names` (empty array deletes it). */
async function writeFreshTargetRecord(
  runDir: FileSystemDirectoryHandle,
  names: string[],
): Promise<void> {
  if (names.length === 0) {
    try {
      await runDir.removeEntry('fresh-targets.json')
    } catch (e) {
      if (!isNotFoundError(e)) throw e
    }
    return
  }
  const handle = await runDir.getFileHandle('fresh-targets.json', { create: true })
  const writable = await handle.createWritable()
  await writable.write(JSON.stringify(names))
  await writable.close()
}

async function recoverAbandonedImportBackups(): Promise<void> {
  const locks = getWebLocks()
  if (locks) {
    await locks.request(IMPORT_LOCK_GLOBAL, recoverAbandonedImportBackupsInner)
  } else {
    // Imports are refused without Web Locks. Only durably finished runs can
    // be recovered in that environment; the liveness check enforces this.
    await recoverAbandonedImportBackupsInner()
  }
}

async function readImportOwner(
  userDir: FileSystemDirectoryHandle,
  dirName: string,
): Promise<string | null> {
  let target: FileSystemDirectoryHandle
  try {
    target = await userDir.getDirectoryHandle(dirName)
  } catch (e) {
    if (isNotFoundError(e)) return null
    throw e
  }
  try {
    const handle = await target.getFileHandle(IMPORT_OWNER_FILE)
    return await (await handle.getFile()).text()
  } catch (e) {
    if (isNotFoundError(e)) return ''
    throw e
  }
}

async function writeImportOwner(target: FileSystemDirectoryHandle, runId: string): Promise<void> {
  const handle = await target.getFileHandle(IMPORT_OWNER_FILE, { create: true })
  const writable = await handle.createWritable()
  await writable.write(runId)
  await writable.close()
}

async function recoverAbandonedImportBackupsInner(): Promise<void> {
  let backupsRoot: FileSystemDirectoryHandle
  let userDir: FileSystemDirectoryHandle
  try {
    const opfsRoot = await navigator.storage.getDirectory()
    const skillsDir = await opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: false })
    backupsRoot = await skillsDir.getDirectoryHandle(IMPORT_BACKUPS_DIR, { create: false })
    // The user dir normally exists (the crashed import had removed a skill
    // from it); create it if missing so restore always has a target.
    userDir = await skillsDir.getDirectoryHandle(USER_SKILLS_DIR, { create: true })
  } catch {
    // No `.skills/.import-backups/` (or no skills root) — nothing abandoned.
    return
  }

  // Snapshot run names first: removing entries during iteration would be
  // fragile against the handle's async iterator.
  const runIds: string[] = []
  for await (const [name, entry] of backupsRoot.entries()) {
    if (entry.kind === 'directory') runIds.push(name)
  }

  for (const runId of runIds) {
    try {
      const runDir = await backupsRoot.getDirectoryHandle(runId)
      // An import still executing (this tab, or another holding its run
      // Web Lock) has staged its backup as the LIVE rollback copy —
      // restoring/consuming it mid-import would leave the import without
      // a rollback path. Leave the run untouched; if the import finishes
      // it cleans up after itself, and if it crashes the NEXT scan (after
      // the lock is released) recovers it.
      if (await isImportRunActive(runId)) continue
      const state = await readImportRunState(runDir)
      if (state?.status === 'import-complete') {
        // The import finished successfully; only its cleanup crashed.
        // Restoring the backups would REVERT the good import — drop them.
        await backupsRoot.removeEntry(runId, { recursive: true })
        continue
      }
      // A FRESH-target record (written before any bytes hit a new skill's
      // directory) means an interrupted import may have left a PARTIALLY
      // written fresh skill: recovery must remove those incomplete targets
      // so they never look installed.
      let incompleteFresh: string[] = []
      try {
        const freshHandle = await runDir.getFileHandle('fresh-targets.json')
        const freshFile = await freshHandle.getFile()
        const parsed: unknown = JSON.parse(await freshFile.text())
        if (Array.isArray(parsed)) {
          incompleteFresh = parsed.filter(
            (n): n is string => typeof n === 'string' && n.length > 0,
          )
        }
      } catch (e) {
        if (!isNotFoundError(e)) {
          // Unreadable record: leave the whole run for a later retry rather
          // than risking a partial fresh skill being treated as installed.
          console.warn(
            `[UserSkillsScanner] Failed to read fresh-target record of run ${runId}:`,
            e,
          )
          continue
        }
      }
      let freshRemovalFailures = false
      const removedFresh = new Set<string>()
      for (const dirName of incompleteFresh) {
        try {
          // An old journal cannot remove a directory installed by a later
          // run. Legacy unmarked targets are intentionally left intact.
          if (await readImportOwner(userDir, dirName) !== runId) {
            removedFresh.add(dirName)
            continue
          }
          await userDir.removeEntry(dirName, { recursive: true })
          removedFresh.add(dirName)
          console.log(
            `[UserSkillsScanner] Removed incomplete fresh skill "${dirName}" from interrupted import (run ${runId}).`,
          )
        } catch (removeErr) {
          if (!isNotFoundError(removeErr)) {
            // A REAL removal failure: the partial fresh skill is still on
            // disk. Retain its record (and the run directory) so the next
            // scan retries the cleanup — deleting the record now would
            // strand the partial skill permanently as "installed".
            freshRemovalFailures = true
            console.warn(
              `[UserSkillsScanner] Failed to remove incomplete fresh skill "${dirName}" (run ${runId}):`,
              removeErr,
            )
          }
        }
      }
      if (freshRemovalFailures) {
        // Keep fresh-targets.json (only the REMOVED names are dropped — the
        // failing ones stay recorded) and the run directory for a retry.
        const remaining = incompleteFresh.filter((n) => !removedFresh.has(n))
        try {
          await writeFreshTargetRecord(runDir, remaining)
          console.warn(
            `[UserSkillsScanner] Retaining fresh-target record of run ${runId} for retry: ${remaining.join(', ')}`,
          )
        } catch (recordErr) {
          console.warn(
            `[UserSkillsScanner] Failed to update fresh-target record of run ${runId}:`,
            recordErr,
          )
        }
        continue
      }
      if (incompleteFresh.length > 0) {
        try {
          await runDir.removeEntry('fresh-targets.json')
        } catch {
          // Best-effort — the run dir removal below covers it anyway.
        }
      }
      // Interrupted staging / import, or a failed rollback: restore only the
      // MARKED staged entries have a complete backup. The ownership check
      // below distinguishes a missing or run-owned target from newer
      // content; unmarked staging may be partial and is never restored.
      const stagedNames: string[] = []
      for await (const [name, entry] of runDir.entries()) {
        if (entry.kind === 'directory') stagedNames.push(name)
      }
      let restoredAll = true
      for (const dirName of stagedNames) {
        if (!(await isStagedMarked(runDir, dirName))) continue
        try {
          const owner = await readImportOwner(userDir, dirName)
          if (owner !== null && owner !== runId) {
            // Existing unowned content may be a newer install. Preserve
            // both it and the backup until ownership can be established.
            restoredAll = false
            continue
          }
          const stagedDir = await runDir.getDirectoryHandle(dirName)
          const files = await readStagedBackup(stagedDir)
          if (Object.keys(files).length === 0) continue
          await restoreUserSkillDir(userDir, dirName, files, runId)
          console.log(
            `[UserSkillsScanner] Restored skill "${dirName}" from abandoned import backup (run ${runId}).`,
          )
        } catch (restoreErr) {
          restoredAll = false
          console.warn(
            `[UserSkillsScanner] Failed to restore "${dirName}" from abandoned import backup run ${runId}:`,
            restoreErr,
          )
        }
      }
      if (restoredAll) {
        await backupsRoot.removeEntry(runId, { recursive: true })
      }
    } catch (e) {
      // Leave this run's backup in place — the next scan retries recovery.
      console.warn(
        `[UserSkillsScanner] Failed to recover abandoned import backup run ${runId}:`,
        e,
      )
    }
  }
}

/**
 * Scan `.skills/user/` for all SKILL.md files and their resources.
 *
 * Each subdirectory under `user/` is treated as a skill:
 *   .skills/user/<skill-name>/SKILL.md       (required)
 *   .skills/user/<skill-name>/scripts/*.py   (optional)
 *   .skills/user/<skill-name>/references/*.md (optional)
 *   .skills/user/<skill-name>/assets/*        (optional)
 *
 * Before scanning, abandoned import backups (left by an import whose tab
 * died mid-write) are recovered, so restored skills are included in the
 * same scan result.
 *
 * @returns Parsed skills with source='user', resources, and any errors. When
 *          two scans overlap, the LATER-started one's result wins: an
 *          earlier scan that finishes after a newer one must not push a
 *          stale directory view over the newer result (the caller caches
 *          whatever this returns, so last-started == last-write).
 */
let lastScanStartedSeq = 0
// Serialization chain: each scan waits for the previous scan's OPFS walk to
// finish before starting its own — two overlapping scans must not interleave
// their directory reads (walker results are only unsafe to MERGE).
let scanTail: Promise<unknown> = Promise.resolve()
// The most recently STARTED scan's result promise — superseded scans adopt
// it (see below) instead of publishing their own stale view.
let latestScan: Promise<UserSkillScanResult> | null = null

export async function scanUserSkills(): Promise<UserSkillScanResult> {
  const seq = ++lastScanStartedSeq
  const run = scanTail.then(() => scanUserSkillsInner())
  scanTail = run.catch(() => {}) // never let a failure break the chain
  latestScan = run
  const result = await run
  // A newer scan started while this one queued/ran: report ITS result so an
  // older refresh never overwrites the manager cache with a stale directory
  // view (both callers then apply the identical, freshest result — and the
  // newer scan's own write, being last, wins deterministically).
  if (seq !== lastScanStartedSeq) {
    // The newer scan FAILED: its rejection must not propagate into THIS
    // caller — refreshUserSkills clears the cached user skills on rejection,
    // so rethrowing would hide valid skills that this scan already read.
    // Fall back to this scan's own (successful, pre-newer) directory view.
    try {
      return await latestScan!
    } catch {
      return result
    }
  }
  return result
}

async function scanUserSkillsInner(): Promise<UserSkillScanResult> {
  const skills: Skill[] = []
  const resources: SkillResource[] = []
  const errors: string[] = []

  try {
    await recoverAbandonedImportBackups()
  } catch (e) {
    // Recovery is best-effort — never block the scan on it.
    console.warn('[UserSkillsScanner] Import-backup recovery failed:', e)
  }

  const userDir = await getUserSkillsDir()
  if (!userDir) {
    // No user skills directory yet — this is normal
    return { skills, resources, errors }
  }

  for await (const [name, entry] of userDir.entries()) {
    if (entry.kind !== 'directory') continue

    const skillDirHandle = await userDir.getDirectoryHandle(name)
    const result = await scanSingleUserSkill(skillDirHandle, name)

    if (result.skill) {
      skills.push(result.skill)
      resources.push(...result.resources)
      errors.push(...result.errors)
    } else if (result.errors.length > 0) {
      errors.push(...result.errors)
    }
  }

  if (skills.length > 0) {
    console.log(
      `[UserSkillsScanner] Found ${skills.length} user skill(s):`,
      skills.map((s) => s.name)
    )
  }

  return { skills, resources, errors }
}

/**
 * Scan a single user skill directory.
 */
async function scanSingleUserSkill(
  skillDirHandle: FileSystemDirectoryHandle,
  dirName: string
): Promise<{ skill: Skill | null; resources: SkillResource[]; errors: string[] }> {
  const resources: SkillResource[] = []
  const errors: string[] = []

  // Find SKILL.md
  let skillMdHandle: FileSystemFileHandle | null = null
  try {
    skillMdHandle = await skillDirHandle.getFileHandle('SKILL.md')
  } catch {
    // No SKILL.md in this directory — skip
    return { skill: null, resources, errors }
  }

  // Read and parse SKILL.md
  let content: string
  let fileMtime = 0
  try {
    const file = await skillMdHandle.getFile()
    content = await file.text()
    fileMtime = file.lastModified
  } catch (e) {
    errors.push(`user/${dirName}/SKILL.md: ${e instanceof Error ? e.message : String(e)}`)
    return { skill: null, resources, errors }
  }

  const result = parseSkillMd(content, 'user')
  if (!result.skill) {
    errors.push(`user/${dirName}/SKILL.md: ${result.error ?? 'parse error'}`)
    return { skill: null, resources, errors }
  }

  // Use directory name as skill ID (it's already slug-safe)
  // ParseSkillMd generates ID from name via slugify, but directory name is
  // the authoritative ID for user skills.
  const skill = result.skill
  skill.id = `user:${dirName}`
  skill.source = 'user'
  // Use the actual file modification time so multiple skills imported
  // around the same time can be distinguished by when their SKILL.md
  // was last edited.
  if (fileMtime) {
    skill.updatedAt = fileMtime
    skill.createdAt = fileMtime
  }

  // Scan resources (same logic as project skill scanner)
  await scanUserSkillResources(skillDirHandle, skill.id, resources, errors)

  return { skill, resources, errors }
}

/**
 * Scan resource files in a user skill directory.
 */
async function scanUserSkillResources(
  skillDirHandle: FileSystemDirectoryHandle,
  skillId: string,
  resources: SkillResource[],
  errors: string[]
): Promise<void> {
  let totalSize = 0
  let fileCount = 0

  const ignoredDirs = new Set([
    '.git', '.svn', '.hg', 'node_modules', '__pycache__', '.pytest_cache', '.venv', 'venv',
  ])

  const scanRecursive = async (
    dirHandle: FileSystemDirectoryHandle,
    relativeDir: string
  ): Promise<void> => {
    for await (const [name, entry] of dirHandle.entries()) {
      if (entry.kind === 'directory') {
        if (ignoredDirs.has(name)) continue
        const subDir = await dirHandle.getDirectoryHandle(name)
        const nextRelativeDir = relativeDir ? `${relativeDir}/${name}` : name
        await scanRecursive(subDir, nextRelativeDir)
        continue
      }

      // Skip SKILL.md — it's the skill instruction, not a resource
      if (name.toUpperCase() === 'SKILL.MD') continue
      if (name === IMPORT_OWNER_FILE) continue

      const resourcePath = relativeDir ? `${relativeDir}/${name}` : name

      try {
        const file = await entry.getFile()
        const size = file.size

        if (size > RESOURCE_LIMITS.MAX_FILE_SIZE) {
          errors.push(`${skillId}/${resourcePath}: File too large (${size} bytes)`)
          continue
        }
        if (totalSize + size > RESOURCE_LIMITS.MAX_TOTAL_SIZE) {
          errors.push(`${skillId}/${resourcePath}: Total resources too large, skipping`)
          break
        }
        if (fileCount >= RESOURCE_LIMITS.MAX_RESOURCES_PER_SKILL) {
          errors.push(`${skillId}/${resourcePath}: Too many resource files, skipping`)
          break
        }

        if (!isTextFile(name)) {
          // Binary resources are available via OPFS but not loaded as text
          continue
        }

        const fileContent = await file.text()
        const contentType = getMimeType(name)
        const topLevelDir = resourcePath.split('/')[0] || ''
        const resourceType = getResourceType(topLevelDir)

        resources.push({
          id: generateResourceId(skillId, resourcePath),
          skillId,
          resourcePath,
          resourceType,
          content: fileContent,
          contentType,
          size,
          createdAt: Date.now(),
        })

        totalSize += size
        fileCount++
      } catch (e) {
        errors.push(`${skillId}/${resourcePath}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }

  await scanRecursive(skillDirHandle, '')
}

/**
 * Derive the OPFS directory name for a skill.
 *
 * Uses the shared `slugify` function (same logic used by `parseSkillMd` to
 * generate a skill ID from its name, and by `importSkillMd` in the store).
 * This ensures that migration, import, and manual creation all derive the
 * **same** directory name from a given skill name, preventing duplicates.
 *
 * Skill names already use `cw-` kebab-case (filesystem-safe), so in practice
 * `slugify(name)` returns the name unchanged for well-formed names.
 *
 * @param name  Skill display name (e.g. `cw-my-skill`)
 * @param id    Skill ID (used only as a fallback if name is empty)
 */
function deriveDirName(name: string, id: string): string {
  // Prefer the name — it's what import/create use to derive the dir.
  // Fall back to the ID segment after the last ':' (e.g. legacy `user:foo`).
  const candidate = name || id.split(':').pop() || ''
  return slugify(candidate)
}

/**
 * Migrate user skills from SQLite to OPFS `.skills/user/`.
 *
 * Older versions of the app stored user-created skills in the SQLite `skills`
 * table with `source = 'user'`. The current architecture uses OPFS
 * `.skills/user/<dir>/SKILL.md` as the single source of truth.
 *
 * This function:
 *   1. Queries SQLite for `source = 'user'` skills
 *   2. For each, writes SKILL.md + resources to OPFS (if not already present)
 *   3. Deletes the record from SQLite (after successful OPFS write)
 *
 * The migration is idempotent — if the OPFS directory already exists,
 * the skill is treated as already migrated and the SQLite record is pruned.
 *
 * @returns Summary of migrated/pruned skills
 */
export async function migrateUserSkillsFromSQLite(): Promise<{
  migrated: string[]
  pruned: string[]
  errors: string[]
}> {
  const migrated: string[] = []
  const pruned: string[] = []
  const errors: string[] = []

  // Import lazily to avoid circular dependencies during module init
  const { getSkillRepository } = await import('@/sqlite')
  const repo = getSkillRepository()

  let legacySkills
  try {
    legacySkills = await repo.findBySource('user')
  } catch (e) {
    // SQLite not ready or table missing — nothing to migrate
    errors.push(`findBySource failed: ${e instanceof Error ? e.message : String(e)}`)
    return { migrated, pruned, errors }
  }

  if (legacySkills.length === 0) {
    return { migrated, pruned, errors }
  }

  console.log(
    `[UserSkillsScanner] Migrating ${legacySkills.length} user skill(s) from SQLite to OPFS`
  )

  const opfsRoot = await navigator.storage.getDirectory()
  const skillsDir = await opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: true })
  const userDir = await skillsDir.getDirectoryHandle(USER_SKILLS_DIR, { create: true })

  for (const skill of legacySkills) {
    const dirName = deriveDirName(skill.name, skill.id)
    if (!dirName) {
      errors.push(`Skill ${skill.id}: could not derive directory name`)
      continue
    }

    try {
      // Check if OPFS directory already exists (already migrated)
      let skillDir: FileSystemDirectoryHandle
      try {
        skillDir = await userDir.getDirectoryHandle(dirName)
        // Directory exists — skill was already migrated, just prune SQLite
        await repo.delete(skill.id)
        pruned.push(skill.id)
        continue
      } catch {
        // Not found — create it
        skillDir = await userDir.getDirectoryHandle(dirName, { create: true })
      }

      // Write SKILL.md (prefer rawContent, fallback to re-serialised instruction)
      const skillMdContent =
        skill.rawContent ||
        skill.instruction ||
        `# ${skill.name}\n\n${skill.description || ''}\n`
      const mdHandle = await skillDir.getFileHandle('SKILL.md', { create: true })
      const writable = await mdHandle.createWritable()
      await writable.write(skillMdContent)
      await writable.close()

      // Write resource files
      let resources: SkillResource[]
      try {
        resources = await repo.getResources(skill.id)
      } catch {
        resources = []
      }
      for (const resource of resources) {
        try {
          const parts = resource.resourcePath.split('/').filter(Boolean)
          const fileName = parts.pop()!
          let dir = skillDir
          for (const part of parts) {
            dir = await dir.getDirectoryHandle(part, { create: true })
          }
          const resHandle = await dir.getFileHandle(fileName, { create: true })
          const rw = await resHandle.createWritable()
          await rw.write(resource.content)
          await rw.close()
        } catch (e) {
          errors.push(
            `Skill ${skill.id} resource ${resource.resourcePath}: ${e instanceof Error ? e.message : String(e)}`
          )
        }
      }

      // Migration of this skill succeeded — delete from SQLite
      await repo.delete(skill.id)
      migrated.push(skill.id)
      console.log(`[UserSkillsScanner] Migrated user skill: ${skill.id} → .skills/user/${dirName}/`)
    } catch (e) {
      errors.push(`Skill ${skill.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  console.log(
    `[UserSkillsScanner] Migration complete: ${migrated.length} migrated, ${pruned.length} pruned, ${errors.length} errors`
  )

  return { migrated, pruned, errors }
}

/**
 * Write a user skill SKILL.md to OPFS `.skills/user/<dirName>/SKILL.md`.
 * Creates intermediate directories as needed.
 *
 * @param dirName  Skill directory name (slug-safe)
 * @param content  SKILL.md file content
 */
export async function writeUserSkillMd(dirName: string, content: string): Promise<void> {
 const opfsRoot = await navigator.storage.getDirectory()
 const skillsDir = await opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: true })
 const userDir = await skillsDir.getDirectoryHandle(USER_SKILLS_DIR, { create: true })
 const skillDir = await userDir.getDirectoryHandle(dirName, { create: true })
 const mdHandle = await skillDir.getFileHandle('SKILL.md', { create: true })
 const writable = await mdHandle.createWritable()
 await writable.write(content)
 await writable.close()
}

/**
 * Import a skill folder from a native FileSystemDirectoryHandle into OPFS
 * `.skills/user/<dirName>/`.
 *
 * Folder imports go through the SAME pipeline as ZIP imports
 * (`importUserSkillZip`): per-directory cross-tab serialization (Web Lock
 * on `dir:<dirName>` plus the global lock), durable staged backups with
 * crash recovery, and rollback on failure. A folder import overlapping a
 * ZIP import of the same skill (even from another tab) therefore cannot
 * interleave remove/backup/write steps — one import would otherwise erase
 * or overwrite the other's result.
 *
 * @param srcDirHandle  Source folder handle (from drag-drop or folder picker)
 * @returns the number of files copied.
 */
export async function importUserSkillFolder(
  srcDirHandle: FileSystemDirectoryHandle,
): Promise<number> {
  const dirName = srcDirHandle.name
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(dirName)) {
    throw new Error(
      `Folder name "${dirName}" is not a valid skill directory name (letters, digits, hyphens).`,
    )
  }
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const skill: ZipSkillEntry = { dirName, entries: [], fileCount: 0, _commonRoot: '' }
  // Folder and ZIP imports share the same cross-tab lock and durable backup
  // transaction, so neither can overwrite the other's in-flight changes.
  return withImportSerialization(runId, [dirName], () =>
    importUserSkillZipInner({ isBundle: false, skill, _raw: {} }, [skill], runId,
      (target) => copyDirectoryRecursive(srcDirHandle, target)))
}

/**
 * Result of inspecting a single skill inside a zip — used for preview UI.
 */
export interface ZipSkillEntry {
  /** Skill directory name (inferred from zip filename or root folder) */
  dirName: string
  /** File tree for preview */
  entries: import('./skill-folder-utils').FileEntry[]
  /** File count for this skill */
  fileCount: number
  /** The common root prefix in the zip (e.g. "skills/my-skill/") */
  _commonRoot: string
}

/**
 * Result of inspecting a zip before import — used for preview UI.
 * Supports both single-skill and multi-skill (bundle) zips.
 */
export interface ZipSkillPreview {
  /** Whether this zip contains multiple skills (bundle mode) */
  isBundle: boolean
  /** Single skill preview (when isBundle=false) */
  skill?: ZipSkillEntry
  /** Multiple skill previews (when isBundle=true) */
  skills?: ZipSkillEntry[]
  /** The raw unzipped entries (path → data), kept for the actual write */
  _raw: Record<string, Uint8Array>
}

/** Find all SKILL.md paths in the unzipped data (case-insensitive). */
function findAllSkillMdPaths(paths: string[]): string[] {
  return paths.filter((p) => p.split('/').pop()?.toLowerCase() === 'skill.md')
}

/**
 * Build a single ZipSkillEntry from a SKILL.md path within the zip.
 * Derives dirName and collects all files under the same root.
 */
function buildSkillEntry(
  allPaths: string[],
  skillMdPath: string,
  _raw: Record<string, Uint8Array>,
  fallbackDirName: string,
): ZipSkillEntry {
  // Determine the common root prefix for this skill (everything before SKILL.md).
  const segments = skillMdPath.split('/')
  const commonRoot = segments.length > 1 ? segments.slice(0, -1).join('/') + '/' : ''

  // Infer dirName: prefer the top-level folder name, otherwise use fallback.
  let dirName: string
  if (commonRoot) {
    dirName = commonRoot.replace(/\/$/, '')
    // For bundle mode, dirName might be nested (e.g. "skills/my-skill").
    // Take only the last segment as the actual skill directory name.
    if (dirName.includes('/')) {
      dirName = dirName.split('/').pop()!
    }
  } else {
    dirName = fallbackDirName
  }

  // Collect paths that belong to this skill (under commonRoot).
  const skillPaths = commonRoot
    ? allPaths.filter((p) => p.startsWith(commonRoot))
    : allPaths

  // Strip common root for preview
  const relativePaths = skillPaths.map((p) =>
    commonRoot && p.startsWith(commonRoot) ? p.slice(commonRoot.length) : p,
  )

  return {
    dirName,
    entries: buildFileTreeFromPaths(relativePaths),
    fileCount: skillPaths.length,
    _commonRoot: commonRoot,
  }
}

/**
 * Inspect a zip file for skill import (stage 1 — validation + preview).
 *
 * Unzips in memory, finds SKILL.md file(s), and builds preview data.
 * Supports both single-skill zips and multi-skill bundle zips.
 *
 * @param zipFile  The .zip File object (from drag-drop or file picker)
 * @returns preview data, or throws if the zip is invalid.
 */
export async function previewUserSkillZip(zipFile: File): Promise<ZipSkillPreview> {
  // Size caps BEFORE any unzip work: reject oversized archives up front
  // instead of buffering them (decompression-bomb guard).
  if (zipFile.size > ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE) {
    throw new Error(
      `ZIP archive is too large (${zipFile.size} bytes; limit: ${ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE} bytes).`,
    )
  }
  const buffer = await zipFile.arrayBuffer()
  const unzipped = await unzipWithLimits(new Uint8Array(buffer))

  // Build a list of file paths (skip directory entries ending with '/')
  const allPaths = Object.keys(unzipped).filter((p) => !p.endsWith('/'))
  if (allPaths.length === 0) {
    throw new Error('ZIP archive is empty')
  }

  // Find all SKILL.md files (case-insensitive)
  const skillMdPaths = findAllSkillMdPaths(allPaths)
  if (skillMdPaths.length === 0) {
    throw new Error('No SKILL.md found in ZIP archive')
  }

  const fallbackDirName = zipFile.name.replace(/\.zip$/i, '')

  // Build skill entries for each SKILL.md found
  const skills = skillMdPaths.map((mdPath) =>
    buildSkillEntry(allPaths, mdPath, unzipped, fallbackDirName),
  )

  // Validate dirNames — they must be safe identifiers.
  for (const skill of skills) {
    if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(skill.dirName)) {
      throw new Error(
        `Invalid skill name "${skill.dirName}". Skill folder names must start with a letter and contain only letters, digits, and hyphens (e.g. "my-skill").`,
      )
    }
  }

  if (skills.length === 1) {
    return {
      isBundle: false,
      skill: skills[0],
      _raw: unzipped,
    }
  }

  return {
    isBundle: true,
    skills,
    _raw: unzipped,
  }
}

/**
 * Import a single skill from unzipped data into OPFS `.skills/user/<dirName>/`.
 *
 * @param raw       The raw unzipped entries (path → data)
 * @param dirName   Target skill directory name
 * @param commonRoot  The common root prefix to strip from each path
 * @returns the number of files written.
 */
async function writeZipSkillToOpfs(
  raw: Record<string, Uint8Array>,
  dirName: string,
  commonRoot: string,
  /** Pre-created directory handle — skips the internal removal when the caller already staged the target. */
  precreatedDir?: FileSystemDirectoryHandle,
): Promise<number> {
  let skillDir: FileSystemDirectoryHandle
  if (precreatedDir) {
    skillDir = precreatedDir
  } else {
    const opfsRoot = await navigator.storage.getDirectory()
    const skillsDir = await opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: true })
    const userDir = await skillsDir.getDirectoryHandle(USER_SKILLS_DIR, { create: true })

    // Remove existing skill directory to avoid stale files
    try {
      await userDir.removeEntry(dirName, { recursive: true })
    } catch {
      // Directory doesn't exist yet — fine
    }
    skillDir = await userDir.getDirectoryHandle(dirName, { create: true })
  }
  let fileCount = 0

  for (const [path, data] of Object.entries(raw)) {
    if (path.endsWith('/')) continue

    // Only process files under this skill's common root
    if (commonRoot && !path.startsWith(commonRoot)) continue

    // Strip common root prefix
    const relPath = commonRoot && path.startsWith(commonRoot)
      ? path.slice(commonRoot.length)
      : path

    // Split into path segments and navigate/create intermediate dirs
    const parts = relPath.split('/').filter(Boolean)
    if (parts.length === 0) continue
    if (parts.length === 1 && parts[0] === IMPORT_OWNER_FILE) {
      throw new Error(`ZIP archive contains reserved import file ${IMPORT_OWNER_FILE}.`)
    }

    let currentDir = skillDir
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true })
    }

    const fileHandle = await currentDir.getFileHandle(parts[parts.length - 1], { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(data)
    await writable.close()
    fileCount++
  }

  return fileCount
}

/**
 * Write a flat map of relative paths → data into `dirHandle` (staging and
 * restore helper).
 */
async function writeSkillFiles(
  dirHandle: FileSystemDirectoryHandle,
  files: Record<string, Uint8Array>,
): Promise<void> {
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let currentDir = dirHandle
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true })
    }
    const fileHandle = await currentDir.getFileHandle(parts[parts.length - 1], { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(data)
    await writable.close()
  }
}

/**
 * Read a staged backup directory back from OPFS (restore path for a failed
 * overwrite-import). Unlike the in-memory backup map, this survives a tab
 * close during the import window.
 */
async function readStagedBackup(
  stagedDir: FileSystemDirectoryHandle,
): Promise<Record<string, Uint8Array>> {
  const readRecursive = async (
    dirHandle: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<Record<string, Uint8Array>> => {
    const out: Record<string, Uint8Array> = {}
    for await (const [name, entry] of dirHandle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name
      if (entry.kind === 'directory') {
        const sub = await dirHandle.getDirectoryHandle(name)
        Object.assign(out, await readRecursive(sub, path))
      } else {
        const file = await (entry as FileSystemFileHandle).getFile()
        out[path] = new Uint8Array(await file.arrayBuffer())
      }
    }
    return out
  }
  return readRecursive(stagedDir, '')
}

/**
 * Import a previewed zip skill into OPFS `.skills/user/<dirName>/` (stage 2).
 *
 * For single-skill zips, imports the one skill.
 * For bundle zips, imports all skills.
 *
 * Imports of the SAME target directories are SERIALIZED across callers and
 * tabs (in-tab promise chain + cross-tab Web Lock on `dir:<dirKey>`): two
 * concurrent imports of one skill must not interleave their remove/write
 * phases, or both can report success while the installed directory holds a
 * mix of files from both archives.
 *
 * Backups are DURABLE: before any original is removed, the previous content
 * is staged on disk under `.skills/.import-backups/<runId>/<dirName>/`, so a
 * tab close between removal and rollback cannot lose the skill — the backup
 * survives in OPFS. On success the staged run directory is deleted; on
 * failure the skill is restored FROM THE STAGED DIRECTORY (not memory) and
 * the run directory is then cleaned up.
 *
 * On failure, only the directories THIS import actually touched are cleaned
 * up: directories that did not exist before the import are removed, and
 * directories that were overwritten are restored from the staged backup — a
 * previously installed skill that merely appears in a failed bundle preview
 * is never deleted.
 *
 * @param preview  The preview returned by previewUserSkillZip
 * @returns the total number of files written across all skills.
 */
export async function importUserSkillZip(
  preview: ZipSkillPreview,
  options: { ifAbsent?: boolean } = {},
): Promise<number> {
  const skills = preview.isBundle ? (preview.skills ?? []) : preview.skill ? [preview.skill] : []

  if (skills.length === 0) return 0

  // A bundle whose SKILL.md files live under different paths but collapse to
  // the SAME final folder name would funnel every entry into one target
  // directory: later entries overwrite matching files while files unique to
  // earlier entries survive — an incoherent merge of distinct skills. Reject
  // the bundle before ANY staging/writing.
  const seenDirNames = new Set<string>()
  for (const s of skills) {
    if (seenDirNames.has(s.dirName)) {
      throw new Error(
        `ZIP bundle contains duplicate skill folders ("${s.dirName}") — each skill must live in its own folder.`,
      )
    }
    seenDirNames.add(s.dirName)
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  const dirNames = [...seenDirNames].sort()
  return withImportSerialization(runId, dirNames, async () => {
    if (options.ifAbsent) {
      // This check must happen AFTER acquiring the cross-tab locks. A second
      // landing page may have observed "not installed" before the first one
      // committed, and must preserve that install and subsequent local edits.
      const root = await navigator.storage.getDirectory()
      const skillsRoot = await root.getDirectoryHandle(SKILLS_ROOT, { create: true })
      const userDir = await skillsRoot.getDirectoryHandle(USER_SKILLS_DIR, { create: true })
      for (const dirName of dirNames) {
        try {
          await userDir.getDirectoryHandle(dirName)
          return 0
        } catch (e) {
          if (!isNotFoundError(e)) throw e
        }
      }
    }
    return importUserSkillZipInner(preview, skills, runId)
  })
}

async function importUserSkillZipInner(
  preview: ZipSkillPreview,
  skills: ZipSkillEntry[],
  runId: string,
  writeFolder?: (target: FileSystemDirectoryHandle) => Promise<number>,
): Promise<number> {
  const { _raw } = preview

  const opfsRoot = await navigator.storage.getDirectory()
  const skillsDir = await opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: true })
  const userDir = await skillsDir.getDirectoryHandle(USER_SKILLS_DIR, { create: true })
  const backupsRoot = await skillsDir.getDirectoryHandle(IMPORT_BACKUPS_DIR, { create: true })
  const runDir = await backupsRoot.getDirectoryHandle(runId, { create: true })

  // Aggregate size of an existing skill BEFORE reading it into memory: a
  // huge installed tree (grown outside the import pipeline) must not be
  // buffered wholesale for backup — the incoming ZIP's caps say nothing
  // about the size of the skill it overwrites. Skills beyond the same
  // aggregate cap cannot be backed up safely and the import aborts before
  // touching anything.
  const backupSizeOf = async (dirName: string): Promise<number | null> => {
    let skillDir: FileSystemDirectoryHandle
    try {
      skillDir = await userDir.getDirectoryHandle(dirName)
    } catch (e) {
      if (isNotFoundError(e)) return null
      throw e
    }
    let total = 0
    let count = 0
    const measure = async (dir: FileSystemDirectoryHandle): Promise<void> => {
      for await (const [, entry] of dir.entries()) {
        if (entry.kind === 'directory') {
          await measure(await dir.getDirectoryHandle(entry.name))
          continue
        }
        const file = await (entry as FileSystemFileHandle).getFile()
        total += file.size
        count++
        if (
          total > ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE ||
          count > ZIP_IMPORT_LIMITS.MAX_ENTRIES
        ) {
          throw new Error(
            `Existing skill "${dirName}" exceeds the backup size limit (${total} bytes) — refusing to overwrite it.`,
          )
        }
      }
    }
    await measure(skillDir)
    return total
  }

  // Stage 1: back up every target directory that already exists — staged
  // DURABLY under .skills/.import-backups/<runId>/ — then remove it so
  // writeZipSkillToOpfs starts from a clean slate. The staged backups let
  // us restore the previous version if a later skill in the bundle fails,
  // even if this tab dies before the rollback runs.
  const backedUp = new Set<string>()
  try {
    for (const s of skills) {
      // Throws on a real read failure — absence (NotFoundError) returns
      // null and is the only "no backup needed" signal.
      const existingSize = await backupSizeOf(s.dirName)
      if (existingSize !== null) {
        const existing = await readUserSkillDir(userDir, s.dirName)
        const stagedDir = await runDir.getDirectoryHandle(s.dirName, { create: true })
        await writeSkillFiles(stagedDir, existing!)
        backedUp.add(s.dirName)
        // The target directory EXISTS (we just read it) — a removal failure
        // here is a real error, not absence: suppressing it would leave the
        // OLD files in place and let the import write into the surviving
        // directory, so files absent from the new archive stay installed as
        // stale content. Abort instead (the backup is staged, nothing lost).
        // Record a complete backup BEFORE removing the target. A crash
        // between removal and a later marker write would otherwise leave
        // the only copy unmarked and unrecoverable.
        await markStaged(runDir, s.dirName)
        await userDir.removeEntry(s.dirName, { recursive: true })
      }
    }
  } catch (e) {
    // Backup staging failed midway: earlier targets of THIS run may already
    // be staged-AND-removed — restore each of them NOW from its staged
    // backup so the on-disk state matches the pre-import state, then clean
    // up. A restore that fails keeps the run directory (markers + staged
    // copies intact) for the next scan's recovery instead of deleting the
    // only remaining backup.
    const restoreFailures: string[] = []
    for (const dirName of backedUp) {
      try {
        const stagedDir = await runDir.getDirectoryHandle(dirName)
        const files = await readStagedBackup(stagedDir)
        if (Object.keys(files).length > 0) {
          await restoreUserSkillDir(userDir, dirName, files, runId)
        }
      } catch (restoreErr) {
        restoreFailures.push(dirName)
        console.warn(
          `[UserSkillsScanner] Failed to restore ${dirName} after staging failure:`,
          restoreErr,
        )
      }
    }
    if (restoreFailures.length === 0) {
      try {
        await backupsRoot.removeEntry(runId, { recursive: true })
      } catch {
        // Cleanup best-effort.
      }
    } else {
      try {
        await writeImportRunState(runDir, { status: 'failed-rollback' })
      } catch {
        // State is best-effort: the markers remain either way, and an
        // interrupted import restores marked entries, so recovery still
        // retries the failed restores.
      }
    }
    throw e
  }

  const hasStagedBackup = async (dirName: string): Promise<boolean> => {
    if (!backedUp.has(dirName)) return false
    try {
      await runDir.getDirectoryHandle(dirName)
      return true
    } catch {
      return false
    }
  }

  // Durable record of FRESH targets (no pre-existing skill): a tab close
  // mid-write leaves no staged backup and no in-memory set, so recovery
  // would otherwise keep the partially written directory and treat it as
  // an installed skill. The record is written BEFORE any bytes hit the
  // target and cleared after the last file lands.
  const freshTargetsFile = 'fresh-targets.json'
  const freshTargets: string[] = skills
    .map((s) => s.dirName)
    .filter((d) => !backedUp.has(d))
  const writeFreshTargets = async (names: string[]): Promise<void> => {
    const handle = await runDir.getFileHandle(freshTargetsFile, { create: true })
    const writable = await handle.createWritable()
    await writable.write(JSON.stringify(names))
    await writable.close()
  }
  if (freshTargets.length > 0) {
    try {
      await writeFreshTargets(freshTargets)
    } catch (recordErr) {
      // Cannot record → a crash mid-write could leave an unrecoverable
      // partial fresh skill. Abort BEFORE touching the target — but stage-1
      // may already have REMOVED overwritten targets, so their staged
      // backups must be restored first (the fresh-target bookkeeping failure
      // is part of the same rollback path as any other pre-write failure).
      console.warn(
        `[UserSkillsScanner] Failed to record fresh-import targets for run ${runId}:`,
        recordErr,
      )
      const restoreFailures: string[] = []
      for (const dirName of backedUp) {
        try {
          const stagedDir = await runDir.getDirectoryHandle(dirName)
          const files = await readStagedBackup(stagedDir)
          if (Object.keys(files).length > 0) {
            await restoreUserSkillDir(userDir, dirName, files, runId)
          }
        } catch (restoreErr) {
          restoreFailures.push(dirName)
          console.warn(
            `[UserSkillsScanner] Failed to restore ${dirName} after fresh-target record failure:`,
            restoreErr,
          )
        }
      }
      if (restoreFailures.length === 0) {
        try {
          await backupsRoot.removeEntry(runId, { recursive: true })
        } catch (cleanupErr) {
          console.warn(
            `[UserSkillsScanner] Failed to clean up import backup staging ${runId}:`,
            cleanupErr,
          )
        }
      } else {
        // Some overwritten targets could not be restored: their staged
        // backups are the ONLY remaining copy — keep the run directory so
        // the next scan's recovery retries the restores.
        try {
          await writeImportRunState(runDir, { status: 'failed-rollback' })
        } catch (stateErr) {
          console.warn(
            `[UserSkillsScanner] Failed to persist rollback-failure state for run ${runId}:`,
            stateErr,
          )
        }
      }
      throw new Error(
        `Failed to record fresh-import targets for recovery: ${
          recordErr instanceof Error ? recordErr.message : String(recordErr)
        }`,
      )
    }
  }

  // Stage 2: write each skill, tracking exactly what this import wrote.
  const written = new Set<string>()
  try {
    let total = 0
    for (const s of skills) {
      // Create the target only when we actually write the skill — an
      // untouched skill's directory must not be (re)created on failure.
      const target = await userDir.getDirectoryHandle(s.dirName, { create: true })
      await writeImportOwner(target, runId)
      total += writeFolder
        ? await writeFolder(target)
        : await writeZipSkillToOpfs(_raw, s.dirName, s._commonRoot, target)
      await target.removeEntry(IMPORT_OWNER_FILE)
      written.add(s.dirName)
      // Fresh skill fully written — drop it from the durable recovery
      // record so a LATER crash cannot delete the completed skill.
      if (freshTargets.includes(s.dirName)) {
        try {
          await writeFreshTargets(freshTargets.filter((d) => d !== s.dirName))
        } catch (recordErr) {
          // Best-effort: the run state below (import-complete) still
          // clears the record on the success path.
          console.warn(
            `[UserSkillsScanner] Failed to update fresh-target record for ${s.dirName}:`,
            recordErr,
          )
        }
      }
    }
    // Success: the staged backups are no longer needed. Mark the run
    // import-complete FIRST (best-effort) so a cleanup crash can never make
    // recovery restore backups over the freshly installed skills, then
    // remove the staging directory.
    try {
      await writeImportRunState(runDir, { status: 'import-complete' })
    } catch (stateErr) {
      console.warn(
        `[UserSkillsScanner] Failed to mark run ${runId} import-complete:`,
        stateErr,
      )
    }
    try {
      await backupsRoot.removeEntry(runId, { recursive: true })
    } catch (cleanupErr) {
      console.warn(
        `[UserSkillsScanner] Failed to clean up import backup staging ${runId}:`,
        cleanupErr,
      )
    }
    return total
  } catch (e) {
    // Stage 3 (cleanup): restore overwritten skills from their STAGED
    // backups (disk — survives even if this tab is closing), remove
    // directories created fresh by this failed import, and recreate
    // (empty) directories we removed but never reached. Never touch
    // anything this import did not write or stage.
    const restoreFromStaging = async (dirName: string) => {
      const stagedDir = await runDir.getDirectoryHandle(dirName)
      const files = await readStagedBackup(stagedDir)
      await restoreUserSkillDir(userDir, dirName, files, runId)
    }
    const rollbackFailures: string[] = []
    for (const dirName of written) {
      try {
        if (await hasStagedBackup(dirName)) {
          await restoreFromStaging(dirName)
        } else {
          await userDir.removeEntry(dirName, { recursive: true })
        }
      } catch (restoreErr) {
        rollbackFailures.push(dirName)
        console.warn(
          `[UserSkillsScanner] Failed to roll back ${dirName}:`,
          restoreErr,
        )
      }
    }
    for (const s of skills) {
      if (written.has(s.dirName)) continue
      try {
        if (await hasStagedBackup(s.dirName)) {
          // Staged-but-never-reached skill: its previous directory was
          // removed in stage 1 — restore it so it is exactly as before.
          await restoreFromStaging(s.dirName)
        } else {
          // Freshly created by the failed write attempt (or its
          // self-removal path) — remove the partial directory so it never
          // looks installed.
          await userDir.removeEntry(s.dirName, { recursive: true })
        }
      } catch (restoreErr) {
        rollbackFailures.push(s.dirName)
        console.warn(
          `[UserSkillsScanner] Failed to roll back untouched skill ${s.dirName}:`,
          restoreErr,
        )
      }
    }
    if (rollbackFailures.length > 0) {
      // The staged backups are the ONLY remaining copy of those skills.
      // Keep the run directory and mark it failed-rollback: the next
      // scan's recovery retries the restores from disk. Deleting the run
      // directory here would destroy the user's skills permanently.
      try {
        await writeImportRunState(runDir, { status: 'failed-rollback' })
      } catch (stateErr) {
        console.warn(
          `[UserSkillsScanner] Failed to persist rollback-failure state for run ${runId}:`,
          stateErr,
        )
      }
      console.error(
        `[UserSkillsScanner] Rollback failed for: ${rollbackFailures.join(', ')} — the previous versions will be restored on the next scan.`,
      )
      // The staged backups are the only remaining copy of the failed
      // restores — keep the run directory (return instead of falling
      // through to the cleanup below).
      throw e
    }
    // Rollback fully succeeded — clean up the staged run directory.
    try {
      await backupsRoot.removeEntry(runId, { recursive: true })
    } catch (cleanupErr) {
      console.warn(
        `[UserSkillsScanner] Failed to clean up import backup staging ${runId}:`,
        cleanupErr,
      )
    }
    throw e
  }
}

/**
 * Read every file under `.skills/user/<dirName>/` into memory (backup).
 *
 * Returns null ONLY when the directory does not exist (absence). Any other
 * error — a failing getFile, an unreadable entry, a partial read — throws,
 * so a caller must never interpret a real read failure as "nothing to
 * back up" and proceed without a backup (that would let a later failed
 * import delete the user's existing skill).
 */
async function readUserSkillDir(
  userDir: FileSystemDirectoryHandle,
  dirName: string,
): Promise<Record<string, Uint8Array> | null> {
  // Aggregate cap for the existing tree being read into memory: an
  // overwrite-import only promises the INCOMING zip is within limits — the
  // skill it replaces may have grown beyond them (e.g. hand-edited). Buffer
  // such a tree wholesale and memory is gone before any cap applies.
  let totalBytes = 0
  let fileCount = 0
  const readRecursive = async (
    dirHandle: FileSystemDirectoryHandle,
    prefix: string,
  ): Promise<Record<string, Uint8Array>> => {
    const out: Record<string, Uint8Array> = {}
    for await (const [name, entry] of dirHandle.entries()) {
      const path = prefix ? `${prefix}/${name}` : name
      if (entry.kind === 'directory') {
        const sub = await dirHandle.getDirectoryHandle(name)
        Object.assign(out, await readRecursive(sub, path))
      } else {
        const file = await (entry as FileSystemFileHandle).getFile()
        totalBytes += file.size
        fileCount++
        if (
          totalBytes > ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE ||
          fileCount > ZIP_IMPORT_LIMITS.MAX_ENTRIES
        ) {
          throw new Error(
            `Existing skill "${dirName}" exceeds the backup size limit — refusing to read it for overwrite.`,
          )
        }
        out[path] = new Uint8Array(await file.arrayBuffer())
      }
    }
    return out
  }

  let skillDir: FileSystemDirectoryHandle
  try {
    skillDir = await userDir.getDirectoryHandle(dirName)
  } catch (e) {
    if (isNotFoundError(e)) return null
    throw e
  }
  return await readRecursive(skillDir, '')
}

/**
 * Recreate `.skills/user/<dirName>/` from a backup produced by
 * `readUserSkillDir` (restore path for a failed overwrite-import).
 */
async function restoreUserSkillDir(
  userDir: FileSystemDirectoryHandle,
  dirName: string,
  files: Record<string, Uint8Array>,
  runId: string,
): Promise<void> {
  try {
    await userDir.removeEntry(dirName, { recursive: true })
  } catch (e) {
    // ONLY absence is fine (nothing to clear). Any other removal failure
    // means the partially imported directory SURVIVED: proceeding would
    // merge stale files into the restored skill and let the caller delete
    // the backup over an incomplete restore — propagate so rollback keeps
    // the staged backup for a retry.
    if (!isNotFoundError(e)) throw e
  }
  const skillDir = await userDir.getDirectoryHandle(dirName, { create: true })
  try {
    await writeImportOwner(skillDir, runId)
  } catch (e) {
    // If even the ownership marker cannot be written, remove the empty
    // target so a later recovery can safely restore the staged copy.
    try {
      await userDir.removeEntry(dirName, { recursive: true })
    } catch {
      // The staged backup remains for a later retry.
    }
    throw e
  }
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean)
    if (parts.length === 0) continue
    let currentDir = skillDir
    for (let i = 0; i < parts.length - 1; i++) {
      currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true })
    }
    const fileHandle = await currentDir.getFileHandle(parts[parts.length - 1], { create: true })
    const writable = await fileHandle.createWritable()
    await writable.write(data)
    await writable.close()
  }
  await skillDir.removeEntry(IMPORT_OWNER_FILE)
}

/**
 * Build a FileEntry tree from a flat list of slash-separated paths.
 * Used for zip preview (zip entries are flat, not hierarchical).
 */
function buildFileTreeFromPaths(
  paths: string[],
): import('./skill-folder-utils').FileEntry[] {
  const root: import('./skill-folder-utils').FileEntry[] = []

  for (const path of paths) {
    const parts = path.split('/').filter(Boolean)
    let level = root

    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]
      const isFile = i === parts.length - 1

      if (isFile) {
        level.push({ name, kind: 'file' })
      } else {
        let dir = level.find((e) => e.kind === 'directory' && e.name === name)
        if (!dir) {
          dir = { name, kind: 'directory', children: [] }
          level.push(dir)
        }
        level = dir.children!
      }
    }
  }

  // Sort: directories first, then files, alphabetically
  const sortEntries = (entries: import('./skill-folder-utils').FileEntry[]) => {
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    entries.forEach((e) => {
      if (e.children) sortEntries(e.children)
    })
  }
  sortEntries(root)

  return root
}

/**
 * Delete a user skill directory from OPFS `.skills/user/<dirName>/`.
 *
 * @param dirName  Skill directory name (slug-safe)
 */
export async function deleteUserSkillDir(dirName: string): Promise<void> {
 const opfsRoot = await navigator.storage.getDirectory()
 const skillsDir = await opfsRoot.getDirectoryHandle(SKILLS_ROOT, { create: false })
 const userDir = await skillsDir.getDirectoryHandle(USER_SKILLS_DIR, { create: false })
 await userDir.removeEntry(dirName, { recursive: true })
}

/**
 * Check if a user skill directory exists in OPFS.
 * Used for validation before write operations.
 */
export async function userSkillDirExists(skillDirName: string): Promise<boolean> {
  try {
    const userDir = await getUserSkillsDir()
    if (!userDir) return false
    await userDir.getDirectoryHandle(skillDirName)
    return true
  } catch {
    return false
  }
}
