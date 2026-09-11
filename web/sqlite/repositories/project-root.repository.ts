/**
 * Project Root Repository
 *
 * SQLite storage for multi-root workspace configuration.
 * Each project can have N local folder handles (roots).
 * Exactly one root per project is marked as `is_default`.
 */

import { generateId, getSQLiteDB } from '../sqlite-database'
import type { DiskBackend } from '@/opfs/native-disk/executor'

export interface ProjectRoot {
  id: string
  projectId: string
  name: string
  isDefault: boolean
  readOnly: boolean
  backend: DiskBackend
  scopeId: string | null
  sortOrder: number
  createdAt: number
}

interface ProjectRootRow {
  id: string
  project_id: string
  name: string
  is_default: number
  read_only: number
  backend: DiskBackend
  scope_id: string | null
  sort_order: number
  created_at: number
}

export class ProjectRootRepository {
  /**
   * Find all roots for a project, ordered by sort_order.
   */
  async findByProject(projectId: string): Promise<ProjectRoot[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<ProjectRootRow>(
      'SELECT * FROM project_roots WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC',
      [projectId]
    )
    return rows.map((row) => this.rowToRoot(row))
  }

  /**
   * Find a single root by ID.
   */
  async findById(id: string): Promise<ProjectRoot | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<ProjectRootRow>(
      'SELECT * FROM project_roots WHERE id = ?',
      [id]
    )
    return row ? this.rowToRoot(row) : null
  }

  /**
   * Find the default root for a project.
   */
  async findDefaultRoot(projectId: string): Promise<ProjectRoot | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<ProjectRootRow>(
      'SELECT * FROM project_roots WHERE project_id = ? AND is_default = 1 LIMIT 1',
      [projectId]
    )
    return row ? this.rowToRoot(row) : null
  }

  /**
   * Find a root by project ID and root name.
   */
  async findByProjectAndName(projectId: string, name: string): Promise<ProjectRoot | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<ProjectRootRow>(
      'SELECT * FROM project_roots WHERE project_id = ? AND name = ?',
      [projectId, name]
    )
    return row ? this.rowToRoot(row) : null
  }

  /**
   * Create a new root for a project.
   * If this is the first root, it automatically becomes the default.
   */
  async createRoot(input: {
    projectId: string
    name: string
    isDefault?: boolean
    readOnly?: boolean
    backend?: DiskBackend
    scopeId?: string | null
    sortOrder?: number
  }): Promise<ProjectRoot> {
    const db = getSQLiteDB()
    const existing = await this.findByProject(input.projectId)

    // First root is always default
    const isDefault = input.isDefault ?? (existing.length === 0)
    const sortOrder = input.sortOrder ?? existing.length

    const root: ProjectRoot = {
      id: generateId('root'),
      projectId: input.projectId,
      name: input.name,
      isDefault,
      readOnly: input.readOnly ?? false,
      backend: input.backend ?? 'fsaccess',
      scopeId: input.scopeId ?? null,
      sortOrder,
      createdAt: Date.now(),
    }

    await db.execute(
      `INSERT INTO project_roots (id, project_id, name, is_default, read_only, backend, scope_id, sort_order, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        root.id,
        root.projectId,
        root.name,
        root.isDefault ? 1 : 0,
        root.readOnly ? 1 : 0,
        root.backend,
        root.scopeId,
        root.sortOrder,
        root.createdAt,
      ]
    )

    return root
  }

  /**
   * Update an existing root.
   */
  async updateRoot(root: ProjectRoot): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `UPDATE project_roots
       SET name = ?, is_default = ?, read_only = ?, backend = ?, scope_id = ?, sort_order = ?
       WHERE id = ?`,
      [root.name, root.isDefault ? 1 : 0, root.readOnly ? 1 : 0, root.backend, root.scopeId, root.sortOrder, root.id]
    )
  }

  /**
   * Set the default root for a project (unsets previous default).
   */
  async setDefaultRoot(projectId: string, rootId: string): Promise<void> {
    const db = getSQLiteDB()
    await db.transaction(async (tx) => {
      await tx.execute(
        'UPDATE project_roots SET is_default = 0 WHERE project_id = ?',
        [projectId]
      )
      await tx.execute(
        'UPDATE project_roots SET is_default = 1 WHERE id = ? AND project_id = ?',
        [rootId, projectId]
      )
    })
  }

  /**
   * Find ALL bindings (across every project) that reference a native-host
   * scope_id.
   *
   * The host-side scope store (~/.creatorweave/native-host-scopes.json) is
   * global: adding the same local folder from multiple projects dedupes to a
   * single scope_id (see Rust scope.rs add_scope). Revoking that scope from
   * one project would break every other project still using it, so callers
   * (folder-access.store removeRoot) use this to implement reference-counted
   * revocation — only revoke when the last binding is removed.
   */
  async findByScopeId(scopeId: string): Promise<ProjectRoot[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<ProjectRootRow>(
      'SELECT * FROM project_roots WHERE backend = ? AND scope_id = ?',
      ['native-host', scopeId]
    )
    return rows.map((row) => this.rowToRoot(row))
  }

  /**
   * Delete a root by ID.
   */
  async deleteRoot(id: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM project_roots WHERE id = ?', [id])
  }

  /**
   * Delete all roots for a project.
   */
  async deleteByProject(projectId: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM project_roots WHERE project_id = ?', [projectId])
  }

  /**
   * Count roots for a project.
   */
  async countByProject(projectId: string): Promise<number> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM project_roots WHERE project_id = ?',
      [projectId]
    )
    return row?.cnt ?? 0
  }

  private rowToRoot(row: ProjectRootRow): ProjectRoot {
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      isDefault: row.is_default === 1,
      readOnly: row.read_only === 1,
      backend: row.backend ?? 'fsaccess',
      scopeId: row.scope_id ?? null,
      sortOrder: row.sort_order,
      createdAt: row.created_at,
    }
  }
}

let projectRootRepositoryInstance: ProjectRootRepository | null = null

export function getProjectRootRepository(): ProjectRootRepository {
  if (!projectRootRepositoryInstance) {
    projectRootRepositoryInstance = new ProjectRootRepository()
  }
  return projectRootRepositoryInstance
}
