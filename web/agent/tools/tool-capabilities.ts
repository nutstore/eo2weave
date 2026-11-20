/**
 * Capability classes for tool surfaces handed to a subagent.
 *
 * Classes are coarse on purpose: a per-tool allowlist fails open, because a tool
 * added later is simply absent from the list and therefore "allowed" by nobody's
 * decision. Classes are assigned by kind, and — critically — an unmapped tool
 * falls back to `write`, the *most* restrictive class on the read-only axis.
 *
 * That default was earned, not chosen: a read-only probe agent still created a
 * workspace file through `run_python` because the tool was unmapped and fell
 * into `read`. Code execution is a write channel, and so is anything that
 * installs files, touches the DB, or restores a snapshot.
 */

export type ToolCapabilityClass = 'read' | 'write' | 'shell' | 'external' | 'orchestrate'

export const ALL_TOOL_CLASSES: readonly ToolCapabilityClass[] = [
  'read',
  'write',
  'shell',
  'external',
  'orchestrate',
]

/**
 * Arbitrary execution. These are not read-only in any enforceable sense: they
 * can write files, reach the network through the JS bridge, and run whatever the
 * model writes. Plan mode only *asks* them to stay read-only.
 */
const SHELL_TOOLS = new Set([
  'bash',
  'exec',
  'execute',
  'run_code',
  'run_python',
  'processes',
  'canvas_run', // executes a stored flow, i.e. runs arbitrary node prompts
])

/** Delegating further or steering other agents. */
const ORCHESTRATE_TOOLS = new Set([
  'spawn_subagent',
  'send_message_to_subagent',
  'stop_subagent',
  'resume_subagent',
  'get_subagent_status',
  'get_subagent_trace',
  'list_subagents',
  'delegate_to',
])

/** Reaching outside the workspace (third-party tools, upstream pages, web). */
const EXTERNAL_TOOLS = new Set(['call_tool', 'mcp_tasks', 'web_search', 'web_fetch'])

/** Mutating the workspace, the change set, the schedule, or an upstream page. */
const WRITE_TOOLS = new Set([
  'write',
  'edit',
  'delete',
  'sync-to-disk',
  'snapshot_restore',
  'rollback_checkpoint',
  'create_checkpoint',
  'db_query',
  'install_skill',
  'manage_schedule',
  'switch_agent_mode',
  'page_click',
  'page_fill',
  'page_type',
  'page_scroll',
  'page_evaluate',
  'canvas_create',
  'canvas_add_node',
  'canvas_connect',
  'canvas_update',
  'canvas_remove',
  'canvas_disconnect',
])

/**
 * Tools that only observe state. Everything here must be listed explicitly —
 * that is the whole point of the fail-closed default below.
 */
const READ_TOOLS = new Set([
  'read',
  'search',
  'ls',
  'ocr',
  'read_image',
  'snapshot_status',
  'snapshot_diff',
  'snapshot_log',
  'snapshot_show',
  'detect_conflicts',
  'read_skill',
  'read_skill_resource',
  'search_skills',
  'search_tools',
  'ask_user_question',
  'read_conversation_history',
  'search_conversations',
  'page_snapshot',
  'page_text_content',
  'page_find_elements',
  'page_synthesize_locators',
  'page_screenshot',
])

export function capabilityClassOf(toolName: string): ToolCapabilityClass {
  if (SHELL_TOOLS.has(toolName)) return 'shell'
  if (ORCHESTRATE_TOOLS.has(toolName)) return 'orchestrate'
  if (EXTERNAL_TOOLS.has(toolName)) return 'external'
  if (WRITE_TOOLS.has(toolName)) return 'write'
  if (READ_TOOLS.has(toolName)) return 'read'
  // Fail closed: an unclassified tool is treated as mutating until someone
  // classifies it. A read-only member simply cannot use it yet; that is the
  // safe direction to be wrong in.
  return 'write'
}

/**
 * Validate untrusted capability declarations (meta.json, tool arguments).
 * Unknown class names are rejected rather than ignored: a typo must not silently
 * widen or narrow the surface.
 */
export function parseCapabilityClasses(raw: unknown): ToolCapabilityClass[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw) || raw.length === 0) return undefined
  const classes: ToolCapabilityClass[] = []
  for (const value of raw) {
    if (typeof value !== 'string' || !ALL_TOOL_CLASSES.includes(value as ToolCapabilityClass)) {
      throw new Error(`Unknown tool capability class "${String(value)}". Allowed: ${ALL_TOOL_CLASSES.join(', ')}`)
    }
    if (!classes.includes(value as ToolCapabilityClass)) classes.push(value as ToolCapabilityClass)
  }
  return classes
}

/** Intersection of two optional class sets; `undefined` means "no restriction". */
export function intersectCapabilityClasses(
  a: readonly ToolCapabilityClass[] | undefined,
  b: readonly ToolCapabilityClass[] | undefined,
): ToolCapabilityClass[] | undefined {
  if (!a) return b ? [...b] : undefined
  if (!b) return [...a]
  const result = a.filter(className => b.includes(className))
  return result
}

export function isToolAllowedByClasses(
  toolName: string,
  classes: readonly ToolCapabilityClass[] | undefined,
): boolean {
  if (!classes) return true
  return classes.includes(capabilityClassOf(toolName))
}
