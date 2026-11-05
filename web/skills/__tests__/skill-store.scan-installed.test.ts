/**
 * Tests for `scanInstalledDirNames`' fallback policy (issue #185, Path 2):
 *
 * The store-cache fallback is only valid when OPFS is genuinely unavailable
 * (`.skills/user/` absent). A transient OPFS failure must propagate to the
 * caller — silently degrading to a stale cached list made installed skills
 * look missing (or vice versa) and let an update report success while the
 * requested skill stayed un-updated.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/skills.store', () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [
        { id: 'user:cached-skill', source: 'user' },
        { id: 'user:other-skill', source: 'user' },
        { id: 'builtin:x', source: 'builtin' },
      ],
    }),
  },
}))

import { scanInstalledDirNames } from '@/skills/skill-store'

type DirStub = {
  kind: 'directory'
  name: string
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<DirStub>
  values: () => AsyncIterable<{ kind: string; name: string }>
}

const notFound = (path: string): Error => new Error(`NotFoundError: ${path}`)

const makeDir = (
  name: string,
  children: Record<string, DirStub> = {},
  subdirs: string[] = [],
): DirStub => ({
  kind: 'directory',
  name,
  getDirectoryHandle: async (child) => {
    const next = children[child]
    if (!next) throw notFound(`${name}/${child}`)
    return next
  },
  // eslint-disable-next-line require-yield
  values: async function* () {
    for (const sub of subdirs) yield { kind: 'directory', name: sub }
  },
})

const useOpfsRoot = (root: DirStub | { fail: Error }): void => {
  ;(navigator as unknown as { storage: { getDirectory: () => Promise<unknown> } }).storage = {
    getDirectory: () =>
      'fail' in root ? Promise.reject(root.fail) : Promise.resolve(root),
  }
}

beforeEach(() => {
  useOpfsRoot(makeDir('opfs-root'))
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (navigator as unknown as { storage?: unknown }).storage
})

describe('scanInstalledDirNames (#185 fallback policy)', () => {
  it('returns OPFS directory names when OPFS is healthy', async () => {
    useOpfsRoot(
      makeDir('opfs-root', {
        '.skills': makeDir('.skills', {
          user: makeDir('user', {}, ['alpha', 'beta']),
        }),
      }),
    )
    await expect(scanInstalledDirNames()).resolves.toEqual(
      new Set(['alpha', 'beta']),
    )
  })

  it('falls back to the store cache when `.skills/user/` is absent (NotFoundError)', async () => {
    useOpfsRoot(makeDir('opfs-root'))
    // Fallback strips the `user:` id prefix so callers comparing against
    // bare directory names still match (#154 round 8, merged from main).
    await expect(scanInstalledDirNames()).resolves.toEqual(
      new Set(['cached-skill', 'other-skill']),
    )
  })

  it('propagates a non-NotFound OPFS failure instead of using the stale store cache', async () => {
    useOpfsRoot({ fail: new Error('PermissionDeniedError: OPFS unavailable') })
    await expect(scanInstalledDirNames()).rejects.toThrow('PermissionDeniedError')
  })

  it('propagates a mid-walk failure instead of silently degrading to the cache', async () => {
    const brokenUserDir: DirStub = {
      kind: 'directory',
      name: 'user',
      getDirectoryHandle: async () => brokenUserDir,
      values: async function* () {
        throw new Error('DataError: walk failed mid-iteration')
        // eslint-disable-next-line no-unreachable
        yield { kind: 'directory', name: 'alpha' }
      },
    }
    useOpfsRoot(
      makeDir('opfs-root', {
        '.skills': makeDir('.skills', { user: brokenUserDir }),
      }),
    )
    await expect(scanInstalledDirNames()).rejects.toThrow('walk failed')
  })
})
