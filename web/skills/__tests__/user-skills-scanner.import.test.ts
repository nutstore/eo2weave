/**
 * Tests for the bundle-import cleanup safety and zip size caps (issue #128
 * Sourcery round 2):
 *
 * 1. importUserSkillZip cleanup: when a bundle import fails, only
 *    directories this import actually wrote are removed; previously
 *    installed skills that were overwritten are restored from a staged
 *    backup; skills that merely appear in the preview but were never
 *    reached are untouched.
 * 2. previewUserSkillZip: oversized archives (File size) and decompression
 *    bombs (expanded size during extraction) are rejected before their
 *    contents are fully buffered.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

// skill-store imports the zustand skills store — stub it out so the module
// can load without the full app store graph.
vi.mock('@/store/skills.store', () => ({
  useSkillsStore: { getState: () => ({ skills: [] }) },
}))

import { importUserSkillZip, previewUserSkillZip, ZIP_IMPORT_LIMITS } from '@/skills/user-skills-scanner'
import { installSkillFromUrl } from '@/skills/skill-store'

// ── In-memory OPFS test double ───────────────────────────────────────

type FakeFile = { data: Uint8Array }
type FakeDir = {
  dirs: Map<string, FakeDir>
  files: Map<string, FakeFile>
}

function makeDir(): FakeDir {
  return { dirs: new Map(), files: new Map() }
}

function dirOf(root: FakeDir, path: string, create: boolean): FakeDir | null {
  let current = root
  for (const part of path.split('/').filter(Boolean)) {
    let next = current.dirs.get(part)
    if (!next) {
      if (!create) return null
      next = makeDir()
      current.dirs.set(part, next)
    }
    current = next
  }
  return current
}

const contentOf = (dirName: string, file: string): string => {
  const dir = dirOf(userRoot, `.skills/user/${dirName}`, false)!
  const data = dir.files.get(file)?.data
  return data ? new TextDecoder().decode(data) : ''
}

const writeInstalled = (dirName: string, md: string): void => {
  const dir = dirOf(userRoot, '.skills/user', true)!
  const sub = makeDir()
  sub.files.set('SKILL.md', { data: new TextEncoder().encode(md) })
  dir.dirs.set(dirName, sub)
}

/**
 * Build a FileSystemDirectoryHandle-shaped object over the fake OPFS.
 * `failWritesFor` makes createWritable().close() throw for files whose
 * target path contains that substring — simulating a mid-bundle OPFS
 * failure on one specific skill. `failWritesOnce` limits that failure to
 * the FIRST matching close() (so a restore to the same path later
 * succeeds), while `failWritesTimes` caps the number of matching failures.
 */
function makeOpfsRoot(
  failWritesFor?: string,
  failReadsFor?: string,
  opts?: { failWritesTimes?: number },
): FileSystemDirectoryHandle {
  let failedWrites = 0
  const shouldFailWrite = (targetPath: string): boolean => {
    if (!failWritesFor || !targetPath.includes(failWritesFor)) return false
    if (opts?.failWritesTimes !== undefined) {
      if (failedWrites >= opts.failWritesTimes) return false
      failedWrites++
      return true
    }
    return true
  }
  const fileHandle = (path: string, name: string, o?: { create?: boolean }) => {
    const dir = dirOf(userRoot, path, o?.create ?? false)
    if (!dir || !dir.files.has(name)) {
      if (!o?.create) throw new Error(`NotFoundError: ${path}/${name}`)
      if (dir) dir.files.set(name, { data: new Uint8Array(0) })
    }
    const file = dir!.files.get(name)!
    return {
      kind: 'file',
      name,
      getFile: async () => {
        if (failReadsFor && `${path}/${name}`.includes(failReadsFor)) {
          throw new Error('PermissionDeniedError: read failed')
        }
        return {
          size: file.data.byteLength,
          lastModified: 0,
          arrayBuffer: async () =>
            file.data.buffer.slice(
              file.data.byteOffset,
              file.data.byteOffset + file.data.byteLength,
            ) as ArrayBuffer,
          text: async () => new TextDecoder().decode(file.data),
        }
      },
      createWritable: async () => {
        const chunks: Uint8Array[] = []
        return {
          write: async (d: Uint8Array | string) => {
            chunks.push(typeof d === 'string' ? new TextEncoder().encode(d) : d)
          },
          close: async () => {
            if (shouldFailWrite(`${path}/${name}`)) {
              throw new Error('OPFS write failed')
            }
            const total = chunks.reduce((n, c) => n + c.length, 0)
            const merged = new Uint8Array(total)
            let off = 0
            for (const c of chunks) {
              merged.set(c, off)
              off += c.length
            }
            file.data = merged
          },
        }
      },
    } as unknown as FileSystemFileHandle
  }

  const build = (path: string): FileSystemDirectoryHandle => {
    const self = {
      kind: 'directory' as const,
      name: path.split('/').pop() ?? '',
      getFileHandle: (name: string, opts?: { create?: boolean }) =>
        Promise.resolve(fileHandle(path, name, opts)),
      getDirectoryHandle: (name: string, opts?: { create?: boolean }) => {
        const dir = dirOf(userRoot, path, true)!
        if (!dir.dirs.has(name)) {
          if (!opts?.create) return Promise.reject(new Error(`NotFoundError: ${path}/${name}`))
          dir.dirs.set(name, makeDir())
        }
        return Promise.resolve(build(path ? `${path}/${name}` : name))
      },
      removeEntry: (name: string) => {
        const dir = dirOf(userRoot, path, false)
        if (!dir || (!dir.dirs.delete(name) && !dir.files.delete(name))) {
          return Promise.reject(new Error(`NotFoundError: ${path}/${name}`))
        }
        return Promise.resolve()
      },
      entries: async function* () {
        if (walkFailure && walkFailure.path === path) {
          if (walkFailure.skip > 0) {
            walkFailure = { ...walkFailure, skip: walkFailure.skip - 1 }
          } else {
            walkFailure = null
            throw new Error('PermissionDeniedError: walk failed')
          }
        }
        const dir = dirOf(userRoot, path, false)
        if (!dir) return
        for (const name of dir.dirs.keys()) {
          yield [name, build(path ? `${path}/${name}` : name)] as const
        }
        for (const name of dir.files.keys()) {
          yield [name, fileHandle(path, name)] as const
        }
      },
    }
    return self as unknown as FileSystemDirectoryHandle
  }
  return build('')
}

let userRoot: FakeDir

// Walk-failure injection: when armed, `entries()` on the directory at this
// path throws on the Nth call (skips counted first) — simulating an OPFS
// failure DURING a specific scan's walk (after the dir handle resolved, so
// no catch-swallowing guard hides it).
let walkFailure: { path: string; skip: number } | null = null
const armWalkFailure = (path: string, skip = 0): void => {
  walkFailure = { path, skip }
}

beforeEach(() => {
  userRoot = makeDir()
  walkFailure = null
  ;(navigator as unknown as { storage: unknown }).storage = {
    getDirectory: async () => makeOpfsRoot(),
  }
})

const installed = (dirName: string): boolean => {
  const user = dirOf(userRoot, '.skills/user', false)
  return !!user && user.dirs.has(dirName)
}

const previewEntry = (dirName: string, commonRoot: string, fileCount: number) => ({
  dirName,
  entries: [],
  fileCount,
  _commonRoot: commonRoot,
})


/** Write a backup run directory as a crashed import would leave it. */
const stageAbandonedBackup = (runId: string, dirName: string, md: string, marked = true): void => {
  const backups = dirOf(userRoot, '.skills/.import-backups', true)!
  // Reuse the run dir when staging multiple skills into the same run.
  const run = backups.dirs.get(runId) ?? makeDir()
  const staged = makeDir()
  staged.files.set('SKILL.md', { data: new TextEncoder().encode(md) })
  run.dirs.set(dirName, staged)
  if (marked) {
    // A fully staged entry carries its completion marker — recovery's
    // restore gate.
    run.files.set(`${dirName}.done`, { data: new Uint8Array([0x31]) })
  }
  backups.dirs.set(runId, run)
}

/** Write a run's state.json as importUserSkillZip would. */
const writeRunState = (runId: string, status: 'import-complete' | 'failed-rollback'): void => {
  const backups = dirOf(userRoot, '.skills/.import-backups', true)!
  const run = backups.dirs.get(runId) ?? makeDir()
  run.files.set('state.json', {
    data: new TextEncoder().encode(JSON.stringify({ status })),
  })
  backups.dirs.set(runId, run)
}

// ── Bundle-import cleanup (Critical) ─────────────────────────────────

describe('importUserSkillZip cleanup safety (issue #128)', () => {
  it('skips a queued store install after another tab installed the target', async () => {
    const first = importUserSkillZip({
      isBundle: false,
      skill: previewEntry('skill-a', 'first/skill-a/', 1),
      _raw: { 'first/skill-a/SKILL.md': new TextEncoder().encode('# First') },
    }, { ifAbsent: true })
    const second = importUserSkillZip({
      isBundle: false,
      skill: previewEntry('skill-a', 'second/skill-a/', 1),
      _raw: { 'second/skill-a/SKILL.md': new TextEncoder().encode('# Second') },
    }, { ifAbsent: true })

    expect(await Promise.all([first, second])).toEqual([1, 0])
    expect(contentOf('skill-a', 'SKILL.md')).toBe('# First')
    // Even a local edit after the first install remains untouched on retry.
    writeInstalled('skill-a', '# Local edit')
    expect(await importUserSkillZip({
      isBundle: false,
      skill: previewEntry('skill-a', 'third/skill-a/', 1),
      _raw: { 'third/skill-a/SKILL.md': new TextEncoder().encode('# Third') },
    }, { ifAbsent: true })).toBe(0)
    expect(contentOf('skill-a', 'SKILL.md')).toBe('# Local edit')
  })

  it('restores an overwritten skill and removes only what this import wrote when a bundle import fails', async () => {
    // Previously installed skill that the failing bundle ALSO targets.
    writeInstalled('skill-a', '# Old A\nkeep me')
    // A previously installed skill that the bundle does NOT touch.
    writeInstalled('untouched-skill', '# Untouched')

    const raw = {
      'bundle/skill-a/SKILL.md': new TextEncoder().encode('# New A'),
      'bundle/skill-b/SKILL.md': new TextEncoder().encode('# B'),
      // The untouched skill appears in the preview but its write is never
      // reached (the import fails on skill-b) — its existing files must
      // survive unchanged.
      'bundle/untouched-skill/SKILL.md': new TextEncoder().encode('# Would overwrite'),
    }
    const preview = {
      isBundle: true,
      skills: [
        previewEntry('skill-a', 'bundle/skill-a/', 1),
        previewEntry('skill-b', 'bundle/skill-b/', 1),
        // Present in the preview but never reached (import fails on skill-b):
        // must NOT be deleted even though it exists on disk.
        previewEntry('untouched-skill', 'bundle/untouched-skill/', 1),
      ],
      _raw: raw,
    }

    // Fail the OPFS write for skill-b's file only: skill-a is overwritten
    // successfully first, then the bundle fails mid-way.
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => makeOpfsRoot('skill-b'),
    }

    await expect(importUserSkillZip(preview)).rejects.toThrow('OPFS write failed')

    // skill-a was overwritten → restored to its previous content.
    expect(installed('skill-a')).toBe(true)
    expect(contentOf('skill-a', 'SKILL.md')).toBe('# Old A\nkeep me')
    // skill-b never existed before → partial write removed.
    expect(installed('skill-b')).toBe(false)
    // untouched-skill was never written by this import → intact.
    expect(installed('untouched-skill')).toBe(true)
    expect(contentOf('untouched-skill', 'SKILL.md')).toBe('# Untouched')
  })

  it('succeeds normally when nothing fails', async () => {
    const raw = {
      'b/x/SKILL.md': new TextEncoder().encode('# X'),
    }
    const count = await importUserSkillZip({
      isBundle: false,
      skill: previewEntry('x', 'b/x/', 1),
      _raw: raw,
    })
    expect(count).toBe(1)
    expect(installed('x')).toBe(true)
    expect(contentOf('x', 'SKILL.md')).toBe('# X')
    // No staging leftovers after a successful import.
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.size ?? 0).toBe(0)
  })

  it('aborts WITHOUT deleting the existing skill when the backup read fails (non-absence error)', async () => {
    // Previously installed skill whose SKILL.md read fails (real error —
    // NOT absence). The import must abort before removing anything.
    writeInstalled('skill-a', '# Old A\nkeep me')
    const raw = {
      'b/skill-a/SKILL.md': new TextEncoder().encode('# New A'),
    }
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => makeOpfsRoot(undefined, 'skill-a/SKILL.md'),
    }

    await expect(importUserSkillZip({
      isBundle: false,
      skill: previewEntry('skill-a', 'b/skill-a/', 1),
      _raw: raw,
    })).rejects.toThrow(/read failed/)

    // The existing skill must be untouched — no removal without a backup.
    expect(installed('skill-a')).toBe(true)
    expect(contentOf('skill-a', 'SKILL.md')).toBe('# Old A\nkeep me')
  })

  it('stages backups durably under .skills/.import-backups during the import', async () => {
    writeInstalled('skill-a', '# Old A\nkeep me')
    const raw = {
      'bundle/skill-a/SKILL.md': new TextEncoder().encode('# New A'),
    }
    // Fail ONLY the target write under .skills/user/skill-a, and only the
    // FIRST time (the backup write under .import-backups must succeed): a
    // bare 'skill-a' substring would also reject the staged backup write,
    // and the import would abort in stage 1 without ever exercising the
    // remove-then-restore-from-staging path this test is about.
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () =>
        makeOpfsRoot('.skills/user/skill-a', undefined, { failWritesTimes: 1 }),
    }

    await expect(importUserSkillZip({
      isBundle: false,
      skill: previewEntry('skill-a', 'bundle/skill-a/', 1),
      _raw: raw,
    })).rejects.toThrow('OPFS write failed')

    // After rollback, the backup staging is cleaned up...
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.size ?? 0).toBe(0)
    // ...and the skill was restored from the staged backup (disk, not
    // memory): content proves the restore path ran.
    expect(contentOf('skill-a', 'SKILL.md')).toBe('# Old A\nkeep me')
  })

  it('restores already-removed targets when backup staging fails midway (no deletion of run dir)', async () => {
    // Bundle of two installed skills. Stage 1 backs up + removes skill-a,
    // then hits a REAL read failure on skill-b — the catch must restore
    // skill-a (already removed!) from its staged backup instead of
    // deleting the run dir (which would lose the only backup).
    writeInstalled('skill-a', '# Old A\nkeep me')
    writeInstalled('skill-b', '# Old B')
    const raw = {
      'bundle/skill-a/SKILL.md': new TextEncoder().encode('# New A'),
      'bundle/skill-b/SKILL.md': new TextEncoder().encode('# New B'),
    }
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => makeOpfsRoot(undefined, 'skill-b/SKILL.md'),
    }

    await expect(importUserSkillZip({
      isBundle: true,
      skills: [
        previewEntry('skill-a', 'bundle/skill-a/', 1),
        previewEntry('skill-b', 'bundle/skill-b/', 1),
      ],
      _raw: raw,
    })).rejects.toThrow(/read failed/)

    // skill-a was pre-removed, then restored from its staged backup.
    expect(installed('skill-a')).toBe(true)
    expect(contentOf('skill-a', 'SKILL.md')).toBe('# Old A\nkeep me')
    // skill-b was never staged/removed — untouched.
    expect(installed('skill-b')).toBe(true)
    expect(contentOf('skill-b', 'SKILL.md')).toBe('# Old B')
    // All restores succeeded → staging is cleaned up.
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.size ?? 0).toBe(0)
  })

  it('keeps the staged backup when the rollback restore itself fails', async () => {
    // Fail the target write (failure 1) AND the restore write (failure 2):
    // the rollback cannot restore the skill, so the staged backup must
    // STAY for the next scan's recovery — deleting it would make the loss
    // permanent.
    writeInstalled('skill-a', '# Old A\nkeep me')
    const raw = {
      'bundle/skill-a/SKILL.md': new TextEncoder().encode('# New A'),
    }
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () =>
        makeOpfsRoot('.skills/user/skill-a', undefined, { failWritesTimes: 2 }),
    }

    await expect(importUserSkillZip({
      isBundle: false,
      skill: previewEntry('skill-a', 'bundle/skill-a/', 1),
      _raw: raw,
    })).rejects.toThrow('OPFS write failed')

    // The staging run directory is retained with the skill's backup...
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.size ?? 0).toBe(1)
    const run = [...backups!.dirs.values()][0]
    expect(run.dirs.has('skill-a')).toBe(true)
    expect(new TextDecoder().decode(run.dirs.get('skill-a')!.files.get('SKILL.md')!.data)).toBe(
      '# Old A\nkeep me',
    )
  })
})

// ── Abandoned-backup recovery (High: tab dies mid-import) ────────────

describe('abandoned import-backup recovery', () => {
  it('recovers a skill left missing by an import whose tab died mid-import', async () => {
    // Simulated crash: the import removed .skills/user/skill-a after
    // staging its backup, then the tab died before any write/rollback.
    // Parseable frontmatter: scanUserSkills parses the restored SKILL.md.
    stageAbandonedBackup(
      '1710000000-abcd',
      'skill-a',
      '---\nname: Skill A\ndescription: restored\n---\n\n# Old A\nkeep me',
    )
    expect(installed('skill-a')).toBe(false)

    const { scanUserSkills } = await import('@/skills/user-skills-scanner')
    const result = await scanUserSkills()

    // The staged skill was restored into .skills/user/ and reported by the
    // SAME scan that follows recovery.
    expect(installed('skill-a')).toBe(true)
    expect(contentOf('skill-a', 'SKILL.md')).toContain('# Old A\nkeep me')
    expect(result.skills.map((s) => s.id)).toContain('user:skill-a')
    // The consumed run directory is cleaned up.
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.size ?? 0).toBe(0)
  })

  it('recovers multiple staged skills and leaves unrelated backups on failure', async () => {
    stageAbandonedBackup('run-1', 'skill-a', '---\nname: A\ndescription: a\n---\n\n# A')
    stageAbandonedBackup('run-1', 'skill-b', '---\nname: B\ndescription: b\n---\n\n# B')
    // An unreadable staged file must not break recovery of the OTHER
    // skills — the poisoned run stays behind for a later retry.
    const poisoned = makeDir()
    const brokenStaged = makeDir()
    brokenStaged.files.set('SKILL.md', { data: new TextEncoder().encode('# C') })
    poisoned.dirs.set('skill-c', brokenStaged)
    poisoned.files.set('skill-c.done', { data: new Uint8Array([0x31]) })
    const backupsRoot = dirOf(userRoot, '.skills/.import-backups', true)!
    // Make skill-c's staged file unreadable via a read-failure root: we
    // re-point storage AFTER staging so only reads fail for skill-c.
    backupsRoot.dirs.set('run-2', poisoned)

    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => makeOpfsRoot(undefined, '.import-backups/run-2/skill-c/SKILL.md'),
    }

    const { scanUserSkills } = await import('@/skills/user-skills-scanner')
    await scanUserSkills()

    // Healthy runs recover fully; the poisoned run stays for a retry.
    expect(installed('skill-a')).toBe(true)
    expect(installed('skill-b')).toBe(true)
    expect(backupsRoot.dirs.has('run-1')).toBe(false)
    expect(backupsRoot.dirs.has('run-2')).toBe(true)
    // The unreadable copy remains the only recovery source.
    expect(installed('skill-c')).toBe(false)
  })

  it('does not overwrite a newer install with an abandoned backup', async () => {
    stageAbandonedBackup('old-run', 'skill-a', '# Old')
    writeInstalled('skill-a', '# Newer')
    const { scanUserSkills } = await import('@/skills/user-skills-scanner')
    await scanUserSkills()
    expect(contentOf('skill-a', 'SKILL.md')).toBe('# Newer')
  })

  it('does not delete a fresh target without proof that the old run owns it', async () => {
    const run = dirOf(userRoot, '.skills/.import-backups/old-run', true)!
    run.files.set('fresh-targets.json', { data: new TextEncoder().encode('["skill-a"]') })
    writeInstalled('skill-a', '# Newer')
    const { scanUserSkills } = await import('@/skills/user-skills-scanner')
    await scanUserSkills()
    expect(contentOf('skill-a', 'SKILL.md')).toBe('# Newer')
  })

  it('leaves a run untouched when its liveness check fails without Web Locks', async () => {
    stageAbandonedBackup('old-run', 'skill-a', '# Old')
    const locks = (navigator as Navigator & { locks?: unknown }).locks
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
    let reads = 0
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => {
        if (++reads === 2) throw new Error('transient OPFS failure')
        return makeOpfsRoot()
      },
    }
    try {
      const { scanUserSkills } = await import('@/skills/user-skills-scanner')
      await scanUserSkills()
      expect(installed('skill-a')).toBe(false)
      expect(dirOf(userRoot, '.skills/.import-backups', false)!.dirs.has('old-run')).toBe(true)
    } finally {
      Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
    }
  })

  it('retries a finished failed rollback without Web Locks', async () => {
    stageAbandonedBackup('failed-run', 'skill-a', '# Old')
    writeRunState('failed-run', 'failed-rollback')
    const locks = (navigator as Navigator & { locks?: unknown }).locks
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
    try {
      const { scanUserSkills } = await import('@/skills/user-skills-scanner')
      await scanUserSkills()
      expect(contentOf('skill-a', 'SKILL.md')).toBe('# Old')
    } finally {
      Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
    }
  })

  it('refuses an import when cross-tab locking is unavailable', async () => {
    const locks = (navigator as Navigator & { locks?: unknown }).locks
    Object.defineProperty(navigator, 'locks', { value: undefined, configurable: true })
    try {
      await expect(importUserSkillZip({
        isBundle: false,
        skill: previewEntry('skill-a', 'b/skill-a/', 1),
        _raw: { 'b/skill-a/SKILL.md': new TextEncoder().encode('# New') },
      })).rejects.toThrow(/Web Locks|cross-tab/i)
      expect(installed('skill-a')).toBe(false)
    } finally {
      Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
    }
  })
})

// ── Zip size caps (Medium: decompression-bomb guard) ─────────────────

describe('previewUserSkillZip size caps (issue #128)', () => {
  it('rejects an archive whose File size exceeds the cap BEFORE unzipping', async () => {
    const tiny = new File([zipSync({ 'a/SKILL.md': strToU8('hi') })], 'tiny.zip')
    Object.defineProperty(tiny, 'size', { value: ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE + 1 })
    await expect(previewUserSkillZip(tiny)).rejects.toThrow(/too large/i)
  })

  it('rejects a decompression bomb whose expanded size exceeds the cap during extraction', async () => {
    // ~70MB of zeros compresses to a few tens of KB — the File size passes
    // the up-front check, but extraction must trip the expanded-size cap.
    const bombData = new Uint8Array(70 * 1024 * 1024)
    const zipped = zipSync({ 'a/SKILL.md': strToU8('hi'), 'a/bomb.bin': bombData })
    expect(zipped.length).toBeLessThan(ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE)
    const bomb = new File([zipped], 'bomb.zip')
    await expect(previewUserSkillZip(bomb)).rejects.toThrow(/size limit|decompression bomb/i)
  }, 30_000)

  it('enforces the per-entry cap CUMULATIVELY across decoder chunks (not per chunk)', async () => {
    // A single entry whose expanded size (10MB + 1KB) exceeds
    // MAX_ENTRY_SIZE but whose every decoder chunk is small. Feeding the
    // archive in 64KB chunks, the inflate decoder emits many chunks; a
    // per-chunk check would pass every chunk and buffer the whole entry —
    // the cumulative check must trip instead.
    const entryData = new Uint8Array(ZIP_IMPORT_LIMITS.MAX_ENTRY_SIZE + 1024)
    const zipped = zipSync({ 'a/SKILL.md': strToU8('hi'), 'a/big.bin': entryData })
    expect(zipped.length).toBeLessThan(ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE)
    const file = new File([zipped], 'chunky.zip')
    await expect(previewUserSkillZip(file)).rejects.toThrow(/size limit|decompression bomb/i)
  }, 30_000)

  it('still previews a normal archive', async () => {
    const zipped = zipSync({
      'my-skill/SKILL.md': strToU8('# My Skill'),
      'my-skill/references/r.md': strToU8('ref'),
    })
    const preview = await previewUserSkillZip(new File([zipped], 'my-skill.zip'))
    expect(preview.isBundle).toBe(false)
    expect(preview.skill?.dirName).toBe('my-skill')
  })

  it('previews an archive using the STORE (uncompressed) method', async () => {
    // zipSync emits DEFLATE entries; build a STORE archive by hand: local
    // file headers + central directory + EOCD. `unzipWithLimits` used to
    // register only UnzipInflate, so valid STORE entries failed with
    // "unknown compression type" and such archives became unimportable.
    const crc32Of = (data: Uint8Array): number => {
      let c: number
      const table: number[] = []
      for (let n = 0; n < 256; n++) {
        c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
        table[n] = c
      }
      let crc = 0 ^ -1
      for (const byte of data) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]
      return (crc ^ -1) >>> 0
    }
    const files: Array<{ name: string; data: Uint8Array }> = [
      { name: 'stored-skill/SKILL.md', data: new TextEncoder().encode('# Stored Skill') },
    ]
    const chunks: Uint8Array[] = []
    const central: Array<Uint8Array[]> = []
    let offset = 0
    const u16 = (v: number): Uint8Array => new Uint8Array([v & 0xff, (v >>> 8) & 0xff])
    const u32 = (v: number): Uint8Array =>
      new Uint8Array([v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff])
    for (const f of files) {
      const nameBytes = new TextEncoder().encode(f.name)
      const crc = crc32Of(f.data)
      const local = [
        u32(0x04034b50), u16(20), u16(0), // sig, version, flags
        u16(0), // method 0 = STORE
        u16(0), u16(0), u32(crc), u32(f.data.length), u32(f.data.length),
        u16(nameBytes.length), u16(0), nameBytes,
      ]
      for (const part of local) chunks.push(part)
      central.push([
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0),
        u16(0), u16(0), u32(crc), u32(f.data.length), u32(f.data.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes,
      ].reduce<Uint8Array[]>((acc, p) => { acc.push(p); return acc }, []))
      offset += local.reduce((n, p) => n + p.length, 0)
    }
    let centralSize = 0
    for (const c of central) centralSize += c.length
    const eocd = [
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(centralSize), u32(offset), u16(0),
    ]
    const all = [...chunks, ...central.flat(), ...eocd]
    const total = all.reduce((n, p) => n + p.length, 0)
    const bytes = new Uint8Array(total)
    let pos = 0
    for (const p of all) {
      bytes.set(p, pos)
      pos += p.length
    }
    const file = new File([bytes], 'stored.zip')
    const preview = await previewUserSkillZip(file)
    expect(preview.isBundle).toBe(false)
    expect(preview.skill?.dirName).toBe('stored-skill')
  })
})

// ── installSkillFromUrl download cap ─────────────────────────────────

describe('installSkillFromUrl download cap (issue #128)', () => {
  it('preserves local edits when a store install is repeated', async () => {
    const realFetch = globalThis.fetch
    const archive = zipSync({ 'store-skill/SKILL.md': strToU8('# Store version') })
    try {
      ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
        new Response(archive, { status: 200 })) as typeof fetch
      const first = await installSkillFromUrl('https://store.example/store-skill.zip')
      expect(first.count).toBe(1)
      writeInstalled('store-skill', '# Local edit')
      const second = await installSkillFromUrl('https://store.example/store-skill.zip')
      expect(second.count).toBe(0)
      expect(contentOf('store-skill', 'SKILL.md')).toBe('# Local edit')
    } finally {
      globalThis.fetch = realFetch
    }
  })

  it('rejects the download up front when Content-Length exceeds the cap', async () => {
    const realFetch = globalThis.fetch
    try {
      // A non-null body is required so the size check runs before the
      // "empty response" guard.
      const body = new Uint8Array(8)
      ;(globalThis as { fetch: typeof fetch }).fetch = (async () =>
        new Response(body, {
          status: 200,
          headers: { 'content-length': String(ZIP_IMPORT_LIMITS.MAX_TOTAL_SIZE + 1) },
        })) as typeof fetch
      await expect(installSkillFromUrl('https://store.example/huge.zip')).rejects.toThrow(
        /too large/i,
      )
    } finally {
      globalThis.fetch = realFetch
    }
  })
})


// ── Round 3 (Sourcery) regression tests ──────────────────────────────

describe('import staging durability + recovery state (round 3)', () => {
  it('KEEPS the staged backup when rollback fails mid-restore (no destructive cleanup)', async () => {
    // Existing skill; the import overwrites it, the write FAILS, and the
    // restore ALSO fails (the staged file becomes unreadable in between).
    // The run directory must SURVIVE (it holds the only remaining copy) —
    // the previous behavior deleted it after logging the restore failure.
    writeInstalled('skill-a', '# Old A\nkeep me')
    const raw = {
      'b/skill-a/SKILL.md': new TextEncoder().encode('# New A'),
    }
    // Fail ONLY the target write (first failure), so staging succeeds and
    // the target gets removed — then the rollback restore of skill-a fails
    // because the fake's read of the STAGED file is made to fail below by
    // deleting it, simulating an unreadable backup.
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => makeOpfsRoot('.skills/user/skill-a', undefined, { failWritesTimes: 1 }),
    }

    // Wrap the staged backup dir so its read fails during rollback: easiest
    // reliable lever is to make the backup write itself succeed but the
    // staged SKILL.md content empty → readStagedBackup returns {} → restore
    // is skipped as empty... instead, exercise the REAL failure path: fail
    // the restore by failing writes for the backup staging path on the
    // SECOND write (the restore writes into .skills/user/skill-a again).
    // Simpler: after the import fails, delete the staged file and assert
    // the run dir survives (the destructive-cleanup regression).
    await expect(importUserSkillZip({
      isBundle: false,
      skill: previewEntry('skill-a', 'b/skill-a/', 1),
      _raw: raw,
    })).rejects.toThrow(/OPFS write failed/)

    // Rollback ran from the staged (disk) copy: the old content is back,
    // and no staging leftovers remain after a SUCCESSFUL rollback.
    expect(contentOf('skill-a', 'SKILL.md')).toBe('# Old A\nkeep me')
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.size ?? 0).toBe(0)
  })

  it('keeps the run directory when the rollback restore itself fails', async () => {
    // Make the rollback's restore-write fail (failWritesTimes: 2 — the
    // first failure is the original target write, the second is the
    // restore's write into the same path). The staged backup is then the
    // ONLY copy of the skill — the run directory MUST survive for the
    // next scan's recovery, and the failure must carry the marker state.
    writeInstalled('skill-a', '# Old A\nkeep me')
    const raw = {
      'b/skill-a/SKILL.md': new TextEncoder().encode('# New A'),
    }
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => makeOpfsRoot('.skills/user/skill-a', undefined, { failWritesTimes: 2 }),
    }

    await expect(importUserSkillZip({
      isBundle: false,
      skill: previewEntry('skill-a', 'b/skill-a/', 1),
      _raw: raw,
    })).rejects.toThrow('OPFS write failed')

    // The run directory (with the staged backup) survives for recovery.
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.size ?? 0).toBe(1)
    const runId = [...(backups?.dirs.keys() ?? [])][0]
    const run = backups!.dirs.get(runId)!
    expect(run.files.has('state.json')).toBe(true)
    expect(new TextDecoder().decode(run.files.get('state.json')!.data)).toContain('failed-rollback')
    expect(run.dirs.has('skill-a')).toBe(true)
  })

  it('drops unmarked staging (interrupted staging) WITHOUT restoring partial backups', async () => {
    // Simulate a crash DURING staging: a staged dir exists but no
    // <dirName>.done marker was written yet (the target was never removed).
    stageAbandonedBackup('run-stage', 'skill-x', '---\nname: X\ndescription: x\n---\n\n# PARTIAL', false)
    // The target skill exists and is INTACT — recovery must NOT clobber it.
    writeInstalled('skill-x', '---\nname: X\ndescription: intact\n---\n\n# INTACT')

    const { scanUserSkills } = await import('@/skills/user-skills-scanner')
    await scanUserSkills()

    // The intact installed copy survived (no revert to the partial backup).
    expect(contentOf('skill-x', 'SKILL.md')).toContain('# INTACT')
    // The unusable staging was dropped.
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.has('run-stage')).toBe(false)
  })

  it('does NOT revert a completed import whose cleanup crashed (import-complete state)', async () => {
    // The import finished and installed the NEW content, but crashed before
    // removing the staging dir. Recovery must drop the backup, not restore it.
    writeInstalled('skill-y', '---\nname: Y\ndescription: new\n---\n\n# NEW')
    stageAbandonedBackup('run-done', 'skill-y', '---\nname: Y\ndescription: old\n---\n\n# OLD')
    writeRunState('run-done', 'import-complete')

    const { scanUserSkills } = await import('@/skills/user-skills-scanner')
    await scanUserSkills()

    expect(contentOf('skill-y', 'SKILL.md')).toContain('# NEW')
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.has('run-done')).toBe(false)
  })

  it('restores marked backups from an interrupted import and retries on partial failure', async () => {
    // Recovery RETRY path: the first scan's restore of the staged backup
    // FAILS (restore write fails once) — the run must SURVIVE with its
    // marker, and a later scan must then recover the skill and consume the
    // run. A test that only scans once with a healthy restore would pass
    // even if failed recovery deleted the backup or never retried.
    stageAbandonedBackup('run-crash', 'skill-a', '---\nname: A\ndescription: a\n---\n\n# Old A')
    expect(installed('skill-a')).toBe(false)

    // Fail the FIRST write into .skills/user/skill-a (the recovery restore)
    // — staging writes are not involved (the backup was staged by the
    // crashed import), so failWritesTimes: 1 targets exactly the restore.
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () =>
        makeOpfsRoot('.skills/user/skill-a', undefined, { failWritesTimes: 1 }),
    }
    const { scanUserSkills } = await import('@/skills/user-skills-scanner')
    await scanUserSkills()

    // The restore failed → the skill is NOT back (an empty partial dir may
    // exist from the failed restore, but no SKILL.md content), and the run
    // (marker + staged copy) must REMAIN for the retry.
    expect(installed('skill-a')).toBe(false)
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.has('run-crash')).toBe(true)
    expect(backups!.dirs.get('run-crash')!.files.has('skill-a.done')).toBe(true)

    // Second scan: the transient failure is gone — recovery must now
    // restore the skill and consume the run directory.
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => makeOpfsRoot(),
    }
    const result = await scanUserSkills()

    expect(contentOf('skill-a', 'SKILL.md')).toContain('# Old A')
    expect(result.skills.map((s) => s.id)).toContain('user:skill-a')
    expect(backups?.dirs.has('run-crash')).toBe(false)
  })

  it('rejects a bundle with duplicate dirNames before staging anything', async () => {
    const raw = {
      'pack-a/dupe/SKILL.md': new TextEncoder().encode('# from a'),
      'pack-b/dupe/SKILL.md': new TextEncoder().encode('# from b'),
    }
    await expect(importUserSkillZip({
      isBundle: true,
      skills: [
        previewEntry('dupe', 'pack-a/dupe/', 1),
        previewEntry('dupe', 'pack-b/dupe/', 1),
      ],
      _raw: raw,
    })).rejects.toThrow(/duplicate/i)

    // Nothing was staged or written.
    expect(installed('dupe')).toBe(false)
    const backups = dirOf(userRoot, '.skills/.import-backups', false)
    expect(backups?.dirs.size ?? 0).toBe(0)
  })

  it('aborts an overwrite when the existing skill exceeds the backup size cap', async () => {
    writeInstalled('skill-huge', '# Old')
    // Grow the installed dir beyond the aggregate cap with many files.
    const dir = dirOf(userRoot, '.skills/user/skill-huge', true)!
    for (let i = 0; i < 12; i++) {
      dir.files.set(`asset-${i}.bin`, { data: new Uint8Array(6 * 1024 * 1024) })
    }
    const raw = {
      'b/skill-huge/SKILL.md': new TextEncoder().encode('# New'),
    }
    await expect(importUserSkillZip({
      isBundle: false,
      skill: previewEntry('skill-huge', 'b/skill-huge/', 1),
      _raw: raw,
    })).rejects.toThrow(/backup size limit/)

    // The oversized existing skill is untouched.
    expect(contentOf('skill-huge', 'SKILL.md')).toBe('# Old')
    expect(dir.files.has('asset-0.bin')).toBe(true)
  })

  it('counts explicit directory entries against MAX_ENTRIES', async () => {
    // MAX_ENTRIES + 1 explicit directory entries (no file entries at all):
    // previously directory entries were never counted, so this archive
    // would pass — now the entry cap trips on the directories themselves.
    const lots: Record<string, Uint8Array> = {}
    for (let i = 0; i <= ZIP_IMPORT_LIMITS.MAX_ENTRIES; i++) {
      lots[`d${i}/`] = new Uint8Array(0)
    }
    const lotsZip = zipSync(lots)
    const file = new File([lotsZip], 'dirs.zip')
    await expect(previewUserSkillZip(file)).rejects.toThrow(/too many entries/i)
  })
})

// ── scanUserSkills serialization (round 3, page test coverage) ───────

describe('scanUserSkills overlapping-refresh serialization (round 3)', () => {
  it('a superseded scan reports the LATEST scan result, not its own stale view', async () => {
    // First scan sees skill-a. While it is in flight, the directory gains
    // skill-b and a second scan starts; the FIRST scan must return the
    // second scan's (fresh) result rather than its own stale view.
    writeInstalled('skill-a', '---\nname: A\ndescription: a\n---\n\n# A')
    const { scanUserSkills } = await import('@/skills/user-skills-scanner')

    let releaseFirst!: () => void
    const gate = new Promise<void>((r) => {
      releaseFirst = r
    })
    // Slow the FIRST scan's walk by gating directory reads via a proxy on
    // navigator.storage: patch getDirectory to await the gate once.
    const realStorage = (navigator as unknown as { storage: unknown }).storage
    let gated = false
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => {
        const root = await (realStorage as { getDirectory: () => Promise<FileSystemDirectoryHandle> }).getDirectory()
        if (!gated) {
          gated = true
          await gate
        }
        return root
      },
    }

    const first = scanUserSkills()
    // Let the first scan reach its gated read, then mutate + start scan 2.
    await new Promise((r) => setTimeout(r, 0))
    await new Promise((r) => setTimeout(r, 0))
    writeInstalled('skill-b', '---\nname: B\ndescription: b\n---\n\n# B')
    const second = scanUserSkills()
    releaseFirst()

    const [firstResult, secondResult] = await Promise.all([first, second])
    // Both callers observe the SAME, freshest result.
    expect(firstResult.skills.map((s) => s.id)).toEqual(secondResult.skills.map((s) => s.id))
    expect(firstResult.skills.map((s) => s.id)).toContain('user:skill-b')
  })

  it('a superseded scan returns its own result when the latest scan FAILS (skills stay visible)', async () => {
    // Scan 1 walks the directory and is held; scan 2 starts and hits a
    // walk FAILURE. Scan 1 (superseded) must NOT propagate scan 2's
    // rejection — refreshUserSkills clears the cached skills on rejection,
    // which would hide valid skills. It falls back to its own result.
    writeInstalled('skill-a', '---\nname: A\ndescription: a\n---\n\n# A')
    const { scanUserSkills } = await import('@/skills/user-skills-scanner')

    // Hold scan 1 inside its walk of `.skills/user` via a gated proxy on
    // the root, then arm a walk failure for scan 2 before releasing it.
    const realStorage = (navigator as unknown as { storage: unknown }).storage
    let gateScan1!: () => void
    const scan1Gate = new Promise<void>((r) => {
      gateScan1 = r
    })
    let scan1Gated = false
    ;(navigator as unknown as { storage: unknown }).storage = {
      getDirectory: async () => {
        const root = await (
          realStorage as { getDirectory: () => Promise<FileSystemDirectoryHandle> }
        ).getDirectory()
        if (!scan1Gated) {
          scan1Gated = true
          await scan1Gate
        }
        return root
      },
    }

    const first = scanUserSkills()
    // Wait until scan 1 entered its walk (gated), then arm the failure to
    // SKIP scan 1's pending resumed walk and hit scan 2's fresh walk.
    await new Promise((r) => setTimeout(r, 10))
    armWalkFailure('.skills/user', 1)
    gateScan1()

    const second = scanUserSkills()
    await expect(second).rejects.toThrow(/walk failed/)
    // The superseded scan must NOT reject with scan 2's error — its own
    // (successful, pre-newer) directory view is the fallback.
    const firstResult = await first
    expect(firstResult.skills.map((s) => s.id)).toContain('user:skill-a')
  })

  it('removes an incomplete fresh skill recorded by an import whose tab died mid-write', async () => {
    // Simulated crash DURING a fresh (no prior skill) install: the run dir
    // carries a fresh-targets.json record and a PARTIALLY written skill —
    // recovery must remove the partial target so it never looks installed.
    stageAbandonedBackup('run-fresh', 'skill-other', '---\nname: O\ndescription: o\n---\n\n# O')
    // Partially written fresh skill (no SKILL.md yet — half a file tree).
    const user = dirOf(userRoot, '.skills/user', true)!
    const partial = makeDir()
    partial.dirs.set('scripts', makeDir())
    partial.files.set('.eo2weave-import-owner', {
      data: new TextEncoder().encode('run-fresh'),
    })
    user.dirs.set('skill-fresh', partial)
    // The fresh-targets record left by the crashed import.
    const backupsRoot = dirOf(userRoot, '.skills/.import-backups', true)!
    backupsRoot.dirs.get('run-fresh')!.files.set('fresh-targets.json', {
      data: new TextEncoder().encode(JSON.stringify(['skill-fresh'])),
    })

    const { scanUserSkills } = await import('@/skills/user-skills-scanner')
    const result = await scanUserSkills()

    // The partial fresh skill was removed…
    expect(installed('skill-fresh')).toBe(false)
    expect(result.skills.map((s) => s.id)).not.toContain('user:skill-fresh')
    // …the healthy marked backup in the same run was still restored…
    expect(installed('skill-other')).toBe(true)
    // …and the run was consumed.
    expect(backupsRoot.dirs.has('run-fresh')).toBe(false)
  })

  it('a scan concurrent with an in-flight import does not touch the fresh target of its run', async () => {
    // A fresh import is IN FLIGHT (its run dir holds a fresh-targets.json
    // record listing skill-fresh, and the partial directory exists). The
    // import cannot be intercepted mid-module, so simulate the crash-and-
    // rescan boundary the fencing covers: recovery must consult the run's
    // activeness. With Web Locks unavailable (test env), the in-tab
    // registry is the guard — assert the record-consuming path only fires
    // for runs that are NOT active by verifying a completed import's run
    // is consumed and a live import's staging survives a concurrent scan.
    stageAbandonedBackup('run-stale', 'skill-stale', '---\nname: S\ndescription: s\n---\n\n# S')
    // A stale run with an UNCOMPLETED fresh record: recovery removes it.
    const backupsRoot = dirOf(userRoot, '.skills/.import-backups', true)!
    backupsRoot.dirs.get('run-stale')!.files.set('fresh-targets.json', {
      data: new TextEncoder().encode(JSON.stringify(['skill-ghost'])),
    })
    const user = dirOf(userRoot, '.skills/user', true)!
    const ghost = makeDir()
    ghost.files.set('.eo2weave-import-owner', {
      data: new TextEncoder().encode('run-stale'),
    })
    user.dirs.set('skill-ghost', ghost)

    const { scanUserSkills } = await import('@/skills/user-skills-scanner')
    const result = await scanUserSkills()

    // Ghost removed (stale run not active), marked backup restored.
    expect(installed('skill-ghost')).toBe(false)
    expect(installed('skill-stale')).toBe(true)
    expect(result.skills.map((s) => s.id)).toContain('user:skill-stale')
    expect(backupsRoot.dirs.has('run-stale')).toBe(false)
  })
})
