import type { ServerCapabilities } from '@modelcontextprotocol/client'
import type {
  SerializedTaskReference,
  TaskState,
  TaskView,
} from '@modelcontextprotocol/ext-tasks/client'
import type { MCPToolCallResult } from './mcp-types'

export interface MCPInvocationContext {
  projectId: string
  conversationId: string
  agentId?: string
  toolCallId?: string
  localTaskId?: string
}
export type ObservationState =
  | 'submitting'
  | 'observing'
  | 'paused'
  | 'attention'
  | 'submission_unknown'
export interface ManagedMCPTask {
  id: string
  serverId: string
  endpointId: string
  context: MCPInvocationContext
  toolName: string
  untrusted?: boolean
  reference?: SerializedTaskReference
  remoteStatus?: TaskState
  observation: ObservationState
  createdAt: number
  updatedAt: number
  snapshot?: TaskView
  result?: MCPToolCallResult
  resultAssetId?: string
  resultIsError?: boolean
  error?: string
  notifiedAt?: number
  settledAt?: number
  /** Composer presentation is independent of remote execution and notifications. */
  composer?: {
    eligible: boolean
    dismissedAt?: number
    sentMessageId?: string
    queued?: boolean
  }
  cancellationRequested?: boolean
  cancellationSupported: boolean
  legacySession?: {
    connectionId?: string
    sessionId?: string
    protocolVersion: string
    capabilities: ServerCapabilities
  }
}
export type MCPInvocation =
  | { kind: 'result'; result: MCPToolCallResult }
  | { kind: 'task'; task: ManagedMCPTask }
export const isTaskTerminal = (task: ManagedMCPTask) =>
  task.remoteStatus === 'completed' ||
  task.remoteStatus === 'failed' ||
  task.remoteStatus === 'cancelled'

export const needsTaskObservation = (task: ManagedMCPTask) =>
  !!task.reference &&
  (!isTaskTerminal(task) || (task.remoteStatus === 'completed' && !task.settledAt))
