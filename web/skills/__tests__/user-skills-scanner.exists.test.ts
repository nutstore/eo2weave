/**
 * Tests for the OPFS existence checks in the skill update flow (issue #185):
 *
 * `userSkillDirExists` must distinguish absence (NotFoundError → `false`)
 * from a real storage failure (throw). Previously every error was converted
 * to `false`, so a transient OPFS failure made an installed skill look
 * uninstalled and callers silently skipped updates or misrouted deletes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The zustand store import inside skill-store is irrelevant here, but the
// scanner module itself doesn't import it — no store stub needed.

import { userSkillDirExists } from '@/skills/user-skills-scanner'

type DirStub = {
  kind: 'directory'
  name: string
  getDirectoryHandle: (name: string, opts?: { create?: boolean }) => Promise<DirStub>
}

const notFound = (path: string): Error =>
  new Error(`NotFoundError: ${path}`)

const makeDir = (
  name: string,
  children: Record<string, DirStub> = {},
): DirStub => ({
  kind: 'directory',
  name,
  getDirectoryHandle: async (child) => {
    const next = children[child]
    if (!next) throw notFound(`${name}/${child}`)
    return next
  },
})

/** Install a fake OPFS root for the duration of a test. */
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

describe('userSkillDirExists (#185 error-surfacing)', () => {
  it('returns true when the skill directory exists', async () => {
    useOpfsRoot(
      makeDir('opfs-root', {
        '.skills': makeDir('.skills', {
          user: makeDir('user', { 'my-skill': makeDir('my-skill') }),
        }),
      }),
    )
    await expect(userSkillDirExists('my-skill')).resolves.toBe(true)
  })

  it('returns false when the skill directory is absent (NotFoundError — not a failure)', async () => {
    useOpfsRoot(
      makeDir('opfs-root', {
        '.skills': makeDir('.skills', { user: makeDir('user') }),
      }),
    )
    await expect(userSkillDirExists('my-skill')).resolves.toBe(false)
  })

  it('returns false when `.skills/user/` does not exist yet', async () => {
    useOpfsRoot(makeDir('opfs-root'))
    await expect(userSkillDirExists('my-skill')).resolves.toBe(false)
  })

  it('throws when resolving `.skills` fails with a non-NotFound storage error', async () => {
    useOpfsRoot({
      fail: new Error('PermissionDeniedError: OPFS unavailable'),
    })
    await expect(userSkillDirExists('my-skill')).rejects.toThrow(
      'PermissionDeniedError',
    )
  })

  it('throws when resolving `user/` fails with a non-NotFound storage error', async () => {
    const brokenSkillsDir: DirStub = {
      kind: 'directory',
      name: '.skills',
      getDirectoryHandle: async () => {
        throw new Error('QuotaExceededError: storage broken')
      },
    }
    useOpfsRoot(
      makeDir('opfs-root', { '.skills': brokenSkillsDir }),
    )
    await expect(userSkillDirExists('my-skill')).rejects.toThrow(
      'QuotaExceededError',
    )
  })

  it('throws when the skill-directory probe itself fails with a non-NotFound storage error', async () => {
    const brokenUserDir: DirStub = {
      kind: 'directory',
      name: 'user',
      getDirectoryHandle: async () => {
        throw new Error('InvalidStateError: handle detached')
      },
    }
    useOpfsRoot(
      makeDir('opfs-root', {
        '.skills': makeDir('.skills', { user: brokenUserDir }),
      }),
    )
    await expect(userSkillDirExists('my-skill')).rejects.toThrow(
      'InvalidStateError',
    )
  })
})
