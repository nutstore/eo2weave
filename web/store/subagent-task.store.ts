import { create } from 'zustand'
import type { Message } from '@/agent/message-types'
import type { SubagentDeliveryPhase } from '@/agent/subagent/async-types'
import type { SubagentTaskStatus, SubagentTaskUsage, SubagentType } from '@/agent/tools/tool-types'

export interface SubagentTaskProjection {
  agentId: string
  conversationId: string
  parentToolCallId?: string
  name?: string
  description: string
  role: SubagentType
  status: SubagentTaskStatus
  createdAt: number
  updatedAt: number
  lastActivity: number
  recentActivity?: string
  usage?: SubagentTaskUsage
  error?: { code: string; message: string }
  isAsync: boolean
  executionId?: string
  deliveryPhase?: SubagentDeliveryPhase
  messages: Message[]
}

interface SubagentTaskState {
  tasks: Record<string, SubagentTaskProjection>
  publish: (task: SubagentTaskProjection) => void
  setDeliveryPhase: (agentId: string, executionId: string, phase: SubagentDeliveryPhase) => void
  removeConversation: (conversationId: string) => void
}

/** Runtime and SQLite hydration publish here, independently of the parent draft. */
export const useSubagentTaskStore = create<SubagentTaskState>((set) => ({
  tasks: {},
  publish: (task) => set((state) => ({ tasks: { ...state.tasks, [task.agentId]: task } })),
  setDeliveryPhase: (agentId, executionId, deliveryPhase) =>
    set((state) => {
      const task = state.tasks[agentId]
      return task?.executionId === executionId
        ? { tasks: { ...state.tasks, [agentId]: { ...task, deliveryPhase } } }
        : state
    }),
  removeConversation: (conversationId) =>
    set((state) => ({
      tasks: Object.fromEntries(
        Object.entries(state.tasks).filter(([, task]) => task.conversationId !== conversationId)
      ),
    })),
}))

export const selectSubagentTasks = (conversationId: string) => (state: SubagentTaskState) =>
  Object.values(state.tasks).filter((task) => task.conversationId === conversationId)

export const selectSubagentTask = (agentId: string) => (state: SubagentTaskState) =>
  state.tasks[agentId]
