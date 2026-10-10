/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Conversation Agent Run — extracted from conversation.store.sqlite.ts
 *
 * Implementation of the store's `runAgent` action (~1900 lines), following the
 * Part A bridge/Impl pattern: the store method is a one-line delegate that
 * calls `runAgentImpl`, passing the store instance (via the
 * `ConversationAgentRunInternals` bridge interface) plus the zustand `set` and
 * `get` closures the method body already operates on.
 *
 * The body is moved VERBATIM from the facade — zero rewrites — because the
 * original method already reached all state via the `set`/`get` closures and
 * module imports (no `this.` references at all). The single facade-module
 * symbol it referenced (`handleSubagentStepNotification`) is reached through
 * the bridge so this file never imports the facade (no cycles).
 */

import { toast } from 'sonner'
import { type Conversation, type Message, type ToolCall, type ConversationStatus, type ContextWindowUsage, createRunChangesMessage, createUserMessage } from '@/agent/message-types'
import { extractFirstMentionedAgentId } from '@/agent/agent-mention'
import { emitThinkingStart, emitThinkingDelta, emitCompressionEvent, emitToolStart, emitComplete, emitError } from '@/streaming-bus'
import { useConversationContextStore } from './conversation-context.store'
import { useConversationRuntimeStore, createEmptyRuntime } from './conversation-runtime.store'
import { deleteAgentLoop, setAgentLoop } from './agent-loop-registry'
import { deleteStreamingQueues, getStreamingQueues, setStreamingQueues } from './streaming-queue-registry'
import { applyDraftAssistantEvent } from './draft-assistant'
import { getElicitationHandler } from '@/mcp/elicitation-handler.tsx'
import { ensureRuntime, attachReasoningDurations, commitDraftToMessages, findSpawnStepInDraft, summarizeForNotification, reconcileMessageSnapshot, deriveContextUsageFromAssistantUsage } from './conversation-message-ops'
import { StreamingQueue } from '../utils/streaming-queue'
import { AgentLoop } from '@/agent/agent-loop'
import { createToolPolicyHooks } from '@/agent/tool-policy'
import { createLLMProvider } from '@/agent/llm/provider-factory'
import { ContextManager } from '@/agent/context-manager'
import { getToolRegistry } from '@/agent/tool-registry'
import { getOrCreateSubagentRuntime } from '@/agent/subagent/runtime'
import { getApiKeyRepository } from '@/sqlite'
import { LLM_PROVIDER_CONFIGS, isCustomProviderType } from '@/agent/providers/types'
import { generateFollowUp } from '@/agent/follow-up-generator'
import { useSettingsStore } from './settings.store'
import { getCurrentWorkspaceAgentMode } from './workspace-preferences.store'
import type { LLMProviderType } from '@/agent/providers/types'
import type { SubagentTaskNotification, SubagentStepNotification } from '@/agent/tools/tool-types'
import { persistConversationMeta, persistMessageReplace } from './conversation-persist'

/**
 * zustand setter as captured by the store creator closure (immer middleware:
 * updater receives a draft state).
 *
 * The draft is typed structurally: it enumerates exactly the snapshot members
 * the moved runAgent body reads/mutates on the main conversation store (the
 * zustand draft is the full state, so extra members at runtime are harmless).
 */
type AgentRunStoreDraft = {
  conversations: Conversation[]
  cancelledRunIds: Set<string>
}

/**
 * zustand getter as captured by the store creator closure. Returns the full
 * store state; members enumerated by what the moved body actually accesses.
 */
type StoreGet = () => {
  conversations: Conversation[]
  cancelledRunIds: Set<string>
  isConversationRunning(id: string): boolean
  addMessage(conversationId: string, message: Message): void
  updateMessages(conversationId: string, messages: Message[]): void
  runAgent(
    conversationId: string,
    providerType: LLMProviderType,
    modelName: string,
    maxTokens: number,
    directoryHandle: FileSystemDirectoryHandle | null,
    agentOverrideId?: string | null,
    options?: { background?: boolean }
  ): Promise<void>
  generateTitle(
    id: string,
    manual: boolean
  ): Promise<
    | { ok: true; title: string; changed: boolean }
    | { ok: false; reason: string }
  >
  setSuggestedFollowUp(conversationId: string, suggestion: string): void
}

type StoreSet = (updater: (state: AgentRunStoreDraft) => void) => void

/**
 * Bridge onto the facade-module symbols runAgent touches. The delegate casts
 * the facade side into this interface; members are enumerated by what the
 * moved body actually references.
 */
export interface ConversationAgentRunInternals {
  /** Route subagent step notifications to per-agent draft state (facade-module fn). */
  handleSubagentStepNotification(
    conversationId: string,
    event: SubagentStepNotification
  ): void
}

/**
 * Implementation of the store's `runAgent` action. Body moved verbatim from
 * conversation.store.sqlite.ts; `set`/`get` are the zustand closures passed
 * through by the facade delegate.
 */
export async function runAgentImpl(
  store: ConversationAgentRunInternals,
  set: StoreSet,
  get: StoreGet,
      conversationId: string,
      providerType: LLMProviderType,
      modelName: string,
      maxTokens: number,
      directoryHandle: FileSystemDirectoryHandle | null,
      agentOverrideId?: string | null,
      options?: { background?: boolean }
): Promise<void> {
  const { handleSubagentStepNotification } = store
  // Background runs (external agents driving EO2Weave) must NOT steal the
  // user's active workspace — they only ensure the workspace exists.
  const background = options?.background === true

      const state = get()
      const conv = state.conversations.find((c) => c.id === conversationId)
      if (!conv) return

      if (state.isConversationRunning(conversationId)) {
        console.warn('[conversation.store] Conversation is already running:', conversationId)
        return
      }

      // Mark the favicon as "in progress" so the user can see agent
      // status from other tabs (independent of system notifications).
      // Fires immediately; no await — canvas work is async in background.
      try {
        const { setFaviconState } = await import('@/services/favicon-indicator')
        setFaviconState('running')
      } catch {
        // favicon-indicator unavailable — non-fatal
      }

      try {
        // Ensure the workspace exists before the agent starts. This avoids
        // write/edit/delete tools failing with "No active workspace" on
        // first-turn chats where workspace creation/switch is still in-flight.
        //
        // Foreground (UI-initiated) runs activate the workspace, which switches
        // the whole UI. Background runs (external agents via WebMCP) must NOT
        // steal the user's view — they only ensure the workspace OPFS/SQLite
        // records exist, then drive the loop against the per-conversation
        // runtime. Tool routing is unaffected either way: ToolContext carries
        // the conversationId as its workspaceId explicitly.
        const workspaceStore = useConversationContextStore.getState()
        if (background) {
          // Ensure the workspace record/OPFS dirs exist without switching.
          const manager = await (async () => {
            const m = await import('@/opfs')
            return m.getWorkspaceManager()
          })()
          const existing = manager.getWorkspaceByRoot(`workspaces/${conversationId}`)
          if (!existing || existing.workspaceId !== conversationId) {
            await manager.getOrCreateWorkspace(`workspaces/${conversationId}`)
          }
        } else if (workspaceStore.activeWorkspaceId !== conversationId) {
          await workspaceStore.switchWorkspace(conversationId)
        }

        // FIX (parallel isolation): Resolve directoryHandle from THIS run's
        // conversationId (= workspaceId), NOT from the global active-project
        // pointer. Previously the caller passed useAgentStore.directoryHandle
        // which is a global singleton shared by all parallel runs — switching
        // the UI view (or another tab) mid-run rewrote it and caused tools to
        // read/write the WRONG project's directory. Each run now resolves its
        // own handle so parallel runs in different projects never cross-talk.
        // The legacy `directoryHandle` parameter is kept for backward-compat
        // but overridden by the per-workspace resolution below.
        let resolvedDirHandle: FileSystemDirectoryHandle | null = directoryHandle
        try {
          const { resolveWorkspaceDirectoryHandle } = await import('@/agent/tools/tool-utils')
          const wsHandle = await resolveWorkspaceDirectoryHandle(conversationId)
          if (wsHandle) {
            resolvedDirHandle = wsHandle
          }
        } catch {
          // Fall back to the caller-provided handle if per-workspace resolution fails.
        }
        directoryHandle = resolvedDirHandle

        const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        let runEpoch = 0
        // Ownership is deliberately in-memory and run scoped. The overlay has
        // one pending row per path, so paths already pending when this run
        // begins are never eligible for automatic application.
        const runChangedPaths = new Set<string>()
        const pendingPathsAtRunStart = new Set<string>()
        let runOwnershipReady = false
        // Captures the auto-apply snapshot for this run (set in onLoopComplete,
        // consumed after agentLoop.run resolves to attach a run_changes card).
        let runApplyResult: { snapshotId: string } | null = null
        let latestMessages: Message[] = conv.messages
        // Compression summaries are injected into the agent loop as
        // system-context messages and mirrored into the runtime message state.
        let committed = false

        // --- Delegation handoff state ---
        // When the delegate_to tool is invoked, it calls `onDelegation`
        // (registered on toolContext below) which stashes the request here.
        // After agentLoop.run resolves we check this and restart the loop
        // with the target agent persona (one-way handoff).
        let pendingDelegation: {
          targetAgentId: string
          task: string
          reason?: string
        } | null = null
        // Per-runAgent invocation depth. Read from the conversation runtime
        // state so recursive runAgent calls can inherit & increment it.
        // MAX_DELEGATION_DEPTH prevents infinite A→B→A loops.
        const MAX_DELEGATION_DEPTH = 5
        const delegationDepth = conv.delegationDepth ?? 0

        // Acquire run lock immediately to prevent concurrent duplicate starts.
        useConversationRuntimeStore.setState((state) => {
          let rt = state.runtimes.get(conversationId)
          if (!rt) {
            rt = createEmptyRuntime()
            state.runtimes.set(conversationId, rt)
          }
          rt.runEpoch = (rt.runEpoch || 0) + 1
          runEpoch = rt.runEpoch
          rt.activeRunId = runId
          rt.status = 'pending'
          rt.error = null
          rt.currentToolCall = null
          rt.activeToolCalls = []
          rt.streamingToolArgs = ''
          rt.streamingToolArgsByCallId = {}
          rt.streamingContent = ''
          rt.streamingReasoning = ''
          rt.completedContent = null
          rt.completedReasoning = null
          rt.isContentStreaming = false
          rt.isReasoningStreaming = false
          rt.contextWindowUsage = null
          rt.collectedAssets = []
          rt.draftAssistant = {
            reasoning: '',
            content: '',
            toolCalls: [],
            toolResults: {},
            toolCall: null,
            toolArgs: '',
            steps: [],
            activeReasoningStepId: null,
            activeContentStepId: null,
            activeToolStepId: null,
            activeCompressionStepId: null,
          }
        })
        // Mirror run-lock state to runtime store so streaming callbacks can guard on activeRunId
        useConversationRuntimeStore.setState((state) => {
          const r = ensureRuntime(state, conversationId)
          r.runEpoch = runEpoch
          r.activeRunId = runId
          r.status = 'pending'
          r.error = null
          r.currentToolCall = null
          r.activeToolCalls = []
          r.streamingToolArgs = ''
          r.streamingToolArgsByCallId = {}
          r.streamingContent = ''
          r.streamingReasoning = ''
          r.completedContent = null
          r.completedReasoning = null
          r.isContentStreaming = false
          r.isReasoningStreaming = false
          r.contextWindowUsage = null
          r.collectedAssets = []
          r.draftAssistant = {
            reasoning: '',
            content: '',
            toolCalls: [],
            toolResults: {},
            toolCall: null,
            toolArgs: '',
            steps: [],
            activeReasoningStepId: null,
            activeContentStepId: null,
            activeToolStepId: null,
            activeCompressionStepId: null,
          }
        })

        // Also set run state on the main conversation store so that
        // commitAndPersistRunningDrafts (used by beforeunload/pagehide handlers)
        // can correctly detect running conversations and save streaming drafts.
        set((state) => {
          const c = state.conversations.find((c) => c.id === conversationId)
          if (c) {
            c.activeRunId = runId
            c.runEpoch = runEpoch
            c.status = 'pending'
            c.error = null
            c.draftAssistant = {
              reasoning: '',
              content: '',
              toolCalls: [],
              toolResults: {},
              toolCall: null,
              toolArgs: '',
              steps: [],
              activeReasoningStepId: null,
              activeContentStepId: null,
              activeToolStepId: null,
              activeCompressionStepId: null,
            }
          }
        })

        const isCurrentRun = () => {
          const rt = useConversationRuntimeStore.getState().runtimes.get(conversationId)
          return !!rt && rt.activeRunId === runId && (rt.runEpoch || 0) === runEpoch
        }

        const isCurrentRunEpoch = () => {
          const rt = useConversationRuntimeStore.getState().runtimes.get(conversationId)
          return !!rt && (rt.runEpoch || 0) === runEpoch
        }

        const failRunEarly = (message: string) => {
          if (!isCurrentRun()) return
          set((state) => {
            const c = state.conversations.find((c) => c.id === conversationId)
            if (c && c.activeRunId === runId) {
              c.status = 'error'
              c.error = message
              c.activeRunId = null
              c.draftAssistant = null
              c.currentToolCall = null
              c.activeToolCalls = []
              c.streamingToolArgs = ''
              c.streamingToolArgsByCallId = {}
              c.streamingContent = ''
              c.streamingReasoning = ''
            }
          })
          useConversationRuntimeStore.setState((state) => {
            const r = ensureRuntime(state, conversationId)
            if (r.activeRunId !== runId) return
            r.status = 'error'
            r.error = message
            r.activeRunId = null
            r.draftAssistant = null
            r.currentToolCall = null
            r.activeToolCalls = []
            r.streamingToolArgs = ''
            r.streamingToolArgsByCallId = {}
            r.streamingContent = ''
            r.streamingReasoning = ''
          })

          // Persist messages on early failure so that historical messages
          // (including the user message that triggered this run) are not lost
          // if the user refreshes the page.
          const errorConv = get().conversations.find((c) => c.id === conversationId)
          if (errorConv) {
            persistMessageReplace(conversationId, errorConv.messages).catch((err) => {
              console.error('[conversation.store] Failed to persist on failRunEarly:', err)
            })
          }
        }

        // Persist conversation to SQLite when a block completes (debounced).
        // Rapid block boundaries are coalesced; the final complete handler
        // will flush immediately, so at most one debounced write runs mid-stream.
        const persistAfterBlockComplete = () => {
          const current = get().conversations.find((c) => c.id === conversationId)
          if (!current) return
          persistMessageReplace(conversationId, current.messages, false).catch((err) => {
            console.warn('[conversation.store] Block-complete persist failed:', err)
          })
        }

        const lastUserMessage = [...conv.messages].reverse().find((m) => m.role === 'user')

        const apiKeyRepo = getApiKeyRepository()
        const settingsState = useSettingsStore.getState()
        const effectiveConfig = settingsState.getEffectiveProviderConfig()
        const providerConfig =
          isCustomProviderType(providerType)
            ? effectiveConfig
            : {
                apiKeyProviderKey: providerType,
                baseUrl: LLM_PROVIDER_CONFIGS[providerType].baseURL,
                modelName: modelName || LLM_PROVIDER_CONFIGS[providerType].modelName,
              }

        if (!providerConfig?.baseUrl || !providerConfig.modelName) {
          failRunEarly('请先配置自定义服务商和模型')
          return
        }

        // Custom providers may run keyless (e.g. Ollama at localhost:11434/v1):
        // no Authorization header is sent and Ollama ignores Bearer tokens, so
        // a missing key is not a hard error for them.
        const apiKey = await apiKeyRepo.load(providerConfig.apiKeyProviderKey)
        if (!apiKey && !isCustomProviderType(providerType)) {
          failRunEarly('API Key 未设置，请先在设置中配置')
          return
        }

        // Resolve runtime routing context from the current conversation/workspace.
        // Do not depend on global active-project pointer for agent prompt injection.
        let resolvedProjectId: string | null = null
        let activeAgentId: string | null = null
        let knownAgentIds: Set<string> | null = null

        try {
          const { getWorkspaceRepository } =
            await import('@/sqlite/repositories/workspace.repository')
          const workspace = await getWorkspaceRepository().findWorkspaceById(conversationId)
          resolvedProjectId = workspace?.projectId || null
        } catch {
          // Ignore workspace lookup failures; agent prompt injection will be skipped without projectId.
        }

        try {
          const { useAgentsStore } = await import('./agents.store')
          const agentsState = useAgentsStore.getState()
          activeAgentId = agentsState.activeAgentId || null
          knownAgentIds = new Set(agentsState.agents.map((agent) => agent.id.toLowerCase()))
        } catch {
          // Ignore agents-store read failures and fallback to default.
        }

        const provider = createLLMProvider({
          apiKey: apiKey || '',
          providerType,
          baseUrl: providerConfig.baseUrl,
          model: providerConfig.modelName,
          apiMode: isCustomProviderType(providerType)
            ? settingsState.customProviders.find((p) => p.id === providerType)?.apiMode || 'chat-completions'
            : undefined,
        })

        const contextManager = new ContextManager({
          maxContextTokens: provider.maxContextTokens,
          reserveTokens: maxTokens,
          enableSummarization: true,
          maxMessageGroups: provider.maxContextTokens >= 200000 ? 80 : 50,
        })

        const toolRegistry = getToolRegistry()
        const toolPolicyHooks = createToolPolicyHooks()

        const normalizedOverride = agentOverrideId?.trim() || null
        const overrideFromLatestMessage = extractFirstMentionedAgentId(lastUserMessage?.content)
        const resolvedOverride = normalizedOverride || overrideFromLatestMessage

        if (resolvedOverride) {
          const normalizedResolvedOverride = resolvedOverride.toLowerCase()
          if (!knownAgentIds || knownAgentIds.has(normalizedResolvedOverride)) {
            activeAgentId = resolvedOverride
          } else {
            console.warn(
              '[conversation.store] Ignoring unknown @agent override from latest message:',
              resolvedOverride
            )
          }
        }
        if (!activeAgentId) {
          activeAgentId = 'default'
        }

        try {
          const { getWorkspaceManager } = await import('@/opfs')
          const workspace = await (await getWorkspaceManager()).getWorkspace(conversationId)
          if (workspace) {
            for (const change of workspace.getPendingChanges()) {
              pendingPathsAtRunStart.add(change.path)
            }
            runOwnershipReady = true
          }
        } catch (error) {
          // Fail closed: without a reliable baseline, leave all changes in the
          // normal manual-review queue rather than risk applying historic work.
          console.warn('[conversation.store] Unable to establish auto-apply run boundary:', error)
        }

        const configuredMaxIterations = useSettingsStore.getState().maxIterations
        const maxIterations =
          configuredMaxIterations === 0
            ? 0
            : Number.isFinite(configuredMaxIterations)
              ? Math.max(1, Math.min(100, Math.floor(configuredMaxIterations)))
              : 20

        const agentMode = getCurrentWorkspaceAgentMode()

        // Resolve OPFS workspace dir for subagent transcript storage
        let subagentGetWorkspaceDir: (() => Promise<FileSystemDirectoryHandle>) | undefined
        try {
          const { getWorkspaceManager } = await import('@/opfs')
          const wsManager = await getWorkspaceManager()
          const wsRuntime = await wsManager.getWorkspace(conversationId)
          if (wsRuntime) {
            subagentGetWorkspaceDir = async () => wsRuntime.workspaceDir
          }
        } catch {
          // Transcript storage is optional — subagent continues without it
        }

        // `getOrCreateSubagentRuntime` keeps a workspace-scoped singleton.
        // Refresh its base context for this run before any delegated task is
        // started, so child writes contribute to the same ownership set.
        const subagentRuntime = getOrCreateSubagentRuntime({
          workspaceId: conversationId,
          provider,
          toolRegistry,
          contextManager,
          baseToolContext: {
            directoryHandle,
            workspaceId: conversationId,
            projectId: resolvedProjectId,
            currentAgentId: activeAgentId,
            agentMode,
            onWorkspacePathsChanged: (paths) => {
              for (const path of paths) runChangedPaths.add(path)
            },
          },
          getWorkspaceDir: subagentGetWorkspaceDir,
          onNotification: (event: SubagentTaskNotification | SubagentStepNotification) => {
            // ── Route step_notification events to subagent draft state ──
            if (event.event_type === 'step_notification') {
              handleSubagentStepNotification(conversationId, event)
              return
            }

            // ── Handle task_notification (status updates) ──
            const subagentEvent = {
              agentId: event.agentId,
              status: event.status,
              summary: event.summary,
              timestamp: event.timestamp,
            }
            // Update conversations store
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || !c.draftAssistant) return
              const targetStep = findSpawnStepInDraft(c.draftAssistant, event.parentToolCallId)
              if (targetStep) {
                if (!targetStep.subagentEvents) targetStep.subagentEvents = []
                targetStep.subagentEvents.push(subagentEvent)
                c.updatedAt = Date.now()
              }
            })
            // Mirror to runtime store (UI reads draftAssistant from runtime store)
            useConversationRuntimeStore.setState((state) => {
              const r = state.runtimes.get(conversationId)
              if (!r || !r.draftAssistant) return
              const targetStep = findSpawnStepInDraft(r.draftAssistant, event.parentToolCallId)
              if (targetStep) {
                if (!targetStep.subagentEvents) targetStep.subagentEvents = []
                targetStep.subagentEvents.push(subagentEvent)
              }
            })
          },
        })

        const agentLoop = new AgentLoop({
          provider,
          toolRegistry,
          contextManager,
          mode: agentMode,
          sessionId: conversationId,
          toolContext: {
            directoryHandle,
            workspaceId: conversationId,
            projectId: resolvedProjectId,
            currentAgentId: activeAgentId,
            agentMode,
            onWorkspacePathsChanged: (paths) => {
              for (const path of paths) runChangedPaths.add(path)
            },
            subagentRuntime,
            askUserQuestion: async (params) => {
              const { setPendingQuestion, removePendingQuestion } =
                await import('@/store/pending-question.store')
              // Use the actual toolCallId from the LLM's tool_calls response.
              // This correlates the pending question with the UI's ToolCallDisplay.
              const toolCallId =
                params.toolCallId ?? `ask-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
              return new Promise<{ answer: string; confirmed: boolean; timed_out: boolean }>(
                (resolve) => {
                  setPendingQuestion({
                    conversationId,
                    toolCallId,
                    question: params.question,
                    type: params.type,
                    options: params.options,
                    defaultAnswer: params.defaultAnswer,
                    context: params.context,
                    resolve: (result) => {
                      removePendingQuestion(conversationId, toolCallId)
                      resolve(result)
                    },
                  })

                  // Listen for abort signal to unblock the promise on cancellation
                  if (params.signal) {
                    const onAbort = () => {
                      removePendingQuestion(conversationId, toolCallId)
                      resolve({
                        answer: params.defaultAnswer ?? 'cancelled',
                        confirmed: false,
                        timed_out: false,
                      })
                    }
                    if (params.signal.aborted) {
                      onAbort()
                    } else {
                      params.signal.addEventListener('abort', onAbort, { once: true })
                    }
                  }
                }
              )
            },
            onDelegation: (payload) => {
              // Only honour delegation from the current run; ignore stale loops.
              if (!isCurrentRun()) return
              if (delegationDepth >= MAX_DELEGATION_DEPTH) {
                console.warn(
                  '[conversation.store] delegate_to depth limit reached, ignoring handoff',
                  { conversationId, delegationDepth, target: payload.targetAgentId }
                )
                return
              }
              pendingDelegation = payload
            },
          },
          maxIterations,
          initialConvertCallCount: conv.compressionConvertCallCount ?? 0,
          initialLastSummaryConvertCall:
            conv.compressionLastSummaryConvertCall ?? Number.NEGATIVE_INFINITY,
          initialCompressionBaseline:
            conv.compressedContextSummary && conv.compressedContextCutoffTimestamp
              ? { summary: conv.compressedContextSummary, cutoffTimestamp: conv.compressedContextCutoffTimestamp }
              : null,
          onCompressionStateUpdate: (compressionState) => {
            if (!isCurrentRun()) return
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || c.activeRunId !== runId) return
              c.compressionConvertCallCount = compressionState.convertCallCount
              c.compressionLastSummaryConvertCall = compressionState.lastSummaryConvertCall
            })
          },
          beforeToolCall: toolPolicyHooks.beforeToolCall,
          afterToolCall: async (context) => {
            if (context.isError) return undefined
            const changeTools = new Set(['write', 'edit', 'delete'])
            if (!changeTools.has(context.toolName)) return undefined
            const { useConversationContextStore } =
              await import('@/store/conversation-context.store')
            await useConversationContextStore.getState().refreshPendingChanges(true)
            return undefined
          },
          onLoopComplete: async () => {
            // Refresh pending changes after each agent loop completes
            const { useConversationContextStore } =
              await import('@/store/conversation-context.store')
            await useConversationContextStore.getState().refreshPendingChanges()

            // Apply only changes owned by this run, only while it completed
            // normally. Aborts and elicitation do not reach onLoopComplete;
            // iteration-limit stops and delegate_to handoffs are explicitly
            // excluded as incomplete/intermediate runs.
            try {
              const runtime = useConversationRuntimeStore.getState()
              const iterationLimitReached = runtime.runtimes.get(conversationId)?.iterationLimitReached
              const wasCancelled = runtime.cancelledRunIds.has(runId)
              const { useWorkspacePreferencesStore } = await import('./workspace-preferences.store')
              const preferences = useWorkspacePreferencesStore.getState()
              // Read the policy for this run's workspace directly so a user
              // navigating to another workspace while it runs cannot alter
              // its completion behavior.
              const autoApplyEnabled =
                preferences.autoApplyOnRunCompleteByWorkspace[conversationId] ?? false
              // Only auto-apply paths first made pending by this run. A path that
              // was already pending can contain unreviewed work from an earlier
              // run, even if this run updates the same overlay file.
              const eligiblePaths = [...runChangedPaths].filter(
                (path) => !pendingPathsAtRunStart.has(path),
              )

              if (
                isCurrentRun() &&
                runOwnershipReady &&
                !wasCancelled &&
                iterationLimitReached === null &&
                !pendingDelegation &&
                autoApplyEnabled &&
                eligiblePaths.length > 0
              ) {
                const [{ getWorkspaceManager }, { autoApplyCompletedRunChanges }] = await Promise.all([
                  import('@/opfs'),
                  import('@/agent/auto-apply-run-changes'),
                ])
                const workspace = await (await getWorkspaceManager()).getWorkspace(conversationId)
                if (workspace) {
                  const applyResult = await autoApplyCompletedRunChanges(
                    workspace,
                    eligiblePaths,
                    () => useConversationContextStore.getState().refreshPendingChanges(true),
                    runId,
                  )
                  // Remember the snapshot so a "what this run changed" card can be
                  // appended to this run's message history after finalize commits.
                  if (applyResult.status === 'synced') {
                    runApplyResult = { snapshotId: applyResult.snapshotId }
                  } else if (applyResult.status === 'partial' && applyResult.snapshotId) {
                    runApplyResult = { snapshotId: applyResult.snapshotId }
                  }
                }
              }
            } catch (error) {
              // Auto-apply is best effort and must never convert an otherwise
              // successful run into an agent failure. Pending changes remain
              // available through the existing manual review queue.
              console.warn('[conversation.store] Auto-apply after completed run failed:', error)
            }

            // === Exec auto-flush snapshots (REMOVED in PR-3) ===
            // The exec tool no longer flushes pending changes to disk before
            // running commands (that was an authorization bypass). Disk sync
            // now happens exclusively through sync-to-disk (authorized) or
            // the run-level auto-apply below. Nothing to drain here anymore.

            // === Favicon handling ===
            // Always reset to idle when the loop ends — the user will see
            // the result either in-page (if viewing) or via the system
            // notification (if not). No lingering "pending" dot.
            try {
              const { setFaviconState } = await import('@/services/favicon-indicator')
              setFaviconState('idle')
            } catch {
              // non-fatal
            }

            // === Notification handling ===
            // Only notify when the user is NOT actively looking at this conversation.
            try {
              const hash = window.location.hash
              const match = hash.match(/\/workspaces?\/([^/?]+)/)
              const activeWorkspaceId = match ? decodeURIComponent(match[1]) : null
              const isVisible = document.visibilityState === 'visible'
              const isViewingConversation = activeWorkspaceId === conversationId && isVisible

              // User is viewing this conversation — don't notify.
              if (isViewingConversation) return

              const { notifyAgentComplete } = await import('@/services/agent-notification')
              const currentConv = get().conversations.find((c) => c.id === conversationId)
              if (!currentConv) return
              // Project ID sources, in priority order:
              //   1. resolvedProjectId (from workspace repo lookup at run start)
              //   2. activeProjectId from project store (sync, always present)
              // resolvedProjectId can be null if the workspace lookup at run
              // start raced or failed — fall back to the active project.
              let notifProjectId = resolvedProjectId
              if (!notifProjectId) {
                try {
                  const { useProjectStore } = await import('@/store/project.store')
                  notifProjectId = useProjectStore.getState().activeProjectId || null
                } catch {
                  // ignore
                }
              }
              if (!notifProjectId) return

              // Build a short summary from the last assistant message
              const lastAssistant = [...currentConv.messages]
                .reverse()
                .find((m) => m.role === 'assistant' && (m.content || '').trim().length > 0)
              const summary = lastAssistant
                ? summarizeForNotification(lastAssistant.content ?? '')
                : '已完成'

              await notifyAgentComplete({
                conversationId,
                projectId: notifProjectId,
                title: currentConv.title ?? 'EO2Weave Agent',
                body: summary,
              })
            } catch (err) {
              console.warn('[conversation.store] notify failed:', err)
            }
          },
          // Soft-interrupt at tool boundaries: after each tool call completes,
          // check whether a user message was queued. If so, yield the loop so
          // the runAgent flow can dequeue and start a fresh turn — matching
          // Codex/Claude Code's "interrupt at tool boundary" feel instead of
          // waiting for the entire agent run to finish.
          shouldYieldForQueue: () =>
            useConversationRuntimeStore.getState().getQueueDepth(conversationId) > 0,
        })

        setAgentLoop(conversationId, agentLoop)

        const currentMessages = conv.messages

        const finalizeRun = async (
          status: ConversationStatus,
          finalMessages?: Message[],
          error?: string
        ) => {
          // If already committed, nothing to do
          if (committed) return
          // Unregister the live loop up front; the rest of finalize only
          // touches persisted state.
          deleteAgentLoop(conversationId)

          // Only the current run is allowed to commit message state.
          // Stale callbacks from prior runs (e.g. after project/workspace switch
          // or elicitation-triggered nested run) must never overwrite UI history.
          const current = get().conversations.find((c) => c.id === conversationId)
          const isRunCurrent =
            !!current && current.activeRunId === runId && (current.runEpoch || 0) === runEpoch
          const isSameEpoch = !!current && (current.runEpoch || 0) === runEpoch
          if (!isRunCurrent && !isSameEpoch) {
            console.info('[conversation.store] skip finalize from stale run', {
              conversationId,
              runId,
              status,
            })
            return
          }

          committed = true
          const currentSnapshot = get().conversations.find((c) => c.id === conversationId)?.messages || []
          const targetMessages = reconcileMessageSnapshot(currentSnapshot, finalMessages || latestMessages)
          const derivedUsageAtFinalize = deriveContextUsageFromAssistantUsage(
            targetMessages,
            provider.maxContextTokens,
            maxTokens
          )
          const usageAtFinalize = derivedUsageAtFinalize

          // Collect any assets accumulated during this agent run before overwriting messages
          const currentConv = get().conversations.find((c) => c.id === conversationId)
          const collectedAssets = currentConv?.collectedAssets?.length
            ? [...currentConv.collectedAssets]
            : undefined

          // targetMessages may come from an Immer-frozen source.
          // Build a fresh array/object snapshot before putting it back into state.
          const finalizedMessages =
            status === 'idle' && collectedAssets && collectedAssets.length > 0
              ? (() => {
                  const cloned = targetMessages.slice()
                  for (let i = cloned.length - 1; i >= 0; i--) {
                    // Skip run_changes cards — they carry no generated assets.
                    if (cloned[i].role === 'assistant' && cloned[i].kind !== 'run_changes') {
                      cloned[i] = {
                        ...cloned[i],
                        assets: collectedAssets,
                      }
                      break
                    }
                  }
                  return cloned
                })()
              : targetMessages

          set((inner) => {
            const c = inner.conversations.find((x) => x.id === conversationId)
            if (!c) return
            if (status === 'idle') {
              c.messages = finalizedMessages
              if (usageAtFinalize) {
                c.contextWindowUsage = usageAtFinalize
                c.lastContextWindowUsage = usageAtFinalize
              }
              c.collectedAssets = []
            }
            c.status = status
            c.error = error || null
            c.currentToolCall = null
            c.activeToolCalls = []
            c.streamingToolArgs = ''
            c.streamingToolArgsByCallId = {}
            c.streamingContent = ''
            c.streamingReasoning = ''
            c.completedContent = null
            c.completedReasoning = null
            c.isContentStreaming = false
            c.isReasoningStreaming = false
            c.draftAssistant = null
            c.activeRunId = null
            if (status === 'idle') {
              inner.cancelledRunIds.delete(runId)
            }
          })
          deleteStreamingQueues(conversationId)

          // Reset runtime store for this conversation
          useConversationRuntimeStore.setState((state) => {
            const r = state.runtimes.get(conversationId)
            if (r) {
              r.status = status
              r.error = error || null
              r.currentToolCall = null
              r.activeToolCalls = []
              r.streamingToolArgs = ''
              r.streamingToolArgsByCallId = {}
              r.streamingContent = ''
              r.streamingReasoning = ''
              r.completedContent = null
              r.completedReasoning = null
              r.isContentStreaming = false
              r.isReasoningStreaming = false
              r.draftAssistant = null
              r.activeRunId = null
              if (status === 'idle') {
                r.collectedAssets = []
                if (usageAtFinalize) {
                  r.contextWindowUsage = usageAtFinalize
                }
                // Keep r.contextWindowUsage so the ContextUsageBar remains visible
                // after the agent loop finishes. It will be cleared when a new
                // run starts (runAgent).
              }
            }
          })

          if (status === 'idle') {
            emitComplete()
            const finalConv = get().conversations.find((c) => c.id === conversationId)
            if (finalConv)
              persistMessageReplace(conversationId, finalConv.messages).catch((err) => {
                console.error(
                  '[conversation.store] Failed to persist conversation on complete:',
                  err
                )
                toast.error('对话保存失败，部分内容可能丢失')
              })
            if (finalConv) {
              persistConversationMeta(finalConv).catch((err) => {
                console.warn(
                  '[conversation.store] Failed to persist context usage meta on complete:',
                  err
                )
              })
            }

            try {
              const { useConversationContextStore } =
                await import('@/store/conversation-context.store')
              await useConversationContextStore.getState().refreshPendingChanges(true)
            } catch (err) {
              console.warn(
                '[conversation.store] Failed to refresh pending changes on complete:',
                err
              )
            }

            // Refresh asset inventory so the AssetsPopover badge stays up-to-date
            try {
              const { useAssetInventoryStore } = await import('@/store/asset-inventory.store')
              useAssetInventoryStore.getState().refresh().catch(() => {})
            } catch {
              // Non-critical — asset inventory refresh failure should not affect the loop
            }

            // Only generate follow-up on successful (non-cancelled, non-error) completion
            const runWasCancelled = get().cancelledRunIds.has(runId)
            if (!runWasCancelled) {
              try {
                const apiKey = await apiKeyRepo.load(providerConfig.apiKeyProviderKey)
                if (apiKey) {
                  const suggestion = await generateFollowUp(targetMessages, providerType, apiKey)
                  if (suggestion) {
                    get().setSuggestedFollowUp(conversationId, suggestion)
                  }
                }
              } catch (err) {
                if (process.env.NODE_ENV !== 'production') console.error('[conversation.store] Failed to generate follow-up:', err)
              }

              // Auto-generate a topic title using the current model.
              // Only fires within the first 2 user turns and only overwrites
              // titles that are still in 'auto' mode (not user-edited).
              try {
                const titleConv = get().conversations.find((c) => c.id === conversationId)
                const userTurnCount = titleConv?.messages.filter(
                  (m) => m.role === 'user' && (m.content || '').trim().length > 0
                ).length ?? 0
                if (titleConv && titleConv.titleMode !== 'manual' && userTurnCount <= 2) {
                  get().generateTitle(conversationId, false)
                }
              } catch (err) {
                if (process.env.NODE_ENV !== 'production') console.error('[conversation.store] Failed to auto-generate title:', err)
              }
            }
            // Clean up cancelled run ID tracking (moved inside set() above)
          }
        }

        // Reasoning streaming queue
        let fullReasoningAccumulator = ''
        const reasoningQueue = new StreamingQueue((_key: string, accumulated: string) => {
          fullReasoningAccumulator += accumulated
          // Write to runtime store only — avoids touching conversations[] at 60fps
          useConversationRuntimeStore.setState((state) => {
            const r = ensureRuntime(state, conversationId)
            if (r.activeRunId === runId) {
              r.streamingReasoning = fullReasoningAccumulator
              applyDraftAssistantEvent(r, {
                type: 'reasoning_stream_sync',
                reasoning: fullReasoningAccumulator,
              })
            }
          })
        })

        // Content streaming queue
        // Note: The accumulated value from queue is per-frame, but we maintain
        // the full accumulated content in store.state.streamingContent separately
        let fullContentAccumulator = ''
        const contentQueue = new StreamingQueue((_key: string, accumulated: string) => {
          fullContentAccumulator += accumulated
          // Write to runtime store only — avoids touching conversations[] at 60fps
          useConversationRuntimeStore.setState((state) => {
            const r = ensureRuntime(state, conversationId)
            if (r.activeRunId === runId) {
              r.streamingContent = fullContentAccumulator
              applyDraftAssistantEvent(r, {
                type: 'content_stream_sync',
                content: fullContentAccumulator,
              })
            }
          })
        })

        setStreamingQueues(conversationId, {
          reasoning: reasoningQueue,
          content: contentQueue,
        })

        const cleanupQueues = () => {
          reasoningQueue.destroy()
          contentQueue.destroy()
          deleteStreamingQueues(conversationId)
        }

        // Clear iteration limit flag from any previous run
        useConversationRuntimeStore.setState((state) => {
          const r = state.runtimes.get(conversationId)
          if (r) {
            r.iterationLimitReached = null
          }
        })

        const resultMessages = await agentLoop.run(currentMessages, {
          onMessageStart: () => {
            if (!isCurrentRun()) return
            // Reset accumulators for new message
            fullContentAccumulator = ''
            fullReasoningAccumulator = ''
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.streamingContent = ''
                c.streamingReasoning = ''
                c.isReasoningStreaming = false
                c.completedReasoning = ''
                c.isContentStreaming = false
                c.completedContent = ''
                applyDraftAssistantEvent(c, { type: 'message_start' })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.streamingContent = ''
                r.streamingReasoning = ''
                r.isReasoningStreaming = false
                r.completedReasoning = ''
                r.isContentStreaming = false
                r.completedContent = ''
                applyDraftAssistantEvent(r, { type: 'message_start' })
              }
            })
          },
          onReasoningStart: () => {
            if (!isCurrentRun()) return
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.status = 'streaming'
                c.isReasoningStreaming = true
                applyDraftAssistantEvent(c, { type: 'reasoning_start' })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.status = 'streaming'
                r.isReasoningStreaming = true
                applyDraftAssistantEvent(r, { type: 'reasoning_start' })
              }
            })
            emitThinkingStart()
          },
          onReasoningDelta: (delta: string) => {
            if (!isCurrentRun()) return
            reasoningQueue.add('reasoning', delta)
            emitThinkingDelta(delta)
          },
          onReasoningComplete: (reasoning: string) => {
            if (!isCurrentRun()) return
            reasoningQueue.flushNow()
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.isReasoningStreaming = false
                c.completedReasoning = reasoning
                c.streamingReasoning = ''
                applyDraftAssistantEvent(c, {
                  type: 'reasoning_complete',
                  reasoning,
                })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.isReasoningStreaming = false
                r.completedReasoning = reasoning
                r.streamingReasoning = ''
                applyDraftAssistantEvent(r, {
                  type: 'reasoning_complete',
                  reasoning,
                })
              }
            })
          },
          onContentStart: () => {
            if (!isCurrentRun()) return
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.status = 'streaming'
                c.isContentStreaming = true
                applyDraftAssistantEvent(c, { type: 'content_start' })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.status = 'streaming'
                r.isContentStreaming = true
                applyDraftAssistantEvent(r, { type: 'content_start' })
              }
            })
          },
          onContentDelta: (delta: string) => {
            if (!isCurrentRun()) return
            contentQueue.add('content', delta)
          },
          onContentComplete: (content: string) => {
            if (!isCurrentRun()) return
            contentQueue.flushNow()
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.isContentStreaming = false
                c.completedContent = content
                c.streamingContent = ''
                applyDraftAssistantEvent(c, {
                  type: 'content_complete',
                  content,
                })
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.isContentStreaming = false
                r.completedContent = content
                r.streamingContent = ''
                applyDraftAssistantEvent(r, {
                  type: 'content_complete',
                  content,
                })
              }
            })
          },
          onToolCallStart: (tc: ToolCall) => {
            if (!isCurrentRun()) return
            const existingConversation = get().conversations.find((c) => c.id === conversationId)
            const shouldEmitToolStart =
              existingConversation?.activeRunId === runId
                ? existingConversation.currentToolCall?.id !== tc.id
                : true
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.status = 'tool_calling'
                const isSameTool = c.currentToolCall?.id === tc.id
                c.currentToolCall = tc
                c.activeToolCalls = c.activeToolCalls || []
                if (!c.activeToolCalls.some((x) => x.id === tc.id)) {
                  c.activeToolCalls.push(tc)
                }
                c.streamingToolArgsByCallId = c.streamingToolArgsByCallId || {}
                if (!c.streamingToolArgsByCallId[tc.id]) {
                  c.streamingToolArgsByCallId[tc.id] = ''
                }
                applyDraftAssistantEvent(c, {
                  type: 'tool_start',
                  toolCall: tc,
                })
                // Keep already streamed args when the same tool transitions
                // from "stream preview" to actual execution.
                if (!isSameTool) {
                  c.streamingToolArgs = ''
                  if (c.draftAssistant) {
                    c.draftAssistant.toolArgs = ''
                  }
                }
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                r.status = 'tool_calling'
                const isSameTool = r.currentToolCall?.id === tc.id
                r.currentToolCall = tc
                r.activeToolCalls = r.activeToolCalls || []
                if (!r.activeToolCalls.some((x) => x.id === tc.id)) {
                  r.activeToolCalls.push(tc)
                }
                r.streamingToolArgsByCallId = r.streamingToolArgsByCallId || {}
                if (!r.streamingToolArgsByCallId[tc.id]) {
                  r.streamingToolArgsByCallId[tc.id] = ''
                }
                applyDraftAssistantEvent(r, {
                  type: 'tool_start',
                  toolCall: tc,
                })
                if (!isSameTool) {
                  r.streamingToolArgs = ''
                  if (r.draftAssistant) {
                    r.draftAssistant.toolArgs = ''
                  }
                }
              }
            })
            if (shouldEmitToolStart) {
              emitToolStart({
                name: tc.function.name,
                args: tc.function.arguments,
                id: tc.id,
              })
            }
          },
          onToolCallDelta: (_index: number, argsDelta: string, toolCallId?: string) => {
            if (!isCurrentRun()) return
            // Write to runtime store only — avoids touching conversations[] at 60fps
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId && r.draftAssistant) {
                const isCurrentToolDelta = !toolCallId || r.currentToolCall?.id === toolCallId
                if (isCurrentToolDelta) {
                  r.streamingToolArgs += argsDelta
                }
                if (toolCallId) {
                  r.streamingToolArgsByCallId = r.streamingToolArgsByCallId || {}
                  r.streamingToolArgsByCallId[toolCallId] =
                    (r.streamingToolArgsByCallId[toolCallId] || '') + argsDelta
                }
                applyDraftAssistantEvent(r, {
                  type: 'tool_delta',
                  argsDelta,
                  toolCallId,
                  isCurrentToolDelta: !!isCurrentToolDelta,
                })
              }
            })
          },
          onToolCallComplete: (tc: ToolCall, _result: string) => {
            if (!isCurrentRun()) return
            set((state) => {
              const c = state.conversations.find((c) => c.id === conversationId)
              if (c && c.activeRunId === runId) {
                const isCurrentTool = c.currentToolCall?.id === tc.id

                if (isCurrentTool) {
                  c.currentToolCall = null
                  c.streamingToolArgs = ''
                }
                c.activeToolCalls = (c.activeToolCalls || []).filter((x) => x.id !== tc.id)

                // Check if there are more tools to execute
                const hasMoreTools = (c.activeToolCalls || []).length > 0
                if (hasMoreTools) {
                  // Continue with next tool
                  c.currentToolCall = c.activeToolCalls[c.activeToolCalls.length - 1]
                  c.streamingToolArgs =
                    (c.streamingToolArgsByCallId || {})[c.currentToolCall.id] || ''
                  // Keep status as 'tool_calling' since we're still executing tools
                  c.status = 'tool_calling'
                } else {
                  // All tools completed, waiting for next model response
                  // Set status to 'pending' to show loading effect
                  c.status = 'pending'
                }

                c.streamingToolArgsByCallId = c.streamingToolArgsByCallId || {}

                applyDraftAssistantEvent(c, {
                  type: 'tool_complete',
                  toolCall: tc,
                  result: _result,
                  isCurrentTool,
                  nextToolCall: c.currentToolCall,
                  streamedArgsByCallId: c.streamingToolArgsByCallId,
                })

                delete c.streamingToolArgsByCallId[tc.id]
              }
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                const isCurrentTool = r.currentToolCall?.id === tc.id
                if (isCurrentTool) {
                  r.currentToolCall = null
                  r.streamingToolArgs = ''
                }
                r.activeToolCalls = (r.activeToolCalls || []).filter((x) => x.id !== tc.id)
                const hasMoreTools = (r.activeToolCalls || []).length > 0
                if (hasMoreTools) {
                  r.currentToolCall = r.activeToolCalls[r.activeToolCalls.length - 1]
                  r.streamingToolArgs =
                    (r.streamingToolArgsByCallId || {})[r.currentToolCall.id] || ''
                  r.status = 'tool_calling'
                } else {
                  r.status = 'pending'
                }
                r.streamingToolArgsByCallId = r.streamingToolArgsByCallId || {}
                applyDraftAssistantEvent(r, {
                  type: 'tool_complete',
                  toolCall: tc,
                  result: _result,
                  isCurrentTool,
                  nextToolCall: r.currentToolCall,
                  streamedArgsByCallId: r.streamingToolArgsByCallId,
                })
                delete r.streamingToolArgsByCallId[tc.id]
              }
            })

            // ── Auto-refresh agents list when write/delete tools touch agents/ directory ──
            // Detects paths like vfs://agents/{id}/... and refreshes useAgentsStore so the
            // @-mention dropdown picks up newly created agents without a page reload.
            try {
              const toolName = tc.function.name
              if (toolName === 'write' || toolName === 'delete') {
                const args = JSON.parse(tc.function.arguments)
                const paths: string[] = args.path
                  ? [args.path]
                  : Array.isArray(args.files)
                    ? args.files.map((f: { path: string }) => f.path)
                    : Array.isArray(args.paths)
                      ? args.paths
                      : []
                const touchesAgents = paths.some((p: string) => {
                  const norm = p.replace(/^vfs:\/\/workspace\//, '')
                  return norm.startsWith('agents/') || p.startsWith('vfs://agents/')
                })
                if (touchesAgents) {
                  import('./agents.store').then(({ useAgentsStore }) => {
                    useAgentsStore.getState().refreshAgents()
                  })
                }
              }
            } catch {
              // Best-effort: never let agent-refresh failure break tool completion
            }
          },
          onContextCompressionStart: (payload) => {
            if (!isCurrentRun()) return
            emitCompressionEvent({
              phase: 'start',
              droppedGroups: payload.droppedGroups,
              droppedContentChars: payload.droppedContentChars,
            })
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || c.activeRunId !== runId) return
              if (c.status !== 'streaming' && c.status !== 'tool_calling') {
                c.status = 'pending'
              }
              applyDraftAssistantEvent(c, { type: 'compression_start' })
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                if (r.status !== 'streaming' && r.status !== 'tool_calling') {
                  r.status = 'pending'
                }
                applyDraftAssistantEvent(r, { type: 'compression_start' })
              }
            })
          },
          onContextCompressionComplete: (payload) => {
            if (!isCurrentRun()) return
            emitCompressionEvent({
              phase: 'complete',
              mode: payload.mode,
              droppedGroups: payload.droppedGroups,
              droppedContentChars: payload.droppedContentChars,
              summaryChars: payload.summaryChars,
              latencyMs: payload.latencyMs,
            })
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || c.activeRunId !== runId) return
              applyDraftAssistantEvent(c, {
                type: 'compression_complete',
                mode: payload.mode === 'skip' ? 'skip' : 'compress',
              })
            })
            // Sync to runtime store
            useConversationRuntimeStore.setState((state) => {
              const r = ensureRuntime(state, conversationId)
              if (r.activeRunId === runId) {
                applyDraftAssistantEvent(r, {
                  type: 'compression_complete',
                  mode: payload.mode === 'skip' ? 'skip' : 'compress',
                })
              }
            })
            // Summary message is now injected by AgentLoop directly into
            // allMessages via onMessagesUpdated, so no need to collect it here.
          },
          // SEP-1306: Handle binary elicitation for file uploads
          onElicitation: async (elicitation: any) => {
            if (!isCurrentRun()) return
            console.log('[conversation.store] SEP-1306 elicitation:', elicitation)

            try {
              // Get the server config for auth token
              const mcpManager = (await import('@/mcp/mcp-manager')).getMCPManager()
              await mcpManager.initialize()
              const server = mcpManager.getServer(elicitation.serverId)

              if (!server) {
                throw new Error(`MCP server not found: ${elicitation.serverId}`)
              }

              const authToken = server?.token

              // Show file picker and upload via ElicitationHandler
              // The elicitation object contains full BinaryElicitation data from the server
              const handler = getElicitationHandler()
              const metadata = await handler.handleBinaryElicitation(
                {
                  mode: elicitation.mode,
                  message: elicitation.message,
                  requestedSchema: elicitation.requestedSchema || {
                    type: 'object',
                    properties: {},
                  },
                  uploadEndpoints: elicitation.uploadEndpoints || {},
                },
                {
                  // Pass tool args for OPFS file lookup (priority)
                  toolArgs: elicitation.args,
                  // Pass directory handle for OPFS access
                  directoryHandle,
                },
                authToken
              )

              // Add tool result message with the file metadata
              // This completes the pending tool call with the upload result
              // IMPORTANT: Tell the LLM to retry with the new download_url using natural language
              const { createToolMessage } = await import('@/agent/message-types')

              // Get the file field name from uploadEndpoints (dynamic, not hardcoded)
              const uploadEndpoints = elicitation.uploadEndpoints || {}
              const fileFieldName = Object.keys(uploadEndpoints)[0] || 'file'

              // Extract original args excluding the file field (we'll replace it)
              const originalArgs = { ...(elicitation.args || {}) }
              delete originalArgs[fileFieldName]

              // Build natural language instruction for LLM to retry
              let retryInstruction = `文件已上传成功。请重新调用 ${elicitation.toolName} 工具，使用以下参数：\n\n`
              retryInstruction += `{\n`
              retryInstruction += `  "${fileFieldName}": {\n`
              retryInstruction += `    "download_url": "${metadata.download_url}",\n`
              retryInstruction += `    "file_id": "${metadata.file_id}"\n`
              retryInstruction += `  }`

              // Add other original args (like question)
              for (const [key, value] of Object.entries(originalArgs)) {
                retryInstruction += `,\n  "${key}": ${JSON.stringify(value)}`
              }
              retryInstruction += `\n}`

              const toolResultMsg = createToolMessage({
                toolCallId: elicitation.toolCallId || 'unknown',
                name: elicitation.toolName,
                content: retryInstruction,
              })

              get().addMessage(conversationId, toolResultMsg)

              // Resume agent loop with the tool result
              // First, manually clean up the previous agentLoop state
              deleteAgentLoop(conversationId)
              set((state) => {
                const c = state.conversations.find((c) => c.id === conversationId)
                if (c) {
                  c.status = 'idle'
                  c.error = null
                  c.activeRunId = null
                  c.draftAssistant = null
                }
              })

              // Now start a new agent loop with the updated messages
              await get().runAgent(
                conversationId,
                providerType,
                modelName,
                maxTokens,
                directoryHandle,
                activeAgentId
              )
            } catch (error) {
              console.error('[conversation.store] Elicitation failed:', error)
              const errorMsg = error instanceof Error ? error.message : String(error)

              // Add tool result with error
              const { createToolMessage } = await import('@/agent/message-types')
              const errorResultMsg = createToolMessage({
                toolCallId: elicitation.toolCallId || 'unknown',
                name: elicitation.toolName,
                content: JSON.stringify({
                  error: `文件上传失败: ${errorMsg}`,
                }),
              })
              get().addMessage(conversationId, errorResultMsg)

              deleteAgentLoop(conversationId)
              set((state) => {
                const c = state.conversations.find((c) => c.id === conversationId)
                if (c) {
                  c.status = 'error'
                  c.error = errorMsg
                }
              })
              emitError(errorMsg)
            }
          },
          onMessagesUpdated: (msgs: Message[]) => {
            if (!isCurrentRun() && !isCurrentRunEpoch()) return
            const previous = get().conversations.find((x) => x.id === conversationId)?.messages || []
            const currentDraft = useConversationRuntimeStore.getState().runtimes.get(conversationId)?.draftAssistant
            const messagesWithReasoningDurations = attachReasoningDurations(msgs, currentDraft)
            const reconciled = reconcileMessageSnapshot(previous, messagesWithReasoningDurations)
            latestMessages = reconciled
            set((state) => {
              const c = state.conversations.find((x) => x.id === conversationId)
              if (!c || (c.runEpoch || 0) !== runEpoch) return
              c.messages = reconciled
              c.compressedContextSummary =
                reconciled.find((msg) => msg.kind === 'context_summary')?.content || c.compressedContextSummary || null
              c.compressedContextCutoffTimestamp =
                reconciled.find((msg) => msg.kind === 'context_summary')?.timestamp ||
                c.compressedContextCutoffTimestamp ||
                null
              c.updatedAt = Date.now()
              // Evict draft entries already committed to messages.
              // This prevents commitDraftToMessages (cancel path) from duplicating them.
              if (c.draftAssistant) {
                // Clean up tool calls/results already in committed messages
                const committedToolCallIds = new Set(
                  reconciled
                    .filter((m) => m.role === 'assistant' && m.toolCalls)
                    .flatMap((m) => m.toolCalls!.map((tc) => tc.id))
                )
                if (committedToolCallIds.size > 0) {
                  c.draftAssistant.toolCalls = c.draftAssistant.toolCalls.filter(
                    (tc) => !committedToolCallIds.has(tc.id)
                  )
                  for (const id of committedToolCallIds) {
                    delete c.draftAssistant.toolResults[id]
                  }
                }
                // Clean up reasoning/content already in committed messages.
                // The last committed assistant message carries the full text and
                // reasoning from this iteration — subsequent commits must not replay them.
                const lastAssistant = [...reconciled].reverse().find((m) => m.role === 'assistant')
                if (lastAssistant) {
                  if (lastAssistant.reasoning) {
                    c.draftAssistant.reasoning = ''
                  }
                  if (lastAssistant.content) {
                    c.draftAssistant.content = ''
                  }
                }
                // Remove completed steps whose content is now in committed messages
                c.draftAssistant.steps = c.draftAssistant.steps.filter((s) => {
                  if (s.streaming) return true
                  if (s.type === 'tool_call' && committedToolCallIds.has(s.toolCall.id)) return false
                  if ((s.type === 'reasoning' || s.type === 'content') && lastAssistant) return false
                  return true
                })
              }
            })
            const latestAssistant = [...reconciled]
              .reverse()
              .find((m) => m.role === 'assistant' && m.usage)
            if (latestAssistant?.usage) {
              const modelMaxTokens = provider.maxContextTokens
              const reserveTokens = maxTokens
              const maxInputTokens = Math.max(1, modelMaxTokens - reserveTokens)
              const usedTokens =
                latestAssistant.usage.totalTokens ??
                latestAssistant.usage.promptTokens + latestAssistant.usage.completionTokens
              const usagePercent = Math.max(0, Math.min(100, (usedTokens / modelMaxTokens) * 100))
              const usage: ContextWindowUsage = {
                usedTokens,
                maxTokens: maxInputTokens,
                reserveTokens,
                usagePercent,
                modelMaxTokens,
              }
              set((state) => {
                const c = state.conversations.find((x) => x.id === conversationId)
                if (!c || (c.runEpoch || 0) !== runEpoch) return
                c.contextWindowUsage = usage
                c.lastContextWindowUsage = usage
              })
              useConversationRuntimeStore.setState((state) => {
                const r = ensureRuntime(state, conversationId)
                if ((r.runEpoch || 0) === runEpoch) {
                  r.contextWindowUsage = usage
                }
              })
            }
            // Persist immediately — this callback fires at block boundaries
            // (message_end), so it's the right time to save.
            persistAfterBlockComplete()
            // Sync draft eviction to runtime store
            const committedIds = new Set(
              reconciled
                .filter((m) => m.role === 'assistant' && m.toolCalls)
                .flatMap((m) => m.toolCalls!.map((tc) => tc.id))
            )
            const lastAssistantMsg = [...reconciled].reverse().find((m) => m.role === 'assistant')
            if (committedIds.size > 0 || lastAssistantMsg) {
              useConversationRuntimeStore.setState((state) => {
                const r = state.runtimes.get(conversationId)
                if (r?.draftAssistant && (r.runEpoch || 0) === runEpoch) {
                  if (committedIds.size > 0) {
                    r.draftAssistant.toolCalls = r.draftAssistant.toolCalls.filter(
                      (tc) => !committedIds.has(tc.id)
                    )
                    for (const id of committedIds) {
                      delete r.draftAssistant.toolResults[id]
                    }
                  }
                  if (lastAssistantMsg) {
                    if (lastAssistantMsg.reasoning) {
                      r.draftAssistant.reasoning = ''
                    }
                    if (lastAssistantMsg.content) {
                      r.draftAssistant.content = ''
                    }
                  }
                  r.draftAssistant.steps = r.draftAssistant.steps.filter((s) => {
                    if (s.streaming) return true
                    if (s.type === 'tool_call' && committedIds.has(s.toolCall.id)) return false
                    if ((s.type === 'reasoning' || s.type === 'content') && lastAssistantMsg) return false
                    return true
                  })
                }
              })
            }
          },
          onComplete: async (msgs: Message[]) => {
            if (!isCurrentRun() && !isCurrentRunEpoch()) return
            const previous = get().conversations.find((x) => x.id === conversationId)?.messages || []
            const currentDraft = useConversationRuntimeStore.getState().runtimes.get(conversationId)?.draftAssistant
            const messagesWithReasoningDurations = attachReasoningDurations(msgs, currentDraft)
            const reconciled = reconcileMessageSnapshot(previous, messagesWithReasoningDurations)
            console.info('[#LoopStop] store_onComplete', {
              conversationId,
              runId,
              messagesCount: reconciled.length,
            })
            latestMessages = reconciled
            // Attach the auto-apply snapshot card to this run's message history so
            // the user sees "what this run changed". onComplete runs right after
            // onLoopComplete (where auto-apply set runApplyResult), and is the
            // first/effective finalize point — the later finalizeRun call after
            // agentLoop.run resolves is short-circuited by the `committed` guard.
            if (runApplyResult) {
              latestMessages = [...latestMessages, createRunChangesMessage(runApplyResult.snapshotId)]
            }
            reasoningQueue.flushNow()
            contentQueue.flushNow()
            cleanupQueues()
            await finalizeRun('idle', latestMessages)
          },
          onError: (err: Error) => {
            if (!isCurrentRun()) return
            console.error('[#LoopStop] store_onError', {
              conversationId,
              runId,
              error: err.message,
            })
            reasoningQueue.flushNow()
            contentQueue.flushNow()
            cleanupQueues()
            deleteAgentLoop(conversationId)
            deleteStreamingQueues(conversationId)
            set((inner) => {
              const c = inner.conversations.find((x) => x.id === conversationId)
              if (c && c.activeRunId === runId) {
                c.status = 'error'
                c.error = err.message
                c.activeRunId = null
                c.draftAssistant = null
              }
            })
            // Reset runtime store on error
            useConversationRuntimeStore.setState((state) => {
              const r = state.runtimes.get(conversationId)
              if (r) {
                r.status = 'error'
                r.error = err.message
                r.activeRunId = null
                r.draftAssistant = null
              }
            })
            // Persist messages on error so that historical messages are not lost
            // on page refresh. Without this, only the in-memory store retains
            // messages after an LLM error.
            const errorConv = get().conversations.find((x) => x.id === conversationId)
            if (errorConv) {
              persistMessageReplace(conversationId, errorConv.messages).catch((persistErr) => {
                console.error('[conversation.store] Failed to persist on onError:', persistErr)
              })
            }
            emitError(err.message)
          },
          onIterationLimitReached: (limit: number) => {
            if (!isCurrentRun()) return
            console.info('[#LoopStop] iteration_limit_reached', {
              conversationId,
              runId,
              limit,
            })
            useConversationRuntimeStore.setState((state) => {
              const r = state.runtimes.get(conversationId)
              if (r) {
                r.iterationLimitReached = limit
              }
            })
          },
        })
        const previousMessages = get().conversations.find((x) => x.id === conversationId)?.messages || []
        latestMessages = reconcileMessageSnapshot(previousMessages, resultMessages)
        await finalizeRun('idle', latestMessages)

        // ─── delegate_to handoff ───────────────────────────────────────────
        // If delegate_to was called during this run, restart the loop with the
        // target agent persona. finalizeRun above already cleaned up the
        // current run's state (status='idle', activeRunId=null, loop deleted),
        // so we can safely start a fresh run.
        //
        // We inject ONE synthetic user-role "delegation note" message before
        // restarting. This is required by the LLM API: the previous run ended
        // with an assistant turn, and the API rejects "Cannot continue from
        // message role: assistant" without an intervening user/tool message.
        // The note carries the task framing + a `delegationNote` metadata
        // flag so the UI can render it as a system card instead of a user
        // chat bubble.
        if (pendingDelegation && isCurrentRunEpoch()) {
          const { targetAgentId, task, reason } = pendingDelegation
          pendingDelegation = null

          // Dynamic import to avoid circular dependency
          // (agents.store → project.store → conversation.store).
          const { useAgentsStore } = await import('./agents.store')
          const agentsState = useAgentsStore.getState()
          const sourceAgent = agentsState.agents.find((a) => a.id === activeAgentId)
          const targetAgent = agentsState.agents.find((a) => a.id === targetAgentId)

          // Sync the agents store so the UI shows the target persona active.
          void agentsState.setActiveAgent(targetAgentId)

          // Inject the delegation note as a user-role message. The content
          // doubles as the target agent's framing; `delegationNote` metadata
          // marks it as system-injected so the UI can render it specially.
          const note: Message = {
            id: `${Date.now()}-delegation-${Math.random().toString(36).slice(2, 9)}`,
            role: 'user',
            content: `[Delegated task from ${sourceAgent?.name ?? activeAgentId}]: ${task}`,
            timestamp: Date.now(),
            delegationNote: {
              fromAgentId: activeAgentId ?? 'default',
              fromAgentName: sourceAgent?.name,
              task,
              ...(reason ? { reason } : {}),
            },
          }
          get().addMessage(conversationId, note)

          // Stash the incremented depth on the conversation so the recursive
          // runAgent picks it up (Conversation.delegationDepth is in-memory only).
          set((state) => {
            const c = state.conversations.find((x) => x.id === conversationId)
            if (c) c.delegationDepth = delegationDepth + 1
          })

          console.info('[conversation.store] delegate_to handoff', {
            conversationId,
            from: activeAgentId,
            to: targetAgentId,
            targetName: targetAgent?.name,
            depth: delegationDepth + 1,
          })

          // Restart with the target agent persona. agentOverrideId forces the
          // persona even if the latest message @mentions someone else.
          await get().runAgent(
            conversationId,
            providerType,
            modelName,
            maxTokens,
            directoryHandle,
            targetAgentId
          )
          return
        }

        // Clean exit with no delegation — clear the depth counter so the next
        // user-initiated turn starts fresh.
        if (delegationDepth !== 0) {
          set((state) => {
            const c = state.conversations.find((x) => x.id === conversationId)
            if (c) c.delegationDepth = 0
          })
        }
      } catch (error) {
        // Flush streaming queues BEFORE destroy so any buffered
        // reasoning/content deltas are applied to the draft before we commit.
        const queues = getStreamingQueues(conversationId)
        if (queues) {
          queues.reasoning.flushNow()
          queues.content.flushNow()
          queues.reasoning.destroy()
          queues.content.destroy()
        }
        deleteStreamingQueues(conversationId)

        if (error instanceof Error && error.name === 'AbortError') {
          deleteAgentLoop(conversationId)

          let abortCommittedPartial = false
          set((state) => {
            const c = state.conversations.find((c) => c.id === conversationId)
            if (c) {
              // Sync draft from runtime store before committing
              const rtDraft = useConversationRuntimeStore.getState().runtimes.get(conversationId)?.draftAssistant
              if (rtDraft && !c.draftAssistant) {
                c.draftAssistant = rtDraft
              }
              abortCommittedPartial = commitDraftToMessages(c)
              if (abortCommittedPartial) {
                c.updatedAt = Date.now()
              }
              c.status = 'idle'
              c.activeRunId = null
              c.draftAssistant = null
            }
          })
          // Reset runtime store
          useConversationRuntimeStore.setState((state) => {
            const r = state.runtimes.get(conversationId)
            if (r) {
              r.status = 'idle'
              r.activeRunId = null
              r.draftAssistant = null
            }
          })
          // Persist committed partial messages to prevent data loss
          if (abortCommittedPartial) {
            const abortConv = get().conversations.find((c) => c.id === conversationId)
            if (abortConv) {
              persistMessageReplace(conversationId, abortConv.messages).catch((persistErr) => {
                console.error('[conversation.store] Failed to persist on AbortError partial commit:', persistErr)
              })
            }
          }
          // Do NOT return here — fall through to consume queued messages
          // so that messages enqueued during the cancelled run are processed.
        } else {
          deleteAgentLoop(conversationId)
          deleteStreamingQueues(conversationId)
          set((state) => {
            const c = state.conversations.find((c) => c.id === conversationId)
            if (c) {
              c.status = 'error'
              c.error = error instanceof Error ? error.message : String(error)
              c.activeRunId = null
              c.draftAssistant = null
            }
          })
          // Reset runtime store on generic error
          useConversationRuntimeStore.setState((state) => {
            const r = state.runtimes.get(conversationId)
            if (r) {
              r.status = 'error'
              r.error = error instanceof Error ? error.message : String(error)
              r.activeRunId = null
              r.draftAssistant = null
            }
          })
          // Persist messages on generic error to prevent data loss on page refresh
          const catchConv = get().conversations.find((c) => c.id === conversationId)
          if (catchConv) {
            persistMessageReplace(conversationId, catchConv.messages).catch((persistErr) => {
              console.error('[conversation.store] Failed to persist on catch:', persistErr)
            })
          }
        } // end else (non-AbortError path — errors do NOT consume queue)
      }

      // ── Consume queued messages ──
      // After a successful (idle) run, check if messages were queued during execution.
      // If so, dequeue the next one and trigger a new agent run.
      const finalStatus = get().conversations.find((c) => c.id === conversationId)?.status
      if (finalStatus === 'idle') {
        const nextMsg = useConversationRuntimeStore.getState().dequeueMessage(conversationId)
        if (nextMsg) {
          const userMsg = createUserMessage(nextMsg.text, nextMsg.assets, nextMsg.pageContext, {
            contentParts: nextMsg.contentParts,
            readImageHandoff: nextMsg.readImageHandoff,
          })
          const currentConv = get().conversations.find((c) => c.id === conversationId)
          if (currentConv) {
            get().updateMessages(conversationId, [...currentConv.messages, userMsg])
            // Schedule the next run on the next microtask to avoid re-entrancy.
            // FIX (parallel isolation): Pass null — runAgent now resolves the
            // directoryHandle from conversationId internally, so the global
            // active-project pointer can no longer cross-contaminate this run.
            queueMicrotask(() => {
              get().runAgent(
                conversationId,
                providerType,
                modelName,
                maxTokens,
                null,
                nextMsg.agentOverrideId ?? null,
                nextMsg.background ? { background: true } : undefined,
              )
            })
          }
        }
      }
}

