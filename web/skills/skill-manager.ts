/**
 * Skill Manager - lifecycle management and Agent integration.
 *
 * Responsibilities:
 * - Initialize skills system (load from SQLite + seed builtins)
 * - Scan project directory for skills
 * - Scan user skills directory
 * - Build skills block for system prompt (metadata-only, on-demand loading)
 */

import { scanProviderSkills, listProviderSkillResources } from './provider-skills'
import { providerRegistry } from '@/vfs/provider-registry'
import type { Skill, SkillMetadata, SkillResource } from './skill-types'
import * as storage from './skill-storage'
import {
  buildAvailableSkillsBlock,
} from './skill-injection'
import { scanProjectSkills } from './skill-scanner'
import { scanUserSkills, migrateUserSkillsFromSQLite } from './user-skills-scanner'
import { generateResourceId } from './skill-resources'
import {
  clearSkillCommands,
  registerSkillCommands,
} from './slash-command-registry'

export class SkillManager {
  private _initialized = false
  private cachedPersistentSkills: Skill[] = []
  private cachedProjectSkills: Skill[] = []
  private cachedProviderSkills: Skill[] = []
  private providerRefresh: Promise<void> | null = null
  private cachedUserSkills: Skill[] = []
  private userResourcesBySkillId = new Map<string, SkillResource[]>()
  private projectResourcesBySkillId = new Map<string, SkillResource[]>()
  private activeProjectId: string | null = null
  private initPromise: Promise<void> | null = null

  /** Check if the skill manager has been initialized */
  get initialized(): boolean {
    return this._initialized
  }

  /**
   * Initialize the skill system.
   * Loads skills from SQLite and seeds builtins if needed.
   * Safe to call multiple times - subsequent calls will await the same promise.
   */
  async initialize(): Promise<void> {
    // If already initialized, return immediately
    if (this._initialized) return

    // If initialization is in progress, await the same promise
    if (this.initPromise) return this.initPromise

    // Start initialization
    this.initPromise = this._doInitialize()
    await this.initPromise
    this.initPromise = null
  }

  private async _doInitialize(): Promise<void> {
    try {
      // Step 0a: Register built-in slash commands (compact etc.)
      try {
        const { registerBuiltinSlashCommands } = await import('./slash-command-registry')
        registerBuiltinSlashCommands()
      } catch (error) {
        console.warn('[SkillManager] Builtin slash commands registration failed:', error)
      }

      // Step 0b: Materialize builtin skills to OPFS (incremental sync)
      try {
        const { initializeSkillsSystem } = await import('./skills-system-init')
        const result = await initializeSkillsSystem()
        console.log(
          '[SkillManager] Skills system init:',
          result.registryOk ? 'registry OK' : 'registry FAILED',
          result.materialize
            ? `${result.materialize.written} written, ${result.materialize.skipped} skipped`
            : 'no materialize',
          result.healthy ? 'healthy' : 'UNHEALTHY'
        )
      } catch (error) {
        console.warn('[SkillManager] Skills system init failed (non-fatal):', error)
      }

      // Project skills are now runtime-scoped and must not persist in SQLite.
      await storage.purgeProjectSkillsFromStorage()

      // Step 1: Seed materialized builtin skills from OPFS (cw-brainstorm etc.)
      // These are skills defined in builtin-packages/ with SKILL.md files.
      const bundledSkillIds: string[] = []
      try {
        const { BUNDLED_SKILL_FILES } = await import('./builtin-packages-registry')
        const { parseSkillMd } = await import('./skill-parser')
        const skillNames = new Set<string>()
        for (const key of Object.keys(BUNDLED_SKILL_FILES)) {
          const slashIdx = key.indexOf('/')
          if (slashIdx > 0) skillNames.add(key.substring(0, slashIdx))
        }
        for (const skillName of skillNames) {
          const skillMd = BUNDLED_SKILL_FILES[`${skillName}/SKILL.md`]
          if (!skillMd) continue
          const parsed = parseSkillMd(skillMd, 'builtin')
          if (!parsed.skill) continue
          const skill = {
            ...parsed.skill,
            id: `builtin:${parsed.skill.id}`,
          }
          bundledSkillIds.push(skill.id)
          const existing = await storage.getSkillById(skill.id)
          if (!existing) {
            console.log('[SkillManager] Saving bundled skill:', skill.id)
            await storage.saveSkill(skill, skillMd)
          } else if (existing.version !== skill.version) {
            // Builtin skill version changed — update instruction in SQLite
            console.log(`[SkillManager] Updating bundled skill: ${skill.id} (${existing.version} → ${skill.version})`)
            await storage.saveSkill(skill, skillMd)
          }
        }
      } catch (error) {
        console.warn('[SkillManager] Bundled skill seeding failed:', error)
      }

      await this.refreshCache()

      // Step 2: Prune stale builtin skills that are no longer bundled
      const validBuiltinIds = new Set(bundledSkillIds)
      const allSkills = await storage.getAllSkills()
      for (const skill of allSkills) {
        if (skill.source === 'builtin' && !validBuiltinIds.has(skill.id)) {
          console.log('[SkillManager] Pruning stale builtin skill:', skill.id)
          await storage.deleteSkill(skill.id)
        }
      }
      await this.refreshCache()

      // Step 2b: Migrate legacy user skills from SQLite to OPFS.
      // Older app versions stored source='user' skills in SQLite. The current
      // architecture uses OPFS `.skills/user/` as the single source of truth.
      // This must run BEFORE refreshUserSkills() so the migrated files are
      // picked up by the OPFS scan.
      try {
        const result = await migrateUserSkillsFromSQLite()
        if (result.migrated.length > 0 || result.pruned.length > 0) {
          // Re-sync cachedPersistentSkills — migrated skills are now removed
          // from SQLite and should not linger in the persistent cache.
          await this.refreshCache()
        }
      } catch (error) {
        console.warn('[SkillManager] User skill migration failed:', error)
      }

      // Step 3: Scan user skills from OPFS `.skills/user/` directory.
      // These are runtime-loaded (not persisted to SQLite) — OPFS files
      // are the single source of truth for user skills.
      await this.refreshUserSkills()
      await this.refreshProviderSkills()

      // Update tool registry with skill tools
      const { getToolRegistry } = await import('@/agent/tool-registry')
      const registry = getToolRegistry()
      await registry.registerSkillTools()

      // Sync all skills (builtin + user + project) as slash commands
      this.syncSlashCommands()

      console.log(
        '[SkillManager] _doInitialize: complete, cached',
        this.getSkills().length,
        'skills'
      )
      this._initialized = true
    } catch (error) {
      console.error('[SkillManager] Initialization failed:', error)
      throw error
    }
  }

  /**
   * Scan a project directory for skill files and resources.
   * Imports both skills and their associated resource files.
   */
  async scanProject(
    rootHandle: FileSystemDirectoryHandle,
    projectId?: string | null
  ): Promise<{ added: number; resourcesAdded: number; errors: string[] }> {
    const { skills, resources, errors } = await scanProjectSkills(rootHandle)
    const preExistingIds = new Set(this.cachedProjectSkills.map((skill) => skill.id))
    const normalizedResources = this.normalizeProjectResources(skills, resources, errors)
    this.setProjectSkills(skills, normalizedResources, projectId)

    let added = 0
    for (const skill of skills) {
      if (!preExistingIds.has(skill.id)) {
        added++
      }
    }

    return { added, resourcesAdded: normalizedResources.length, errors }
  }

  /**
   * Get the skills block for system prompt.
   * Uses the on-demand loading approach - only metadata is injected.
   */
  getSkillsBlock(): string {
    const metadata = this.getSkillMetadata()
    return buildAvailableSkillsBlock(metadata)
  }

  /**
   * Get the enhanced system prompt with skills block.
   * This is a synchronous method - ensure initialize() has been called first.
   *
   * @deprecated Use getSkillsBlock directly instead for more control
   */
  getEnhancedSystemPrompt(basePrompt: string): string {
    const skillsBlock = this.getSkillsBlock()
    return basePrompt + skillsBlock
  }

  /**
   * Get all cached skills (for UI display).
   */
  getSkills(): Skill[] {
    const registrations = providerRegistry.registrations()
    const providers = this.cachedProviderSkills.filter(skill => registrations.some(r =>
      r.id === skill.providerLocation?.providerId && r.mountName === skill.providerLocation?.mountName))
    return [...this.cachedPersistentSkills, ...this.cachedUserSkills, ...this.cachedProjectSkills, ...providers]
  }

  /**
   * Get cached skill metadata (for UI list).
   */
  getSkillMetadata(): SkillMetadata[] {
    return this.getSkills().map((s) => ({
      id: s.id,
      name: s.name,
      version: s.version,
      description: s.description,
      author: s.author,
      category: s.category,
      tags: s.tags,
      source: s.source,
      providerLocation: s.providerLocation,
      triggers: s.triggers,
      enabled: s.enabled,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }))
  }

  /**
   * Get a cached skill by ID.
   */
  getSkillById(id: string): Skill | null {
    return this.getSkills().find((skill) => skill.id === id) || null
  }

  /**
   * Case-insensitive skill lookup by name.
   */
  getSkillByName(name: string): Skill | null {
    const normalized = name.toLowerCase().trim()
    const skills = this.getSkills()
    const byId = skills.find(skill => skill.id === name.trim())
    if (byId) return byId
    const matches = skills.filter(skill => skill.name.toLowerCase() === normalized)
    const local = matches.filter(skill => skill.source !== 'provider')
    if (local.length === 1) return local[0]
    return matches.length === 1 ? matches[0] : null
  }

  /**
   * Get enabled skill names from combined cache.
   */
  getEnabledSkillNames(): string[] {
    return this.getSkills()
      .filter((skill) => skill.enabled)
      .map((skill) => skill.source === 'provider' ? skill.id : skill.name)
      .sort((a, b) => a.localeCompare(b))
  }

  /**
   * Get resources for a skill (project resources are runtime-scoped in memory).
   */
  async getSkillResources(skillId: string): Promise<SkillResource[]> {
    if (skillId.startsWith('provider:')) {
      const skill = this.getSkillById(skillId)
      return skill ? listProviderSkillResources(skill) : []
    }
    if (skillId.startsWith('project:')) {
      return this.projectResourcesBySkillId.get(skillId) || []
    }
    if (skillId.startsWith('user:')) {
      return this.userResourcesBySkillId.get(skillId) || []
    }
    return storage.getSkillResources(skillId)
  }

  /**
   * Replace current project skill cache.
   */
  setProjectSkills(skills: Skill[], resources: SkillResource[], projectId?: string | null): void {
    this.activeProjectId = projectId ?? this.activeProjectId
    this.cachedProjectSkills = skills.map((skill) => ({
      ...skill,
      enabled: this.getProjectSkillEnabled(this.activeProjectId, skill.id, skill.enabled),
    }))

    const bySkillId = new Map<string, SkillResource[]>()
    for (const resource of resources) {
      const list = bySkillId.get(resource.skillId)
      if (list) {
        list.push(resource)
      } else {
        bySkillId.set(resource.skillId, [resource])
      }
    }
    this.projectResourcesBySkillId = bySkillId

    // Project skills changed — update slash command registry synchronously
    this.syncSlashCommands()
  }

  /**
   * Clear runtime-scoped project skills for active project switch/reset.
   */
  clearProjectSkills(): void {
    this.cachedProjectSkills = []
    this.projectResourcesBySkillId = new Map<string, SkillResource[]>()
    this.activeProjectId = null
    // Project skills cleared — update slash command registry synchronously
    this.syncSlashCommands()
  }

  /**
   * Update enabled status for a user or provider skill without a SQLite record.
   *
   * User skills do not have a SQLite record. The enabled state is persisted
   * to localStorage (keyed globally, not per-project) so that it survives
   * page refreshes. On load, `refreshUserSkills()` reads this state and
   * applies it to the freshly-scanned skills.
   */
  setUserSkillEnabled(skillId: string, enabled: boolean): void {
    // Persist to localStorage
    const state = this.loadUserSkillState()
    state[skillId] = enabled
    this.saveUserSkillState(state)

    this.cachedProviderSkills = this.cachedProviderSkills.map(skill =>
      skill.id === skillId ? { ...skill, enabled } : skill)
    // Update in-memory cache
    this.cachedUserSkills = this.cachedUserSkills.map((skill) =>
      skill.id === skillId ? { ...skill, enabled } : skill
    )
  }

  /**
   * Persist and update enabled status for a project-scoped skill.
   */
  setProjectSkillEnabled(skillId: string, enabled: boolean, projectId?: string | null): void {
    const targetProjectId = projectId ?? this.activeProjectId
    if (!targetProjectId) {
      // Fallback for cases where active project is unknown (in-memory only).
      this.cachedProjectSkills = this.cachedProjectSkills.map((skill) =>
        skill.id === skillId ? { ...skill, enabled } : skill
      )
      return
    }

    const state = this.loadProjectSkillState(targetProjectId)
    state[skillId] = enabled
    this.saveProjectSkillState(targetProjectId, state)

    this.cachedProjectSkills = this.cachedProjectSkills.map((skill) =>
      skill.id === skillId ? { ...skill, enabled } : skill
    )
  }

  /** Refresh connected provider skills in memory, sharing concurrent discovery requests. */
  async refreshProviderSkills(): Promise<void> {
    if (this.providerRefresh) return this.providerRefresh
    this.providerRefresh = (async () => {
      const skills = await scanProviderSkills()
      const state = this.loadUserSkillState()
      const next = skills.map(skill => ({ ...skill, enabled: state[skill.id] ?? skill.enabled, createdAt: 0, updatedAt: 0 }))
      if (JSON.stringify(next) === JSON.stringify(this.cachedProviderSkills)) return
      this.cachedProviderSkills = next
      this.syncSlashCommands()
    })().finally(() => { this.providerRefresh = null })
    return this.providerRefresh
  }

  /**
   * Scan OPFS `.skills/user/` for user skills and populate runtime cache.
   *
   * User skills are NOT persisted to SQLite — OPFS files are the single source
   * of truth. Call this after user skills are created/edited/deleted via
   * `vfs://skills/user/` file operations.
   */
  async refreshUserSkills(): Promise<void> {
    try {
      const result = await scanUserSkills()
      // Apply persisted enabled state from localStorage so that user-skill
      // toggle choices survive page refreshes.
      const savedState = this.loadUserSkillState()
      this.cachedUserSkills = result.skills.map((skill) => ({
        ...skill,
        enabled: Object.prototype.hasOwnProperty.call(savedState, skill.id)
          ? savedState[skill.id]
          : skill.enabled,
      }))
      const bySkillId = new Map<string, SkillResource[]>()
      for (const resource of result.resources) {
        const list = bySkillId.get(resource.skillId)
        if (list) {
          list.push(resource)
        } else {
          bySkillId.set(resource.skillId, [resource])
        }
      }
      this.userResourcesBySkillId = bySkillId

      if (result.errors.length > 0) {
        console.warn('[SkillManager] User skills scan errors:', result.errors)
      }
      if (result.skills.length > 0) {
        console.log(
          '[SkillManager] Loaded',
          result.skills.length,
          'user skill(s):',
          result.skills.map((s) => s.name)
        )
      }
      // Keep slash commands in sync
      this.syncSlashCommands()
    } catch (error) {
      console.warn('[SkillManager] User skills scan failed:', error)
      this.cachedUserSkills = []
      this.userResourcesBySkillId = new Map()
    }
  }

  /**
   * Refresh the in-memory skill cache from SQLite.
   */
  async refreshCache(): Promise<void> {
    this.cachedPersistentSkills = await storage.getAllSkills()
    // Keep slash commands in sync after persistent skill changes (user added/removed)
    this.syncSlashCommands()
  }

  /**
   * Sync all skills (builtin + user + project) to the slash command registry.
   *
   * Strategy: unregister all skill-sourced commands, then re-register from
   * the combined skill cache. This guarantees the menu always reflects the
   * current set of skills regardless of source (builtin, user-created, or
   * project-scoped).
   *
   * Synchronous so that setProjectSkills/clearProjectSkills callers see the
   * updated registry immediately — no microtask delay, no race with the
   * subsequent loadSkills() call in WorkspaceLayout.
   *
   * Idempotent and safe to call multiple times.
   */
  syncSlashCommands(): void {
    try {
      // Clear all existing skill-sourced commands (source='skill') and their IDs
      clearSkillCommands()

      // Re-register from combined cache (builtin + user + project)
      const skills = this.getSkills()
      const skillNames = skills.map((s) => s.name)
      console.log(
        `[SkillManager] syncSlashCommands: ${skills.length} skills → slash commands`,
        skillNames
      )
      if (skills.length > 0) {
        registerSkillCommands(
          skills.map((skill) => ({
            id: skill.source === 'provider' ? skill.id : skill.name,
            label: skill.name,
            description: skill.description,
            source: 'skill' as const,
          }))
        )
      }
    } catch (error) {
      console.warn('[SkillManager] syncSlashCommands failed:', error)
    }
  }

  private normalizeProjectResources(
    skills: Skill[],
    resources: SkillResource[],
    errors: string[]
  ): SkillResource[] {
    const normalized: SkillResource[] = []

    for (const resource of resources) {
      let skillId = resource.skillId
      if (!skillId || skillId === 'pending') {
        if (skills.length !== 1) {
          errors.push(
            `Unable to resolve owning skill for resource '${resource.resourcePath}' (skillId missing)`
          )
          continue
        }
        skillId = skills[0].id
      }

      normalized.push({
        ...resource,
        skillId,
        id:
          resource.id && !resource.id.startsWith('pending:')
            ? resource.id
            : generateResourceId(skillId, resource.resourcePath),
      })
    }

    return normalized
  }

  private getProjectSkillEnabled(
    projectId: string | null,
    skillId: string,
    fallback: boolean
  ): boolean {
    if (!projectId) return fallback
    const state = this.loadProjectSkillState(projectId)
    return Object.prototype.hasOwnProperty.call(state, skillId) ? state[skillId] : fallback
  }

  private getProjectSkillStateKey(projectId: string): string {
    return `creatorweave:project-skill-enabled:${projectId}`
  }

  private loadProjectSkillState(projectId: string): Record<string, boolean> {
    const storage = this.getLocalStorage()
    if (!storage) return {}

    try {
      const raw = storage.getItem(this.getProjectSkillStateKey(projectId))
      if (!raw) return {}
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') return {}
      const result: Record<string, boolean> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'boolean') {
          result[key] = value
        }
      }
      return result
    } catch {
      return {}
    }
  }

  private saveProjectSkillState(projectId: string, state: Record<string, boolean>): void {
    const storage = this.getLocalStorage()
    if (!storage) return

    try {
      storage.setItem(this.getProjectSkillStateKey(projectId), JSON.stringify(state))
    } catch (error) {
      console.warn('[SkillManager] Failed to persist project skill state:', error)
    }
  }

  // ------------------------------------------------------------------
  // User skill enabled-state persistence (localStorage, global scope)
  // ------------------------------------------------------------------

  private getUserSkillStateKey(): string {
    return 'creatorweave:user-skill-enabled'
  }

  private loadUserSkillState(): Record<string, boolean> {
    const storage = this.getLocalStorage()
    if (!storage) return {}

    try {
      const raw = storage.getItem(this.getUserSkillStateKey())
      if (!raw) return {}
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object') return {}
      const result: Record<string, boolean> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'boolean') {
          result[key] = value
        }
      }
      return result
    } catch {
      return {}
    }
  }

  private saveUserSkillState(state: Record<string, boolean>): void {
    const storage = this.getLocalStorage()
    if (!storage) return

    try {
      storage.setItem(this.getUserSkillStateKey(), JSON.stringify(state))
    } catch (error) {
      console.warn('[SkillManager] Failed to persist user skill state:', error)
    }
  }

  private getLocalStorage(): Storage | null {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return null
      return window.localStorage
    } catch {
      return null
    }
  }
}

/** Singleton instance */
let instance: SkillManager | null = null

export function getSkillManager(): SkillManager {
  if (!instance) {
    instance = new SkillManager()
  }
  return instance
}
