/**
 * Agent Mode System - defines read-only (Plan) and full-access (Act) modes.
 *
 * Plan mode: Only read-only tools are available (read, search, ls, etc.)
 * Act mode: All tools are available including write operations (write, edit, delete, etc.)
 */

/** Agent execution mode */
export type AgentMode = 'plan' | 'act'

/** Tool category for mode-based filtering */
export type ToolCategory = 'read' | 'write' | 'external'

/** Tool metadata for mode classification */
export interface ToolModeMetadata {
  /** Tool name */
  name: string
  /** Tool category: read-only or write */
  category: ToolCategory
  /** Description of what this tool does in plan mode (if different) */
  planModeDescription?: string
}

/**
 * Classification of built-in tools by category.
 * Read tools: Safe to use in Plan mode
 * Write tools: Only available in Act mode
 */
export const TOOL_MODE_CLASSIFICATION: Map<string, ToolModeMetadata> = new Map([
  // ============================================================================
  // READ-ONLY TOOLS (Available in Plan mode)
  // ============================================================================
  ['read', { name: 'read', category: 'read' }],
  ['search', { name: 'search', category: 'read' }],
  ['ls', { name: 'ls', category: 'read' }],
  ['run_python', {
    name: 'run_python',
    category: 'read',
    planModeDescription: 'Execute Python code in sandbox (read-only in plan mode - no file modifications persisted)'
  }],
  ['bash', {
    name: 'bash',
    category: 'read',
    planModeDescription: 'Execute read-only bash commands in sandbox (grep, cat, ls, etc. — writes blocked)'
  }],
  ['ocr', { name: 'ocr', category: 'read' }],
  
  // Snapshot read tools (OPFS change review — NOT real git)
  ['snapshot_status', { name: 'snapshot_status', category: 'read' }],
  ['snapshot_diff', { name: 'snapshot_diff', category: 'read' }],
  ['snapshot_log', { name: 'snapshot_log', category: 'read' }],
  ['snapshot_show', { name: 'snapshot_show', category: 'read' }],
  
  // Skill tools (read-only)
  ['read_skill', { name: 'read_skill', category: 'read' }],
  ['read_skill_resource', { name: 'read_skill_resource', category: 'read' }],
  ['search_skills', { name: 'search_skills', category: 'read' }],
  // Meta tools (read-only — no file modifications)
  ['ask_user_question', { name: 'ask_user_question', category: 'read' }],
  ['delegate_to', { name: 'delegate_to', category: 'read' }],
  // Subagent orchestration tools (read-only orchestration surface)
  ['search_conversations', { name: 'search_conversations', category: 'read' }],
  // Unified external tool bridge (search + call)
  ['search_tools', { name: 'search_tools', category: 'read' }],
  // call_tool reaches OUTSIDE the workspace (MCP/WebMCP servers, upstream
  // pages). It stays visible in plan mode so the agent can still probe
  // external info, but every invocation requires per-call user approval
  // (policy-engine authorize; plan mode never offers session memory).
  ['call_tool', {
    name: 'call_tool',
    category: 'external',
    planModeDescription: 'Execute external MCP/WebMCP tools (each call requires explicit user approval, even in plan mode)'
  }],
  // Web bridge tools (read-only — fetch external info, requires Browser Extension)
  ['web_search', { name: 'web_search', category: 'read' }],
  ['web_fetch', { name: 'web_fetch', category: 'read' }],
  // Page action read tools (read-only — inspect upstream page, requires Browser Extension + side panel)
  ['page_snapshot', { name: 'page_snapshot', category: 'read' }],
  ['page_text_content', { name: 'page_text_content', category: 'read' }],
  ['page_find_elements', { name: 'page_find_elements', category: 'read' }],
  ['page_synthesize_locators', { name: 'page_synthesize_locators', category: 'read' }],
  ['page_screenshot', { name: 'page_screenshot', category: 'read' }],
  ['spawn_subagent', { name: 'spawn_subagent', category: 'read' }],
  ['batch_spawn', { name: 'batch_spawn', category: 'read' }],
  ['send_message_to_subagent', { name: 'send_message_to_subagent', category: 'read' }],
  ['stop_subagent', { name: 'stop_subagent', category: 'read' }],
  ['resume_subagent', { name: 'resume_subagent', category: 'read' }],
  ['get_subagent_status', { name: 'get_subagent_status', category: 'read' }],
  ['list_subagents', { name: 'list_subagents', category: 'read' }],
  
  // ============================================================================
  // WRITE TOOLS (Only available in Act mode)
  // ============================================================================
  ['write', { name: 'write', category: 'write' }],
  ['edit', { name: 'edit', category: 'write' }],
  ['delete', { name: 'delete', category: 'write' }],
  
  // Snapshot write tools (OPFS undo/restore — NOT real git)
  ['snapshot_restore', { name: 'snapshot_restore', category: 'write' }],

  // Sync tools (writes to OPFS)
  ['sync-to-opfs', { name: 'sync-to-opfs', category: 'write' }],

  // Image generation — EXEMPT from the Plan-mode write gate (decided
  // 2026-09-10, image-generation PRD R2.3): the tool only writes generated
  // images into the OPFS assets directory (never workspace files), so Plan
  // mode can generate images directly. Classified 'read' following the same
  // precedent as run_python/bash (sandboxed side effects, safe in plan mode);
  // planModeDescription documents the limited write scope for UI/prompt use.
  ['generate_image', {
    name: 'generate_image',
    category: 'read',
    planModeDescription: 'Generate images into the assets directory (writes limited to OPFS assets — no workspace file modifications)',
  }],

  // Page action write tools (mutate upstream page — requires Browser Extension + side panel)
  ['page_click', { name: 'page_click', category: 'write' }],
  ['page_fill', { name: 'page_fill', category: 'write' }],
  ['page_type', { name: 'page_type', category: 'write' }],
  ['page_scroll', { name: 'page_scroll', category: 'write' }],
  ['page_evaluate', { name: 'page_evaluate', category: 'write' }],
])

/**
 * Get tool category by name.
 * Defaults to 'write' for safety (unknown tools are treated as write operations).
 */
export function getToolCategory(toolName: string): ToolCategory {
  const metadata = TOOL_MODE_CLASSIFICATION.get(toolName)
  return metadata?.category ?? 'write'
}

/**
 * Check if a tool is allowed in the given mode.
 */
export function isToolAllowedInMode(toolName: string, mode: AgentMode): boolean {
  if (mode === 'act') return true // Act mode allows all tools

  const category = getToolCategory(toolName)
  // 'external' tools (call_tool) stay visible in plan mode: plan is for
  // read-only EXPLORATION, which includes probing external sources. Safety
  // comes from the prompt-level authorization on every invocation (see
  // policy-engine), not from hiding the tool.
  return category === 'read' || category === 'external'
}

/**
 * Get list of allowed tool names for a given mode.
 */
export function getAllowedToolsForMode(mode: AgentMode, allTools: string[]): string[] {
  if (mode === 'act') return allTools
  return allTools.filter(tool => isToolAllowedInMode(tool, mode))
}

/**
 * Get mode display name for UI
 */
export function getModeDisplayName(mode: AgentMode): string {
  return mode === 'plan' ? 'Plan Mode' : 'Act Mode'
}

/**
 * Get mode description for UI
 */
export function getModeDescription(mode: AgentMode): string {
  return mode === 'plan'
    ? 'Read-only mode. Agent can analyze and plan but cannot modify files.'
    : 'Agent can read, write, and call external tools — every sensitive operation requires user confirmation.'
}

/**
 * Get icon for mode
 */
export function getModeIcon(mode: AgentMode): string {
  return mode === 'plan' ? '🔍' : '⚡'
}
