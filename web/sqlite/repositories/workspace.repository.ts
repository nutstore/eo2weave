/**
 * Workspace Repository
 *
 * SQLite-based storage for OPFS workspace metadata
 * (Actual file content still stored in OPFS directories)
 */

import {
  getSQLiteDB,
  type WorkspaceRow,
  type FileMetadataRow,
  type PendingChangeRow,
} from '../sqlite-database'

export interface Workspace {
  id: string
  projectId?: string
  rootDirectory: string
  name: string
  status: 'active' | 'archived'
  cacheSize: number
  /** Computed from fs_ops table, not stored in workspaces table */
  pendingCount: number
  modifiedFiles: number
  createdAt: number
  lastAccessedAt: number
}

export interface FileMetadata {
  id: string
  workspaceId: string
  path: string
  mtime: number
  size: number
  contentType: 'text' | 'binary'
  hash?: string
  createdAt: number
  updatedAt: number
}

export interface PendingChange {
  id: string
  workspaceId: string
  path: string
  type: 'create' | 'modify' | 'delete'
  fsMtime: number
  agentMessageId?: string
  timestamp: number
}

export interface WorkspaceStats {
  workspaceId: string
  fileCount: number
  totalFileSize: number
  pendingCount: number
}

//=============================================================================
// Workspace Repository
//=============================================================================

export class WorkspaceRepository {
  //===========================================================================
  // Workspace Operations
  //===========================================================================

  /**
   * Get all workspaces
   */
  async findAllWorkspaces(): Promise<Workspace[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<WorkspaceRow>(
      'SELECT * FROM workspaces ORDER BY last_accessed_at DESC'
    )
    return rows.map((row) => this.rowToWorkspace(row))
  }

  /**
   * Count all workspaces across projects
   */
  async countAllWorkspaces(): Promise<number> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<{ count: number }>('SELECT COUNT(*) as count FROM workspaces')
    return Number(row?.count || 0)
  }

  /**
   * Get all workspaces for a project
   */
  async findWorkspacesByProject(projectId: string): Promise<Workspace[]> {
    const db = getSQLiteDB()
    // Standalone chats keep a hidden host workspace row (NOT NULL project_id
    // schema), but they are not project conversations — project-scoped
    // listings must not include them.
    const rows = await db.queryAll<WorkspaceRow>(
      `SELECT w.* FROM workspaces w
       LEFT JOIN conversations c ON c.id = w.id
       WHERE w.project_id = ? AND c.kind IS NOT 'direct'
       ORDER BY w.last_accessed_at DESC`,
      [projectId]
    )
    return rows.map((row) => this.rowToWorkspace(row))
  }

  /**
   * Get ALL workspaces hosted by a project, including standalone-chat
   * (kind='direct') host rows. Used by deleteProject's rebind step: the
   * hidden host rows must also leave the deleted project or their
   * project_id goes stale. Project listings must keep using
   * findWorkspacesByProject, which filters the direct hosts out.
   */
  async findAllWorkspacesByProjectIncludingDirect(projectId: string): Promise<Workspace[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE project_id = ? ORDER BY last_accessed_at DESC',
      [projectId]
    )
    return rows.map((row) => this.rowToWorkspace(row))
  }

  /**
   * Find workspace by ID
   */
  async findWorkspaceById(id: string): Promise<Workspace | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<WorkspaceRow>('SELECT * FROM workspaces WHERE id = ?', [id])
    return row ? this.rowToWorkspace(row) : null
  }

  /**
   * Find workspace by root directory
   */
  async findWorkspaceByRootDirectory(rootDirectory: string): Promise<Workspace | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE root_directory = ?',
      [rootDirectory]
    )
    return row ? this.rowToWorkspace(row) : null
  }

  /**
   * @deprecated Active workspace singleton table removed (PR-B). Use
   * findActiveWorkspaceByProject or the workspace store instead.
   * Returns null — kept only to avoid breaking imports.
   */
  async findActiveWorkspace(): Promise<Workspace | null> {
    return null
  }

  /**
   * Create a new workspace
   */
  async createWorkspace(
    workspace: Omit<Workspace, 'createdAt' | 'lastAccessedAt'>
  ): Promise<void> {
    const db = getSQLiteDB()
    const now = Date.now()
    const newWorkspace: Workspace = {
      ...workspace,
      createdAt: now,
      lastAccessedAt: now,
    }

    await db.execute(
      `INSERT INTO workspaces (id, project_id, root_directory, name, status, cache_size, modified_files, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        newWorkspace.id,
        newWorkspace.projectId,
        newWorkspace.rootDirectory,
        newWorkspace.name,
        newWorkspace.status,
        newWorkspace.cacheSize,
        newWorkspace.modifiedFiles,
        newWorkspace.createdAt,
        newWorkspace.lastAccessedAt,
      ]
    )
  }

  /**
   * Idempotent upsert used by WorkspaceManager to keep SQLite `workspaces`
   * row in sync with OPFS + in-memory index. Preserves `created_at` on
   * existing rows (avoids scrambling conversation list order).
   *
   * This is the Single Source of Truth entry point: all workspace creation
   * paths should funnel through WorkspaceManager.createWorkspace, which
   * calls this method internally.
   *
   * `pendingCount` is intentionally excluded — it's a computed column from
   * `fs_ops`, not a stored field in the `workspaces` table.
   */
  async upsertWorkspace(
    workspace: {
      id: string
      projectId: string
      rootDirectory: string
      name: string
      status: 'active' | 'archived'
      cacheSize: number
      modifiedFiles: number
      createdAt?: number
      lastAccessedAt?: number
    }
  ): Promise<void> {
    const db = getSQLiteDB()
    const now = Date.now()
    const createdAt = workspace.createdAt ?? now
    const lastAccessedAt = workspace.lastAccessedAt ?? now

    await db.execute(
      `INSERT INTO workspaces (id, project_id, root_directory, name, status, cache_size, modified_files, created_at, last_accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id,
         root_directory = excluded.root_directory,
         name = excluded.name,
         status = excluded.status,
         cache_size = excluded.cache_size,
         modified_files = excluded.modified_files,
         last_accessed_at = excluded.last_accessed_at`,
      [
        workspace.id,
        workspace.projectId,
        workspace.rootDirectory,
        workspace.name,
        workspace.status,
        workspace.cacheSize,
        workspace.modifiedFiles,
        createdAt,
        lastAccessedAt,
      ]
    )
  }

  /**
   * Update workspace
   */
  async updateWorkspace(workspace: Workspace): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `UPDATE workspaces
       SET project_id = ?, root_directory = ?, name = ?, status = ?, cache_size = ?,
           modified_files = ?, last_accessed_at = ?
       WHERE id = ?`,
      [
        workspace.projectId,
        workspace.rootDirectory,
        workspace.name,
        workspace.status,
        workspace.cacheSize,
        workspace.modifiedFiles,
        workspace.lastAccessedAt,
        workspace.id,
      ]
    )
  }

  /**
   * Update workspace name
   */
  async updateWorkspaceName(id: string, name: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('UPDATE workspaces SET name = ? WHERE id = ?', [name, id])
  }

  /**
   * Update workspace root directory
   */
  async updateWorkspaceRootDirectory(id: string, rootDirectory: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('UPDATE workspaces SET root_directory = ? WHERE id = ?', [rootDirectory, id])
  }

  /**
   * Update workspace status
   */
  async updateWorkspaceStatus(id: string, status: 'active' | 'archived'): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('UPDATE workspaces SET status = ? WHERE id = ?', [status, id])
  }

  /**
   * Update workspace access time
   */
  async updateWorkspaceAccessTime(id: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('UPDATE workspaces SET last_accessed_at = ? WHERE id = ?', [Date.now(), id])
  }

  /**
   * @deprecated No-op. Active workspace singleton removed (PR-B).
   */
  async setActiveWorkspace(workspaceId: string): Promise<void> {
    void workspaceId // signature retained for callers; write path is gone
  }

  /**
   * @deprecated Active workspace is now URL-driven. Returns the most recently
   * accessed workspace for the project as a best-effort fallback, or null.
   * Callers that need the *current* active workspace should read the workspace
   * store's activeWorkspaceId instead.
   */
  async findActiveWorkspaceByProject(projectId: string): Promise<Workspace | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<WorkspaceRow>(
      `SELECT * FROM workspaces
       WHERE project_id = ? AND status = 'active'
       ORDER BY last_accessed_at DESC
       LIMIT 1`,
      [projectId]
    )
    return row ? this.rowToWorkspace(row) : null
  }

  /**
   * @deprecated No-op for active tracking. Per-project active workspace pointer
   * was removed (PR-B); the active workspace is derived from the URL route.
   * Still bumps last_accessed_at on the workspace so the "recent work" fallback
   * sort in findActiveWorkspaceByProject returns sensible results.
   */
  async setActiveWorkspaceForProject(projectId: string, workspaceId: string): Promise<void> {
    void projectId // per-project pointer is gone; only workspaceId is used below
    try {
      const db = getSQLiteDB()
      await db.execute('UPDATE workspaces SET last_accessed_at = ? WHERE id = ?', [Date.now(), workspaceId])
    } catch {
      // ignore
    }
  }

  /**
   * @deprecated No-op. Per-project active workspace tracking removed (PR-B).
   */
  async clearActiveWorkspaceForProject(projectId: string): Promise<void> {
    void projectId // signature retained for callers; table is gone
  }

  /**
   * @deprecated No-op. Active workspace singleton removed (PR-B).
   */
  async clearActiveWorkspace(): Promise<void> {
    // no-op
  }

  /**
   * Delete workspace
   */
  async deleteWorkspace(id: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM workspaces WHERE id = ?', [id])
  }

  /**
   * Get workspace count
   */
  async getWorkspaceCount(): Promise<number> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<{ count: number }>('SELECT COUNT(*) as count FROM workspaces')
    return row?.count || 0
  }

  /**
   * Get workspace stats
   */
  async getWorkspaceStats(workspaceId: string): Promise<WorkspaceStats | null> {
    const db = getSQLiteDB()

    const fileCountRow = await db.queryFirst<{ count: number }>(
      'SELECT COUNT(*) as count FROM file_metadata WHERE workspace_id = ?',
      [workspaceId]
    )
    const fileSizeRow = await db.queryFirst<{ total: number }>(
      'SELECT SUM(size) as total FROM file_metadata WHERE workspace_id = ?',
      [workspaceId]
    )
    const pendingCount = await this.getRealPendingCount(workspaceId)

    if (!fileCountRow) return null

    return {
      workspaceId,
      fileCount: fileCountRow.count,
      totalFileSize: fileSizeRow?.total || 0,
      pendingCount,
    }
  }

  //===========================================================================
  // File Metadata Operations
  //===========================================================================

  /**
   * Get all file metadata for a workspace
   */
  async findFileMetadataByWorkspace(workspaceId: string): Promise<FileMetadata[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<FileMetadataRow>(
      'SELECT * FROM file_metadata WHERE workspace_id = ? ORDER BY path',
      [workspaceId]
    )
    return rows.map((row) => this.rowToFileMetadata(row))
  }

  /**
   * Find file metadata by path
   */
  async findFileMetadata(workspaceId: string, path: string): Promise<FileMetadata | null> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<FileMetadataRow>(
      'SELECT * FROM file_metadata WHERE workspace_id = ? AND path = ?',
      [workspaceId, path]
    )
    return row ? this.rowToFileMetadata(row) : null
  }

  /**
   * Save file metadata
   */
  async saveFileMetadata(metadata: FileMetadata): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `INSERT INTO file_metadata (id, workspace_id, path, mtime, size, content_type, hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(workspace_id, path) DO UPDATE SET
         mtime = excluded.mtime,
         size = excluded.size,
         content_type = excluded.content_type,
         hash = excluded.hash,
         updated_at = excluded.updated_at`,
      [
        metadata.id,
        metadata.workspaceId,
        metadata.path,
        metadata.mtime,
        metadata.size,
        metadata.contentType,
        metadata.hash || null,
        metadata.createdAt,
        metadata.updatedAt,
      ]
    )
  }

  /**
   * Delete file metadata
   */
  async deleteFileMetadata(workspaceId: string, path: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM file_metadata WHERE workspace_id = ? AND path = ?', [
      workspaceId,
      path,
    ])
  }

  /**
   * Delete all file metadata for a workspace
   */
  async deleteAllFileMetadata(workspaceId: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM file_metadata WHERE workspace_id = ?', [workspaceId])
  }

  //===========================================================================
  // Pending Changes Operations (legacy compatibility only)
  //===========================================================================

  /**
   * Get all pending changes for a workspace
   */
  async findPendingChangesByWorkspace(workspaceId: string): Promise<PendingChange[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<PendingChangeRow>(
      'SELECT * FROM pending_changes WHERE workspace_id = ? ORDER BY timestamp',
      [workspaceId]
    )
    return rows.map((row) => this.rowToPendingChange(row))
  }

  /**
   * Save pending change
   */
  async savePendingChange(change: PendingChange): Promise<void> {
    const db = getSQLiteDB()
    await db.execute(
      `INSERT INTO pending_changes (id, workspace_id, path, type, fs_mtime, agent_message_id, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         path = excluded.path,
         type = excluded.type,
         fs_mtime = excluded.fs_mtime,
         agent_message_id = excluded.agent_message_id,
         timestamp = excluded.timestamp`,
      [
        change.id,
        change.workspaceId,
        change.path,
        change.type,
        change.fsMtime,
        change.agentMessageId || null,
        change.timestamp,
      ]
    )
  }

  /**
   * Delete pending change
   */
  async deletePendingChange(id: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM pending_changes WHERE id = ?', [id])
  }

  /**
   * Delete all pending changes for a workspace
   */
  async deleteAllPendingChanges(workspaceId: string): Promise<void> {
    const db = getSQLiteDB()
    await db.execute('DELETE FROM pending_changes WHERE workspace_id = ?', [workspaceId])
  }

  //===========================================================================
  // Batch Operations for Migration
  //===========================================================================

  /**
   * Get all workspace stats (for workspace list display)
   */
  async getAllWorkspaceStats(): Promise<WorkspaceStats[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<{
      workspace_id: string
      file_count: number
      total_file_size: number
    }>(
      `SELECT
        w.id as workspace_id,
        COUNT(DISTINCT f.id) as file_count,
        COALESCE(SUM(f.size), 0) as total_file_size
       FROM workspaces w
       LEFT JOIN file_metadata f ON f.workspace_id = w.id
       GROUP BY w.id
       ORDER BY w.last_accessed_at DESC`
    )

    // Get real pending counts from fs_ops (not cached values)
    const pendingCounts = await this.getRealPendingCounts()

    return rows.map((row) => ({
      workspaceId: row.workspace_id,
      fileCount: row.file_count,
      totalFileSize: row.total_file_size,
      pendingCount: pendingCounts.get(row.workspace_id) ?? 0,
    }))
  }

  /**
   * Find active workspaces
   */
  async findActiveWorkspaces(): Promise<Workspace[]> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<WorkspaceRow>(
      "SELECT * FROM workspaces WHERE status = 'active' ORDER BY last_accessed_at DESC"
    )
    const workspaces = rows.map((row) => this.rowToWorkspace(row))

    // Get real pending counts from fs_ops (filtered by review_status)
    const pendingCounts = await this.getRealPendingCounts()
    return workspaces.map((ws) => ({
      ...ws,
      pendingCount: pendingCounts.get(ws.id) ?? 0,
    }))
  }

  /**
   * Get real pending counts from fs_ops table (not cached)
   * Only counts ops with review_status = 'pending' or NULL
   */
  async getRealPendingCounts(): Promise<Map<string, number>> {
    const db = getSQLiteDB()
    const rows = await db.queryAll<{ workspace_id: string; count: number }>(
      `SELECT workspace_id, COUNT(*) as count
       FROM fs_ops
       WHERE status = 'pending'
         AND (review_status IS NULL OR review_status = 'pending')
       GROUP BY workspace_id`
    )
    return new Map(rows.map((r) => [r.workspace_id, r.count]))
  }

  /**
   * Get real pending count for a specific workspace
   */
  async getRealPendingCount(workspaceId: string): Promise<number> {
    const db = getSQLiteDB()
    const row = await db.queryFirst<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM fs_ops
       WHERE workspace_id = ?
         AND status = 'pending'
         AND (review_status IS NULL OR review_status = 'pending')`,
      [workspaceId]
    )
    return row?.count ?? 0
  }

  /**
   * Find inactive workspaces (not accessed for specified days)
   */
  async findInactiveWorkspaces(days: number): Promise<Workspace[]> {
    const db = getSQLiteDB()
    const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000
    const rows = await db.queryAll<WorkspaceRow>(
      'SELECT * FROM workspaces WHERE last_accessed_at < ? ORDER BY last_accessed_at ASC',
      [cutoffTime]
    )
    return rows.map((row) => this.rowToWorkspace(row))
  }

  /**
   * Batch update workspace stats (for synchronization)
   */
  async updateWorkspaceStats(
    workspaceId: string,
    stats: {
      cacheSize?: number
      modifiedFiles?: number
    }
  ): Promise<void> {
    const db = getSQLiteDB()
    const updates: string[] = []
    const values: (number | string)[] = []

    if (stats.cacheSize !== undefined) {
      updates.push('cache_size = ?')
      values.push(stats.cacheSize)
    }
    if (stats.modifiedFiles !== undefined) {
      updates.push('modified_files = ?')
      values.push(stats.modifiedFiles)
    }

    if (updates.length === 0) return

    values.push(workspaceId)
    await db.execute(`UPDATE workspaces SET ${updates.join(', ')} WHERE id = ?`, values)
  }

  /**
   * Archive old workspaces (mark as archived instead of deleting)
   */
  async archiveInactiveWorkspaces(days: number): Promise<number> {
    const db = getSQLiteDB()
    const cutoffTime = Date.now() - days * 24 * 60 * 60 * 1000
    await db.execute(
      "UPDATE workspaces SET status = 'archived' WHERE last_accessed_at < ? AND status = 'active'",
      [cutoffTime]
    )
    // Query to get count of affected rows
    const countRow = await db.queryFirst<{ count: number }>('SELECT changes() as count')
    return countRow?.count || 0
  }

  //===========================================================================
  // Helpers
  //===========================================================================

  private rowToWorkspace(row: WorkspaceRow): Workspace {
    return {
      id: row.id,
      projectId: row.project_id,
      rootDirectory: row.root_directory,
      name: row.name,
      status: row.status,
      cacheSize: row.cache_size,
      // pendingCount is computed from fs_ops table, not stored
      pendingCount: 0,
      modifiedFiles: row.modified_files,
      createdAt: row.created_at,
      lastAccessedAt: row.last_accessed_at,
    }
  }

  private rowToFileMetadata(row: FileMetadataRow): FileMetadata {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      path: row.path,
      mtime: row.mtime,
      size: row.size,
      contentType: row.content_type,
      hash: row.hash || undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  private rowToPendingChange(row: PendingChangeRow): PendingChange {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      path: row.path,
      type: row.type,
      fsMtime: row.fs_mtime,
      agentMessageId: row.agent_message_id || undefined,
      timestamp: row.timestamp,
    }
  }
}

//=============================================================================
// Singleton Instance
//=============================================================================

let workspaceRepoInstance: WorkspaceRepository | null = null

export function getWorkspaceRepository(): WorkspaceRepository {
  if (!workspaceRepoInstance) {
    workspaceRepoInstance = new WorkspaceRepository()
  }
  return workspaceRepoInstance
}
