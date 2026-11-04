/**
 * Functional tests for the install_skill agent tool (#154).
 *
 * The tool used to short-circuit on an already-installed skill and report
 * "already installed" — the store's newer version never reached the user's
 * copy. The tool must now always go through the version-aware install flow
 * and report what that flow decided.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const fetchSkillStoreManifestMock = vi.fn()
const planSkillUpdateMock = vi.fn()
const installSkillFromUrlMock = vi.fn()
const refreshUserSkillsMock = vi.fn()
const bumpSkillsScanVersionMock = vi.fn()

vi.mock('@/skills/skill-store', () => ({
  fetchSkillStoreManifest: (...args: unknown[]) => fetchSkillStoreManifestMock(...(args as [])),
  planSkillUpdate: (...args: unknown[]) => planSkillUpdateMock(...(args as [])),
  installSkillFromUrl: (...args: unknown[]) => installSkillFromUrlMock(...(args as [])),
}))

vi.mock('@/skills/skill-version', () => ({
  skillUpdateNeedsConsent: (action: string) => action === 'update',
}))

vi.mock('@/skills/skill-manager', () => ({
  getSkillManager: () => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    refreshUserSkills: (...args: unknown[]) => refreshUserSkillsMock(...(args as [])),
  }),
}))

vi.mock('@/store/skills.store', () => ({
  useSkillsStore: {
    getState: () => ({ bumpSkillsScanVersion: bumpSkillsScanVersionMock }),
  },
}))

import { installSkillExecutor } from '../install-skill.tool'

const ENTRY = {
  id: 'demo-skill',
  name: 'demo-skill',
  dirName: 'demo-skill',
  description: 'A skill used to verify the agent install path.',
  category: 'general',
  tags: [],
  version: '1.1.3',
  zipUrl: 'https://store.example/demo-skill.zip',
}

const parse = (json: string): Record<string, any> => JSON.parse(json)

describe('install_skill tool (#154)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchSkillStoreManifestMock.mockResolvedValue({ skills: [ENTRY] })
    // Default: the preflight reports a fresh install — no consent gate. The
    // executor still calls it before every installSkillFromUrl.
    planSkillUpdateMock.mockResolvedValue('install')
    refreshUserSkillsMock.mockResolvedValue(undefined)
  })

  it('installs a skill that is not installed yet', async () => {
    installSkillFromUrlMock.mockResolvedValue({
      count: 4,
      manifest: ENTRY,
      outcome: 'installed',
    })

    const result = parse(await installSkillExecutor({ dirName: 'demo-skill' }))

    expect(installSkillFromUrlMock).toHaveBeenCalledWith(ENTRY.zipUrl)
    expect(result.ok).toBe(true)
    expect(result.data.filesInstalled).toBe(4)
  })

  it('routes an already-installed skill through the version-aware install flow', async () => {
    // The store ships a newer version — the tool must NOT short-circuit on
    // "already installed"; the install flow decides update vs. keep.
    installSkillFromUrlMock.mockResolvedValue({
      count: 4,
      manifest: ENTRY,
      outcome: 'updated',
    })

    const result = parse(await installSkillExecutor({ dirName: 'demo-skill' }))

    expect(installSkillFromUrlMock).toHaveBeenCalledWith(ENTRY.zipUrl)
    expect(result.ok).toBe(true)
    expect(result.data.updated).toBe(true)
    expect(result.data.message).toContain('1.1.3')
  })

  it('reports a matching installed copy without claiming an update', async () => {
    installSkillFromUrlMock.mockResolvedValue({
      count: 0,
      manifest: ENTRY,
      outcome: 'current',
    })

    const result = parse(await installSkillExecutor({ dirName: 'demo-skill' }))

    expect(installSkillFromUrlMock).toHaveBeenCalledWith(ENTRY.zipUrl)
    expect(result.ok).toBe(true)
    expect(result.data.alreadyInstalled).toBe(true)
    expect(result.data.updated).toBeUndefined()
  })

  it('never downgrades a newer installed copy', async () => {
    installSkillFromUrlMock.mockResolvedValue({
      count: 0,
      manifest: ENTRY,
      outcome: 'installed-newer',
    })

    const result = parse(await installSkillExecutor({ dirName: 'demo-skill' }))

    expect(installSkillFromUrlMock).toHaveBeenCalledWith(ENTRY.zipUrl)
    expect(result.ok).toBe(true)
    expect(result.data.alreadyInstalled).toBe(true)
  })

  it('reports a store miss without calling the install flow', async () => {
    fetchSkillStoreManifestMock.mockResolvedValue({ skills: [] })

    const result = parse(await installSkillExecutor({ dirName: 'nope' }))

    expect(installSkillFromUrlMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })
})
