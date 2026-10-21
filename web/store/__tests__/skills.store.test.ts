/* eslint-disable */
// @ts-nocheck - Mock objects don't match exact types but work correctly at runtime
/**
 * useSkillsStore Unit Tests
 *
 * Tests for the skills store state management
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSkillsStore } from '../skills.store'
import type { Skill, SkillMetadata } from '@/skills/skill-types'
import type { SkillCategory } from '@/skills/skill-types'

// Mock the skill-storage module
vi.mock('@/skills/skill-storage', () => ({
  getAllSkillMetadata: vi.fn(() => Promise.resolve([])),
  saveSkill: vi.fn(() => Promise.resolve()),
  getSkillById: vi.fn(() => Promise.resolve(null)),
  deleteSkill: vi.fn(() => Promise.resolve()),
  toggleSkill: vi.fn(() => Promise.resolve()),
  getEnabledSkills: vi.fn(() => Promise.resolve([])),
  getSkillsByCategory: vi.fn(() => Promise.resolve([])),
}))

// Mock the user-skills-scanner module. The store's user-skill paths
// (importSkillMd / deleteSkill / createSkillSkeleton) write to OPFS via
// this module; tests must not touch real OPFS.
const { mockUserSkillsScanner } = vi.hoisted(() => ({
  mockUserSkillsScanner: {
    writeUserSkillMd: vi.fn(() => Promise.resolve()),
    deleteUserSkillDir: vi.fn(() => Promise.resolve()),
    userSkillDirExists: vi.fn(() => Promise.resolve(false)),
  },
}))

vi.mock('@/skills/user-skills-scanner', () => ({
  ...mockUserSkillsScanner,
}))

// Mock the skill-parser module
vi.mock('@/skills/skill-parser', () => ({
  parseSkillMd: vi.fn(() => ({
    skill: null,
    error: 'Invalid skill format',
  })),
  serializeSkillMd: vi.fn(() => '# Test Skill\n'),
  slugify: vi.fn((value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')),
}))

// Mock the skill-manager module. The hoisted object is shared so each test
// can override individual method return values (e.g. getSkillMetadata) via
// mockManager.getSkillMetadata.mockReturnValue(...).
const { mockManager } = vi.hoisted(() => ({
  mockManager: {
    initialize: vi.fn(() => Promise.resolve()),
    refreshCache: vi.fn(() => Promise.resolve()),
    refreshUserSkills: vi.fn(() => Promise.resolve()),
    refreshProviderSkills: vi.fn(() => Promise.resolve()),
    getSkillMetadata: vi.fn<[], SkillMetadata[]>(() => []),
    getSkillById: vi.fn(() => null),
    getSkills: vi.fn<[], Skill[]>(() => []),
    setProjectSkillEnabled: vi.fn(),
    setUserSkillEnabled: vi.fn(),
  },
}))

vi.mock('@/skills/skill-manager', () => ({
  getSkillManager: vi.fn(() => mockManager),
}))

import * as storage from '@/skills/skill-storage'
import * as parser from '@/skills/skill-parser'

// Helper function to create mock metadata
function createMockMetadata(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    id: 'test-skill',
    name: 'Test Skill',
    version: '1.0.0',
    description: 'Test description',
    author: 'test',
    category: 'general' as SkillCategory,
    tags: [],
    source: 'user',
    triggers: { keywords: [] },
    enabled: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('useSkillsStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useSkillsStore.setState({
      skills: [],
      loaded: false,
      loading: false,
    })
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('should have correct default values', () => {
      const state = useSkillsStore.getState()

      expect(state.skills).toEqual([])
      expect(state.loaded).toBe(false)
      expect(state.loading).toBe(false)
    })
  })

  describe('loadSkills', () => {
    it('should load skills from storage', async () => {
      const mockMetadata: SkillMetadata[] = [
        createMockMetadata({ id: 'skill-1', name: 'Test Skill 1' }),
        createMockMetadata({ id: 'skill-2', name: 'Test Skill 2' }),
      ]

      mockManager.getSkillMetadata.mockReturnValue(mockMetadata)

      const { loadSkills } = useSkillsStore.getState()
      await loadSkills()

      const state = useSkillsStore.getState()
      expect(state.skills).toEqual(mockMetadata)
      expect(state.loaded).toBe(true)
    })

    it('should set loading state during load', async () => {
      // loadSkills() runs `set({ loading: true })` synchronously before the
      // first await, so the flag is observable as soon as the call returns
      // its promise — no mock interception needed.
      const { loadSkills } = useSkillsStore.getState()
      const loadPromise = loadSkills()

      expect(useSkillsStore.getState().loading).toBe(true)

      await loadPromise
      expect(useSkillsStore.getState().loading).toBe(false)
    })

    it('should not load if already loading', async () => {
      useSkillsStore.setState({ loading: true })

      const { loadSkills } = useSkillsStore.getState()
      await loadSkills()

      // Should not call manager.initialize() if already loading
      expect(mockManager.initialize).not.toHaveBeenCalled()
    })

    it('should handle load errors gracefully', async () => {
      mockManager.initialize.mockRejectedValueOnce(new Error('Storage error'))

      const { loadSkills } = useSkillsStore.getState()
      await loadSkills()

      expect(useSkillsStore.getState().loading).toBe(false)
      expect(useSkillsStore.getState().error).toBe('Storage error')
    })
  })

  describe('addSkill', () => {
    it('should add a new skill', async () => {
      const mockSkill: Skill = {
        id: 'new-skill',
        name: 'New Skill',
        description: 'New description',
        category: 'general' as SkillCategory,
        triggers: { keywords: [] },
        instructions: 'Test instructions',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        // Add missing required properties
        version: '1.0.0',
        author: 'test',
        tags: [],
        source: 'user',
        examples: [],
      }

      const updatedMetadata: SkillMetadata[] = [
        createMockMetadata({ id: 'new-skill', name: 'New Skill' }),
      ]

      mockManager.getSkillMetadata.mockReturnValue(updatedMetadata)

      const { addSkill } = useSkillsStore.getState()
      await addSkill(mockSkill)

      expect(storage.saveSkill).toHaveBeenCalledWith(mockSkill, '# Test Skill\n')
      expect(useSkillsStore.getState().skills).toEqual(updatedMetadata)
    })
  })

  describe('importSkillMd', () => {
    it('should import valid skill markdown', async () => {
      const markdown = '# Test Skill\n\nTest content'
      const mockSkill: Skill = {
        id: 'test-skill',
        name: 'Test Skill',
        description: 'Test',
        category: 'general' as SkillCategory,
        triggers: { keywords: [] },
        instructions: 'Test content',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: '1.0.0',
        author: 'test',
        tags: [],
        source: 'user',
        examples: [],
      }

      vi.mocked(parser.parseSkillMd).mockReturnValue({
        skill: mockSkill,
        error: null,
      })

      vi.mocked(storage.getSkillById).mockResolvedValue(null)

      const updatedMetadata: SkillMetadata[] = [
        createMockMetadata({ id: 'test-skill', name: 'Test Skill' }),
      ]

      mockManager.getSkillMetadata.mockReturnValue(updatedMetadata)

      const { importSkillMd } = useSkillsStore.getState()
      const result = await importSkillMd(markdown)

      expect(result.success).toBe(true)
      // User skills are written to OPFS via the user-skills-scanner, not
      // through the SQLite-era storage.saveSkill.
      expect(mockUserSkillsScanner.writeUserSkillMd).toHaveBeenCalledWith(
        'test-skill',
        markdown
      )
      expect(storage.saveSkill).not.toHaveBeenCalled()
      // Imported skills must be tagged 'user' so they appear under the user
      // skills group in SkillsManager (project / user / builtin). Using
      // 'import' here would make the skill invisible after import.
      expect(parser.parseSkillMd).toHaveBeenCalledWith(markdown, 'user')
    })

    it('should return error for invalid markdown', async () => {
      const invalidMarkdown = 'Not valid skill markdown'

      vi.mocked(parser.parseSkillMd).mockReturnValue({
        skill: null,
        error: 'Invalid skill format',
      })

      const { importSkillMd } = useSkillsStore.getState()
      const result = await importSkillMd(invalidMarkdown)

      expect(result.success).toBe(false)
      expect(result.error).toBe('Invalid skill format')
    })
  })

  describe('deleteSkill', () => {
    it('should remove skill from store', async () => {
      const initialSkills: SkillMetadata[] = [
        createMockMetadata({ id: 'skill-1' }),
        createMockMetadata({ id: 'skill-2' }),
      ]

      useSkillsStore.setState({ skills: initialSkills })

      const { deleteSkill } = useSkillsStore.getState()
      await deleteSkill('skill-1')

      expect(storage.deleteSkill).toHaveBeenCalledWith('skill-1')
      expect(useSkillsStore.getState().skills).toHaveLength(1)
      expect(useSkillsStore.getState().skills[0].id).toBe('skill-2')
    })
  })

  describe('toggleSkill', () => {
    it('should toggle skill enabled state', async () => {
      const initialSkills: SkillMetadata[] = [
        createMockMetadata({ id: 'skill-1', enabled: true }),
      ]

      useSkillsStore.setState({ skills: initialSkills })

      const { toggleSkill } = useSkillsStore.getState()
      await toggleSkill('skill-1', false)

      // The mock skill uses the default `source: 'user'`, and user skills
      // live in OPFS: the store routes through SkillManager and updates the
      // in-memory cache directly instead of calling the SQLite-era
      // storage.toggleSkill.
      expect(mockManager.setUserSkillEnabled).toHaveBeenCalledWith('skill-1', false)
      expect(useSkillsStore.getState().skills[0].enabled).toBe(false)
    })

    it('should route persistent (non-user) skills through storage.toggleSkill', async () => {
      const initialSkills: SkillMetadata[] = [
        createMockMetadata({ id: 'skill-1', enabled: true, source: 'builtin' }),
      ]

      useSkillsStore.setState({ skills: initialSkills })

      const { toggleSkill } = useSkillsStore.getState()
      await toggleSkill('skill-1', false)

      expect(storage.toggleSkill).toHaveBeenCalledWith('skill-1', false)
      expect(useSkillsStore.getState().skills[0].enabled).toBe(false)
    })
  })

  describe('getFullSkill', () => {
    it('should return full skill by id', async () => {
      const mockSkill: Skill = {
        id: 'skill-1',
        name: 'Skill 1',
        description: 'Description 1',
        category: 'general' as SkillCategory,
        triggers: { keywords: [] },
        instructions: 'Test instructions',
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        version: '1.0.0',
        author: 'test',
        tags: [],
        source: 'user',
        examples: [],
      }

      vi.mocked(storage.getSkillById).mockResolvedValue(mockSkill)

      const { getFullSkill } = useSkillsStore.getState()
      const result = await getFullSkill('skill-1')

      expect(result).toEqual(mockSkill)
    })

    it('should return null for non-existent skill', async () => {
      vi.mocked(storage.getSkillById).mockResolvedValue(null)

      const { getFullSkill } = useSkillsStore.getState()
      const result = await getFullSkill('non-existent')

      expect(result).toBeNull()
    })
  })
})
