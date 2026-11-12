import type { Message } from '@/agent/message-types'
import type { SubagentTaskStatus, SubagentTaskUsage } from '@/agent/tools/tool-types'

/** Serializable origin of a child execution. Credentials belong to the provider, never this record. */
export interface SubagentContinuation {
  parentRunId: string
  providerType: string
  modelName: string
  maxTokens: number
  agentOverrideId?: string | null
  projectId?: string | null
}

export type SubagentDeliveryPhase =
  | 'pending'
  | 'delivered'
  | 'processing'
  | 'consumed'
  | 'handled'
  | 'suppressed'
  | 'blocked'
  | 'error'

export interface SubagentExecutionMetadata {
  executionId: string
  isAsync: boolean
  conversationId: string
  continuation?: SubagentContinuation
  suppressed: boolean
  acknowledged?: boolean
  changedPaths: string[]
}

export interface SubagentAcceptedReceipt {
  agentId: string
  status: 'pending' | 'running'
  description: string
  name?: string
}

export interface SubagentBatchAcceptance {
  accepted: Array<SubagentAcceptedReceipt & { task_index: number }>
  rejected: Array<{ task_index: number; reason: string; error_code: string }>
}

/** An immutable execution snapshot; task rows can move on to a later attempt. */
export interface SubagentCompletion {
  id: string
  agentId: string
  executionId: string
  conversationId: string
  projectId?: string | null
  parentToolCallId?: string
  continuation?: SubagentContinuation
  notificationMessageId: string
  deliveryReserved?: boolean
  status: SubagentDeliveryPhase
  taskStatus: SubagentTaskStatus
  description: string
  name?: string
  result: string
  messages: Message[]
  usage?: SubagentTaskUsage
  error?: { code: string; message: string }
  changedPaths: string[]
  createdAt: number
  updatedAt: number
  parentRunId?: string
  deliveryError?: string
}

export interface WaitSubagentsInput {
  agentIds: string[]
  timeout_ms?: number
  wait_for?: 'any' | 'all'
  signal?: AbortSignal
}

export interface WaitSubagentsResult {
  results: SubagentCompletion[]
  pending: string[]
  timed_out: boolean
}
