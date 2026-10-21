/**
 * App-tools handlers — the execute() implementations behind the 20 schemas.
 *
 * Every handler goes through the app's OWN public surfaces (zustand stores,
 * repositories, WorkspaceManager, WorkspaceRuntime) — the same code paths the
 * UI uses. Nothing here bypasses permissions or state management.
 *
 * The dependency-injected deps are intentionally `any`-typed: they wrap
 * dynamic zustand store snapshots and repository classes whose concrete types
 * live across the app. Typing them precisely would couple this module to half
 * the codebase; tests inject mocks instead. All other `any`s flow from these.
 *
 * Run lifecycle: the ONLY terminal signal for a run is the runAgent promise
 * resolving/rejecting (`.then`/`.catch` in send_message). isConversationRunning()
 * is used solely for progress/queue display — a run whose loop never started
 * (early failure, status 'error') still resolves the promise, and the `.then`
 * branch reads the conversation's terminal status to map 'error' → 'failed'.
 */

import { APP_TOOLS } from './schemas'
import type { Message } from '@/agent/message-types'
import { createUserMessage, getMessageRecordType } from '@/agent/message-types'
import { selectConversationExportMessages, selectConversationTranscript } from '@/agent/message-projections'

// ─── Run registry ─────────────────────────────────────────────────────────────

export interface AppRunRecord {
  runId: string
  conversationId: string
  status:
    | 'started' // accepted, agent loop not yet observed running
    | 'queued' // conversation busy — message parked in the queue
    | 'running' // loop observed running
    | 'completed'
    | 'failed'
    | 'timeout'
    | 'cancelled'
  startedAt: number
  finishedAt?: number
  /** First N chars of the sent message — queue-entry identity check on cancel. */
  messageText?: string
  /** Set when the run finishes; scoped to THIS run (messages after startedAt). */
  result?: {
    summary: string
    changedFiles: string[]
    error?: string
    usage?: { inputTokens?: number; outputTokens?: number }
  }
  error?: string
}

const runRegistry = new Map<string, AppRunRecord>()
const RUN_REGISTRY_MAX = 50
let runIdCounter = 0

export function newRunId(): string {
  runIdCounter += 1
  return `run_${Date.now().toString(36)}_${runIdCounter}`
}

function recordRun(rec: AppRunRecord): void {
  runRegistry.set(rec.runId, rec)
  if (runRegistry.size > RUN_REGISTRY_MAX) {
    // Evict the oldest TERMINATED entry; bounded memory beats unbounded
    // growth — the conversation keeps the authoritative history. Non-terminal
    // records (queued/running/started) are never evicted: losing a live runId
    // would blind the agent to an active run.
    const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'timeout'])
    let oldestKey: string | null = null
    let oldestTime = Infinity
    for (const [id, r] of runRegistry) {
      if (!TERMINAL.has(r.status)) continue
      const t = r.finishedAt ?? r.startedAt
      if (t < oldestTime) {
        oldestTime = t
        oldestKey = id
      }
    }
    if (oldestKey) runRegistry.delete(oldestKey)
  }
}

export function getRunRecord(runId: string): AppRunRecord | undefined {
  return runRegistry.get(runId)
}

// ─── Dependency injection (wired by register.ts, overridden in tests) ────────

export interface AppToolDeps {
  getConversationStore: () => any
  getRuntimeStore: () => any
  getSettingsStore: () => any
  getAgentStore: () => any
  getWorkspaceManager: () => Promise<any>
  getProjectRepository: () => any
  getMessageRepository: () => any
  getFSOverlayRepository: () => any
  searchConversations: (args: Record<string, unknown>) => Promise<string>
  validatePath: (path: string) => string
  wait: (ms: number) => Promise<void>
}

let deps: AppToolDeps | null = null

export function initAppToolDeps(d: AppToolDeps): void {
  deps = d
}

function d(): AppToolDeps {
  if (!deps) throw new Error('[app-tools] initAppToolDeps() was never called')
  return deps
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 500
const WAIT_CAP_MS = 55_000 // under the extension relay’s 60s invoke timeout (M-2)
const MAX_MESSAGE_CHARS = 32 * 1024
const MAX_SEND_CHARS = 256 * 1024
const LIST_FILES_LIMIT = 500

function ok(value: unknown): { content: string } {
  return { content: JSON.stringify(value) }
}

function err(message: string): { content: string } {
  return { content: JSON.stringify({ error: message }) }
}

function truncateContent(content: string): { content: string; truncated: boolean } {
  if (content.length > MAX_MESSAGE_CHARS) {
    return { content: content.slice(0, MAX_MESSAGE_CHARS), truncated: true }
  }
  return { content, truncated: false }
}

function findConv(store: any, conversationId: string): any | null {
  return store.conversations.find((c: any) => c.id === conversationId) ?? null
}

/**
 * Assistant summary scoped to THIS run: only messages appended after the run
 * started (timestamp >= startedAt - 1s slack). Falls back to the newest
 * assistant message when the run produced none (e.g. instant failure — the
 * error is surfaced via rec.error instead).
 */
function summaryForRun(store: any, rec: AppRunRecord): string {
  const conv = findConv(store, rec.conversationId)
  const msgs = selectConversationTranscript(conv?.messages ?? [])
  // m-6: prefer message-ORDER scoping. The run's user message is the last user
  // message in the array; everything before it belongs to earlier runs. This is
  // immune to clock skew (timestamps only serve as a sanity check).
  let lastUserIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  let scoped = ''
  for (let i = msgs.length - 1; i > lastUserIdx; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content) {
      scoped = m.content
      break
    }
  }
  if (scoped) return scoped
  // Clock-skew fallback: the timestamp window (unchanged semantics).
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if ((m.timestamp ?? 0) < rec.startedAt - 1000) break
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content) {
      scoped = m.content
      break
    }
  }
  if (scoped) return scoped
  return lastAssistantSummary(store, rec.conversationId)
}

function lastAssistantSummary(store: any, conversationId: string): string {
  const conv = findConv(store, conversationId)
  const msgs = selectConversationTranscript(conv?.messages ?? [])
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role === 'assistant' && typeof m.content === 'string') return m.content
  }
  return ''
}

/**
 * Find the run_changes card created by THIS run (kind === 'run_changes',
 * timestamp >= startedAt) and read its snapshotId. Null when the run produced
 * no snapshot (pure chat / read-only run / auto-apply skipped).
 */
function snapshotIdForRun(store: any, rec: AppRunRecord): string | null {
  const conv = findConv(store, rec.conversationId)
  const msgs: any[] = conv?.messages ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.kind !== 'run_changes') continue
    if ((m.timestamp ?? 0) < rec.startedAt - 1000) continue
    return m.runChanges?.snapshotId ?? null
  }
  return null
}

/**
 * Changed files for a run: resolved from the run's snapshot via
 * FsOverlayRepository.listSnapshotFiles (authoritative path + op list).
 * Empty array when no snapshot exists — NOT an error.
 */
async function changedFilesForRun(rec: AppRunRecord): Promise<string[]> {
  const store = d().getConversationStore()
  const snapshotId = snapshotIdForRun(store, rec)
  if (!snapshotId) return []
  const overlay = d().getFSOverlayRepository()
  const files = await overlay.listSnapshotFiles(snapshotId)
  return (files ?? []).map((f: any) => f.path)
}

/** Conversation-level terminal status ('error' etc.) for a finished run. */
function conversationError(store: any, rec: AppRunRecord): string | null {
  const conv = findConv(store, rec.conversationId)
  if (conv?.status === 'error') return conv.error ?? 'Agent run failed'
  return null
}

/** Finalize a finished run: map the conversation terminal status to run status. */
function finalizeFromStore(store: any, rec: AppRunRecord): AppRunRecord {
  const errMsg = conversationError(store, rec)
  if (errMsg) {
    rec.status = 'failed'
    rec.error = errMsg
  } else if (rec.status !== 'cancelled' && rec.status !== 'timeout') {
    rec.status = 'completed'
  }
  rec.finishedAt = rec.finishedAt ?? Date.now()
  rec.result = {
    summary: summaryForRun(store, rec),
    changedFiles: [], // filled async by withChangedFiles
    ...(errMsg ? { error: errMsg } : {}),
  }
  return rec
}

/** Wait until the runAgent promise resolution flips rec into a terminal state. */
async function waitForRun(rec: AppRunRecord, timeoutMs: number): Promise<AppRunRecord> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await d().wait(POLL_INTERVAL_MS)
    if (['completed', 'failed', 'cancelled', 'timeout'].includes(rec.status)) {
      return rec
    }
  }
  rec.status = 'timeout'
  rec.finishedAt = Date.now()
  rec.error = `wait=true timed out after ${timeoutMs}ms — poll get_run_status / get_run_progress instead`
  return rec
}

/** Attach changedFiles to a finalized record (async overlay read). */
async function withChangedFiles(rec: AppRunRecord): Promise<AppRunRecord> {
  if (!rec.result) return rec
  try {
    rec.result.changedFiles = await changedFilesForRun(rec)
  } catch {
    rec.result.changedFiles = []
  }
  return rec
}

// ─── Handlers ────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, any>) => Promise<{ content: string }>

export const handlers: Record<string, Handler> = {
  // ── Projects ──
  list_projects: async () => {
    const repo = d().getProjectRepository()
    const [projects, stats] = (await Promise.all([
      repo.findAllProjects(),
      repo.findProjectStats(),
    ])) as any[]
    const statMap = new Map((stats as any[]).map((s: any) => [s.projectId, s]))
    return ok({
      projects: projects.map((p: any) => ({
        id: p.id,
        name: p.name,
        workspaceCount: statMap.get(p.id)?.workspaceCount ?? 0,
        lastAccessedAt: statMap.get(p.id)?.lastWorkspaceAccessAt ?? null,
      })),
    })
  },

  create_project: async (args) => {
    const name = String(args.name ?? '').trim()
    if (!name) return err('name is required')
    const repo = d().getProjectRepository()
    const project = await repo.createProject({ name })
    return ok({ project: { id: project.id, name: project.name } })
  },

  // ── Folders ──
  list_mounted_folders: async () => {
    const { useFolderAccessStore } = await import('@/store/folder-access.store')
    const records = (useFolderAccessStore.getState() as any).records ?? {}
    const folders = Object.values(records as Record<string, any>)
      .filter((r) => r.folderName || r.handle || r.persistedHandle)
      .map((r) => ({
        folderId: `${r.projectId}:${r.rootName ?? r.projectId}`,
        projectId: r.projectId,
        name: r.folderName ?? r.rootName ?? r.projectId,
        status: r.status,
      }))
    return ok({ folders })
  },

  // ── Conversations ──
  list_conversations: async (args) => {
    const store = d().getConversationStore()
    // loadFromDB is triggered after workspace readiness — before that the list
    // is legitimately empty, which agents would misread as "no conversations".
    if (!store.loaded) return ok({ loading: true, conversations: [], hasMore: false })
    const limit = Math.min(Math.max(1, Number(args.limit ?? 20)), 100)
    const offset = Math.max(0, Number(args.offset ?? 0))
    let list: any[] = store.conversations ?? []
    if (args.folderId) {
      // folderId = "projectId:rootName" (from list_mounted_folders). Each
      // conversation maps 1:1 to a workspace whose id IS the conversation id;
      // scope to the project's workspaces (the project's roots share one OPFS
      // files/ tree per conversation workspace).
      const projectId = String(args.folderId).split(':')[0]
      const manager = await d().getWorkspaceManager()
      const wsIds = new Set(
        manager
          .getAllWorkspaces()
          .filter((w: any) => w.projectId === projectId)
          .map((w: any) => w.workspaceId),
      )
      list = list.filter((c: any) => wsIds.has(c.id))
    }
    list = [...list].sort((a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    const page = list.slice(offset, offset + limit)
    return ok({
      conversations: page.map((c: any) => ({
        id: c.id,
        title: c.title,
        status: c.status ?? 'idle',
        updatedAt: c.updatedAt ?? null,
      })),
      hasMore: offset + limit < list.length,
    })
  },

  search_conversations: async (args) => {
    // Map camelCase schema params to the executor's snake_case args (M1).
    const mapped: Record<string, unknown> = {
      query: args.query,
      limit: args.limit,
    }
    if (args.projectId) mapped.project = String(args.projectId)
    if (args.updatedAfter != null) mapped.updated_after = Number(args.updatedAfter)
    if (args.updatedBefore != null) mapped.updated_before = Number(args.updatedBefore)
    // The executor returns a JSON string — pass it through verbatim; double
    // encoding here would corrupt the tool result (M1).
    const raw = await d().searchConversations(mapped)
    return { content: raw }
  },

  create_conversation: async (args) => {
    const store = d().getConversationStore()
    const conv = store.createNew(args.title ? String(args.title) : undefined, {
      activate: false, // background creation — never yank the user's current view
    })
    // v3.1: projectId is not persisted on conversations (schema has no column);
    // the parameter was removed from the schema so agents don't expect it.
    return ok({ conversation: { id: conv.id, title: conv.title } })
  },

  rename_conversation: async (args) => {
    const conversationId = String(args.conversationId ?? '')
    const title = String(args.title ?? '').trim()
    if (!conversationId) return err('conversationId is required')
    if (!title) return err('title is required')
    if (title.length > 200) return err('title must be at most 200 characters')
    const store = d().getConversationStore()
    const conv = store.conversations?.find((c: any) => c.id === conversationId)
    if (!conv) return err(`Conversation not found: ${conversationId}`)
    store.updateTitle(conversationId, title)
    return ok({ conversationId, title })
  },

  get_messages: async (args) => {
    const conversationId = String(args.conversationId ?? '')
    if (!conversationId) return err('conversationId is required')
    const page = Math.max(1, Number(args.page ?? 1))
    const pageSize = Math.min(Math.max(1, Number(args.pageSize ?? 50)), 200)
    const repo = d().getMessageRepository()
    const all = await repo.findByConversation(conversationId)
    // Skip UI-only cards (run_changes has no text content) — they would show
    // up as empty assistant entries and skew pagination density.
    const readable = selectConversationExportMessages(all, { includeSystemMessages: true })
      .filter(m => getMessageRecordType(m) !== 'run_changes')
    const total = readable.length
    const end = Math.max(0, total - (page - 1) * pageSize)
    const start = Math.max(0, end - pageSize)
    const slice = readable.slice(start, end)
    return ok({
      messages: slice.map((m: Message) => {
        const raw = typeof m.content === 'string' ? m.content : ''
        const t = truncateContent(raw)
        return {
          role: m.role, recordType: getMessageRecordType(m), kind: m.kind,
          content: t.content, truncated: t.truncated, timestamp: m.timestamp,
        }
      }),
      page,
      totalMessages: total,
      hasMore: start > 0,
    })
  },

  // ── Runs ──
  send_message: async (args) => {
    const conversationId = String(args.conversationId ?? '')
    const content = String(args.content ?? '')
    const wait = Boolean(args.wait ?? false)
    const timeoutMs = Math.min(Math.max(Number(args.timeoutMs ?? 50_000), 1000), WAIT_CAP_MS)
    if (!conversationId) return err('conversationId is required')
    if (!content.trim()) return err('content is required')
    if (content.length > MAX_SEND_CHARS) {
      return err(`content too large: ${content.length} chars (max ${MAX_SEND_CHARS})`)
    }

    const D = d()
    const store = D.getConversationStore()
    const settings = D.getSettingsStore()
    // Guard the startup race: hasApiKey is false until the async key check
    // completes; only treat it as "missing" once that check has run.
    if (settings.hasApiKeyLoaded && !settings.hasApiKey) {
      return err('No API key configured — set up a provider in EO2Weave settings first')
    }
    const conv = findConv(store, conversationId)
    if (!conv) return err(`Conversation not found: ${conversationId}`)

    const agentStore = D.getAgentStore()
    const directoryHandle = agentStore?.directoryHandle ?? null

    const runId = newRunId()
    const rec: AppRunRecord = {
      runId,
      conversationId,
      status: 'started',
      startedAt: Date.now(),
      messageText: content.slice(0, 200),
    }

    // Busy → queue. The queue position is remembered so cancel_run removes
    // exactly this entry instead of killing the conversation's active run.
    if (store.isConversationRunning(conversationId)) {
      // enqueueMessage lives on the RUNTIME store (the conversation store never
      // implemented it) — same call the UI send path uses when busy.
      // background:true makes the eventual dequeue-run stay in the background
      // (no UI workspace steal). The queue itself is in-memory: the message is
      // ALSO persisted below so a refresh cannot silently lose it.
      const runtimeStore = d().getRuntimeStore()
      const result = runtimeStore.enqueueMessage(conversationId, { text: content, background: true })
      if (!result?.enqueued) {
        return err('Conversation is running and its queue is full')
      }
      rec.status = 'queued'
      ;(rec as any).queuePosition = result.position
      // Persist durably: on refresh the queue is lost but the message survives
      // in SQLite and shows up in the conversation history (no silent loss).
      try {
        const msgRepo = d().getMessageRepository()
        const userMsg = createUserMessage(content)
        const seq = (conv.messages?.length ?? 0) + 1
        await msgRepo.insert(conversationId, userMsg, seq)
        store.updateMessages(conversationId, [...(conv.messages ?? []), userMsg])
      } catch (e) {
        console.warn('[app-tools] queued message persist failed:', e)
      }
      recordRun(rec)
      return ok({ runId, status: 'queued', queuePosition: result.position })
    }

    // All validations passed — only now publish the run record (M3: failure
    // paths above must not leave orphan records that later read as completed).
    recordRun(rec)

    const userMsg = createUserMessage(content)
    store.updateMessages(conversationId, [...(conv.messages ?? []), userMsg])
    // Fire-and-forget: the promise resolution is THE terminal signal for this
    // run (C1). runAgentImpl resolves even on early failure (it sets
    // status='error' instead of throwing), so `.then` inspects the terminal
    // conversation status to map failure correctly.
    void store
      .runAgent(conversationId, settings.providerType, settings.modelName, settings.maxTokens, directoryHandle, null, { background: true })
      .then(() => {
        finalizeFromStore(store, rec)
      })
      .catch((e: unknown) => {
        rec.status = 'failed'
        rec.error = e instanceof Error ? e.message : String(e)
        rec.finishedAt = Date.now()
      })
    rec.status = 'running'

    if (!wait) return ok({ runId, status: 'started' })

    const final = await withChangedFiles(await waitForRun(rec, timeoutMs))
    return ok({
      runId: final.runId,
      status: final.status,
      ...(final.result ? { result: final.result } : {}),
      ...(final.error ? { error: final.error } : {}),
    })
  },

  get_run_status: async (args) => {
    const rec = getRunRecord(String(args.runId ?? ''))
    if (!rec) return err(`Unknown runId: ${args.runId}`)
    const store = d().getConversationStore()
    const running = store.isConversationRunning(rec.conversationId)
    // Terminal transitions only come from the runAgent promise (.then/.catch).
    // 'started' means the loop has not registered itself yet (startup race) —
    // NEVER treat it as finished (C1). 'queued' → 'running' when the loop starts
    // consuming the queue.
    if (rec.status === 'queued' && running) {
      // Ambiguous: the loop may be running THIS message (after dequeue) or a
      // PREVIOUS one. Disambiguate by checking whether our message is still in
      // the queue: still present → still queued; gone → it was dequeued and is
      // the run now executing.
      const runtimeStore = d().getRuntimeStore()
      const pos = (rec as any).queuePosition
      const stillQueued =
        typeof pos === 'number' && runtimeStore?.getQueuedMessage?.(rec.conversationId, pos - 1)
      if (!stillQueued) rec.status = 'running'
    }
    if (rec.status === 'queued' && !running) {
      // Conversation went idle while queued: the in-memory queue is gone but the
      // message was durably persisted (queued path writes to SQLite), so it is
      // NOT lost — it is part of the history. Finalize with the scoped summary
      // instead of leaving the run stuck at "queued" forever (C-1).
      finalizeFromStore(store, rec)
    }
    if (
      !running &&
      rec.status !== 'started' &&
      !['completed', 'failed', 'cancelled', 'timeout'].includes(rec.status)
    ) {
      finalizeFromStore(store, rec)
    }
    return ok({
      runId: rec.runId,
      status: rec.status,
      ...(rec.result ? { result: rec.result } : {}),
      ...(rec.error ? { error: rec.error } : {}),
    })
  },

  get_run_progress: async (args) => {
    const rec = getRunRecord(String(args.runId ?? ''))
    if (!rec) return err(`Unknown runId: ${args.runId}`)
    const store = d().getConversationStore()
    const running = store.isConversationRunning(rec.conversationId)
    // m-7: a queued rec whose message is still parked must NOT be reported as
    // running (the active run belongs to a previous message; elapsedMs would
    // silently count from enqueue time).
    if (rec.status === 'queued') {
      const pos = (rec as any).queuePosition
      const entry =
        typeof pos === 'number' ? d().getRuntimeStore()?.getQueuedMessage?.(rec.conversationId, pos - 1) : null
      if (entry) {
        return ok({ status: 'queued', queuePosition: pos, elapsedMs: Date.now() - rec.startedAt })
      }
    }
    if (!running) {
      return ok({ status: rec.status, elapsedMs: (rec.finishedAt ?? Date.now()) - rec.startedAt })
    }
    // Streaming content lives in the RUNTIME store (M5) — the main store's
    // conversation field is legacy and is not written by the agent loop.
    const runtimeStore = d().getRuntimeStore()
    const rt = runtimeStore?.runtimes?.get?.(rec.conversationId) ?? null
    const mainConv = findConv(store, rec.conversationId)
    const current = rt?.currentToolCall ?? mainConv?.currentToolCall ?? null
    const streaming: string = rt?.streamingContent ?? mainConv?.streamingContent ?? ''
    const activeToolCalls: any[] = rt?.activeToolCalls ?? mainConv?.activeToolCalls ?? []
    return ok({
      status: 'running',
      elapsedMs: Date.now() - rec.startedAt,
      toolCallsDone: activeToolCalls.length,
      ...(current
        ? {
            currentTool: {
              name: current.function?.name ?? null,
              argsPreview: String(current.function?.arguments ?? '').slice(0, 200),
            },
          }
        : {}),
      ...(streaming ? { streamingPreview: streaming.slice(-500) } : {}),
    })
  },

  cancel_run: async (args) => {
    const rec = getRunRecord(String(args.runId ?? ''))
    if (!rec) return err(`Unknown runId: ${args.runId}`)
    const store = d().getConversationStore()
    if (rec.status === 'queued') {
      // A queued run has no loop to cancel — remove exactly this queued entry
      // instead of killing whatever run IS active on the conversation (M2).
      // enqueueMessage returns a 1-based position (array length after push);
      // removeQueuedMessage takes a 0-based index.
      const pos = (rec as any).queuePosition
      const runtimeStore = d().getRuntimeStore()
      let removed = false
      if (typeof pos === 'number' && pos >= 1) {
        const idx = pos - 1
        const entry = runtimeStore?.getQueuedMessage?.(rec.conversationId, idx)
        // Indices drift when the user reorders/deletes other queued messages —
        // only remove when the entry still matches this run's message (m-5).
        if (!entry || entry.text === rec.messageText) {
          runtimeStore?.removeQueuedMessage?.(rec.conversationId, idx)
          removed = true
        }
      }
      rec.status = 'cancelled'
      rec.finishedAt = Date.now()
      return ok({ cancelled: true, removedFromQueue: removed })
    }
    if (rec.status !== 'running' && rec.status !== 'started') {
      return err(`Run ${rec.runId} already finished (${rec.status})`)
    }
    store.cancelAgent(rec.conversationId)
    rec.status = 'cancelled'
    rec.finishedAt = Date.now()
    return ok({ cancelled: true })
  },

  // ── Files ──
  read_folder_file: async (args) => {
    const conversationId = String(args.conversationId ?? '')
    const path = String(args.path ?? '')
    if (!conversationId || !path) return err('conversationId and path are required')
    let safePath: string
    try {
      // The schema documents RELATIVE paths ("src/App.tsx"). validatePath
      // expects "/src/App.tsx" — normalize before validating, strip after.
      safePath = d().validatePath(path.startsWith('/') ? path : `/${path}`)
      safePath = safePath.replace(/^\/+/, '')
    } catch (e) {
      return err(e instanceof Error ? e.message : `Invalid path: ${path}`)
    }
    const manager = await d().getWorkspaceManager()
    const runtime = await manager.getWorkspace(conversationId)
    if (!runtime) return err(`No workspace bound to conversation ${conversationId}`)
    try {
      const result = await runtime.readFile(safePath)
      const content = typeof result.content === 'string' ? result.content : ''
      const t = truncateContent(content)
      return ok({ path: safePath, content: t.content, truncated: t.truncated, size: result.metadata?.size ?? t.content.length })
    } catch (e) {
      return err(`Failed to read ${safePath}: ${e instanceof Error ? e.message : String(e)}`)
    }
  },

  write_folder_file: async (args) => {
    const conversationId = String(args.conversationId ?? '')
    const path = String(args.path ?? '')
    const content = String(args.content ?? '')
    if (!conversationId || !path) return err('conversationId and path are required')
    let safePath: string
    try {
      // The schema documents RELATIVE paths ("src/App.tsx"). validatePath
      // expects "/src/App.tsx" — normalize before validating, strip after.
      safePath = d().validatePath(path.startsWith('/') ? path : `/${path}`)
      safePath = safePath.replace(/^\/+/, '')
    } catch (e) {
      return err(e instanceof Error ? e.message : `Invalid path: ${path}`)
    }
    const manager = await d().getWorkspaceManager()
    const runtime = await manager.getWorkspace(conversationId)
    if (!runtime) return err(`No workspace bound to conversation ${conversationId}`)
    try {
      await runtime.writeFile(safePath, content)
      return ok({ path: safePath, written: true, size: content.length })
    } catch (e) {
      return err(`Write failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  },

  list_folder_files: async (args) => {
    const conversationId = String(args.conversationId ?? '')
    const path = String(args.path ?? '')
    const depth = Math.max(0, Number(args.depth ?? 2))
    if (!conversationId) return err('conversationId is required')
    const manager = await d().getWorkspaceManager()
    const runtime = await manager.getWorkspace(conversationId)
    if (!runtime) return err(`No workspace bound to conversation ${conversationId}`)
    const scan = await runtime.scanFiles()
    const prefix = path ? `${path.replace(/\/+$/, '')}/` : ''
    const depthLimit = prefix ? depth + 1 : depth
    const files = [...scan.values()]
      .filter((f) => {
        if (prefix) {
          // m-1: depth applies within the prefix too (relative segment count).
          const rel = f.path.slice(prefix.length)
          if (!rel) return false
          return rel.split('/').length <= depthLimit
        }
        return f.path.split('/').length <= depthLimit
      })
      .map((f) => ({ path: f.path, type: 'file' as const, size: f.size }))
      .sort((a, b) => a.path.localeCompare(b.path))
      .slice(0, LIST_FILES_LIMIT)
    return ok({ files, truncated: files.length >= LIST_FILES_LIMIT })
  },

  // ── Providers & models ──
  list_providers: async () => {
    const { getProvidersByCategory } = await import('@/agent/providers/types')
    const settings = d().getSettingsStore()
    const grouped = getProvidersByCategory()
    const providers: Array<Record<string, unknown>> = []
    for (const group of Object.values(grouped)) {
      for (const { type, meta } of group) {
        providers.push({
          id: type,
          name: meta.displayName,
          isCurrent: type === settings.providerType,
          hasApiKey: type === settings.providerType ? settings.hasApiKey : undefined,
          pinnedModels: settings.pinnedModelsByProvider[type] ?? [],
        })
      }
    }
    return ok({
      providers,
      current: { providerId: settings.providerType, model: settings.modelName },
    })
  },

  list_models: async (args) => {
    const providerId = String(args.providerId ?? '')
    if (!providerId) return err('providerId is required')
    const { getModelsForProvider } = await import('@/agent/providers/types')
    const { getCachedModels } = await import('@/agent/providers/model-store')
    const settings = d().getSettingsStore()
    const staticModels: any[] = getModelsForProvider(providerId)
    const cached = getCachedModels(providerId) as any
    const models: any[] = cached?.models?.length ? cached.models : staticModels
    const pinned = settings.pinnedModelsByProvider[providerId] ?? []
    return ok({
      models: models.map((m: any) => ({
        id: m.id,
        name: m.name,
        contextWindow: m.contextWindow ?? null,
        pinned: pinned.includes(m.id),
      })),
      source: cached?.source ?? 'static',
    })
  },

  add_pinned_model: async (args) => {
    const providerId = String(args.providerId ?? '')
    const modelId = String(args.modelId ?? '')
    if (!providerId || !modelId) return err('providerId and modelId are required')
    const settings = d().getSettingsStore()
    settings.pinModel(providerId, modelId)
    return ok({ pinned: settings.pinnedModelsByProvider[providerId] ?? [] })
  },

  remove_pinned_model: async (args) => {
    const providerId = String(args.providerId ?? '')
    const modelId = String(args.modelId ?? '')
    if (!providerId || !modelId) return err('providerId and modelId are required')
    const settings = d().getSettingsStore()
    settings.unpinModel(providerId, modelId)
    return ok({ pinned: settings.pinnedModelsByProvider[providerId] ?? [] })
  },

  set_default_model: async (args) => {
    const providerId = String(args.providerId ?? '')
    const modelId = String(args.modelId ?? '')
    if (!providerId || !modelId) return err('providerId and modelId are required')
    const settings = d().getSettingsStore()
    // Enforce the documented precondition: only switch to a provider that has
    // credentials or usage records. hasApiKey reflects the CURRENT provider;
    // for others the pinned list / custom-provider records are the signal.
    const isCurrent = providerId === settings.providerType
    const known =
      isCurrent ||
      (settings.pinnedModelsByProvider[providerId]?.length ?? 0) > 0 ||
      (settings as any).customProviders?.some?.((cp: any) => cp.id === providerId) ||
      ['openai', 'anthropic', 'deepseek', 'openrouter', 'codex-oauth'].includes(providerId)
    if (!known) {
      return err(`Provider ${providerId} is not configured — set it up in EO2Weave settings first`)
    }
    settings.switchProviderAndModel(providerId, modelId)
    return ok({ providerId, modelId })
  },
}

// ─── Executor map builder ─────────────────────────────────────────────────────

export function buildToolExecutors(): Map<string, Handler> {
  const map = new Map<string, Handler>()
  for (const def of APP_TOOLS) {
    const h = handlers[def.name]
    if (!h) throw new Error(`[app-tools] missing handler for ${def.name}`)
    map.set(def.name, h)
  }
  return map
}
