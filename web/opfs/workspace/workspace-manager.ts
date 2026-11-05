/**
 * Workspace Manager
 *
 * Project-scoped workspace directory manager.
 *
 * Canonical metadata source is SQLite `workspaces` table.
 * OPFS index files under root are intentionally removed.
 */

import { generateId } from '../utils/opfs-utils'
import { WorkspaceRuntime } from './workspace-runtime'
import { getWorkspaceRepository } from '@/sqlite/repositories/workspace.repository'
import { getProjectRepository } from '@/sqlite/repositories/project.repository'
import type { DiskExecutor } from '../native-disk/executor'
import { isNativeHostAvailable } from '../native-disk/executor'
import { FSAccessExecutor } from '../native-disk/executor-fsaccess'
import { NativeHostExecutor } from '../native-disk/executor-native-host'
import { CompositeExecutor } from '../native-disk/executor-composite'

const PROJECTS_ROOT_DIR = 'projects'
const PROJECT_WORKSPACES_DIR = 'workspaces'
const WORKSPACE_ASSETS_DIR = 'assets'

/**
 * Canonical workspace metadata in memory.
 */
interface WorkspaceMetadataRecord {
  workspaceId: string
  projectId: string
  rootDirectory: string
  name: string
  createdAt: number
  lastAccessedAt: number
}

/**
 * Workspace Manager
 *
 * Responsibilities:
 * - Manage workspace runtimes
 * - Resolve OPFS workspace directory via SQLite `project_id`
 * - Create, retrieve, and delete workspace directories
 */
export class WorkspaceManager {
  private opfsRoot?: FileSystemDirectoryHandle
  private projectsRootDir?: FileSystemDirectoryHandle
  private workspaces: Map<string, WorkspaceRuntime> = new Map()
  private index: WorkspaceMetadataRecord[] = []
  private initialized = false

  /**
   * Initialize workspace manager
   */
  async initialize(): Promise<void> {
    if (this.initialized) return

    this.opfsRoot = (await navigator.storage.getDirectory()) as FileSystemDirectoryHandle
    this.projectsRootDir = await this.opfsRoot.getDirectoryHandle(PROJECTS_ROOT_DIR, { create: true })

    await this.loadIndexFromSQLite()
    this.initialized = true
  }

  /** Choose a root-routed executor; bridge availability never changes existing roots. */
  private resolveDiskExecutor(): DiskExecutor {
    if (isNativeHostAvailable()) {
      return new CompositeExecutor(new FSAccessExecutor(), new NativeHostExecutor())
    }
    return new FSAccessExecutor()
  }

  /**
   * Reload in-memory metadata from SQLite.
   */
  private async loadIndexFromSQLite(): Promise<void> {
    try {
      const repo = getWorkspaceRepository()
      const rows = await repo.findAllWorkspaces()
      this.index = rows
        .filter((row) => !!row.projectId)
        .map((row) => ({
          workspaceId: row.id,
          projectId: row.projectId!,
          rootDirectory: row.rootDirectory,
          name: row.name,
          createdAt: row.createdAt,
          lastAccessedAt: row.lastAccessedAt,
        }))
    } catch {
      // SQLite may be unavailable during early bootstrap in fallback modes.
      this.index = []
    }
  }

  private async getActiveProjectId(): Promise<string | null> {
    const projectRepo = getProjectRepository()
    const activeProject = await projectRepo.findActiveProject()
    return activeProject?.id || null
  }

  private async ensureProjectsRootDir(): Promise<FileSystemDirectoryHandle> {
    if (!this.initialized) await this.initialize()
    if (!this.projectsRootDir) {
      this.projectsRootDir = await this.opfsRoot!.getDirectoryHandle(PROJECTS_ROOT_DIR, { create: true })
    }
    return this.projectsRootDir
  }

  private upsertIndexRecord(record: WorkspaceMetadataRecord): void {
    const idx = this.index.findIndex((item) => item.workspaceId === record.workspaceId)
    if (idx >= 0) {
      this.index[idx] = record
      return
    }
    this.index.push(record)
  }

  private async resolveWorkspaceProjectId(workspaceId: string): Promise<string | null> {
    const cached = this.index.find((item) => item.workspaceId === workspaceId)
    if (cached?.projectId) {
      return cached.projectId
    }

    const repo = getWorkspaceRepository()
    const row = await repo.findWorkspaceById(workspaceId)
    if (!row?.projectId) {
      return null
    }

    this.upsertIndexRecord({
      workspaceId: row.id,
      projectId: row.projectId,
      rootDirectory: row.rootDirectory,
      name: row.name,
      createdAt: row.createdAt,
      lastAccessedAt: row.lastAccessedAt,
    })

    return row.projectId
  }

  private async resolveWorkspaceRootDirectory(workspaceId: string): Promise<string | null> {
    const cached = this.index.find((item) => item.workspaceId === workspaceId)
    if (cached) return cached.rootDirectory

    const repo = getWorkspaceRepository()
    const row = await repo.findWorkspaceById(workspaceId)
    if (!row?.projectId) return null

    this.upsertIndexRecord({
      workspaceId: row.id,
      projectId: row.projectId,
      rootDirectory: row.rootDirectory,
      name: row.name,
      createdAt: row.createdAt,
      lastAccessedAt: row.lastAccessedAt,
    })

    return row.rootDirectory
  }

  private async getWorkspaceDirForProject(
    projectId: string,
    workspaceId: string,
    create: boolean
  ): Promise<FileSystemDirectoryHandle> {
    const projectsRoot = await this.ensureProjectsRootDir()
    const projectDir = await projectsRoot.getDirectoryHandle(projectId, { create })
    const projectWorkspacesDir = await projectDir.getDirectoryHandle(PROJECT_WORKSPACES_DIR, {
      create,
    })
    return await projectWorkspacesDir.getDirectoryHandle(workspaceId, { create })
  }

  /**
   * Create workspace runtime and directory.
   */
  async createWorkspace(
    rootDirectory: string,
    workspaceId?: string,
    name?: string,
    targetProjectId?: string
  ): Promise<WorkspaceRuntime> {
    if (!this.initialized) await this.initialize()

    const id = workspaceId || generateId('workspace')

    const existingProjectId = await this.resolveWorkspaceProjectId(id)
    if (existingProjectId && targetProjectId && existingProjectId !== targetProjectId) {
      throw new Error(`Workspace ${id} already belongs to project ${existingProjectId}`)
    }
    const projectId = existingProjectId || targetProjectId || (await this.getActiveProjectId())
    if (!projectId) {
      throw new Error('No active project selected for workspace creation')
    }

    const workspaceDir = await this.getWorkspaceDirForProject(projectId, id, true)
    await workspaceDir.getDirectoryHandle(WORKSPACE_ASSETS_DIR, { create: true })

    // Choose disk executor: Native Host if available, else FS Access API
    const diskExec = this.resolveDiskExecutor()
    const workspace = new WorkspaceRuntime(id, workspaceDir, rootDirectory, diskExec)
    await workspace.initialize()

    this.workspaces.set(id, workspace)

    // FIX: preserve original createdAt/lastAccessedAt when the workspace already
    // exists (idempotent "ensure" path used by loadFromDB). Overwriting with
    // Date.now() on every page load scrambles the conversation list order —
    // the last-processed conversation gets the newest timestamp and jumps to
    // the top, surfacing as "old conversations moved to the front".
    const existingRecord = this.index.find((item) => item.workspaceId === id)
    const isExisting = !!existingRecord || !!existingProjectId

    let resolvedCreatedAt: number
    let resolvedLastAccessedAt: number
    const resolvedName = name || existingRecord?.name || rootDirectory.split('/').pop() || id

    if (isExisting) {
      // Idempotent ensure: keep original timestamps, only refresh
      // rootDirectory/name in case they drifted. If the record isn't in the
      // in-memory index yet, re-read the authoritative timestamps from SQLite
      // instead of falling back to Date.now() (which would scramble order).
      let createdAt = existingRecord?.createdAt
      let lastAccessedAt = existingRecord?.lastAccessedAt
      if (createdAt === undefined || lastAccessedAt === undefined) {
        try {
          const row = await getWorkspaceRepository().findWorkspaceById(id)
          createdAt = row?.createdAt ?? Date.now()
          lastAccessedAt = row?.lastAccessedAt ?? Date.now()
        } catch {
          createdAt = createdAt ?? Date.now()
          lastAccessedAt = lastAccessedAt ?? Date.now()
        }
      }
      resolvedCreatedAt = createdAt
      resolvedLastAccessedAt = lastAccessedAt
    } else {
      const now = Date.now()
      resolvedCreatedAt = now
      resolvedLastAccessedAt = now
    }

    // Update in-memory index (always).
    this.upsertIndexRecord({
      workspaceId: id,
      projectId,
      rootDirectory,
      name: resolvedName,
      createdAt: resolvedCreatedAt,
      lastAccessedAt: resolvedLastAccessedAt,
    })

    // Sync to SQLite (Single Source of Truth). UPSERT preserves `created_at`
    // on existing rows via the ON CONFLICT clause — see upsertWorkspace.
    //
    // Errors propagate to the caller. The existing OPFS dir + in-memory index
    // stay usable for the lifetime of this page session, but a missing SQLite
    // row would re-trigger the "ensure" path on next launch and retry — so we
    // surface failures rather than swallowing them. `loadFromDB` already
    // wraps this call in try/catch to avoid blocking the whole conversation
    // list load.
    await getWorkspaceRepository().upsertWorkspace({
      id,
      projectId,
      rootDirectory,
      name: resolvedName,
      status: 'active',
      cacheSize: 0,
      modifiedFiles: 0,
      createdAt: resolvedCreatedAt,
      lastAccessedAt: resolvedLastAccessedAt,
    })

    return workspace
  }

  /**
   * Get workspace runtime by ID.
   */
  async getWorkspace(workspaceId: string): Promise<WorkspaceRuntime | undefined> {
    if (!this.initialized) await this.initialize()

    if (this.workspaces.has(workspaceId)) {
      return this.workspaces.get(workspaceId)!
    }

    const projectId = await this.resolveWorkspaceProjectId(workspaceId)
    const rootDirectory = await this.resolveWorkspaceRootDirectory(workspaceId)
    if (!projectId || !rootDirectory) {
      return undefined
    }

    try {
      const workspaceDir = await this.getWorkspaceDirForProject(projectId, workspaceId, false)
      await workspaceDir.getDirectoryHandle(WORKSPACE_ASSETS_DIR, { create: true })
      const workspace = new WorkspaceRuntime(workspaceId, workspaceDir, rootDirectory, this.resolveDiskExecutor())
      await workspace.initialize()

      this.workspaces.set(workspaceId, workspace)

      // NOTE: Do NOT update lastAccessedAt here.
      // getWorkspace() is a read-only runtime accessor called by many
      // background tasks (prefetch, skill-scanner, agent
      // tools). Treating it as an "access" causes spurious lastAccessedAt
      // bumps that reorder the sidebar non-deterministically on every page
      // refresh. Access-time updates are the sole responsibility of
      // switchWorkspace() (explicit user action) in workspace.store.ts.

      return workspace
    } catch {
      return undefined
    }
  }

  /**
   * Get existing workspace by root directory, or create one.
   */
  async getOrCreateWorkspace(rootDirectory: string): Promise<WorkspaceRuntime> {
    if (!this.initialized) await this.initialize()

    const existing = this.getWorkspaceByRoot(rootDirectory)
    if (existing) {
      const workspace = await this.getWorkspace(existing.workspaceId)
      if (workspace) {
        return workspace
      }
    }

    return await this.createWorkspace(rootDirectory)
  }

  /**
   * Get workspace metadata list.
   */
  getAllWorkspaces(): Array<WorkspaceMetadataRecord> {
    return this.index.map((item) => ({ ...item }))
  }

  /**
   * Workspace count.
   */
  get workspaceCount(): number {
    return this.index.length
  }

  /**
   * Delete workspace runtime and directory.
   */
  async deleteWorkspace(workspaceId: string): Promise<void> {
    if (!this.initialized) await this.initialize()

    this.workspaces.delete(workspaceId)

    const projectId = await this.resolveWorkspaceProjectId(workspaceId)
    this.index = this.index.filter((item) => item.workspaceId !== workspaceId)

    if (!projectId) {
      return
    }

    try {
      const projectsRoot = await this.ensureProjectsRootDir()
      const projectDir = await projectsRoot.getDirectoryHandle(projectId, { create: false })
      const projectWorkspacesDir = await projectDir.getDirectoryHandle(PROJECT_WORKSPACES_DIR, {
        create: false,
      })
      await projectWorkspacesDir.removeEntry(workspaceId, { recursive: true })
    } catch (err) {
      console.warn(`Failed to delete workspace directory: ${workspaceId}`, err)
    }
  }

  /**
   * Cleanup stale workspaces.
   */
  async cleanupOldWorkspaces(olderThanDays: number = 30): Promise<number> {
    if (!this.initialized) await this.initialize()

    const stale = await getWorkspaceRepository().findInactiveWorkspaces(olderThanDays)
    let cleaned = 0

    for (const workspace of stale) {
      await this.deleteWorkspace(workspace.id)
      cleaned++
    }

    return cleaned
  }

  /**
   * Lookup workspace metadata by root directory.
   */
  getWorkspaceByRoot(rootDirectory: string): WorkspaceMetadataRecord | undefined {
    const item = this.index.find((record) => record.rootDirectory === rootDirectory)
    return item ? { ...item } : undefined
  }

  /**
   * Check workspace existence by ID.
   */
  hasWorkspace(workspaceId: string): boolean {
    return this.index.some((item) => item.workspaceId === workspaceId)
  }

  /**
   * Cheap check: is the WorkspaceRuntime instance already instantiated?
   * Used to skip idempotent re-create calls on page reload when the
   * runtime is already in memory. Distinct from hasWorkspace (which hits
   * the SQLite-backed index) — this only touches the in-memory Map.
   */
  isWorkspaceLoaded(workspaceId: string): boolean {
    return this.workspaces.has(workspaceId)
  }

  /**
   * Update workspace root directory.
   */
  async updateWorkspaceRoot(workspaceId: string, rootDirectory: string): Promise<void> {
    const repo = getWorkspaceRepository()
    await repo.updateWorkspaceRootDirectory(workspaceId, rootDirectory)

    const metadata = this.index.find((item) => item.workspaceId === workspaceId)
    if (metadata) {
      metadata.rootDirectory = rootDirectory
    }

    const workspace = this.workspaces.get(workspaceId)
    if (workspace) {
      await workspace.updateRootDirectory(rootDirectory)
    }
  }

  /**
   * Update workspace display name.
   */
  async updateWorkspaceName(workspaceId: string, name: string): Promise<void> {
    const repo = getWorkspaceRepository()
    await repo.updateWorkspaceName(workspaceId, name)

    const metadata = this.index.find((item) => item.workspaceId === workspaceId)
    if (metadata) {
      metadata.name = name
    }
  }

  /**
   * Clear all in-memory workspace caches (keeps OPFS data).
   */
  clearMemoryCache(): void {
    this.workspaces.clear()
  }

  /**
   * Invalidate the cached root map (`_rootMap`) on every instantiated
   * WorkspaceRuntime whose project matches `projectId`.
   *
   * WHY: `resolvePath()` caches the SQLite `project_roots` result in
   * `_rootMap` (keyed by projectId). When the SQLite table is repaired at
   * runtime (e.g. by `reconcileProjectRoots` self-healing missing rows),
   * already-cached runtimes keep serving the stale map → `resolvePath`
   * keeps falling back to the wrong default root, routing file syncs to the
   * wrong disk location.
   *
   * Call this after mutating `project_roots` so the next `resolvePath()`
   * lazily rebuilds the map from the repaired SQLite table.
   */
  invalidateRootMapCache(projectId?: string): void {
    for (const record of this.index) {
      if (projectId && record.projectId !== projectId) continue
      const runtime = this.workspaces.get(record.workspaceId)
      if (runtime) {
        runtime.invalidateRootCache()
      }
    }
  }

  /**
   * Get statistics for all indexed workspaces.
   */
  async getAllStats(): Promise<
    Array<{
      workspaceId: string
      stats: Awaited<ReturnType<WorkspaceRuntime['getStats']>>
    }>
  > {
    const results: Array<{
      workspaceId: string
      stats: Awaited<ReturnType<WorkspaceRuntime['getStats']>>
    }> = []

    for (const metadata of this.index) {
      const workspace = await this.getWorkspace(metadata.workspaceId)
      if (workspace) {
        const stats = await workspace.getStats()
        results.push({
          workspaceId: metadata.workspaceId,
          stats,
        })
      }
    }

    return results
  }
}
