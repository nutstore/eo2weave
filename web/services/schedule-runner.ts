/**
 * Schedule Runner — executes a single schedule run.
 *
 * Steps:
 * 1. Load schedule from OPFS
 * 2. Build a headless AgentLoop with tool call logging
 * 3. Run the loop with the schedule's prompt
 * 4. Write the log to OPFS
 * 5. Append a summary message to the bound conversation
 * 6. Update schedule metadata (lastRunAt, lastRunNumber, error)
 */

import { AgentLoop } from '@/agent/agent-loop'
import { ContextManager } from '@/agent/context-manager'
import { createUserMessage, type Message } from '@/agent/message-types'
import { createLLMProvider } from '@/agent/llm/provider-factory'
import { getToolRegistry } from '@/agent/tool-registry'
import { loadSchedule, saveSchedule, showScheduleNotification } from '@/services/schedule-storage'
import { writeRunLog, truncateForLog, type ToolCallEntry, type LLMCallEntry } from '@/services/schedule-run-logger'
import type { ToolContext } from '@/agent/tools/tool-types'
import type { PiAIProvider } from '@/agent/llm/pi-ai-provider'
import { useSettingsStore } from '@/store/settings.store'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { LLM_PROVIDER_CONFIGS, isCustomProviderType, type LLMProviderType } from '@/agent/providers/types'

const SCHEDULE_SYSTEM_PROMPT = `你是定时任务，每次按以下 prompt 执行。
可参考项目文件以获取上下文。
重要：不要主动问用户问题，使用已有信息完成任务。如果信息不足，做合理假设并执行。

执行完成后，简要说明做了哪些操作和产物路径。`

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Run a single scheduled task.
 * Called by schedule-heartbeat (60s tick) or manually via triggerSchedule().
 */
export async function runSchedule(scheduleId: string, options?: { force?: boolean }): Promise<void> {
  const schedule = await loadSchedule(scheduleId)
  if (!schedule) {
    console.error(`[ScheduleRunner] Schedule ${scheduleId} not found`)
    return
  }

  if (!schedule.enabled && !options?.force) {
    console.info(`[ScheduleRunner] Schedule ${scheduleId} is disabled, skipping`)
    return
  }

  // Orphan check: the bound conversation may have been deleted since the
  // schedule was created. Without this, the headless run would write its
  // summary into a deleted conversation (appendConversationSummary inserts
  // via the DB even when the conversation row is gone) and the schedule
  // would fire forever on a dead target. Force runs skip this so users can
  // still re-point a schedule via run-now after editing.
  if (!options?.force) {
    try {
      const { getConversationRepository } = await import('@/sqlite/repositories/conversation.repository')
      const conv = await getConversationRepository().findById(schedule.workspaceId)
      if (!conv) {
        console.warn(
          `[ScheduleRunner] Bound conversation ${schedule.workspaceId} no longer exists — ` +
          `disabling schedule "${schedule.name}" (${scheduleId})`
        )
        await saveSchedule({
          ...schedule,
          enabled: false,
          error: 'CONV_DELETED',
          updatedAt: Date.now(),
        })
        if (schedule.notification?.onFailure) {
          await showScheduleNotification(
            `⏸️ 定时任务已停用：${schedule.name}`,
            '绑定的对话已被删除'
          )
        }
        return
      }
    } catch (orphanCheckError) {
      // The check itself must never block a run (e.g. transient DB error) —
      // a false-negative just means one run proceeds as before.
      console.warn('[ScheduleRunner] Orphan check failed (continuing):', orphanCheckError)
    }
  }

  const startedAt = Date.now()
  console.info(`[ScheduleRunner] Starting run for "${schedule.name}" (${scheduleId})`)

  const toolCalls: ToolCallEntry[] = []
  const llmCalls: LLMCallEntry[] = []
  let finalMessages: Message[] = []
  let runError: string | undefined

  try {
    // ── Step 1: Build headless agent loop ──────────────────────────────
    const { provider, contextManager, toolContext } = await buildRuntimeDeps(schedule)

    let toolIndex = 0
    let llmIndex = 0
    // Per-run map: tool index → start time (ms). Scoped here so concurrent
    // schedule runs don't share (and leak entries into) a module-level map.
    const toolStartTimes = new Map<number, number>()

    const agentLoop = new AgentLoop({
      provider,
      toolRegistry: getToolRegistry(),
      contextManager,
      systemPrompt: SCHEDULE_SYSTEM_PROMPT,
      toolContext,
      mode: 'act',
      beforeToolCall: ({ toolName, args }) => {
        const entry: ToolCallEntry = {
          index: ++toolIndex,
          tool: toolName,
          args: args as Record<string, unknown>,
          duration: 0,
          response: '',
        }
        toolCalls.push(entry)
        // Store start time on a temporary map
        toolStartTimes.set(toolIndex, Date.now())
        return undefined // don't block
      },
      afterToolCall: ({ toolName, content, isError }) => {
        const entry = toolCalls[toolCalls.length - 1]
        if (entry && entry.tool === toolName) {
          const startTime = toolStartTimes.get(entry.index) ?? Date.now()
          entry.duration = Date.now() - startTime
          entry.response = truncateForLog(content)
          if (isError) {
            entry.error = content
          }
          toolStartTimes.delete(entry.index)
        }
        return undefined
      },
    })

    // ── Step 2: Run the agent loop ─────────────────────────────────────
    const initialMessages: Message[] = [
      createUserMessage(schedule.prompt),
    ]
    finalMessages = await agentLoop.run(initialMessages)

    // Record LLM call
    llmCalls.push({
      index: ++llmIndex,
      duration: Date.now() - startedAt,
      response: truncateForLog(
        finalMessages
          .filter(m => m.role === 'assistant')
          .map(m => typeof m.content === 'string' ? m.content : '')
          .join('\n\n')
      ),
    })

  } catch (err) {
    runError = err instanceof Error ? err.message : String(err)
    console.error(`[ScheduleRunner] Run failed for ${scheduleId}:`, err)
  }

  const endedAt = Date.now()
  const status = runError ? 'FAILED' : 'SUCCESS'

  // ── Step 3: Write log to OPFS ────────────────────────────────────────
  let logPath: string | undefined
  try {
    logPath = await writeRunLog({
      schedule,
      startedAt,
      endedAt,
      status,
      toolCalls,
      llmCalls,
      error: runError,
    })
    console.info(`[ScheduleRunner] Log written: ${logPath}`)
  } catch (err) {
    console.error(`[ScheduleRunner] Failed to write log:`, err)
  }

  // ── Step 4: Append summary message to conversation ───────────────────
  try {
    await appendConversationSummary(schedule, status, startedAt, endedAt, logPath, runError, finalMessages)
  } catch (err) {
    console.error(`[ScheduleRunner] Failed to append conversation message:`, err)
  }

  // ── Step 5: Update schedule metadata ────────────────────────────────
  const updatedSchedule = {
    ...schedule,
    lastRunAt: endedAt,
    lastRunNumber: schedule.lastRunNumber + 1,
    error: runError ?? null,
    // Keep enabled on LLM_NOT_AVAILABLE (user may not have configured keys yet).
    // For other errors, keep enabled too — disabling on first error makes
    // debugging painful. The heartbeat will retry on the next cron tick.
    enabled: true,
    updatedAt: Date.now(),
  }
  // Note: next run time is not persisted; computed fresh on each heartbeat tick
  await saveSchedule(updatedSchedule)

  // ── Step 6: Send desktop notification ────────────────────────────
  if (updatedSchedule.notification) {
    if (runError && updatedSchedule.notification.onFailure) {
      await showScheduleNotification(
        `❌ 定时任务失败：${schedule.name}`,
        `错误：${runError}`
      )
    } else if (!runError && updatedSchedule.notification.onSuccess) {
      await showScheduleNotification(
        `✅ 定时任务完成：${schedule.name}`,
        `运行成功，耗时 ${formatDuration(endedAt - startedAt)}`
      )
    }
  }

  console.info(`[ScheduleRunner] Run complete for "${schedule.name}" — ${status}`)
}

// ---------------------------------------------------------------------------
// Runtime dependencies
// ---------------------------------------------------------------------------

async function buildRuntimeDeps(schedule: NonNullable<Awaited<ReturnType<typeof loadSchedule>>>): Promise<{
  provider: PiAIProvider
  contextManager: ContextManager
  toolContext: ToolContext
}> {
  // ── Provider ─────────────────────────────────────────────────────────
  // Resolve the effective provider configuration for scheduled execution:
  //   1. getEffectiveProviderConfig() → { apiKeyProviderKey, baseUrl, modelName }
  //   2. getApiKeyRepository().load(apiKeyProviderKey) → apiKey
  //   3. createLLMProvider({ apiKey, providerType, baseUrl, model, apiMode })
  const settingsState = useSettingsStore.getState()
  const providerType = (schedule.llm?.provider ?? settingsState.providerType) as LLMProviderType
  const effectiveConfig = settingsState.getEffectiveProviderConfig()
  if (!effectiveConfig) {
    throw new Error('LLM_NOT_AVAILABLE: no effective provider config found')
  }

  // Resolve baseUrl/model: custom providers use effectiveConfig directly;
  // built-in providers use LLM_PROVIDER_CONFIGS
  const providerConfig = isCustomProviderType(providerType)
    ? effectiveConfig
    : {
        apiKeyProviderKey: providerType,
        baseUrl: LLM_PROVIDER_CONFIGS[providerType]?.baseURL ?? effectiveConfig.baseUrl,
        modelName: schedule.llm?.model || effectiveConfig.modelName || LLM_PROVIDER_CONFIGS[providerType]?.modelName || '',
      }

  if (!providerConfig.modelName) {
    throw new Error(`LLM_NOT_AVAILABLE: model name not resolved for provider "${providerType}"`)
  }

  // Load API key from SQLite
  const { getApiKeyRepository } = await import('@/sqlite')
  const apiKey = await getApiKeyRepository().load(providerConfig.apiKeyProviderKey)
  if (!apiKey) {
    throw new Error(`LLM_NOT_AVAILABLE: API key not configured for provider key "${providerConfig.apiKeyProviderKey}"`)
  }

  // Determine apiMode for custom providers
  const apiMode = isCustomProviderType(providerType)
    ? settingsState.customProviders.find(p => p.id === providerType)?.apiMode || 'chat-completions'
    : undefined

  const provider = createLLMProvider({
    apiKey,
    providerType,
    baseUrl: providerConfig.baseUrl,
    model: schedule.llm?.model ?? providerConfig.modelName,
    apiMode: apiMode as 'chat-completions' | 'responses' | undefined,
  })

  // ── Context Manager ──────────────────────────────────────────────────
  const contextManager = new ContextManager({
    maxContextTokens: provider.maxContextTokens,
    reserveTokens: 4000,
    enableSummarization: false, // No compression for schedule runs
    maxMessageGroups: 20,
  })

  // ── Tool Context ─────────────────────────────────────────────────────
  // Prefer a ready native directory handle from folder-access.store (set when
  // the user grants a folder); fall back to the OPFS workspaceDir below.
  const folderRecords = Object.values(useFolderAccessStore.getState().records)
  const readyFolder = folderRecords.find((r) => r.status === 'ready' && r.handle)
  let directoryHandle: FileSystemDirectoryHandle | null = readyFolder?.handle ?? null

  if (!directoryHandle) {
    try {
      const { getWorkspaceManager } = await import('@/opfs')
      const wsManager = await getWorkspaceManager()
      const wsRuntime = await wsManager.getWorkspace(schedule.workspaceId)
      if (wsRuntime) {
        directoryHandle = wsRuntime.workspaceDir
      }
    } catch {
      // Workspace may not exist — continue without directory handle
    }
  }

  // Direct conversations (kind='direct') have no folder authorization: derive
  // the flag from the authoritative conversation kind via the single selector
  // (never from the caller) and withhold the folder handle, so the registry
  // guard rejects folder-dependent tools on headless runs too. Dynamic import:
  // the selector lives in the big conversation store chunk (static import
  // would create a store ↔ services cycle).
  const { isDirectConversation } = await import('@/store/conversation.store.sqlite')
  const directMode = isDirectConversation(schedule.workspaceId)

  const toolContext: ToolContext = {
    directoryHandle: directMode ? null : directoryHandle,
    workspaceId: schedule.workspaceId,
    projectId: schedule.projectId,
    currentAgentId: 'default',
    agentMode: 'act',
    directMode: directMode || undefined,
    readFileState: new Map(),
  }

  return { provider, contextManager, toolContext }
}

// ---------------------------------------------------------------------------
// Conversation summary
// ---------------------------------------------------------------------------

async function appendConversationSummary(
  schedule: NonNullable<Awaited<ReturnType<typeof loadSchedule>>>,
  status: 'SUCCESS' | 'FAILED',
  startedAt: number,
  endedAt: number,
  logPath: string | undefined,
  error: string | undefined,
  messages: Message[],
): Promise<void> {
  const durationMs = endedAt - startedAt
  const durationStr = formatDuration(durationMs)
  const runNumber = schedule.lastRunNumber + 1

  const emoji = status === 'SUCCESS' ? '✅' : '❌'
  const statusText = status === 'SUCCESS' ? '完成' : '失败'

  // Extract final assistant message if any
  const finalContent = messages
    .filter(m => m.role === 'assistant' && typeof m.content === 'string')
    .map(m => m.content as string)
    .pop()
    ?.slice(0, 300) ?? ''

  // Build the summary content
  const lines: string[] = [
    `🔄 [Schedule] ${schedule.name} Run #${runNumber} ${statusText}（耗时 ${durationStr}）${emoji}`,
  ]
  if (logPath) {
    lines.push(`📄 完整日志: ${logPath}`)
  }
  if (error) {
    lines.push(`⚠️ 错误: ${error}`)
  }
  if (finalContent) {
    lines.push('')
    lines.push(`> ${finalContent}${finalContent.length >= 300 ? '...' : ''}`)
  }

  const summaryContent = lines.join('\n')

  // Append to the bound conversation.
  // Must update BOTH the Zustand in-memory state (for immediate UI refresh)
  // AND the database (for persistence). If the conversation is loaded in the
  // store, use addMessage() which handles both. If not (e.g. different project
  // active), fall back to direct DB insert.
  try {
    const assistantMessage: Message = {
      id: `sched-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: 'assistant',
      kind: 'normal',
      content: summaryContent,
      timestamp: endedAt,
    }

    const { useConversationStore } = await import('@/store/conversation.store')
    const store = useConversationStore.getState()
    const conv = store.conversations.find((c: { id: string }) => c.id === schedule.workspaceId)

    if (conv) {
      // Conversation is loaded in memory — addMessage handles both UI + DB
      store.addMessage(schedule.workspaceId, assistantMessage)
    } else {
      // Conversation not in store (different project / not yet loaded).
      // Insert directly into DB; it will appear when user opens the conversation.
      const { getMessageRepository } = await import('@/sqlite/repositories/message.repository')
      const { getConversationRepository } = await import('@/sqlite/repositories/conversation.repository')
      const messageRepo = await getMessageRepository()
      const convRepo = await getConversationRepository()
      const existingMessages = await messageRepo.findByConversation(schedule.workspaceId)
      const nextSeq = existingMessages.length
      await messageRepo.insert(schedule.workspaceId, assistantMessage, nextSeq)
      await convRepo.touch(schedule.workspaceId)
    }
  } catch (err) {
    console.error('[ScheduleRunner] Failed to insert summary message:', err)
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = Math.floor((ms % 60_000) / 1000)
  return `${mins}m ${secs}s`
}
