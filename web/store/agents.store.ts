/**
 * Agents Store
 *
 * 管理多 Agent 系统的状态。
 * 每个 Agent 有独立的 SOUL.md、IDENTITY.md 等配置文件。
 */

import { create } from 'zustand'
import { toast } from 'sonner'
import { ProjectManager, type AgentMeta, type AgentInfo } from '@/opfs'
import { useProjectStore } from './project.store'

/**
 * Agent 档案文件的读取结果
 */
export interface AgentFiles {
  soul: string
  identity: string
  agents: string
  user: string
  memory: string
  /** 日记日期列表，倒序（最新的在前） */
  diaries: string[]
}

interface AgentsState {
  /** Project whose Agent catalog is currently loaded. */
  loadedProjectId: string | null
  // 当前活跃的 agent
  activeAgentId: string | null
  activeAgent: AgentInfo | null

  // Agent 列表 (仅元数据，轻量)
  agents: AgentMeta[]

  // 状态
  isLoading: boolean
  isInitialized: boolean
  error: string | null

  // ProjectManager 实例 (由外部注入)
  projectManager: ProjectManager | null

  // agent 写文件后的通知计数 —— 供打开中的 Agent 档案面板感知变更并刷新
  agentsRevision: number

  // Actions
  setProjectManager: (pm: ProjectManager) => void
  initialize: (projectId: string) => Promise<void>
  setActiveAgent: (agentId: string) => Promise<void>
  refreshAgents: () => Promise<void>

  // Agent CRUD
  createAgent: (id: string) => Promise<AgentInfo | null>
  deleteAgent: (id: string) => Promise<boolean>

  // Agent 文件编辑
  updateAgentFile: (
    agentId: string,
    file: 'soul' | 'identity' | 'agents' | 'user' | 'memory',
    content: string
  ) => Promise<boolean>

  // Agent 档案读取
  readAgentFiles: (agentId: string) => Promise<AgentFiles | null>
  readAgentDiary: (agentId: string, date: string) => Promise<string | null>

  // Agent 档案写入（按日期的日记）
  updateAgentDiary: (agentId: string, date: string, content: string) => Promise<boolean>

  // 通知 agent 档案面板 agent 文件已变更
  bumpAgentsRevision: () => void

  // 日记
  appendTodayLog: (agentId: string, content: string) => Promise<boolean>

  // 技能
  listSkills: (agentId: string) => Promise<string[]>
  readSkill: (agentId: string, skillName: string) => Promise<string | null>
  writeSkill: (agentId: string, skillName: string, content: string) => Promise<boolean>
  deleteSkill: (agentId: string, skillName: string) => Promise<boolean>
}

let initializationRevision = 0
let selectionRevision = 0
let agentInitialization: { projectId: string; promise: Promise<void> } | null = null

export const useAgentsStore = create<AgentsState>()((set, get) => ({
    loadedProjectId: null,
    activeAgentId: null,
    activeAgent: null,
    agents: [],
    isLoading: false,
    isInitialized: false,
    error: null,
    projectManager: null,
    agentsRevision: 0,

    setProjectManager: (pm) => {
      set({ projectManager: pm })
    },

    initialize: async (projectId) => {
      if (!projectId) {
        initializationRevision += 1
        selectionRevision += 1
        agentInitialization = null
        set({
          loadedProjectId: null, agents: [], activeAgentId: null, activeAgent: null,
          isLoading: false, isInitialized: false, error: null,
        })
        return
      }
      if (useProjectStore.getState().activeProjectId !== projectId) return
      const { projectManager, isInitialized, loadedProjectId } = get()
      if (!projectManager) {
        set({ error: 'ProjectManager not set', isInitialized: false })
        return
      }
      if (isInitialized && loadedProjectId === projectId) return
      if (agentInitialization?.projectId === projectId) return agentInitialization.promise

      const revision = ++initializationRevision
      selectionRevision += 1
      set({
        isLoading: true, error: null, isInitialized: false, loadedProjectId: null,
        agents: [], activeAgentId: null, activeAgent: null,
      })
      const promise = (async () => {
        try {
          const project = await projectManager.getProject(projectId)
          if (!project) throw new Error('Project not found')
          const agents = await project.agentManager.listAgents()
          const defaultAgent = agents.find((a) => a.id === 'default') || agents[0]
          const activeAgent = defaultAgent ? await project.agentManager.getAgent(defaultAgent.id) : null
          // A slow old project must never replace the new project's catalog.
          if (revision !== initializationRevision || useProjectStore.getState().activeProjectId !== projectId) return
          set({
            agents, activeAgent, activeAgentId: activeAgent?.id ?? null,
            loadedProjectId: projectId, isLoading: false, isInitialized: true,
          })
        } catch (e) {
          if (revision !== initializationRevision) return
          const message = e instanceof Error ? e.message : 'Failed to initialize agents'
          set({ error: message, isLoading: false, isInitialized: false })
          console.error('[AgentsStore] initialize failed:', e)
        }
      })()
      agentInitialization = { projectId, promise }
      try {
        await promise
      } finally {
        if (agentInitialization?.promise === promise) agentInitialization = null
      }
    },

    setActiveAgent: async (agentId) => {
      const { projectManager, agents } = get()
      const currentProjectId = useProjectStore.getState().activeProjectId
      if (get().loadedProjectId !== currentProjectId) return

      if (!projectManager) {
        toast.error('Project not initialized. Please try again.')
        return
      }

      const meta = agents.find((a) => a.id === agentId)
      if (!meta) {
        toast.error(`Agent "${agentId}" not found`)
        return
      }

      const selection = ++selectionRevision
      set({ isLoading: true })

      try {
        if (!currentProjectId) {
          set({ isLoading: false })
          return
        }

        const project = await projectManager.getProject(currentProjectId)
        if (selection !== selectionRevision || currentProjectId !== useProjectStore.getState().activeProjectId) return
        if (!project) {
          set({ isLoading: false })
          return
        }

        const agentInfo = await project.agentManager.getAgent(agentId)
        if (selection !== selectionRevision || currentProjectId !== useProjectStore.getState().activeProjectId) return
        if (agentInfo) {
          set({
            activeAgentId: agentId,
            activeAgent: agentInfo,
            isLoading: false,
          })
        } else {
          toast.error(`Failed to load agent "${agentId}"`)
          set({ isLoading: false })
        }
      } catch (e) {
        if (selection !== selectionRevision || currentProjectId !== useProjectStore.getState().activeProjectId) return
        console.error('[AgentsStore] setActiveAgent failed:', e)
        set({ isLoading: false })
      }
    },

    refreshAgents: async () => {
      const { projectManager } = get()
      if (!projectManager) return

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return

        const agents = await project.agentManager.listAgents()
        if (currentProjectId === get().loadedProjectId) set({ agents })
      } catch (e) {
        console.error('[AgentsStore] refreshAgents failed:', e)
      }
    },

    createAgent: async (id) => {
      const { projectManager } = get()
      if (!projectManager) {
        toast.error('ProjectManager not initialized')
        return null
      }

      // 验证 ID 格式
      if (!/^[\p{L}\p{N}_-]+$/u.test(id)) {
        toast.error('Agent ID 只能包含字母（含中文）、数字、下划线(_)和连字符(-)')
        return null
      }

      set({ isLoading: true })

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) {
          set({ isLoading: false })
          return null
        }

        const project = await projectManager.getProject(currentProjectId)
        if (!project) {
          set({ isLoading: false })
          return null
        }

        // 检查是否已存在
        const exists = await project.agentManager.hasAgent(id)
        if (exists) {
          toast.error(`Agent "${id}" already exists`)
          set({ isLoading: false })
          return null
        }

        // 创建 agent
        const agentInfo = await project.agentManager.createAgent(id)

        // 刷新列表
        const agents = await project.agentManager.listAgents()
        set({ agents, isLoading: false })

        toast.success(`Agent "${id}" created`)
        return agentInfo
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to create agent'
        set({ isLoading: false })
        toast.error(message)
        return null
      }
    },

    deleteAgent: async (id) => {
      const { projectManager, activeAgentId } = get()
      if (!projectManager) return false

      // 不允许删除 default
      if (id === 'default') {
        toast.error('Cannot delete default agent')
        return false
      }

      set({ isLoading: true })

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) {
          set({ isLoading: false })
          return false
        }

        const project = await projectManager.getProject(currentProjectId)
        if (!project) {
          set({ isLoading: false })
          return false
        }

        await project.agentManager.deleteAgent(id)

        // 如果删除的是当前活跃的，切换到 default
        if (activeAgentId === id) {
          const defaultAgent = await project.agentManager.getAgent('default')
          set({
            activeAgentId: 'default',
            activeAgent: defaultAgent,
          })
        }

        // 刷新列表
        const agents = await project.agentManager.listAgents()
        set({ agents, isLoading: false })

        toast.success(`Agent "${id}" deleted`)
        return true
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Failed to delete agent'
        set({ isLoading: false })
        toast.error(message)
        return false
      }
    },

    updateAgentFile: async (agentId, file, content) => {
      const { projectManager, activeAgent } = get()
      if (!projectManager) return false

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return false

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return false

        switch (file) {
          case 'soul':
            await project.agentManager.writeSoul(agentId, content)
            break
          case 'identity':
            await project.agentManager.writeIdentity(agentId, content)
            break
          case 'agents':
            await project.agentManager.writeAgents(agentId, content)
            break
          case 'user':
            await project.agentManager.writeUser(agentId, content)
            break
          case 'memory':
            await project.agentManager.writeMemory(agentId, content)
            break
        }

        // 更新缓存中的 activeAgent
        if (activeAgent && activeAgent.id === agentId) {
          set({
            activeAgent: { ...activeAgent, [file]: content },
          })
        }

        return true
      } catch (e) {
        console.error('[AgentsStore] updateAgentFile failed:', e)
        return false
      }
    },

    readAgentFiles: async (agentId) => {
      const { projectManager } = get()
      if (!projectManager) return null

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return null

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return null

        const am = project.agentManager
        const [soul, identity, agents, user, memory, diaries] = await Promise.all([
          am.readSoul(agentId),
          am.readIdentity(agentId),
          am.readAgents(agentId),
          am.readUser(agentId),
          am.readMemory(agentId),
          am.listDiaries(agentId),
        ])

        return {
          soul: soul ?? '',
          identity: identity ?? '',
          agents: agents ?? '',
          user: user ?? '',
          memory: memory ?? '',
          diaries,
        }
      } catch (e) {
        console.error('[AgentsStore] readAgentFiles failed:', e)
        return null
      }
    },

    readAgentDiary: async (agentId, date) => {
      const { projectManager } = get()
      if (!projectManager) return null

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return null

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return null

        return await project.agentManager.readPath(agentId, `memory/${date}.md`)
      } catch (e) {
        console.error('[AgentsStore] readAgentDiary failed:', e)
        return null
      }
    },

    bumpAgentsRevision: () => {
      set((state) => ({ agentsRevision: state.agentsRevision + 1 }))
    },

    updateAgentDiary: async (agentId, date, content) => {
      const { projectManager } = get()
      if (!projectManager) return false

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return false

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return false

        await project.agentManager.writePath(agentId, `memory/${date}.md`, content)
        return true
      } catch (e) {
        console.error('[AgentsStore] updateAgentDiary failed:', e)
        return false
      }
    },

    appendTodayLog: async (agentId, content) => {
      const { projectManager } = get()
      if (!projectManager) return false

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return false

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return false

        await project.agentManager.appendTodayLog(agentId, content)
        return true
      } catch (e) {
        console.error('[AgentsStore] appendTodayLog failed:', e)
        return false
      }
    },

    listSkills: async (agentId) => {
      const { projectManager } = get()
      if (!projectManager) return []

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return []

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return []

        return await project.agentManager.listSkills(agentId)
      } catch (e) {
        console.error('[AgentsStore] listSkills failed:', e)
        return []
      }
    },

    readSkill: async (agentId, skillName) => {
      const { projectManager } = get()
      if (!projectManager) return null

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return null

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return null

        return await project.agentManager.readSkill(agentId, skillName)
      } catch (e) {
        console.error('[AgentsStore] readSkill failed:', e)
        return null
      }
    },

    writeSkill: async (agentId, skillName, content) => {
      const { projectManager } = get()
      if (!projectManager) return false

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return false

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return false

        await project.agentManager.writeSkill(agentId, skillName, content)
        return true
      } catch (e) {
        console.error('[AgentsStore] writeSkill failed:', e)
        return false
      }
    },

    deleteSkill: async (agentId, skillName) => {
      const { projectManager } = get()
      if (!projectManager) return false

      try {
        const currentProjectId = useProjectStore.getState().activeProjectId
        if (!currentProjectId) return false

        const project = await projectManager.getProject(currentProjectId)
        if (!project) return false

        await project.agentManager.deleteSkill(agentId, skillName)
        return true
      } catch (e) {
        console.error('[AgentsStore] deleteSkill failed:', e)
        return false
      }
    },
  }))
export type { AgentsState }
