/**
 * Tests for the #185 review round: storage-error consequences of the PR's
 * "propagate non-NotFound OPFS errors" policy.
 *
 * Covered contracts:
 *  - no-OPFS TypeError from navigator.storage.getDirectory() is treated as
 *    absence (store-cache fallback), not a hard failure;
 *  - a genuine mid-walk enumeration error still propagates (already covered
 *    in skill-store.scan-installed.test.ts — not duplicated here).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store/skills.store', () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [{ id: 'user:cached-skill', source: 'user' }],
    }),
  },
}))

import { scanInstalledDirNames } from '@/skills/skill-store'

beforeEach(() => {
  // No navigator.storage at all: a browser without File System Access.
  vi.stubGlobal('navigator', {} as Navigator)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('scanInstalledDirNames with no OPFS support (#185 review)', () => {
  it('treats the getDirectory TypeError as absence and falls back to the store cache', async () => {
    const names = await scanInstalledDirNames()
    expect(names).toEqual(new Set(['cached-skill']))
  })
})
