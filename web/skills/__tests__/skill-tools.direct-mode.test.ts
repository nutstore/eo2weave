/**
 * Direct-mode skill boundary tests:
 *
 * A standalone chat (kind='direct', toolContext.directMode) has NO project —
 * project-sourced skills are host-project data and their SKILL.md/resources
 * resolve through the HOST project's runtime directory handles. Two layers
 * must enforce the boundary:
 *   1. the `skills` context source withholds project-skill metadata
 *      (nothing advertises what must not be served);
 *   2. `read_skill` / `read_skill_resource` reject project-sourced skills by
 *      name even when the SkillManager cache still holds them (the by-name
 *      bypass around a filtered catalog).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRuntimeContextSources } from '@/agent/context/sources'
import { collectContextSources } from '@/agent/context/journal'
import { readSkillExecutor, readSkillResourceExecutor } from '@/skills/skill-tools'
import {
  readProjectSkillMdFromNativeFs,
  readProjectSkillResourceFromNativeFs,
} from '@/skills/project-skill-live-reader'
import type { Skill, SkillMetadata } from '@/skills/skill-types'

const state = vi.hoisted(() => ({
  initialized: true,
  skills: [] as Skill[],
}))

vi.mock('@/skills/skill-manager', () => ({
  getSkillManager: () => ({
    initialize: async () => {},
    refreshProviderSkills: async () => {},
    initialized: state.initialized,
    getSkills: () => state.skills,
    getSkillMetadata: () => state.skills.map((s) => ({
      id: s.id, name: s.name, version: s.version, description: s.description,
      author: s.author, category: s.category, tags: s.tags, source: s.source,
      providerLocation: s.providerLocation, triggers: s.triggers, enabled: s.enabled,
      createdAt: s.createdAt, updatedAt: s.updatedAt,
    })),
    getSkillByName: (name: string) =>
      state.skills.find((s) => s.name.toLowerCase() === name.trim().toLowerCase()) ?? null,
    getEnabledSkillNames: (options?: { excludeSources?: string[] }) =>
      state.skills.filter((s) => s.enabled && !(options?.excludeSources?.includes(s.source))).map((s) => s.name),
    getSkillResources: async () => [],
  }),
}))

vi.mock('@/skills/provider-skills', () => ({
  readProviderSkillFile: vi.fn(),
  listProviderSkillResources: vi.fn(async () => []),
}))
vi.mock('@/skills/skills-platform-adapter', () => ({
  listSkillResourcesFromOPFS: vi.fn(async () => []),
  readSkillResourceFromOPFS: vi.fn(async () => null),
  readSkillMdFromOPFS: vi.fn(async () => null),
}))
vi.mock('@/skills/project-skill-live-reader', () => ({
  readProjectSkillMdFromNativeFs: vi.fn(async () => null),
  listProjectSkillResourcesFromNativeFs: vi.fn(async () => []),
  readProjectSkillResourceFromNativeFs: vi.fn(async () => null),
}))
vi.mock('@/skills/skill-storage', () => ({ getSkillResources: vi.fn(async () => []) }))

const skill = (overrides: Partial<SkillMetadata>): Skill =>
  ({
    id: 's', name: 's', version: '1', description: 'd', author: 'a',
    category: 'general', tags: [], source: 'user', enabled: true,
    triggers: { keywords: [] }, createdAt: 1, updatedAt: 1,
    ...overrides,
  }) as Skill

const directContext = { directoryHandle: null, directMode: true } as never
const projectContext = { directoryHandle: null } as never

describe('skills context source in direct mode', () => {
  beforeEach(() => {
    state.initialized = true
    state.skills = []
  })

  it('publishes user and builtin skills but NOT project skills', async () => {
    state.skills = [
      skill({ id: 'u', name: 'user-skill', source: 'user' }),
      skill({ id: 'b', name: 'builtin-skill', source: 'builtin' }),
      skill({ id: 'project:root:.skills/secret', name: 'project-skill', source: 'project' }),
    ]
    const source = createRuntimeContextSources(() => ({
      baseSystemPrompt: 'fixed', messages: [], mode: 'act' as const,
      toolContext: { directoryHandle: null, directMode: true },
    })).find((s) => s.id === 'skills')!
    const observations = await collectContextSources([source])
    const keys = Object.keys(observations[0]?.entries ?? {})
    expect(keys).toContain('user-skill')
    expect(keys).toContain('builtin-skill')
    expect(keys).not.toContain('project-skill')
  })

  it('keeps publishing project skills in project (non-direct) mode', async () => {
    state.skills = [skill({ id: 'project:root:.skills/pub', name: 'project-skill', source: 'project' })]
    const source = createRuntimeContextSources(() => ({
      baseSystemPrompt: 'fixed', messages: [], mode: 'act' as const,
      toolContext: { directoryHandle: null },
    })).find((s) => s.id === 'skills')!
    const observations = await collectContextSources([source])
    expect(Object.keys(observations[0]?.entries ?? {})).toContain('project-skill')
  })
})

describe('read_skill / read_skill_resource direct-mode guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.initialized = true
    state.skills = []
  })

  it('read_skill rejects a project skill in direct mode without touching native FS', async () => {
    state.skills = [skill({ id: 'project:root:.skills/leak', name: 'project-skill', source: 'project' })]
    const raw = await readSkillExecutor({ skill_name: 'project-skill' }, directContext)
    const parsed = JSON.parse(raw) as { ok: boolean; error?: { code?: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error?.code).toBe('direct_mode_forbidden')
    expect(readProjectSkillMdFromNativeFs).not.toHaveBeenCalled()
    expect(readProjectSkillResourceFromNativeFs).not.toHaveBeenCalled()
  })

  it('read_skill not-found hint withholds project-skill names in direct mode (round 7)', async () => {
    state.skills = [skill({ id: 'project:root:.skills/secret', name: 'project-skill', source: 'project' })]
    const raw = await readSkillExecutor({ skill_name: 'missing-skill' }, directContext)
    const parsed = JSON.parse(raw) as { ok: boolean; error?: { message?: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error?.message).not.toContain('project-skill')
  })

  it('read_skill not-found hint keeps project skills in project mode (zero drift)', async () => {
    state.skills = [skill({ id: 'project:root:.skills/pub', name: 'project-skill', source: 'project' })]
    const raw = await readSkillExecutor({ skill_name: 'missing-skill' }, projectContext)
    const parsed = JSON.parse(raw) as { ok: boolean; error?: { message?: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error?.message).toContain('project-skill')
  })

  it('read_skill still serves user skills in direct mode (retained capability)', async () => {
    // Assert the CONTENT, not just ok:true — a metadata-only response would
    // satisfy parsed.ok while the capability under test (reading the user
    // skill's actual instructions) silently regressed.
    const userSkill = {
      ...skill({ id: 'user:notes', name: 'user-skill', source: 'user' }),
      instruction: 'Always cite the notes file.',
    } as Skill
    state.skills = [userSkill]
    const raw = await readSkillExecutor({ skill_name: 'user-skill' }, directContext)
    const parsed = JSON.parse(raw) as { ok: boolean; content?: string }
    expect(parsed.ok).toBe(true)
    expect(raw).toContain('Always cite the notes file.')
  })

  it('read_skill serves project skills in project mode (zero drift)', async () => {
    state.skills = [skill({ id: 'project:root:.skills/pub', name: 'project-skill', source: 'project' })]
    const raw = await readSkillExecutor({ skill_name: 'project-skill' }, projectContext)
    const parsed = JSON.parse(raw) as { ok: boolean }
    expect(parsed.ok).toBe(true)
  })

  it('read_skill_resource rejects a project skill in direct mode', async () => {
    state.skills = [skill({ id: 'project:root:.skills/leak', name: 'project-skill', source: 'project' })]
    const raw = await readSkillResourceExecutor(
      { skill_name: 'project-skill', resource_path: 'references/api.md' },
      directContext,
    )
    const parsed = JSON.parse(raw) as { ok: boolean; error?: { code?: string } }
    expect(parsed.ok).toBe(false)
    expect(parsed.error?.code).toBe('direct_mode_forbidden')
    expect(readProjectSkillMdFromNativeFs).not.toHaveBeenCalled()
    expect(readProjectSkillResourceFromNativeFs).not.toHaveBeenCalled()
  })
})
