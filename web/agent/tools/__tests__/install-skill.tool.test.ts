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
const scanInstalledDirNamesMock = vi.fn()
const refreshUserSkillsMock = vi.fn()
const bumpSkillsScanVersionMock = vi.fn()

vi.mock('@/skills/skill-store', () => ({
  fetchSkillStoreManifest: (...args: unknown[]) => fetchSkillStoreManifestMock(...(args as [])),
  planSkillUpdate: (...args: unknown[]) => planSkillUpdateMock(...(args as [])),
  installSkillFromUrl: (...args: unknown[]) => installSkillFromUrlMock(...(args as [])),
  scanInstalledDirNames: (...args: unknown[]) => scanInstalledDirNamesMock(...(args as [])),
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
    // Default: nothing installed locally (the executor only consults this
    // when the manifest fetch fails).
    scanInstalledDirNamesMock.mockResolvedValue(new Set<string>())
    refreshUserSkillsMock.mockResolvedValue(undefined)
  })

  it('installs a skill that is not installed yet', async () => {
    installSkillFromUrlMock.mockResolvedValue({
      count: 4,
      manifest: ENTRY,
      outcome: 'installed',
    })

    const result = parse(await installSkillExecutor({ dirName: 'demo-skill' }))

    expect(installSkillFromUrlMock).toHaveBeenCalledWith(
      ENTRY.zipUrl,
      undefined,
      expect.objectContaining({ focusDirName: 'demo-skill' }),
    )
    expect(result.ok).toBe(true)
    expect(result.data.filesInstalled).toBe(4)
  })

  it('routes an already-installed skill through the version-aware install flow', async () => {
    // The skill IS installed locally (the scan mock reports it) — the tool
    // must NOT short-circuit on "already installed"; the install flow
    // decides update vs. keep. Without this, an executor that restored the
    // unconditional short-circuit would pass these assertions while never
    // reaching the flow (#154 round 8).
    scanInstalledDirNamesMock.mockResolvedValue(new Set(['demo-skill']))
    installSkillFromUrlMock.mockResolvedValue({
      count: 4,
      manifest: ENTRY,
      outcome: 'updated',
    })

    const result = parse(await installSkillExecutor({ dirName: 'demo-skill' }))

    expect(installSkillFromUrlMock).toHaveBeenCalledWith(
      ENTRY.zipUrl,
      undefined,
      expect.objectContaining({ focusDirName: 'demo-skill' }),
    )
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

    expect(installSkillFromUrlMock).toHaveBeenCalledWith(
      ENTRY.zipUrl,
      undefined,
      expect.objectContaining({ focusDirName: 'demo-skill' }),
    )
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

    expect(installSkillFromUrlMock).toHaveBeenCalledWith(
      ENTRY.zipUrl,
      undefined,
      expect.objectContaining({ focusDirName: 'demo-skill' }),
    )
    expect(result.ok).toBe(true)
    expect(result.data.alreadyInstalled).toBe(true)
  })

  it('asks ONE aggregated question for sibling bundle updates and forwards the approval (#183)', async () => {
    const askUserQuestion = vi
      .fn()
      .mockResolvedValue({ confirmed: true, answer: 'yes' })
    // The install flow enumerates the siblings and calls back before writing.
    installSkillFromUrlMock.mockImplementation(
      async (
        _zipUrl: string,
        _onProgress: unknown,
        options: {
          confirmBundleUpdates?: (
            candidates: Array<{ dirName: string }>,
          ) => Promise<string[]>
        },
      ) => {
        const approved = await options.confirmBundleUpdates!([
          { dirName: 'sibling-a' },
          { dirName: 'sibling-b' },
        ])
        return { count: 2, manifest: ENTRY, outcome: 'updated', bundleUpdates: { updated: approved, skipped: [] } }
      },
    )

    const result = parse(
      await installSkillExecutor({ dirName: 'demo-skill' }, { askUserQuestion }),
    )

    // ONE prompt names every affected sibling — not one prompt per member.
    expect(askUserQuestion).toHaveBeenCalledTimes(1)
    const question = askUserQuestion.mock.calls[0][0].question as string
    expect(question).toContain('sibling-a')
    expect(question).toContain('sibling-b')
    // The approval is forwarded as one install: the result names what changed.
    expect(result.data.bundleUpdates).toEqual({
      updated: ['sibling-a', 'sibling-b'],
      skipped: [],
    })
  })

  it('skips sibling updates when the user declines, and reports them (#183)', async () => {
    const askUserQuestion = vi.fn().mockResolvedValue({ confirmed: true, answer: 'no' })
    installSkillFromUrlMock.mockImplementation(
      async (
        _zipUrl: string,
        _onProgress: unknown,
        options: {
          confirmBundleUpdates?: (
            candidates: Array<{ dirName: string }>,
          ) => Promise<string[]>
        },
      ) => {
        const approved = await options.confirmBundleUpdates!([{ dirName: 'sibling-a' }])
        return {
          count: 1,
          manifest: ENTRY,
          outcome: 'updated',
          bundleUpdates: { updated: approved, skipped: approved.length ? [] : ['sibling-a'] },
        }
      },
    )

    const result = parse(
      await installSkillExecutor({ dirName: 'demo-skill' }, { askUserQuestion }),
    )

    expect(result.data.bundleUpdates).toEqual({ updated: [], skipped: ['sibling-a'] })
    expect(result.data.message).toContain('sibling-a')
  })

  it('reports a store miss without calling the install flow', async () => {
    fetchSkillStoreManifestMock.mockResolvedValue({ skills: [] })

    const result = parse(await installSkillExecutor({ dirName: 'nope' }))

    expect(installSkillFromUrlMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
  })

  it('keeps an installed skill usable when the store is unreachable (offline)', async () => {
    // Regression (#154 round 6): the manifest fetch became a hard
    // prerequisite, so an offline call for an installed skill returned
    // install_failed. The local copy must still be reported as usable.
    fetchSkillStoreManifestMock.mockRejectedValue(new Error('network unreachable'))
    scanInstalledDirNamesMock.mockResolvedValue(new Set(['demo-skill']))

    const result = parse(await installSkillExecutor({ dirName: 'demo-skill' }))

    expect(installSkillFromUrlMock).not.toHaveBeenCalled()
    expect(planSkillUpdateMock).not.toHaveBeenCalled()
    expect(result.ok).toBe(true)
    expect(result.data.alreadyInstalled).toBe(true)
    expect(result.data.updated).toBe(false)
    expect(result.data.message).not.toContain('1.1.3')
  })

  it('still fails offline when the skill is not installed locally', async () => {
    fetchSkillStoreManifestMock.mockRejectedValue(new Error('network unreachable'))
    scanInstalledDirNamesMock.mockResolvedValue(new Set<string>())

    const result = parse(await installSkillExecutor({ dirName: 'demo-skill' }))

    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('network unreachable')
  })

  it('does not take the offline fast path for a skill the scan does not report', async () => {
    // The offline fallback is gated on the SCANNED dirName membership — a
    // store id not present in the scan result must still surface the fetch
    // error instead of reporting a usable local copy (#154 round 8).
    fetchSkillStoreManifestMock.mockRejectedValue(new Error('network unreachable'))
    scanInstalledDirNamesMock.mockResolvedValue(new Set(['other-skill']))

    const result = parse(await installSkillExecutor({ dirName: 'demo-skill' }))

    expect(result.ok).toBe(false)
    expect(result.error.message).toContain('network unreachable')
  })
})
