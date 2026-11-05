/**
 * Regression tests for the #185 review round on `scanInstalledDirNames`:
 *
 * 1. Only an API-surface gap (no `navigator.storage` / no `getDirectory`)
 *    counts as "OPFS unavailable" — a TypeError thrown from DEEPER in the
 *    scan (enumeration, handle resolution) must propagate to the caller
 *    instead of silently degrading to the stale store cache. Before the fix
 *    `isOpfsUnavailableError` classified EVERY TypeError as unavailable.
 * 2. A cache-only name (store-cache fallback) is NOT confirmed OPFS
 *    presence: `scanInstalledDirNamesSnapshot()` returns the provenance
 *    WITH the names, so the install-time drop guard can skip the
 *    mid-download-drop path for names that never existed on disk — a shared
 *    flag would be overwritten by any concurrent scan (#185 review round N).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/skills.store', () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [{ id: 'user:cached-skill', source: 'user' }],
    }),
  },
}))

import {
  isOpfsSupportMissing,
  isOpfsUnavailableError,
} from '@/skills/user-skills-scanner'
import {
  scanInstalledDirNamesSnapshot,
} from '@/skills/skill-store'

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

const useOpfsRoot = (root: DirStub): void => {
  ;(navigator as unknown as { storage: { getDirectory: () => Promise<unknown> } }).storage = {
    getDirectory: () => Promise.resolve(root),
  }
}

beforeEach(() => {
  useOpfsRoot(makeDir('opfs-root'))
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (navigator as unknown as { storage?: unknown }).storage
})

describe('isOpfsSupportMissing (#185 review round N, #197)', () => {
  it('classifies a missing File System Access API as unavailable', () => {
    // Capability check, not message matching (#197): with no
    // navigator.storage at all the platform cannot scan OPFS.
    const storage = (navigator as unknown as { storage?: unknown }).storage
    delete (navigator as unknown as { storage?: unknown }).storage
    expect(isOpfsSupportMissing(new TypeError('Cannot read properties of undefined (reading getDirectory)'))).toBe(true)
    expect(isOpfsSupportMissing(new Error('anything at all'))).toBe(true)
    ;(navigator as unknown as { storage?: unknown }).storage = storage
    expect(isOpfsUnavailableError(new TypeError('anything'))).toBe(true)
  })

  it('does NOT classify an operational TypeError (mid-scan) as OPFS unavailability', () => {
    // The API surface EXISTS here (see beforeEach), so a TypeError raised
    // during enumeration cannot be a support gap — even the generic
    // "Cannot read properties of undefined" message the old matcher keyed on.
    expect(isOpfsSupportMissing(new TypeError('Failed to enumerate directory entries'))).toBe(false)
    expect(isOpfsSupportMissing(new TypeError('undefined is not iterable'))).toBe(false)
    expect(isOpfsSupportMissing(new TypeError('Cannot read properties of undefined (reading values)'))).toBe(false)
    // Non-TypeError errors are never an API gap.
    expect(isOpfsSupportMissing(new Error('PermissionDeniedError: nope'))).toBe(false)
  })
})

describe('scanInstalledDirNames provenance (#185 review round N)', () => {
  it('marks an OPFS-backed scan as OPFS-backed', async () => {
    useOpfsRoot(
      makeDir('opfs-root', {
        '.skills': makeDir('.skills', {
          user: makeDir('user', {}, ['alpha']),
        }),
      }),
    )
    const snapshot = await scanInstalledDirNamesSnapshot()
    expect(snapshot.opfsBacked).toBe(true)
    expect([...snapshot.names]).toEqual(['alpha'])
  })

  it('marks the store-cache fallback as NOT OPFS-backed', async () => {
    // `.skills` absent → NotFoundError → store-cache fallback.
    const snapshot = await scanInstalledDirNamesSnapshot()
    expect(snapshot.opfsBacked).toBe(false)
    expect([...snapshot.names]).toEqual(['cached-skill'])
  })

  it('propagates a mid-walk TypeError instead of falling back to the cache', async () => {
    const brokenUserDir: DirStub = {
      kind: 'directory',
      name: 'user',
      getDirectoryHandle: async () => brokenUserDir,
      values: async function* () {
        throw new TypeError('TypeError: failed to enumerate OPFS entries')
        // eslint-disable-next-line no-unreachable
        yield { kind: 'directory', name: 'alpha' }
      },
    }
    useOpfsRoot(
      makeDir('opfs-root', {
        '.skills': makeDir('.skills', { user: brokenUserDir }),
      }),
    )
    // Before the fix this resolved to the stale store cache; now the
    // operational failure must surface.
    await expect(scanInstalledDirNamesSnapshot()).rejects.toThrow('failed to enumerate')
  })
})
