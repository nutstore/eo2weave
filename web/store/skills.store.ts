/**
 * Skills Store - Zustand store for Skills system state.
 * Using Immer middleware for simplified immutable updates.
 */

import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import type { Skill, SkillMetadata, SkillCategory } from '@/skills/skill-types'
import * as storage from '@/skills/skill-storage'
import { parseSkillMd, serializeSkillMd, slugify } from '@/skills/skill-parser'
import { getSkillManager } from '@/skills/skill-manager'
import { useProjectStore } from '@/store/project.store'
import {
  writeUserSkillMd,
  deleteUserSkillDir,
  userSkillDirExists,
} from '@/skills/user-skills-scanner'
import { deleteProjectSkillFromNativeFs } from '@/skills/project-skill-live-reader'

/** Refresh SkillManager cache to keep it in sync with store */
async function refreshSkillManagerCache() {
  try {
    const manager = getSkillManager()
    // Refresh both persistent (SQLite) and user (OPFS) skill caches so the
    // UI reflects OPFS writes immediately.
    await manager.refreshCache()
    await manager.refreshUserSkills()
    await manager.refreshProviderSkills()
  } catch (error) {
    console.error('[SkillsStore] Failed to refresh SkillManager cache:', error)
  }
}

interface SkillsState {
  /** All skill metadata (lightweight) */
  skills: SkillMetadata[]
  /** Whether skills have been loaded from IndexedDB */
  loaded: boolean
  /** Loading state */
  loading: boolean
  /** Error state - prevents retry loop on persistent errors */
  error: string | null
  /** Manual trigger token for forcing project skill re-scan */
  skillsScanVersion: number

  // Actions
  loadSkills: () => Promise<void>
  addSkill: (skill: Skill, rawContent?: string) => Promise<void>
  importSkillMd: (
    content: string
  ) => Promise<{ success: boolean; error?: string; skillId?: string }>
  /**
   * Create a new user skill skeleton in OPFS and return the skill id.
   *
   * Generates a SKILL.md template (frontmatter + instruction placeholder)
   * under `.skills/user/<dirName>/`. Unlike `importSkillMd`, the directory
   * name is provided directly (not derived from the skill name) so the user
   * controls the technical identifier.
   */
  createSkillSkeleton: (
    dirName: string,
    name: string,
    description: string
  ) => Promise<{ success: boolean; error?: string; skillId?: string }>
  deleteSkill: (id: string) => Promise<void>
  toggleSkill: (id: string, enabled: boolean) => Promise<void>
  getFullSkill: (id: string) => Promise<Skill | null>
  getEnabledSkills: () => Promise<Skill[]>
  getSkillsByCategory: (category: SkillCategory) => Promise<Skill[]>
  clearError: () => void
  bumpSkillsScanVersion: () => void
}

type SkillsStateWithImmer = SkillsState & {
  setState: (partial: Partial<SkillsState> | ((state: SkillsState) => void)) => void
}

export const useSkillsStore = create<SkillsStateWithImmer>()(
  immer((set, get) => ({
    setState: set,
    skills: [],
    loaded: false,
    loading: false,
    error: null,
    skillsScanVersion: 0,

    loadSkills: async () => {
      const state = get()
      // Prevent concurrent loadSkills calls — but allow retry after errors
      // (previous versions permanently locked out retry, causing the entire
      // skills system to be unusable until a full page refresh).
      if (state.loading) return
      set({ loading: true, error: null })
      try {
        // Initialize and sync SkillManager first (this seeds builtin skills)
        const manager = getSkillManager()
        await manager.initialize()
        await refreshSkillManagerCache()

        // Load metadata from SkillManager cache (persistent + active project runtime skills)
        const metadata = manager.getSkillMetadata()
        set({ skills: metadata, loaded: true, loading: false, error: null })
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error('[SkillsStore] loadSkills error:', error)
        // Set error state to prevent retry loop
        set({ loading: false, error: errorMsg })
      }
    },

    addSkill: async (skill, rawContent) => {
      const raw = rawContent || serializeSkillMd(skill)
      await storage.saveSkill(skill, raw)
      // Refresh metadata list
      const manager = getSkillManager()
      await refreshSkillManagerCache()
      const metadata = manager.getSkillMetadata()
      set({ skills: metadata })
    },

    importSkillMd: async (content) => {
      const result = parseSkillMd(content, 'user')
      if (!result.skill) {
        return { success: false, error: result.error }
      }

      // User skills are stored in OPFS `.skills/user/<dirName>/SKILL.md`.
      // Derive the directory name from the skill **name** (not id) using the
      // shared slugify function. This matches what migration uses and ensures
      // that re-importing an already-migrated skill updates the same dir
      // instead of creating a duplicate.
      const dirName = slugify(result.skill.name)

      try {
        await writeUserSkillMd(dirName, content)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { success: false, error: `Failed to write user skill: ${msg}` }
      }

      // Refresh both caches (OPFS scan + SQLite) so the new skill appears
      // immediately in the UI.
      const manager = getSkillManager()
      await refreshSkillManagerCache()
      const metadata = manager.getSkillMetadata()
      set({ skills: metadata })
      // Return the user-prefixed skillId so callers (e.g. SkillEditor) can
      // correctly compare it with the existing skill's id (which is also
      // `user:<dirName>` after scanning). Without the prefix, the comparison
      // would always differ and the caller would delete the just-saved skill.
      return { success: true, skillId: `user:${dirName}` }
    },

    createSkillSkeleton: async (dirName, name, description) => {
      // Guard: a directory with this name already exists.
      const exists = await userSkillDirExists(dirName).catch(() => false)
      if (exists) {
        return { success: false, error: 'A skill with this directory name already exists' }
      }

      // Build a SKILL.md template. Frontmatter aligns with the builtin
      // skill style (see socratic-brainstorm/SKILL.md). The instruction
      // body is an HTML comment guide + a placeholder line so the user has
      // immediate orientation when the file opens in the editor.
      const escapedName = name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const escapedDesc = description.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const content = [
        '---',
        `name: "${escapedName}"`,
        'version: "1.0.0"',
        `description: "${escapedDesc}"`,
        'author: "User"',
        'category: general',
        'tags: []',
        'triggers:',
        '  keywords: []',
        '---',
        '',
        `# ${name}`,
        '',
        '<!-- 在这里写下技能的指令（instruction）。',
        '     这段内容会被注入到对话的 system prompt 中，告诉 AI 这个技能怎么用。',
        '',
        '     常见写法：',
        '     - 一句话说明这个技能做什么',
        '     - 触发条件（什么情况下应该激活这个技能）',
        '     - 具体的工作流程 / 步骤',
        '     - 输出格式要求',
        '-->',
        '',
        '在此输入指令内容...',
        '',
      ].join('\n')

      try {
        await writeUserSkillMd(dirName, content)
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return { success: false, error: `Failed to create skill: ${msg}` }
      }

      const manager = getSkillManager()
      await refreshSkillManagerCache()
      const metadata = manager.getSkillMetadata()
      set({ skills: metadata })
      return { success: true, skillId: `user:${dirName}` }
    },

    deleteSkill: async (id) => {
      // User skills (source='user', id prefix 'user:') live in OPFS.
      // Project skills (id prefix 'project:') live on native FS — delete
      //   the skill directory from the project's native folder.
      // Persistent skills (builtin) live in SQLite.
      try {
        if (id.startsWith('user:')) {
          const dirName = id.replace(/^user:/, '')
          // Check if the directory exists before attempting deletion.
          // If it doesn't exist, it may be a legacy SQLite-only skill that
          // wasn't migrated yet — fall through to SQLite deletion.
          const existsInOpfs = await userSkillDirExists(dirName).catch(() => false)
          if (existsInOpfs) {
            await deleteUserSkillDir(dirName)
          } else {
            await storage.deleteSkill(id)
          }
        } else if (id.startsWith('project:')) {
          // Project skills live on native FS (e.g. .skills/my-skill/ or
          // .claude/skills/my-skill/). Delete the directory from native FS
          // using the active project's runtime handle.
          const activeProjectId = useProjectStore.getState().activeProjectId || null
          const deleted = await deleteProjectSkillFromNativeFs(id, activeProjectId)
          if (!deleted) {
            console.warn(
              `[SkillsStore] Project skill directory not found or handle unavailable: ${id}`
            )
          }
        } else {
          await storage.deleteSkill(id)
        }
      } catch (error) {
        console.error('[SkillsStore] deleteSkill failed for', id, error)
        // Still remove from store so UI reflects intent even if storage fails
      }
      set((state) => {
        state.skills = state.skills.filter((s) => s.id !== id)
      })
      await refreshSkillManagerCache()
      // For project skills, bump the scan version so WorkspaceLayout
      // re-scans the project directory and removes the deleted skill from
      // the in-memory cache.
      if (id.startsWith('project:')) {
        get().bumpSkillsScanVersion()
      }
    },

    toggleSkill: async (id, enabled) => {
      const manager = getSkillManager()
      const skill = get().skills.find((s) => s.id === id)

      if (skill?.source === 'project') {
        const activeProjectId = useProjectStore.getState().activeProjectId || null
        manager.setProjectSkillEnabled(id, enabled, activeProjectId)
        set((state) => {
          const target = state.skills.find((s) => s.id === id)
          if (target) {
            target.enabled = enabled
          }
        })
        return
      }

      if (skill?.source === 'user' || skill?.source === 'provider') {
        // User skills live in OPFS; there is no SQLite record to update.
        // Update the in-memory cache directly so the UI reflects the change.
        manager.setUserSkillEnabled(id, enabled)
        set((state) => {
          const target = state.skills.find((s) => s.id === id)
          if (target) {
            target.enabled = enabled
          }
        })
        return
      }

      await storage.toggleSkill(id, enabled)
      set((state) => {
        const target = state.skills.find((s) => s.id === id)
        if (target) {
          target.enabled = enabled
        }
      })
      await refreshSkillManagerCache()
    },

    getFullSkill: async (id) => {
      const manager = getSkillManager()
      const cached = manager.getSkillById(id)
      if (cached) return cached
      const stored = await storage.getSkillById(id)
      return stored || null
    },

    getEnabledSkills: async () => {
      const manager = getSkillManager()
      return manager.getSkills().filter((skill) => skill.enabled)
    },

    getSkillsByCategory: async (category) => {
      const manager = getSkillManager()
      return manager.getSkills().filter((skill) => skill.category === category)
    },

    clearError: () => {
      set({ error: null })
    },

    bumpSkillsScanVersion: () => {
      set((state) => {
        state.skillsScanVersion += 1
      })
    },
  }))
)
