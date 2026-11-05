/**
 * Regression tests for the #185 review round on `scanInstalledDirNames`:
 *
 * 1. Only an API-surface gap (no `navigator.storage` / no `getDirectory`)
 *    counts as "OPFS unavailable" — a TypeError thrown from DEEPER in the
 *    scan (enumeration, handle resolution) must propagate to the caller
 *    instead of silently degrading to the stale store cache. Before the fix
 *    `isOpfsUnavailableError` classified EVERY TypeError as unavailable.
 * 2. A cache-only name (store-cache fallback) is NOT confirmed OPFS
 *    presence: `lastInstalledDirNamesScanWasOpfsBacked()` reports which kind
 *    of snapshot the caller got, so the install-time drop guard can skip the
 *    mid-download-drop path for names that never existed on disk.
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
  lastInstalledDirNamesScanWasOpfsBacked,
  scanInstalledDirNames,
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

describe('isOpfsSupportMissing (#185 review round N)', () => {
  it('classifies a missing navigator.storage API surface as unavailable', () => {
    // What `navigator.storage` being undefined produces at the API surface.
    expect(isOpfsSupportMissing(new TypeError('Cannot read properties of undefined (reading getDirectory)'))).toBe(true)
    expect(isOpfsSupportMissing(new TypeError('navigator.storage.getDirectory is not a function'))).toBe(true)
    expect(isOpfsUnavailableError(new TypeError('anything'))).toBe(true)
  })

  it('does NOT classify an operational TypeError (mid-scan) as OPFS unavailability', () => {
    expect(isOpfsSupportMissing(new TypeError('Failed to enumerate directory entries'))).toBe(false)
    expect(isOpfsSupportMissing(new TypeError('undefined is not iterable'))).toBe(false)
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
    await scanInstalledDirNames()
    expect(lastInstalledDirNamesScanWasOpfsBacked()).toBe(true)
  })

  it('marks the store-cache fallback as NOT OPFS-backed', async () => {
    // `.skills` absent → NotFoundError → store-cache fallback.
    await scanInstalledDirNames()
    expect(lastInstalledDirNamesScanWasOpfsBacked()).toBe(false)
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
    await expect(scanInstalledDirNames()).rejects.toThrow('failed to enumerate')
  })
})
