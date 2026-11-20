/**
 * Agent Manager
 *
 * Manages the per-project agent system.
 * Each agent has its own directory holding SOUL.md, IDENTITY.md and friends.
 */

import { getDefaultAgentTemplate, type AgentTemplate } from './agent-templates'

const AGENTS_DIR = 'agents'
const SKILLS_DIR = 'skills'
const MEMORY_DIR = 'memory'

// Agent file names
const SOUL_FILE = 'SOUL.md'
const IDENTITY_FILE = 'IDENTITY.md'
const AGENTS_FILE = 'AGENTS.md'
const USER_FILE = 'USER.md'
const MEMORY_FILE = 'MEMORY.md'

/**
 * Agent metadata
 */
export interface AgentMeta {
  id: string
  name: string
  createdAt: number
  lastAccessedAt: number
  /** One-line responsibility, shown in the peer roster. Optional. */
  role?: string
  /**
   * Capability boundary applied when this agent acts as a subagent actor.
   * Classes are coarse by design; see agent/tools/tool-capabilities.ts.
   */
  capabilities?: {
    classes?: string[]
    readonly?: boolean
  }
  /** Memory write policy; 'propose' queues writes for review. Default 'propose'. */
  memoryPolicy?: 'off' | 'propose' | 'direct'
}

/**
 * Full agent info
 */
export interface AgentInfo {
  id: string
  meta: AgentMeta
  soul: string
  identity: string
  agents: string
  user: string
  memory: string
}

/**
 * Agent Manager
 *
 * Manages the agent system of a single project.
 */
export class AgentManager {
  private agentsDir: FileSystemDirectoryHandle

  constructor(agentsDir: FileSystemDirectoryHandle) {
    this.agentsDir = agentsDir
  }

  /**
   * Create an AgentManager from a project directory
   */
  static async fromProjectDir(projectDir: FileSystemDirectoryHandle): Promise<AgentManager> {
    const agentsDir = await projectDir.getDirectoryHandle(AGENTS_DIR, { create: true })
    return new AgentManager(agentsDir)
  }

  // ==================== Agent list ====================

  /**
   * List all agents
   */
  async listAgents(): Promise<AgentMeta[]> {
    const agents: AgentMeta[] = []

    try {
      for await (const [name, handle] of this.agentsDir.entries()) {
        if (handle.kind === 'directory') {
          const meta = await this.loadAgentMeta(name)
          if (meta) {
            agents.push(meta)
          }
        }
      }
    } catch (err) {
      console.warn('Failed to list agents:', err)
    }

    return agents.sort((a, b) => a.createdAt - b.createdAt)
  }

  /**
   * Check whether an agent exists
   */
  async hasAgent(id: string): Promise<boolean> {
    try {
      await this.agentsDir.getDirectoryHandle(id)
      return true
    } catch {
      return false
    }
  }

  // ==================== Agent CRUD ====================

  /**
   * Create a new agent
   * @param id Agent ID (e.g., 'default', 'frontend')
   * @param template Optional custom template; defaults to the generic one
   */
  async createAgent(id: string, template?: Partial<AgentTemplate>): Promise<AgentInfo> {
    const defaultTemplate = getDefaultAgentTemplate()
    const t = { ...defaultTemplate, ...template }

    // Create the agent directory
    const agentDir = await this.agentsDir.getDirectoryHandle(id, { create: true })

    // Create subdirectories
    await agentDir.getDirectoryHandle(SKILLS_DIR, { create: true })
    await agentDir.getDirectoryHandle(MEMORY_DIR, { create: true })

    // Write files
    await this.writeFile(agentDir, SOUL_FILE, t.SOUL)
    await this.writeFile(agentDir, IDENTITY_FILE, t.IDENTITY)
    await this.writeFile(agentDir, AGENTS_FILE, t.AGENTS)
    await this.writeFile(agentDir, USER_FILE, t.USER)
    await this.writeFile(agentDir, MEMORY_FILE, t.MEMORY)

    // Write metadata
    const meta: AgentMeta = {
      id,
      name: id,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
    }
    await this.writeMeta(agentDir, meta)

    return {
      id,
      meta,
      soul: t.SOUL,
      identity: t.IDENTITY,
      agents: t.AGENTS,
      user: t.USER,
      memory: t.MEMORY,
    }
  }

  /**
   * Get agent info
   */
  async getAgent(id: string): Promise<AgentInfo | null> {
    try {
      const agentDir = await this.agentsDir.getDirectoryHandle(id)

      const [meta, soul, identity, agents, user, memory] = await Promise.all([
        this.loadAgentMeta(id),
        this.readFile(agentDir, SOUL_FILE),
        this.readFile(agentDir, IDENTITY_FILE),
        this.readFile(agentDir, AGENTS_FILE),
        this.readFile(agentDir, USER_FILE),
        this.readFile(agentDir, MEMORY_FILE),
      ])

      if (!meta) return null

      return {
        id,
        meta,
        soul: soul || '',
        identity: identity || '',
        agents: agents || '',
        user: user || '',
        memory: memory || '',
      }
    } catch {
      return null
    }
  }

  /**
   * Delete an agent
   */
  async deleteAgent(id: string): Promise<void> {
    // The default agent must not be deleted
    if (id === 'default') {
      throw new Error('Cannot delete default agent')
    }
    await this.agentsDir.removeEntry(id, { recursive: true })
  }

  // ==================== Agent file IO ====================

  /**
   * Read the agent's SOUL.md
   */
  async readSoul(id: string): Promise<string | null> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    return this.readFile(agentDir, SOUL_FILE)
  }

  /**
   * Write the agent's SOUL.md
   */
  async writeSoul(id: string, content: string): Promise<void> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    await this.writeFile(agentDir, SOUL_FILE, content)
  }

  /**
   * Read the agent's IDENTITY.md
   */
  async readIdentity(id: string): Promise<string | null> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    return this.readFile(agentDir, IDENTITY_FILE)
  }

  /**
   * Write the agent's IDENTITY.md
   */
  async writeIdentity(id: string, content: string): Promise<void> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    await this.writeFile(agentDir, IDENTITY_FILE, content)
  }

  /**
   * Read the agent's MEMORY.md
   */
  async readMemory(id: string): Promise<string | null> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    return this.readFile(agentDir, MEMORY_FILE)
  }

  /**
   * Write the agent's MEMORY.md
   */
  async writeMemory(id: string, content: string): Promise<void> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    await this.writeFile(agentDir, MEMORY_FILE, content)
  }

  /**
   * Read the agent's USER.md
   */
  async readUser(id: string): Promise<string | null> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    return this.readFile(agentDir, USER_FILE)
  }

  /**
   * Write the agent's USER.md
   */
  async writeUser(id: string, content: string): Promise<void> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    await this.writeFile(agentDir, USER_FILE, content)
  }

  /**
   * Read the agent's AGENTS.md
   */
  async readAgents(id: string): Promise<string | null> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    return this.readFile(agentDir, AGENTS_FILE)
  }

  /**
   * Write the agent's AGENTS.md
   */
  async writeAgents(id: string, content: string): Promise<void> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    await this.writeFile(agentDir, AGENTS_FILE, content)
  }

  /**
   * Read a file at a path relative to the agent root (subdirectories supported)
   */
  async readPath(id: string, relativePath: string): Promise<string | null> {
    const normalized = this.normalizeRelativePath(relativePath)
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    const { dir, fileName } = await this.resolvePath(agentDir, normalized, false)
    return this.readFile(dir, fileName)
  }

  /**
   * Write a file at a path relative to the agent root (subdirectories supported)
   */
  async writePath(id: string, relativePath: string, content: string): Promise<void> {
    const normalized = this.normalizeRelativePath(relativePath)
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    const { dir, fileName } = await this.resolvePath(agentDir, normalized, true)
    await this.writeFile(dir, fileName, content)
  }

  /**
   * Delete a file at a path relative to the agent root (subdirectories supported)
   */
  async deletePath(id: string, relativePath: string): Promise<void> {
    const normalized = this.normalizeRelativePath(relativePath)
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    const { dir, fileName } = await this.resolvePath(agentDir, normalized, false)
    await dir.removeEntry(fileName)
  }

  /**
   * Resolve a path relative to the agent directory and return its directory handle (an empty path yields the agent root)
   */
  async getDirectoryHandle(
    id: string,
    relativeDirPath = '',
    options?: { allowMissing?: boolean }
  ): Promise<{ handle: FileSystemDirectoryHandle; exists: boolean }> {
    const allowMissing = options?.allowMissing ?? false
    const normalizedPath = this.normalizeDirectoryPath(relativeDirPath)
    const agentDir = await this.agentsDir.getDirectoryHandle(id)

    if (!normalizedPath) {
      return { handle: agentDir, exists: true }
    }

    let current = agentDir
    for (const part of normalizedPath.split('/')) {
      try {
        current = await current.getDirectoryHandle(part)
      } catch (error) {
        if (allowMissing) {
          return { handle: agentDir, exists: false }
        }
        throw error
      }
    }

    return { handle: current, exists: true }
  }

  // ==================== Diary memory ====================

  /**
   * List the agent's diary dates (descending, newest first)
   *
   * @returns Date strings, e.g. ['2026-10-22', '2026-10-21']
   */
  async listDiaries(id: string): Promise<string[]> {
    const dates: string[] = []

    try {
      const agentDir = await this.agentsDir.getDirectoryHandle(id)
      const memoryDir = await agentDir.getDirectoryHandle(MEMORY_DIR)
      for await (const [name, handle] of memoryDir.entries()) {
        if (handle.kind === 'file' && name.endsWith('.md')) {
          dates.push(name.replace(/\.md$/, ''))
        }
      }
    } catch {
      // Directory or agent does not exist
    }

    return dates.sort().reverse()
  }

  /**
   * Get today's diary path
   */
  private getTodayLogPath(): string {
    const today = new Date()
    const yyyy = today.getFullYear()
    const mm = String(today.getMonth() + 1).padStart(2, '0')
    const dd = String(today.getDate()).padStart(2, '0')
    return `${yyyy}-${mm}-${dd}.md`
  }

  /**
   * Read the agent's diary for today
   */
  async readTodayLog(id: string): Promise<string | null> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    const memoryDir = await agentDir.getDirectoryHandle(MEMORY_DIR)
    const logPath = this.getTodayLogPath()
    return this.readFile(memoryDir, logPath)
  }

  /**
   * Append to the agent's diary for today
   */
  async appendTodayLog(id: string, content: string): Promise<void> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    const memoryDir = await agentDir.getDirectoryHandle(MEMORY_DIR)
    const logPath = this.getTodayLogPath()

    let existing = ''
    try {
      existing = (await this.readFile(memoryDir, logPath)) || ''
    } catch {
      // File does not exist
    }

    const timestamp = new Date().toLocaleTimeString()
    const newContent = existing + `\n\n## ${timestamp}\n\n${content}\n`
    await this.writeFile(memoryDir, logPath, newContent.trim())
  }

  // ==================== Skills ====================

  /**
   * List the agent's skills
   */
  async listSkills(id: string): Promise<string[]> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    const skillsDir = await agentDir.getDirectoryHandle(SKILLS_DIR)

    const skills: string[] = []
    try {
      for await (const [name, handle] of skillsDir.entries()) {
        if (handle.kind === 'file' && name.endsWith('.md')) {
          skills.push(name.replace(/\.md$/, ''))
        }
      }
    } catch {
      // Directory does not exist
    }
    return skills
  }

  /**
   * Read a skill
   */
  async readSkill(id: string, skillName: string): Promise<string | null> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    const skillsDir = await agentDir.getDirectoryHandle(SKILLS_DIR)
    return this.readFile(skillsDir, `${skillName}.md`)
  }

  /**
   * Write a skill
   */
  async writeSkill(id: string, skillName: string, content: string): Promise<void> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    const skillsDir = await agentDir.getDirectoryHandle(SKILLS_DIR)
    await this.writeFile(skillsDir, `${skillName}.md`, content)
  }

  /**
   * Delete a skill
   */
  async deleteSkill(id: string, skillName: string): Promise<void> {
    const agentDir = await this.agentsDir.getDirectoryHandle(id)
    const skillsDir = await agentDir.getDirectoryHandle(SKILLS_DIR)
    await skillsDir.removeEntry(`${skillName}.md`)
  }

  // ==================== Private methods ====================

  private async readFile(dir: FileSystemDirectoryHandle, filename: string): Promise<string | null> {
    try {
      const file = await dir.getFileHandle(filename)
      const blob = await file.getFile()
      return await blob.text()
    } catch {
      return null
    }
  }

  private async writeFile(
    dir: FileSystemDirectoryHandle,
    filename: string,
    content: string
  ): Promise<void> {
    const file = await dir.getFileHandle(filename, { create: true })
    const writable = await file.createWritable()
    await writable.write(content)
    await writable.close()
  }

  private async loadAgentMeta(id: string): Promise<AgentMeta | null> {
    try {
      const agentDir = await this.agentsDir.getDirectoryHandle(id)
      const content = await this.readFile(agentDir, 'meta.json')
      if (!content) return null
      return JSON.parse(content) as AgentMeta
    } catch {
      return null
    }
  }

  private async writeMeta(agentDir: FileSystemDirectoryHandle, meta: AgentMeta): Promise<void> {
    await this.writeFile(agentDir, 'meta.json', JSON.stringify(meta, null, 2))
  }

  private normalizeRelativePath(path: string): string {
    const normalized = path.replace(/\\/g, '/').trim().replace(/^\/+/, '')
    const parts = normalized.split('/').filter(Boolean)
    if (parts.length === 0) {
      throw new Error('Path cannot be empty')
    }
    if (parts.some((part) => part === '.' || part === '..')) {
      throw new Error('Path cannot include "." or ".."')
    }
    return parts.join('/')
  }

  private normalizeDirectoryPath(path: string): string {
    const normalized = path.replace(/\\/g, '/').trim().replace(/^\/+/, '')
    if (!normalized) return ''
    const parts = normalized.split('/').filter(Boolean)
    if (parts.some((part) => part === '.' || part === '..')) {
      throw new Error('Path cannot include "." or ".."')
    }
    return parts.join('/')
  }

  private async resolvePath(
    agentDir: FileSystemDirectoryHandle,
    normalizedPath: string,
    createDirs: boolean
  ): Promise<{ dir: FileSystemDirectoryHandle; fileName: string }> {
    const parts = normalizedPath.split('/')
    const fileName = parts[parts.length - 1]
    let dir = agentDir

    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i], { create: createDirs })
    }

    return { dir, fileName }
  }
}
