/**
 * Tool Registry - manages tool registration, lookup, and execution.
 *
 * Integrated with intelligent error handling for better user experience.
 * Supports mode-based tool filtering (Plan vs Act mode).
 */

import type { ToolDefinition, ToolExecutor, ToolEntry, ToolContext, ToolPromptDoc } from './tools/tool-types'
import { formatErrorForUser, withAutoRetry } from './error-handling'
import { isToolAllowedInMode, type AgentMode } from './agent-mode'
import { getToolPolicy, type ToolPolicy } from './policy-engine'
import { useSettingsStore } from '@/store/settings.store'

/**
 * Compatibility aliases for renamed tools. The canonical (new) name maps to
 * legacy names the LLM may still emit from older prompts/muscle memory.
 * Lookup by alias resolves to the canonical entry; execution reports the
 * canonical name in envelopes. Prune the alias after one compat cycle.
 */
const TOOL_ALIASES: Record<string, string> = {
  sync: 'sync-to-opfs', // renamed in PR-3 (tool authorization redesign)
}

// Import read tool
import { readDefinition, readExecutor, readPromptDoc } from './tools/read.tool'
// Import write tool
import { writeDefinition, writeExecutor, writePromptDoc } from './tools/write.tool'
import { deleteDefinition, deleteExecutor, deletePromptDoc } from './tools/delete.tool'
import { editDefinition, editExecutor, editPromptDoc } from './tools/file-edit.tool'
import { searchDefinition, searchExecutor, searchPromptDoc } from './tools/search.tool'
import { lsDefinition, lsExecutor, lsPromptDoc } from './tools/ls.tool'
import { pythonDefinition, pythonToolExecutor, pythonPromptDoc } from './tools/execute.tool'
// Bash shell tool (just-bash sandbox)
import { bashDefinition, bashToolExecutor, bashPromptDoc } from './tools/bash.tool'

// Snapshot tools (OPFS change review — NOT real git; real git goes through exec)
import {
  snapshotStatusDefinition,
  snapshotStatusExecutor,
  snapshotDiffDefinition,
  snapshotDiffExecutor,
  snapshotLogDefinition,
  snapshotLogExecutor,
  snapshotShowDefinition,
  snapshotShowExecutor,
  snapshotRestoreDefinition,
  snapshotRestoreExecutor,
  snapshotPromptDoc,
} from './tools/snapshot.tool'

// Import skill tools
import {
  readSkillDefinition,
  readSkillExecutor,
  readSkillResourceDefinition,
  readSkillResourceExecutor,
  skillPromptDoc,
} from '@/skills/skill-tools'

// Skill search tool (Skill Store discovery)
import { searchSkillsDefinition, searchSkillsExecutor, searchSkillsPromptDoc } from './tools/skill-search.tool'

// Skill install tool (installs from Skill Store after user consent)
import { installSkillDefinition, installSkillExecutor, installSkillPromptDoc } from './tools/install-skill.tool'

// Sync-to-OPFS tool (renamed from 'sync' in PR-3)
import { syncToOPFSDefinition, syncToOPFSExecutor, syncPromptDoc } from './tools/sync-opfs.tool'
// Sync-to-Disk tool (new in PR-3 — agent-initiated authorized disk flush)
import { syncToDiskDefinition, syncToDiskExecutor, syncToDiskPromptDoc } from './tools/sync-to-disk.tool'

// Switch mode tool
import { switchAgentModeDefinition, createSwitchModeExecutor, switchModePromptDoc } from './tools/switch-mode.tool'

// Ask user question tool
import {
  askUserQuestionDefinition,
  askUserQuestionExecutor,
  askUserQuestionPromptDoc,
} from './tools/ask-user-question.tool'

// Delegate to another agent persona (one-way handoff)
import {
  delegateToDefinition,
  delegateToExecutor,
  delegateToPromptDoc,
} from './tools/delegate.tool'

import {
  batchSpawnDefinition,
  batchSpawnExecutor,
  getSubagentStatusDefinition,
  getSubagentStatusExecutor,
  listSubagentsDefinition,
  listSubagentsExecutor,
  resumeSubagentDefinition,
  resumeSubagentExecutor,
  sendMessageToSubagentDefinition,
  sendMessageToSubagentExecutor,
  spawnSubagentDefinition,
  spawnSubagentExecutor,
  stopSubagentDefinition,
  stopSubagentExecutor,
  subagentPromptDoc,
} from './tools/subagent.tool'

// Changeset tools (checkpoint, sync, conflicts)
import {
  detectConflictsDefinition,
  detectConflictsExecutor,
  createCheckpointDefinition,
  createCheckpointExecutor,
  rollbackCheckpointDefinition,
  rollbackCheckpointExecutor,
  changesetPromptDoc,
} from './tools/changeset.tool'

// Cross-workspace conversation search
import {
  searchConversationsDefinition,
  searchConversationsExecutor,
  searchConversationsPromptDoc,
} from './tools/search-conversations.tool'

// Image reading tools
import { ocrDefinition, ocrExecutor, ocrPromptDoc } from './tools/ocr.tool'
import { readImageDefinition, readImageExecutor, readImagePromptDoc } from './tools/read-image.tool'
import { canvasToolDefinitions, canvasPromptDoc } from './tools/canvas.tool'
import { dbQueryTool } from './tools/db-query.tool'

// Web bridge tools (conditional — requires Browser Extension)
import {
  isWebBridgeAvailable,
  webSearchDefinition,
  webSearchExecutor,
  webFetchDefinition,
  webFetchExecutor,
  webBridgePromptDoc,
} from './tools/web-bridge.tool'

// Page action tools (conditional — requires Browser Extension + side panel)
import {
  pageSnapshotDefinition,
  pageSnapshotExecutor,
  pageTextContentDefinition,
  pageTextContentExecutor,
  pageFindElementsDefinition,
  pageFindElementsExecutor,
  pageSynthesizeLocatorsDefinition,
  pageSynthesizeLocatorsExecutor,
  pageScreenshotDefinition,
  pageScreenshotExecutor,
  pageReadPromptDoc,
} from './tools/page-read.tool'
import {
  pageClickDefinition,
  pageClickExecutor,
  pageFillDefinition,
  pageFillExecutor,
  pageTypeDefinition,
  pageTypeExecutor,
  pageScrollDefinition,
  pageScrollExecutor,
  pageEvaluateDefinition,
  pageEvaluateExecutor,
  pageWritePromptDoc,
} from './tools/page-write.tool'
import { isPageActionAvailable } from './tools/page-action-bridge'
import { supportsImageInput } from './llm/pi-ai-model-resolver'

// Exec tool — run shell commands via Native Host (Tier 1.5, conditional)
import {
  isExecBridgeAvailable,
  execDefinition,
  execExecutor,
  execPromptDoc,
} from './tools/exec.tool'

// Processes tool — inspect/manage background processes (conditional on exec bridge)
import {
  processesDefinition,
  processesExecutor,
  processesPromptDoc,
} from './tools/processes.tool'

// Image generation tool (conditional — requires image gen model in provider cache)
import {
  isImageGenAvailable,
  imageGenDefinition,
  imageGenExecutor,
  imageGenPromptDoc,
} from './tools/image-gen.tool'
import { onModelsUpdated } from './providers/model-store'

// Unified external tool bridge (replaces separate MCP + WebMCP tool pairs)
import {
  searchToolsDefinition,
  searchToolsExecutor,
  callToolDefinition,
  callToolExecutor,
  getPageToolsDefinition,
  getPageToolsExecutor,
  unifiedExternalToolsPromptDoc,
  getPageToolsPromptDoc,
} from './external-tool-bridge'
import { isSidePanelMode } from './workspace-assistant-context'

const BUILTIN_TOOLS: Array<{ definition: ToolDefinition; executor: ToolExecutor }> = [
  // Unified IO tools (read, write, edit)
  { definition: readDefinition, executor: readExecutor },
  { definition: writeDefinition, executor: writeExecutor },
  { definition: deleteDefinition, executor: deleteExecutor },
  { definition: editDefinition, executor: editExecutor },
  { definition: searchDefinition, executor: searchExecutor },
  // Directory & search
  { definition: lsDefinition, executor: lsExecutor },
  // Execution (unified)
  { definition: pythonDefinition, executor: pythonToolExecutor },
  // Bash shell (just-bash sandbox)
  { definition: bashDefinition, executor: bashToolExecutor },
  // Image reading
  { definition: ocrDefinition, executor: ocrExecutor },
  { definition: readImageDefinition, executor: readImageExecutor },
  // Visual workflow canvas tools
  ...canvasToolDefinitions.map((t) => ({ definition: t.definition, executor: t.executor })),
  // Dev: database query (full CRUD) — dev mode only
  ...(process.env.NODE_ENV !== 'production'
    ? [{ definition: dbQueryTool.definition, executor: dbQueryTool.executor }]
    : []),
  // Snapshot tools (OPFS change review — NOT real git; real git goes through exec)
  { definition: snapshotStatusDefinition, executor: snapshotStatusExecutor },
  { definition: snapshotDiffDefinition, executor: snapshotDiffExecutor },
  { definition: snapshotLogDefinition, executor: snapshotLogExecutor },
  { definition: snapshotShowDefinition, executor: snapshotShowExecutor },
  { definition: snapshotRestoreDefinition, executor: snapshotRestoreExecutor },
  // Sync native files to OPFS
  { definition: syncToOPFSDefinition, executor: syncToOPFSExecutor },
  // Agent-initiated pending-changes flush to real disk (prompt-authorized)
  { definition: syncToDiskDefinition, executor: syncToDiskExecutor },
  // Changeset & sync tools (detect_conflicts always available; checkpoint tools registered dynamically)
  { definition: detectConflictsDefinition, executor: detectConflictsExecutor },
  // Cross-workspace conversation search
  { definition: searchConversationsDefinition, executor: searchConversationsExecutor },
  // Meta tools
  { definition: switchAgentModeDefinition, executor: createSwitchModeExecutor() },
  { definition: askUserQuestionDefinition, executor: askUserQuestionExecutor },
  { definition: delegateToDefinition, executor: delegateToExecutor },
  { definition: spawnSubagentDefinition, executor: spawnSubagentExecutor },
  { definition: batchSpawnDefinition, executor: batchSpawnExecutor },
  { definition: sendMessageToSubagentDefinition, executor: sendMessageToSubagentExecutor },
  { definition: stopSubagentDefinition, executor: stopSubagentExecutor },
  { definition: resumeSubagentDefinition, executor: resumeSubagentExecutor },
  { definition: getSubagentStatusDefinition, executor: getSubagentStatusExecutor },
  { definition: listSubagentsDefinition, executor: listSubagentsExecutor },
]

/**
 * Prompt metadata for tool categorization and UI grouping.
 * Tool descriptions and parameters are sent to the model only through the
 * structured tool schemas, not duplicated in the system prompt.
 */
const ALL_PROMPT_DOCS: ToolPromptDoc[] = [
  readPromptDoc,
  writePromptDoc,
  editPromptDoc,
  deletePromptDoc,
  lsPromptDoc,
  searchPromptDoc,
  syncPromptDoc,
  syncToDiskPromptDoc,
  pythonPromptDoc,
  bashPromptDoc,
  ocrPromptDoc,
  readImagePromptDoc,
  canvasPromptDoc,
  snapshotPromptDoc,
  changesetPromptDoc,
  searchConversationsPromptDoc,
  subagentPromptDoc,
  switchModePromptDoc,
  askUserQuestionPromptDoc,
  delegateToPromptDoc,
  webBridgePromptDoc,
  skillPromptDoc,
  searchSkillsPromptDoc,
  installSkillPromptDoc,
  unifiedExternalToolsPromptDoc,
  getPageToolsPromptDoc,
  imageGenPromptDoc,
  pageReadPromptDoc,
  pageWritePromptDoc,
  execPromptDoc,
  processesPromptDoc,
]

export function getBuiltinToolNames(): string[] {
  return BUILTIN_TOOLS.map((tool) => tool.definition.function.name)
}

export class ToolRegistry {
  private tools = new Map<string, ToolEntry>()

  /** Resolve a possibly-aliased tool name to its canonical name. */
  resolveAlias(name: string): string {
    return TOOL_ALIASES[name] ?? name
  }

  /** Register a tool */
  register(definition: ToolDefinition, executor: ToolExecutor): void {
    const name = definition.function.name
    if (this.tools.has(name)) {
      console.warn(`[ToolRegistry] Overwriting existing tool: ${name}`)
    }
    this.tools.set(name, { definition, executor })
  }

  /** Unregister a tool */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /** Get all tool definitions (for LLM API), respecting feature flags */
  getToolDefinitions(): ToolDefinition[] {
    return this.filterByFeatureFlags(
      Array.from(this.tools.values()).map((entry) => entry.definition),
    )
  }

  /**
   * Get tool definitions filtered by agent mode and feature flags.
   * In 'plan' mode, only read-only tools are returned.
   * In 'act' mode, all tools are returned.
   */
  getToolDefinitionsForMode(mode: AgentMode): ToolDefinition[] {
    let definitions = Array.from(this.tools.values()).map((entry) => entry.definition)

    // Filter by feature flags first
    definitions = this.filterByFeatureFlags(definitions)

    if (mode === 'act') {
      return definitions
    }

    // Plan mode: filter to read-only tools only
    return definitions.filter(tool => isToolAllowedInMode(tool.function.name, mode))
  }

  /** Filter out tools disabled by feature flags (e.g. batch_spawn) */
  private filterByFeatureFlags(definitions: ToolDefinition[]): ToolDefinition[] {
    const { enableBatchSpawn } = useSettingsStore.getState()
    return definitions.filter(tool => {
      if (!enableBatchSpawn && tool.function.name === 'batch_spawn') return false
      return true
    })
  }

  /**
   * Check if a tool is available in the given mode.
   */
  isToolAvailableInMode(name: string, mode: AgentMode): boolean {
    if (!this.tools.has(name)) return false
    return isToolAllowedInMode(name, mode)
  }

  /**
   * Policy metadata for a registered tool (undefined when not registered).
   * Accepts aliases (e.g. legacy 'sync'). The policy table itself lives in
   * policy-engine.ts — this accessor makes it reachable through the registry
   * without duplicating the classification.
   */
  getPolicy(name: string): ToolPolicy | undefined {
    const canonical = this.resolveAlias(name)
    if (!this.tools.has(canonical)) return undefined
    return getToolPolicy(canonical)
  }

  /** Execute a tool by name with intelligent error handling */
  async execute(
    rawName: string,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<string> {
    const name = this.resolveAlias(rawName)
    const entry = this.tools.get(name)
    if (!entry) {
      return JSON.stringify({ error: `Unknown tool: ${rawName}` })
    }

    try {
      // Use auto-retry for transient errors
      return await withAutoRetry(async () => entry.executor(args, context))
    } catch (error) {
      // Format error for user consumption
      const userMessage = formatErrorForUser(error as string | Error)
      return JSON.stringify({ error: userMessage })
    }
  }

  /** Execute a tool without retry (for special cases) */
  async executeNoRetry(
    name: string,
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<string> {
    const entry = this.tools.get(name)
    if (!entry) {
      return JSON.stringify({ error: `Unknown tool: ${name}` })
    }

    try {
      return await entry.executor(args, context)
    } catch (error) {
      const userMessage = formatErrorForUser(error as string | Error)
      return JSON.stringify({ error: userMessage })
    }
  }

  /** Check if a tool is registered */
  has(name: string): boolean {
    return this.tools.has(name)
  }

  /** Get registered tool count */
  get size(): number {
    return this.tools.size
  }

  /** Register all built-in tools */
  registerBuiltins(): void {
    for (const tool of BUILTIN_TOOLS) {
      this.register(tool.definition, tool.executor)
    }
    // Register unified external tool bridge (search_tools + call_tool)
    // Replaces the old separate MCP + WebMCP tool pairs
    this.register(searchToolsDefinition, searchToolsExecutor)
    this.register(callToolDefinition, callToolExecutor)
    // Conditionally register image generation tool
    this.registerImageGenTool()
  }

  //=============================================================================
  // Web Bridge Tools (Browser Extension)
  //=============================================================================

  /**
   * Register web_search and web_fetch tools if the Browser Extension bridge
   * (window.__agentWeb) is detected. Safe to call multiple times.
   */
  registerWebBridgeTools(): boolean {
    if (!isWebBridgeAvailable()) return false
    if (this.has('web_search')) return true // Already registered

    this.register(webSearchDefinition, webSearchExecutor)
    this.register(webFetchDefinition, webFetchExecutor)
    console.log('[ToolRegistry] ✅ Web bridge tools registered (Browser Extension detected)')
    return true
  }

  /**
   * Unregister web bridge tools (e.g. when extension is disconnected).
   */
  unregisterWebBridgeTools(): void {
    this.unregister('web_search')
    this.unregister('web_fetch')
  }

  //=============================================================================
  // Checkpoint Tools (require native directory handle)
  //=============================================================================

  /**
   * Register create_checkpoint and rollback_checkpoint tools.
   * Called when a native directory handle is granted.
   */
  registerCheckpointTools(): void {
    if (this.has('create_checkpoint')) return // Already registered
    this.register(createCheckpointDefinition, createCheckpointExecutor)
    this.register(rollbackCheckpointDefinition, rollbackCheckpointExecutor)
    console.log('[ToolRegistry] ✅ Checkpoint tools registered (native directory handle available)')
  }

  /**
   * Unregister checkpoint tools.
   * Called when the native directory handle is released.
   */
  unregisterCheckpointTools(): void {
    this.unregister('create_checkpoint')
    this.unregister('rollback_checkpoint')
  }

  //=============================================================================
  // Page Action Tools (Browser Extension + side panel)
  //=============================================================================

  /**
   * Register page_snapshot / page_text_content / page_find_elements /
   * page_synthesize_locators (read) and page_click / page_fill / page_type /
   * page_scroll / page_evaluate (write) tools.
   *
   * All page-action tools are registered together (read + write). Mode-based
   * filtering is handled by getToolDefinitionsForMode() via TOOL_MODE_CLASSIFICATION:
   *   - Plan mode: only read tools (snapshot/text/find/synthesize) are visible to the LLM
   *   - Act mode: all tools (including click/fill/type/scroll/evaluate) are visible
   *
   * Per-call authorization (URL blacklist + session YOLO) is enforced inside
   * each write tool's executor via page-action-auth.resolveWriteAuthorization.
   *
   * Safe to call multiple times.
   */
  registerPageActionTools(): boolean {
    if (!isPageActionAvailable()) return false
    if (this.has('page_snapshot')) {
      // Already registered, but still re-check screenshot (model may have changed)
      this.registerPageScreenshotTool()
      return true
    }

    this.register(pageSnapshotDefinition, pageSnapshotExecutor)
    this.register(pageTextContentDefinition, pageTextContentExecutor)
    this.register(pageFindElementsDefinition, pageFindElementsExecutor)
    this.register(pageSynthesizeLocatorsDefinition, pageSynthesizeLocatorsExecutor)

    // Screenshot: conditional on vision support — re-evaluated on model change
    this.registerPageScreenshotTool()

    this.register(pageClickDefinition, pageClickExecutor)
    this.register(pageFillDefinition, pageFillExecutor)
    this.register(pageTypeDefinition, pageTypeExecutor)
    this.register(pageScrollDefinition, pageScrollExecutor)
    this.register(pageEvaluateDefinition, pageEvaluateExecutor)

    console.log('[ToolRegistry] ✅ Page action tools registered (Browser Extension + side panel; mode-filtered)')
    return true
  }

  /**
   * Conditionally register/unregister page_screenshot based on whether the
   * current model supports vision input. Called on initial registration AND
   * whenever the model changes (via the settings subscribe listener).
   */
  registerPageScreenshotTool(): void {
    const shouldHave = isPageActionAvailable() && this.isVisionModelAvailable()
    const has = this.has('page_screenshot')
    if (shouldHave && !has) {
      this.register(pageScreenshotDefinition, pageScreenshotExecutor)
      console.log('[ToolRegistry] ✅ page_screenshot registered (vision model detected)')
    } else if (!shouldHave && has) {
      this.unregister('page_screenshot')
      console.log('[ToolRegistry] page_screenshot unregistered (model does not support vision)')
    }
  }

  /**
   * Check if the current model supports image input (vision).
   * Uses the OpenRouter modality snapshot via supportsImageInput().
   */
  private isVisionModelAvailable(): boolean {
    try {
      const { modelName, providerType } = useSettingsStore.getState()
      if (!modelName) return false
      return supportsImageInput(modelName, providerType || undefined)
    } catch {
      return false
    }
  }

  //=============================================================================
  // Page Tools Fast Path (side-panel mode only)
  //=============================================================================

  /**
   * Register get_page_tools — the side-panel fast path to the current page's
   * WebMCP tool schemas. STRICTLY side-panel-gated: in regular workspace
   * sessions there is no bound upstream page, so the tool is never registered
   * (it would only ever return an error). Mirrors the register/unregister
   * pattern of registerPageActionTools — idempotent, safe to call every
   * getToolRegistry() access since side-panel mode can flip on mid-session.
   */
  registerPageToolsFastPath(): boolean {
    const shouldHave = isSidePanelMode()
    const has = this.has('get_page_tools')
    if (shouldHave && !has) {
      this.register(getPageToolsDefinition, getPageToolsExecutor)
      console.log('[ToolRegistry] ✅ get_page_tools registered (side-panel mode)')
      return true
    }
    if (!shouldHave && has) {
      this.unregister('get_page_tools')
      console.log('[ToolRegistry] get_page_tools unregistered (not in side-panel mode)')
    }
    return shouldHave
  }

  /**
   * Unregister page action tools (e.g. when leaving side-panel mode
   * or when feature flags are toggled off).
   */
  unregisterPageActionTools(): void {
    this.unregister('page_snapshot')
    this.unregister('page_text_content')
    this.unregister('page_find_elements')
    this.unregister('page_synthesize_locators')
    this.unregister('page_click')
    this.unregister('page_fill')
    this.unregister('page_type')
    this.unregister('page_scroll')
    this.unregister('page_evaluate')
  }

  //=============================================================================
  // Exec Tool (Native Host — Tier 1.5 command execution)
  //=============================================================================

  /**
   * Register the exec tool if the Native Host exec bridge is available.
   * This lets the agent run shell commands (tests, builds, linters) on the
   * user's machine via the authorized native-host root.
   * Safe to call multiple times.
   */
  registerExecTool(): boolean {
    if (!isExecBridgeAvailable()) return false
    if (!this.has('exec')) {
      this.register(execDefinition, execExecutor)
      console.log('[ToolRegistry] ✅ Exec tool registered (Native Host bridge detected)')
    }
    // Background-process management rides along with the exec bridge.
    if (!this.has('processes')) {
      this.register(processesDefinition, processesExecutor)
      console.log('[ToolRegistry] ✅ Processes tool registered')
    }
    return true
  }

  /** Unregister the exec tool (e.g. when native host disconnects). */
  unregisterExecTool(): void {
    this.unregister('exec')
    this.unregister('processes')
  }

  //=============================================================================
  // Image Generation Tool (conditional — requires model in provider cache)
  //=============================================================================

  /**
   * Register the generate_image tool if the image gen model is available
   * in the current provider's model cache. Safe to call multiple times.
   */
  registerImageGenTool(): boolean {
    if (!isImageGenAvailable()) {
      // If previously registered, unregister it
      if (this.has('generate_image')) {
        this.unregister('generate_image')
        console.log('[ToolRegistry] generate_image tool unregistered (model no longer available)')
      }
      return false
    }
    if (this.has('generate_image')) return true // Already registered

    this.register(imageGenDefinition, imageGenExecutor)
    console.log('[ToolRegistry] ✅ Image generation tool registered')
    return true
  }

  /**
   * Unregister the image generation tool.
   */
  unregisterImageGenTool(): void {
    this.unregister('generate_image')
  }

  //=============================================================================
  // Skill Tools
  //=============================================================================

  /**
   * Register skill tools
   */
  registerSkillTools(): void {
    this.register(readSkillDefinition, readSkillExecutor)
    this.register(readSkillResourceDefinition, readSkillResourceExecutor)
    this.register(searchSkillsDefinition, searchSkillsExecutor)
    this.register(installSkillDefinition, installSkillExecutor)
  }

  /**
   * Unregister skill tools
   */
  unregisterSkillTools(): void {
    this.unregister('read_skill')
    this.unregister('read_skill_resource')
  }
}

/** Singleton instance */
let instance: ToolRegistry | null = null

/** Whether we've set up the model-cache listener for image gen tool */
let imageGenListenerSetup = false

// ─── Tool change notification (for UI reactivity) ─────────────────────────────

const toolChangeListeners = new Set<() => void>()
let toolChangeVersion = 0

/** Subscribe to tool registration/unregistration changes. Returns unsubscribe fn. */
export function onToolsChanged(listener: () => void): () => void {
  toolChangeListeners.add(listener)
  return () => toolChangeListeners.delete(listener)
}

/** Get current tool change version (incremented on each change). Useful as React key/dep. */
export function getToolChangeVersion(): number {
  return toolChangeVersion
}

function notifyToolsChanged(): void {
  toolChangeVersion++
  for (const listener of toolChangeListeners) {
    try { listener() } catch (err) { console.error('[ToolRegistry] Listener error:', err) }
  }
}

/** Ensure the model-cache listener is registered (called once). */
function ensureImageGenListener(): void {
  if (imageGenListenerSetup) return
  imageGenListenerSetup = true

  // Re-check image gen availability when models are cached/updated
  onModelsUpdated(() => {
    if (instance) {
      const had = instance.has('generate_image')
      instance.registerImageGenTool()
      const has = instance.has('generate_image')
      if (had !== has) notifyToolsChanged()
    }
  })

  // Re-check image gen availability when provider changes
  // (e.g. switching from OpenRouter to Codex OAuth should unregister generate_image)
  useSettingsStore.subscribe((state, prev) => {
    if (state.providerType !== prev.providerType) {
      if (instance) {
        const had = instance.has('generate_image')
        instance.registerImageGenTool()
        const has = instance.has('generate_image')
        if (had !== has) notifyToolsChanged()
      }
    }
  })

  // Re-check page_screenshot when the model name changes
  // (vision support depends on the specific model)
  useSettingsStore.subscribe((state, prev) => {
    if (state.modelName !== prev.modelName) {
      if (instance) {
        const had = instance.has('page_screenshot')
        instance.registerPageScreenshotTool()
        const has = instance.has('page_screenshot')
        if (had !== has) notifyToolsChanged()
      }
    }
  })

  // Also re-check when models are cached/updated (modalities may load late)
  onModelsUpdated(() => {
    if (instance) {
      const had = instance.has('page_screenshot')
      instance.registerPageScreenshotTool()
      const has = instance.has('page_screenshot')
      if (had !== has) notifyToolsChanged()
    }
  })
}

export function getToolRegistry(): ToolRegistry {
  if (!instance) {
    instance = new ToolRegistry()
    instance.registerBuiltins()
    instance.registerSkillTools()
    // Conditionally register web bridge tools (Browser Extension)
    instance.registerWebBridgeTools()
    // Conditionally register exec tool (Native Host Tier 1.5)
    instance.registerExecTool()
    // Conditionally register page action tools (Browser Extension + side panel)
    instance.registerPageActionTools()
    // Conditionally register get_page_tools (side-panel mode only)
    instance.registerPageToolsFastPath()
    // Set up listener for model cache updates (triggers image gen tool re-registration)
    ensureImageGenListener()
  } else {
    // Try to register web bridge tools on every access (extension may have been
    // installed after page load). registerWebBridgeTools() is idempotent — it
    // checks both availability and existing registration.
    instance.registerWebBridgeTools()
    // Also try exec tool (native host may have been installed after page load)
    instance.registerExecTool()
    // Also try page action tools (side-panel mode may have just become active)
    instance.registerPageActionTools()
    // Re-check get_page_tools (side-panel mode may have flipped mid-session)
    instance.registerPageToolsFastPath()
    // Also re-check image gen tool on every access
    instance.registerImageGenTool()
  }
  return instance
}

/**
 * Build a map from tool name → { section, category } for UI grouping.
 * Each entry comes from the tool's ToolPromptDoc.
 */
export function getToolCategoryMap(): Map<string, { section: string; category: string }> {
  const result = new Map<string, { section: string; category: string }>()
  // Map tool names from definitions back to their prompt doc section
  // We derive this from ALL_PROMPT_DOCS + BUILTIN_TOOLS ordering
  const registry = getToolRegistry()
  const names = registry.getToolDefinitions().map((d) => d.function.name)
  for (const doc of ALL_PROMPT_DOCS) {
    const section = doc.section ?? `### ${doc.category.charAt(0).toUpperCase() + doc.category.slice(1)}`
    // Extract tool names from doc lines (e.g. "- `read(path)`" → "read")
    for (const line of doc.lines) {
      const m = line.match(/^- `(\w+)/)
      if (m && names.includes(m[1]!)) {
        result.set(m[1]!, { section, category: doc.category })
      }
    }
  }
  return result
}
