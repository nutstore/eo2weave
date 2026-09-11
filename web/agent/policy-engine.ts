/**
 * Tool Policy Engine — the single authorization decision point.
 *
 * Every tool falls into one of three policy levels:
 *   auto      — run without asking (read tools, sandboxed tools, OPFS writes
 *               that still go through pending-changes review)
 *   prompt    — ask the user via the unified ToolAuthModal (disk writes,
 *               external MCP/WebMCP calls, destructive rollbacks, page-action
 *               writes, exec commands the native host flagged as prompt)
 *   forbidden — never runnable by the LLM (self-privilege-escalation)
 *
 * Decision order (first match wins, see redesign doc §3.2):
 *   1. forbidden                        → deny
 *   2. session memory hit               → allow   ("always allow this convo")
 *   3. yolo mode on                     → allow   (never for forbidden)
 *   3.5 trusted source (settings)       → allow   (plan AND act; never
 *                                                 untrusted-content tools)
 *   4. level === 'auto'                 → allow
 *   5. otherwise                        → prompt via tool-auth.store
 *
 * PR-1 scope: the engine exists and exec/page-write route through it, but no
 * behavior changes — the same tools prompt as before, just through the shared
 * channel. Later PRs reclassify call_tool, add sync-to-disk, and generalize
 * yolo on top of this decision flow.
 */

import { useToolAuthStore } from '@/store/tool-auth.store'
import { useSessionAllowStore } from '@/store/session-allow.store'
import { isYoloOn } from '@/store/yolo-mode.store'
import { isToolSourceTrusted } from '@/store/trusted-source.store'
import type { FileChange } from '@/opfs/types/opfs-types'

export type ToolPolicyLevel = 'auto' | 'prompt' | 'forbidden'

/**
 * i18n-ready modal description: a translation key under `agent.toolAuth.*`
 * plus interpolation params. ToolAuthModal renders it with useT so the
 * modal body follows the user's locale (previously hardcoded English).
 */
export interface ToolAuthDescription {
  /** Key under agent.toolAuth, e.g. 'describeSyncToDisk'. */
  key: string
  /** Interpolation params (e.g. { count: 3 }, { name: 'mcp:get' }). */
  params?: Record<string, string | number>
}

export interface ToolPolicy {
  /** Default decision level for the tool. */
  level: ToolPolicyLevel
  /**
   * Modal context as an i18n descriptor (rendered by ToolAuthModal via useT).
   */
  describe?: (args: unknown) => ToolAuthDescription
  /**
   * Session-memory key generator. A non-null key enables the "Always allow
   * for this conversation" button and the session-allow short-circuit.
   * Return null for tools that must ask every single time (e.g. untrusted
   * external tools).
   */
  memoryKey?: (args: unknown) => string | null
}

export interface AuthorizeRequest {
  /** Tool name, e.g. 'exec', 'sync-to-disk', 'call_tool'. */
  toolName: string
  /** Tool arguments, passed to describe()/memoryKey() for context. */
  args?: unknown
  /**
   * Raw tool arguments for modal DISPLAY (pretty-printed JSON). Independent
   * from `args`: callers keep using `args` for policy decisions while passing
   * a user-friendly payload here (e.g. call_tool passes the real call args).
   */
  toolArgs?: unknown
  /**
   * Structured file-change list for sync-like tools — rendered by
   * ToolAuthModal as a clickable list (click → diff preview).
   */
  fileChanges?: FileChange[]
  /**
   * The tool's own description from its provider (MCP server / WebMCP
   * page), rendered by ToolAuthModal as a clamped "tool description" block
   * with expand toggle. Helps users understand unfamiliar tool names
   * before authorizing. Purely display-only — never used for decisions.
   */
  toolDescription?: string | null
  /** Conversation id (ToolContext.workspaceId). Scopes session memory. */
  conversationId?: string | null
  /** Abort signal of the originating run — aborting resolves as deny. */
  signal?: AbortSignal
  /**
   * Extra runtime constraints beyond the static policy table.
   * Currently: plan mode downgrades call_tool to per-call approval
   * ("always allow" is suppressed — a plan-phase approval must not
   * silently pre-authorize later calls, possibly in act mode).
   */
  mode?: 'plan' | 'act'
  /**
   * Origin the tool belongs to (WebMCP hostname / MCP serverId). When the
   * user has marked this origin "always trusted" in settings, prompt-level
   * tools from it run WITHOUT the modal — in both plan and act mode. Trusted
   * origins are configured in a calm settings context, so unlike
   * conversation-scoped memory the grant is not suppressed in plan mode and
   * never expires with the conversation.
   */
  trustedSource?: { kind: 'webmcp' | 'mcp'; sourceId: string } | null
}

export type AuthResult =
  | { decision: 'allow'; via: 'forbidden-never' | 'session-memory' | 'yolo' | 'trusted-source' | 'auto' }
  | { decision: 'deny'; reason: string }

/**
 * Full authorization flow for one tool invocation. Resolves when the tool may
 * run (allow) or must not (deny, with a reason the LLM can act on).
 */
export async function authorize(req: AuthorizeRequest): Promise<AuthResult> {
  const policy = getToolPolicy(req.toolName)

  // 1. forbidden — never overridable by memory, yolo, or any config.
  if (policy.level === 'forbidden') {
    return {
      decision: 'deny',
      reason: `Tool "${req.toolName}" is forbidden by tool policy and cannot be executed.`,
    }
  }

  // 2. conversation-scoped "always allow" memory. Suppressed in plan mode —
  // an approval granted during plan exploration must not pre-authorize the
  // execution phase (possibly after a plan→act switch).
  const memoryKey = policy.memoryKey?.(req.args) ?? null
  const memoryAllowed = req.mode !== 'plan'
  if (
    memoryAllowed &&
    memoryKey !== null &&
    useSessionAllowStore.getState().has(req.conversationId, memoryKey)
  ) {
    return { decision: 'allow', via: 'session-memory' }
  }

  // 3. yolo mode — skips every prompt-level modal (still not forbidden).
  // Conversation-scoped (yolo-mode.store): switches conversation → off.
  if (isYoloOn(req.conversationId)) {
    return { decision: 'allow', via: 'yolo' }
  }

  // 3.5 user-marked trusted origin — persistent, cross-conversation,
  // cross-mode (plan AND act). isToolSourceTrusted() itself rejects
  // untrusted-content tools, so the human gate on prompt-injection surface
  // survives even a blanket "trust this site" grant. Mode-independence is
  // the feature: settings-granted trust is not an in-conversation approval.
  if (
    req.trustedSource &&
    isToolSourceTrusted(
      req.trustedSource.kind,
      req.trustedSource.sourceId,
      { untrustedContent: (req.args as { untrusted?: boolean } | null)?.untrusted === true }
    )
  ) {
    return { decision: 'allow', via: 'trusted-source' }
  }

  // 4. auto — no user interaction needed.
  if (policy.level === 'auto') {
    return { decision: 'allow', via: 'auto' }
  }

  // 5. prompt — unified modal. Resolves false on deny or abort. In plan mode
  // the "always allow" option is stripped (memoryKey forced null).
  const resolution = await useToolAuthStore.getState().request({
    toolName: req.toolName,
    // i18n descriptor — ToolAuthModal renders it with useT (locale-aware).
    description: policy.describe?.(req.args) ?? null,
    toolDescription: req.toolDescription ?? null,
    toolArgs: req.toolArgs,
    fileChanges: req.fileChanges,
    memoryKey: memoryAllowed ? memoryKey : null,
    conversationId: req.conversationId ?? null,
    signal: req.signal,
  })
  if (!resolution.approved) {
    return {
      decision: 'deny',
      reason: `User denied permission for "${req.toolName}".`,
    }
  }
  // "Always allow" — write the grant into conversation-scoped memory so the
  // short-circuit at step 2 hits on subsequent invocations.
  if (resolution.remembered && memoryKey !== null) {
    useSessionAllowStore.getState().add(req.conversationId, memoryKey)
  }
  return { decision: 'allow', via: 'auto' }
}

// ---------------------------------------------------------------------------
// Policy table
// ---------------------------------------------------------------------------

const PAGE_ACTION_WRITE_TOOLS = new Set([
  'page_click',
  'page_fill',
  'page_type',
  'page_scroll',
  'page_evaluate',
])

function createPolicyTable(): Map<string, ToolPolicy> {
  const table = new Map<string, ToolPolicy>()
  const set = (name: string, policy: ToolPolicy) => table.set(name, policy)

  /** Max deletion paths shown in the deletion-bearing flush modal body. */
  const SYNC_DELETE_PATH_LIMIT = 8

  // -- auto: read-only & sandboxed -----------------------------------------
  for (const name of [
    'read', 'write', 'edit', 'delete', 'search', 'ls',
    'run_python', 'bash',
    'ocr',
    'canvas_add_node', 'canvas_connect', 'canvas_create', 'canvas_disconnect',
    'canvas_get', 'canvas_remove', 'canvas_run', 'canvas_update',
    'create_checkpoint', 'detect_conflicts', 'rollback_checkpoint',
    'search_conversations', 'search_skills', 'install_skill',
    'read_skill', 'read_skill_resource',
    'ask_user_question', 'delegate_to',
    'spawn_subagent', 'batch_spawn', 'send_message_to_subagent',
    'stop_subagent', 'resume_subagent', 'get_subagent_status', 'list_subagents',
    'sync-to-opfs', 'search_tools', 'get_page_tools',
    'web_search', 'web_fetch', 'generate_image',
    'page_snapshot', 'page_text_content', 'page_find_elements',
    'page_synthesize_locators', 'page_screenshot',
  ]) {
    set(name, { level: 'auto' })
  }

  // -- prompt: user confirmation required -----------------------------------

  // sync-to-disk: writing to the REAL disk is the risk-bearing step of the
  // file pipeline (OPFS writes stay auto — they have pending review +
  // snapshots as a second line of defense; the disk does not).
  //
  // A flush WITHOUT pending deletions and a flush WITH deletions get
  // DIFFERENT descriptions and DIFFERENT memory keys: the deletion-bearing
  // modal explicitly lists the doomed paths (the informed consent for an
  // irreversible-on-disk operation), and "always allow" for regular writes
  // never silently covers deletions — each grant must match what it covers.
  set('sync-to-disk', {
    level: 'prompt',
    describe: (args): ToolAuthDescription => {
      const a = args as { count?: number; deletes?: string[] } | null
      const deletes = Array.isArray(a?.deletes) ? a.deletes : []
      if (deletes.length > 0) {
        // Deletion-bearing flush: list the paths (bounded) so the user sees
        // exactly which files will be removed from disk.
        const shown = deletes.slice(0, SYNC_DELETE_PATH_LIMIT)
        const overflow = deletes.length - shown.length
        const pathsDisplay =
          shown.join(', ') + (overflow > 0 ? ` …(+${overflow} more)` : '')
        return {
          key: 'describeSyncToDiskDelete',
          params: { count: deletes.length, paths: pathsDisplay },
        }
      }
      const count = a?.count
      return typeof count === 'number' && count > 0
        ? { key: 'describeSyncToDisk', params: { count } }
        : { key: 'describeSyncToDiskGeneric' }
    },
    memoryKey: (args) => {
      const a = args as { deletes?: string[] } | null
      const hasDeletes = Array.isArray(a?.deletes) && a.deletes.length > 0
      return hasDeletes ? 'sync-to-disk:delete' : 'sync-to-disk'
    },
  })

  // call_tool: first invocation of a server+tool combination always prompts;
  // "always allow" whitelists it for the conversation. Tools coming from
  // untrusted-content pages never get a memory key — they must be approved
  // every single time (prompt-injection surface).
  set('call_tool', {
    level: 'prompt',
    describe: (args) => {
      const name = (args as { full_tool_name?: string } | null)?.full_tool_name
      return name
        ? { key: 'describeCallTool', params: { name } }
        : { key: 'describeCallToolGeneric' }
    },
    memoryKey: (args) => {
      const a = args as { full_tool_name?: string; untrusted?: boolean } | null
      // Untrusted-content tools (annotated pages) are never remembered —
      // every single call must be explicitly approved.
      if (a?.untrusted) return null
      const fullName = a?.full_tool_name?.trim()
      if (!fullName) return null // unusable name → cannot build a safe key
      return `call_tool::${fullName}`
    },
  })

  set('snapshot_restore', {
    level: 'prompt',
    describe: () => ({ key: 'describeSnapshotRestore' }),
    memoryKey: () => null, // rollbacks are too consequential to remember
  })

  for (const name of PAGE_ACTION_WRITE_TOOLS) {
    set(name, {
      level: 'prompt',
      describe: (args) => {
        const url = (args as { url?: string } | null)?.url
        return url
          ? { key: 'describePageWriteUrl', params: { url } }
          : { key: 'describePageWrite' }
      },
      // The URL blacklist (page-action-auth.ts) is a separate hard pre-check;
      // memory is deliberately coarse — one grant covers page-action writes.
      memoryKey: () => 'page-action-write',
    })
  }

  // exec: the three-way decision itself is made by the native host
  // (execpolicy.json). The web side only receives the mapped result, so exec
  // does NOT go through getToolPolicy()/authorize() — exec.tool.ts maps
  // auto/prompt/forbidden directly onto the shared modal channel. The yolo
  // bypass is likewise handled INSIDE exec.tool.ts (prompt → auto), keeping
  // the forbidden gate before it; never route exec through authorize().
  set('exec', { level: 'auto' })

  // -- forbidden: LLM must never self-escalate ------------------------------
  set('switch_agent_mode', { level: 'forbidden' })

  return table
}

const POLICY_TABLE = createPolicyTable()

/** Look up a tool's policy. Unregistered tools default to auto (today's behavior). */
export function getToolPolicy(toolName: string): ToolPolicy {
  return POLICY_TABLE.get(toolName) ?? { level: 'auto' }
}

/** Test/diagnostic helper — the full table. */
export function getAllToolPolicies(): Map<string, ToolPolicy> {
  return POLICY_TABLE
}
