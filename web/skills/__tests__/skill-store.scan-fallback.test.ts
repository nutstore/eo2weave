/**
 * Regression tests for scanInstalledDirNames' store fallback (#154 round 8).
 *
 * When the OPFS scan fails, the fallback mapped the skills store's ids
 * (`user:<dirName>`) into the returned set verbatim — every caller compares
 * that set against BARE directory names, so a usable locally installed
 * skill was reported as not installed (agent "install failed" for an
 * installed skill; the download guard missed a pre-download installation).
 * The fallback must strip the `user:` prefix.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const storeState = { skills: [] as Array<{ id: string; source: string }> }

vi.mock('@/store/skills.store', () => ({
  useSkillsStore: { getState: () => storeState },
}))

import { scanInstalledDirNames } from '../skill-store'

describe('scanInstalledDirNames store fallback (#154 round 8)', () => {
  beforeEach(() => {
    storeState.skills = []
    // Remove navigator.storage so the OPFS scan throws and the store
    // fallback runs.
    vi.stubGlobal('navigator', {} as Navigator)
  })

  it('strips the user: prefix from store ids so membership checks match dirNames', async () => {
    storeState.skills = [
      { id: 'user:demo-skill', source: 'user' },
      { id: 'user:other', source: 'user' },
      { id: 'builtin-1', source: 'builtin' },
      { id: 'project:proj-skill', source: 'project' },
    ]

    const names = await scanInstalledDirNames()

    expect(names.has('demo-skill')).toBe(true)
    expect(names.has('other')).toBe(true)
    expect(names.has('user:demo-skill')).toBe(false)
    expect(names.has('builtin-1')).toBe(false)
    expect(names.has('proj-skill')).toBe(false)
  })
})
