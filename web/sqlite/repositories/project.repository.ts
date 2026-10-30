/**
 * Project Repository
 *
 * SQLite storage for project metadata and active project selection.
 */

import { generateId, getSQLiteDB } from '../sqlite-database'
import { getProjectSecretStoragePrefix } from '@/security/secret-key-scope'

export const DEFAULT_PROJECT_ID = 'default-project'

export interface Project {
  id: string
  name: string
  rootDirectoryHint?: string
  status: 'active' | 'archived'
  createdAt: number
  updatedAt: number
}

export interface ProjectStats {
  projectId: string
  workspaceCount: number
  lastWorkspaceAccessAt?: number
}

interface ProjectRow {
  id: string
  name: string
  root_directory_hint: string | null
  status: 'active' | 'archived'
  created_at: number
  updated_at: number
}

interface ProjectStatsRow {
  project_id: string
  workspace_count: number
  last_workspace_access_at: number | null
}

export class ProjectRepository {
  async ensureDefaultProject(): Promise<void> {
    // Development phase: do not auto-create a default project.
    // Keep method for API compatibility with existing call sites.
    return
  }

  async findAllProjects(): Promise<Project[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<ProjectRow>("SELECT * FROM projects ORDER BY updated_at DESC")
    return rows.map((row) => this.rowToProject(row))
  }

  async findProjectStats(): Promise<ProjectStats[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<ProjectStatsRow>(
      `SELECT
         p.id AS project_id,
         COUNT(w.id) AS workspace_count,
         MAX(w.last_accessed_at) AS last_workspace_access_at
       FROM projects p
       LEFT JOIN workspaces w ON w.project_id = p.id
       GROUP BY p.id`
    )

    return rows.map((row) => ({
      projectId: row.project_id,
      workspaceCount: Number(row.workspace_count || 0),
      lastWorkspaceAccessAt: row.last_workspace_access_at || undefined,
    }))
  }

  async findById(id: string): Promise<Project | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<ProjectRow>('SELECT * FROM projects WHERE id = ?', [id])
    return row ? this.rowToProject(row) : null
  }

  async createProject(input: {
    id?: string
    name: string
    rootDirectoryHint?: string
    status?: 'active' | 'archived'
  }): Promise<Project> {
    const db = getSQLiteDB()
    const now = Date.now()
    const project: Project = {
      id: input.id || generateId('proj'),
      name: input.name,
      rootDirectoryHint: input.rootDirectoryHint,
      status: input.status || 'active',
      createdAt: now,
      updatedAt: now,
    }

    await db.execute(
      `INSERT INTO projects (id, name, root_directory_hint, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        project.id,
        project.name,
        project.rootDirectoryHint || null,
        project.status,
        project.createdAt,
        project.updatedAt,
      ]
    )

    return project
  }

  async updateProject(project: Project): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `UPDATE projects
       SET name = ?, root_directory_hint = ?, status = ?, updated_at = ?
       WHERE id = ?`,
      [project.name, project.rootDirectoryHint || null, project.status, Date.now(), project.id]
    )
  }

  /**
   * Atomically rebind host workspace rows off a project and delete the
   * project row (plus its scoped secrets) in ONE SQLite transaction.
   *
   * Rebinding in a loop of standalone `updateWorkspace` calls left a crash
   * window: a tab/process termination after one or more rebinds committed but
   * before the project row was deleted stranded those workspaces on the
   * successor while the project survived — and the retry loop's
   * findAllWorkspacesByProjectIncludingDirect query no longer matched the
   * already-rebound rows, so the partial reassignment persisted. Inside a
   * transaction the rebinds and the row deletion commit (or roll back)
   * together: any interruption leaves the previous consistent state.
   */
  async deleteProjectIncludingHostRebind(
    projectId: string,
    nextProjectId: string,
    hostWorkspaceIds: string[]
  ): Promise<void> {
    const db = getSQLiteDB()
    const secretPrefix = getProjectSecretStoragePrefix(projectId)
    await db.transaction(async (tx) => {
      for (const workspaceId of hostWorkspaceIds) {
        // eslint-disable-next-line no-await-in-loop -- one transaction; ordering is irrelevant to correctness here
        await tx.execute('UPDATE workspaces SET project_id = ? WHERE id = ?', [
          nextProjectId,
          workspaceId,
        ])
      }
      // Secrets are encrypted API-key records scoped with this exact prefix.
      // substr avoids SQL LIKE wildcard handling for encoded project IDs.
      await tx.execute('DELETE FROM api_keys WHERE substr(provider, 1, ?) = ?', [
        secretPrefix.length,
        secretPrefix,
      ])
      await tx.execute('DELETE FROM projects WHERE id = ?', [projectId])
    })
  }

  async deleteProject(id: string): Promise<void> {
    const db = getSQLiteDB()
    const secretPrefix = getProjectSecretStoragePrefix(id)
    await db.transaction(async (tx) => {
      // Secrets are encrypted API-key records scoped with this exact prefix.
      // substr avoids SQL LIKE wildcard handling for encoded project IDs.
      await tx.execute(
        'DELETE FROM api_keys WHERE substr(provider, 1, ?) = ?',
        [secretPrefix.length, secretPrefix]
      )
      await tx.execute('DELETE FROM projects WHERE id = ?', [id])
    })
  }

  /**
   * Atomically reassign every workspace of `projectId` to `nextProjectId`
   * (empty string = "no project") and delete the project row, including its
   * scoped API-key secrets — all inside ONE SQLite transaction.
   *
   * Performing the rebind as a single UPDATE inside the same transaction as
   * the row deletion closes the partial-reassignment hole of the previous
   * per-workspace `updateWorkspace` loop: if the tab or process dies between
   * individual rebinds and the deletion, the old sequence left the project
   * row alive with some workspaces already moved to the successor, and a
   * retry (which only sees rows still pointing at the original project)
   * could not undo the partial reassignment. Here a crash at any point rolls
   * the rebind AND the deletion back together, so the operation is fully
   * retryable.
   */
  async rebindWorkspacesAndDeleteProject(projectId: string, nextProjectId: string): Promise<void> {
    const db = getSQLiteDB()
    const secretPrefix = getProjectSecretStoragePrefix(projectId)
    await db.transaction(async (tx) => {
      // Single-statement rebind — no per-row round-trips, and the set of
      // affected rows is exactly the rows matching the project at commit time
      // (rows the per-row loop had already missed could survive a retry).
      await tx.execute('UPDATE workspaces SET project_id = ? WHERE project_id = ?', [
        nextProjectId,
        projectId,
      ])
      // Secrets are encrypted API-key records scoped with this exact prefix.
      // substr avoids SQL LIKE wildcard handling for encoded project IDs.
      await tx.execute(
        'DELETE FROM api_keys WHERE substr(provider, 1, ?) = ?',
        [secretPrefix.length, secretPrefix]
      )
      await tx.execute('DELETE FROM projects WHERE id = ?', [projectId])
    })
  }

  // NOTE: The active_project singleton table was removed (PR-B: URL-driven active
  // project). The following methods are kept as no-ops / store-backed fallbacks
  // for backward-compatibility with callers that haven't been migrated yet.
  // Active project is now derived from the URL route, never persisted.

  /**
   * @deprecated Active project is now URL-driven. Returns the project matching
   * the current in-memory store's activeProjectId, or null. Does NOT read any
   * persisted singleton.
   */
  async findActiveProject(): Promise<Project | null> {
    try {
      const { useProjectStore } = await import('@/store/project.store')
      const activeId = useProjectStore.getState().activeProjectId
      if (!activeId) return null
      const db = getSQLiteDB()
      const row = await db.queryFirst<ProjectRow>('SELECT * FROM projects WHERE id = ?', [activeId])
      return row ? this.rowToProject(row) : null
    } catch {
      return null
    }
  }

  /**
   * @deprecated No-op. Active project is URL-driven and not persisted.
   * Retained only to avoid breaking callers; the DB write is gone.
   */
  async setActiveProject(projectId: string): Promise<void> {
    if (!projectId) return
    // Keep "recent work" sorting signal: bump updated_at on switch.
    try {
      const db = getSQLiteDB()
      await db.execute('UPDATE projects SET updated_at = ? WHERE id = ?', [Date.now(), projectId])
    } catch {
      // ignore — best-effort
    }
  }

  /**
   * @deprecated No-op. Active project is URL-driven and not persisted.
   */
  async clearActiveProject(): Promise<void> {
    // no-op — nothing to clear
  }

  private rowToProject(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      rootDirectoryHint: row.root_directory_hint || undefined,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }
}

let projectRepositoryInstance: ProjectRepository | null = null

export function getProjectRepository(): ProjectRepository {
  if (!projectRepositoryInstance) {
    projectRepositoryInstance = new ProjectRepository()
  }
  return projectRepositoryInstance
}
