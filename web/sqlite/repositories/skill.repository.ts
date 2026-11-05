/**
 * Skill Repository
 *
 * SQLite-based storage for skills
 */

import { getSQLiteDB } from '../sqlite-database'
import type {
  StoredSkill,
  SkillMetadata,
  SkillSource,
  SkillCategory,
  SkillResource,
} from '../../skills/skill-types'
import { parseJSON, toJSON, boolToInt, intToBool } from '../sqlite-database'
import { parseDescriptionI18nFromSkillMd } from '../../skills/skill-parser'

// Database row type (snake_case for SQLite)
interface SkillRow {
  id: string
  name: string
  version: string
  description: string | null
  author: string | null
  category: string
  tags: string // JSON array
  source: string // SkillSource as string
  triggers: string // JSON array of SkillTrigger
  instruction: string | null
  examples: string | null // JSON array
  templates: string | null // JSON array
  raw_content: string | null
  enabled: number // BOOLEAN (0 or 1)
  created_at: number
  updated_at: number
}

// Resource row type
interface ResourceRow {
  id: string
  skill_id: string
  resource_path: string
  resource_type: string
  content: string
  content_type: string | null
  size: number
  created_at: number
}

//=============================================================================
// Skill Repository
//=============================================================================

export type { SkillMetadata } from '../../skills/skill-types'
export type { StoredSkill } from '../../skills/skill-types'

export class SkillRepository {
  /**
   * Get all skills
   */
  async findAll(): Promise<StoredSkill[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<SkillRow>('SELECT * FROM skills ORDER BY category, name')
    return rows.map((row) => this.rowToSkill(row))
  }

  /**
   * Find skill by ID
   */
  async findById(id: string): Promise<StoredSkill | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<SkillRow>('SELECT * FROM skills WHERE id = ?', [id])
    return row ? this.rowToSkill(row) : null
  }

  /**
   * Find skill by name (case-insensitive)
   */
  async findByName(name: string): Promise<StoredSkill | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<SkillRow>('SELECT * FROM skills WHERE LOWER(name) = LOWER(?)', [
      name,
    ])
    return row ? this.rowToSkill(row) : null
  }

  /**
   * Get all enabled skill names (for tool enum generation)
   */
  async getEnabledSkillNames(): Promise<string[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<{ name: string }>(
      'SELECT name FROM skills WHERE enabled = 1 ORDER BY name'
    )
    return rows.map((r) => r.name)
  }

  /**
   * Get all skill metadata (lightweight)
   */
  async findAllMetadata(): Promise<SkillMetadata[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<SkillRow>(
      'SELECT id, name, version, description, author, category, tags, source, triggers, enabled, created_at, updated_at FROM skills ORDER BY category, name'
    )
    return rows.map((row) => this.rowToMetadata(row))
  }

  /**
   * Find skills by category
   */
  async findByCategory(category: string): Promise<StoredSkill[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<SkillRow>(
      'SELECT * FROM skills WHERE category = ? ORDER BY name',
      [category]
    )
    return rows.map((row) => this.rowToSkill(row))
  }

  /**
   * Find enabled skills only
   */
  async findEnabled(): Promise<StoredSkill[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<SkillRow>(
      'SELECT * FROM skills WHERE enabled = 1 ORDER BY category, name'
    )
    return rows.map((row) => this.rowToSkill(row))
  }

  /**
   * Find by source
   */
  async findBySource(source: SkillSource): Promise<StoredSkill[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<SkillRow>(
      'SELECT * FROM skills WHERE source = ? ORDER BY name',
      [source]
    )
    return rows.map((row) => this.rowToSkill(row))
  }

  /**
   * Search skills by keyword in name, description, or tags
   */
  async search(keyword: string): Promise<StoredSkill[]> {
    const db = getSQLiteDB()
    const pattern = `%${keyword}%`
    const rows = await db.queryAll<SkillRow>(
      `SELECT * FROM skills
       WHERE name LIKE ? OR description LIKE ? OR tags LIKE ?
       ORDER BY category, name`,
      [pattern, pattern, pattern]
    )
    return rows.map((row) => this.rowToSkill(row))
  }

  /**
   * Insert or update a skill
   */
  async save(skill: StoredSkill): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `INSERT INTO skills (id, name, version, description, author, category, tags, source, triggers,
                          instruction, examples, templates, raw_content, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         version = excluded.version,
         description = excluded.description,
         author = excluded.author,
         category = excluded.category,
         tags = excluded.tags,
         source = excluded.source,
         triggers = excluded.triggers,
         instruction = excluded.instruction,
         examples = excluded.examples,
         templates = excluded.templates,
         raw_content = excluded.raw_content,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      [
        skill.id,
        skill.name,
        skill.version,
        skill.description,
        skill.author,
        skill.category,
        toJSON(skill.tags),
        skill.source,
        toJSON(skill.triggers),
        skill.instruction || null,
        skill.examples || null,
        skill.templates || null,
        skill.rawContent || null,
        boolToInt(skill.enabled),
        skill.createdAt,
        skill.updatedAt,
      ]
    )
  }

  /**
   * Toggle skill enabled status
   */
  async toggleEnabled(id: string, enabled: boolean): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('UPDATE skills SET enabled = ?, updated_at = ? WHERE id = ?', [
      boolToInt(enabled),
      Date.now(),
      id,
    ])
  }

  /**
   * Delete a skill by ID
   */
  async delete(id: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM skills WHERE id = ?', [id])
  }

  /**
   * Delete all skills
   */
  async deleteAll(): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM skills')
  }

  /**
   * Get all categories
   */
  async getCategories(): Promise<string[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<{ category: string }>(
      'SELECT DISTINCT category FROM skills ORDER BY category'
    )
    return rows.map((r) => r.category)
  }

  /**
   * Convert database row to domain object
   */
  private rowToSkill(row: SkillRow): StoredSkill {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description || '',
      // Display-only translations live in the SKILL.md frontmatter, which the
      // row keeps verbatim as raw_content — re-read them so a reload keeps the
      // localized dropdown text (#206 review).
      description_i18n: parseDescriptionI18nFromSkillMd(row.raw_content || ''),
      author: row.author || '',
      category: row.category as SkillCategory,
      tags: parseJSON<string[]>(row.tags, []),
      source: row.source as SkillSource,
      triggers: parseJSON(row.triggers, { keywords: [] }),
      instruction: row.instruction || '',
      examples: row.examples || undefined,
      templates: row.templates || undefined,
      rawContent: row.raw_content || '',
      enabled: intToBool(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  /**
   * Convert database row to metadata
   */
  private rowToMetadata(row: SkillRow): SkillMetadata {
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      description: row.description || '',
      description_i18n: parseDescriptionI18nFromSkillMd(row.raw_content || ''),
      author: row.author || '',
      category: row.category as SkillCategory,
      tags: parseJSON<string[]>(row.tags, []),
      source: row.source as SkillSource,
      triggers: parseJSON(row.triggers, { keywords: [] }),
      enabled: intToBool(row.enabled),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  //=============================================================================
  // Resource Methods (for on-demand loading)
  //=============================================================================

  /**
   * Get all resources for a skill
   */
  async getResources(skillId: string): Promise<SkillResource[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<ResourceRow>(
      'SELECT * FROM skill_resources WHERE skill_id = ? ORDER BY resource_type, resource_path',
      [skillId]
    )
    return rows.map((row) => this.rowToResource(row))
  }

  /**
   * Get a specific resource by skill ID and resource path
   */
  async getResource(skillId: string, resourcePath: string): Promise<SkillResource | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<ResourceRow>(
      'SELECT * FROM skill_resources WHERE skill_id = ? AND resource_path = ?',
      [skillId, resourcePath]
    )
    return row ? this.rowToResource(row) : null
  }

  /**
   * Get a resource by its composite ID
   */
  async getResourceById(resourceId: string): Promise<SkillResource | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<ResourceRow>('SELECT * FROM skill_resources WHERE id = ?', [
      resourceId,
    ])
    return row ? this.rowToResource(row) : null
  }

  /**
   * Save a resource (insert or update)
   */
  async saveResource(resource: SkillResource): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `INSERT INTO skill_resources (id, skill_id, resource_path, resource_type, content, content_type, size, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         content = excluded.content,
         content_type = excluded.content_type,
         size = excluded.size`,
      [
        resource.id,
        resource.skillId,
        resource.resourcePath,
        resource.resourceType,
        resource.content,
        resource.contentType,
        resource.size,
        resource.createdAt,
      ]
    )
  }

  /**
   * Delete a resource
   */
  async deleteResource(resourceId: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM skill_resources WHERE id = ?', [resourceId])
  }

  /**
   * Delete all resources for a skill
   */
  async deleteResourcesForSkill(skillId: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM skill_resources WHERE skill_id = ?', [skillId])
  }

  /**
   * Get resource count for a skill
   */
  async getResourceCount(skillId: string): Promise<number> {
    const db = getSQLiteDB()
    const result = await db.queryFirst<{ count: number }>(
      'SELECT COUNT(*) as count FROM skill_resources WHERE skill_id = ?',
      [skillId]
    )
    return result?.count || 0
  }

  /**
   * Get total resource size for a skill
   */
  async getTotalResourceSize(skillId: string): Promise<number> {
    const db = getSQLiteDB()
    const result = await db.queryFirst<{ total: number }>(
      'SELECT SUM(size) as total FROM skill_resources WHERE skill_id = ?',
      [skillId]
    )
    return result?.total || 0
  }

  /**
   * Convert database row to SkillResource
   */
  private rowToResource(row: ResourceRow): SkillResource {
    return {
      id: row.id,
      skillId: row.skill_id,
      resourcePath: row.resource_path,
      resourceType: row.resource_type as SkillResource['resourceType'],
      content: row.content,
      contentType: row.content_type || 'text/plain',
      size: row.size,
      createdAt: row.created_at,
    }
  }
}

//=============================================================================
// Singleton Instance
//=============================================================================

let skillRepoInstance: SkillRepository | null = null

export function getSkillRepository(): SkillRepository {
  if (!skillRepoInstance) {
    skillRepoInstance = new SkillRepository()
  }
  return skillRepoInstance
}
