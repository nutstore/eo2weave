/**
 * Project Manager
 *
 * Manages the project system. Each project holds agents and workspaces.
 * Creating a project initializes a default agent automatically.
 *
 * Directory layout:
 * projects/{projectId}/
 * ├── agents/{agentId}/
 * └── workspaces/{workspaceId}/
 *     ├── files/
 *     ├── assets/
 *     └── workspace.json
 */

import { AgentManager } from '../agent'
import { getDefaultAgentTemplate } from '../agent/agent-templates'

const PROJECTS_DIR = 'projects'
const AGENTS_DIR = 'agents'
const WORKSPACES_DIR = 'workspaces'

/**
 * Project info
 */
export interface ProjectInfo {
  id: string
  agentManager: AgentManager
}

/**
 * Project Manager
 */
export class ProjectManager {
  private projectsDir: FileSystemDirectoryHandle
  private projectCache: Map<string, ProjectInfo> = new Map()

  constructor(projectsDir: FileSystemDirectoryHandle) {
    this.projectsDir = projectsDir
  }

  /**
   * Create a ProjectManager from the OPFS root
   */
  static async create(): Promise<ProjectManager> {
    const opfsRoot = await navigator.storage.getDirectory()
    const projectsDir = await opfsRoot.getDirectoryHandle(PROJECTS_DIR, { create: true })
    return new ProjectManager(projectsDir)
  }

  /**
   * Check whether a project exists
   */
  async hasProject(id: string): Promise<boolean> {
    try {
      await this.projectsDir.getDirectoryHandle(id)
      return true
    } catch {
      return false
    }
  }

  /**
   * Ensure project directory structure exists for a concrete project ID.
   * This aligns OPFS directory names with SQLite `projects.id`.
   */
  async ensureProject(projectId: string): Promise<ProjectInfo> {
    if (!projectId) {
      throw new Error('projectId is required')
    }

    if (this.projectCache.has(projectId)) {
      return this.projectCache.get(projectId)!
    }

    const projectDir = await this.projectsDir.getDirectoryHandle(projectId, { create: true })
    const agentsDir = await projectDir.getDirectoryHandle(AGENTS_DIR, { create: true })
    await projectDir.getDirectoryHandle(WORKSPACES_DIR, { create: true })

    const agentManager = new AgentManager(agentsDir)
    const hasDefault = await agentManager.hasAgent('default')
    if (!hasDefault) {
      await agentManager.createAgent('default', getDefaultAgentTemplate())
    }

    const projectInfo: ProjectInfo = {
      id: projectId,
      agentManager,
    }

    this.projectCache.set(projectId, projectInfo)
    return projectInfo
  }

  /**
   * Create a new project
   * @param path Project path (used to derive the ID)
   */
  async createProject(path: string): Promise<ProjectInfo> {
    // Legacy behavior: keep path hashing for backward compatibility.
    const hashedProjectId = this.hashPath(path)
    return this.ensureProject(hashedProjectId)
  }

  /**
   * Get a project
   */
  async getProject(id: string): Promise<ProjectInfo | null> {
    // Check the cache
    if (this.projectCache.has(id)) {
      return this.projectCache.get(id)!
    }

    try {
      const projectDir = await this.projectsDir.getDirectoryHandle(id)
      const agentsDir = await projectDir.getDirectoryHandle(AGENTS_DIR, { create: true })
      await projectDir.getDirectoryHandle(WORKSPACES_DIR, { create: true })
      const agentManager = new AgentManager(agentsDir)

      const hasDefault = await agentManager.hasAgent('default')
      if (!hasDefault) {
        await agentManager.createAgent('default', getDefaultAgentTemplate())
      }

      const projectInfo: ProjectInfo = {
        id,
        agentManager,
      }

      this.projectCache.set(id, projectInfo)
      return projectInfo
    } catch {
      return null
    }
  }

  /**
   * Delete a project
   */
  async deleteProject(id: string): Promise<void> {
    await this.projectsDir.removeEntry(id, { recursive: true })
    this.projectCache.delete(id)
  }

  /**
   * Get or create a project by path
   */
  async getOrCreateProject(path: string): Promise<ProjectInfo> {
    const id = this.hashPath(path)
    const existing = await this.getProject(id)
    if (existing) return existing
    return this.ensureProject(id)
  }

  /**
   * Get or create project by concrete project ID.
   */
  async getOrCreateProjectById(projectId: string): Promise<ProjectInfo> {
    const existing = await this.getProject(projectId)
    if (existing) return existing
    return this.ensureProject(projectId)
  }

  /**
   * Get the project's workspaces directory
   */
  async getWorkspacesDir(id: string): Promise<FileSystemDirectoryHandle | null> {
    try {
      const projectDir = await this.projectsDir.getDirectoryHandle(id)
      return projectDir.getDirectoryHandle(WORKSPACES_DIR)
    } catch {
      return null
    }
  }

  /**
   * Get the project's team board directory.
   *
   * A sibling of `agents/` and `workspaces/`, deliberately outside every
   * workspace root: boards never enter git, never enter the sync-to-disk review
   * queue, and never appear in a project listing.
   *
   * `create` is false by default on purpose — reading a board must not bring one
   * into existence, otherwise "which runs exist" becomes unknowable.
   */
  async getTeamDir(id: string, options?: { create?: boolean }): Promise<FileSystemDirectoryHandle | null> {
    try {
      const projectDir = await this.projectsDir.getDirectoryHandle(id)
      return await projectDir.getDirectoryHandle('team', { create: options?.create ?? false })
    } catch {
      return null
    }
  }

  /**
   * Path hash
   */
  hashPath(path: string): string {
    let hash = 0
    for (let i = 0; i < path.length; i++) {
      const char = path.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash
    }
    return Math.abs(hash).toString(16).padStart(8, '0')
  }
}
