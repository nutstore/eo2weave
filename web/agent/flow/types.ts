/**
 * Flow Types — Lumen-style visual workflow data model.
 *
 * A flow is a DAG of nodes connected by edges. Each node is either a data
 * source (input), a processing step (tool / llm), a quality gate (review),
 * or a sink (output). Edges carry data from one node's output to the next
 * node's input.
 *
 * Two layers:
 * - FlowTemplate: project-level reusable definition (stored in SQLite)
 * - FlowInstance: a live copy attached to a conversation (stored in
 *   conversations.flow_instance_json)
 */

// ---------------------------------------------------------------------------
// Node kinds
// ---------------------------------------------------------------------------

export type FlowNodeKind = 'input' | 'tool' | 'llm' | 'review' | 'output' | 'router'

// ---------------------------------------------------------------------------
// Node configuration (discriminated by kind)
// ---------------------------------------------------------------------------

export interface InputNodeConfig {
  /** Source type for the input node */
  inputType: 'file' | 'text' | 'today'
  /** File path (for inputType: 'file'). Supports {{date}} {{today}} variables. */
  path?: string
  /** Static text content (for inputType: 'text') */
  value?: string
}

export interface ToolNodeConfig {
  /** Tool name from ToolRegistry, e.g. 'read', 'web_search', 'run_python', 'edit' */
  toolName: string
  /** Arguments for the tool. Values support {{var}} template references. */
  args?: Record<string, unknown>
}

export interface LlmNodeConfig {
  /** Prompt for the LLM. Supports {{input}} and {{nodeId}} references. */
  prompt: string
  /** Optional model override */
  model?: string
  /** Optional temperature override */
  temperature?: number
  /**
   * Output format. When 'json', the engine will:
   * 1. Append a "respond with valid JSON only" instruction to the prompt
   * 2. Parse the LLM response as JSON
   * 3. Store the parsed object so downstream nodes can access fields via {{field_name}}
   * Default: 'text' (raw string output).
   */
  outputFormat?: 'text' | 'json'
  /**
   * JSON schema description (for outputFormat: 'json').
   * Human-readable description of expected fields, injected into the prompt.
   * E.g. "title: string, score: number, tags: string[]"
   */
  jsonSchema?: string
}

export interface ReviewNodeConfig {
  /** Acceptance criteria, e.g. "no more than 200 characters, cover the key points" */
  criteria: string
  /** Minimum passing score (0-100), default 80 */
  minScore?: number
}

export interface OutputNodeConfig {
  /** File path to write (supports {{date}}). If omitted, result is kept as a card. */
  path?: string
}

export interface RouterRule {
  /** Human-readable label for this branch, e.g. "high quality" */
  label: string
  /**
   * Expression evaluated against the upstream output.
   * Supports {{var}} template references (resolved before evaluation).
   * Uses a restricted JS evaluator (no access to globals/DOM).
   * Use `true` for the catch-all / else branch.
   * Examples: '{{score}} >= 80', '{{status}} === "published"', '{{wordCount}} > 500'
   */
  expr: string
  /**
   * Label of the target downstream node that this rule routes to.
   * The engine matches this against outgoing edges' `conditionLabel`.
   * If not set, the first unmatched downstream edge is used (fallback).
   */
  targetLabel?: string
}

export interface RouterNodeConfig {
  /**
   * Ordered list of routing rules. The engine evaluates them top-to-bottom
   * and activates the FIRST rule whose `expr` is truthy. The matching rule's
   * `targetLabel` determines which downstream branch executes.
   */
  rules: RouterRule[]
}

export type FlowNodeConfig =
  | InputNodeConfig
  | ToolNodeConfig
  | LlmNodeConfig
  | ReviewNodeConfig
  | OutputNodeConfig
  | RouterNodeConfig

// ---------------------------------------------------------------------------
// Node & Edge
// ---------------------------------------------------------------------------

export interface FlowNode {
  id: string
  kind: FlowNodeKind
  label: string
  /** Canvas position (px) */
  position: { x: number; y: number }
  /** Kind-specific configuration */
  config: FlowNodeConfig
  /** Max retry count for this node (default 1) */
  retry?: number
}

export interface FlowEdge {
  /** Source node id */
  from: string
  /** Target node id */
  to: string
  /**
   * Variable name for the downstream reference. Defaults to the source node id.
   * E.g. if node n1 has outputKey "raw_note", the downstream can reference it
   * via {{raw_note}}. We auto-derive the varName from node id if not set.
   */
  varName?: string
  /** Whether this edge is a Review-loop back-edge (shown as red dashed). */
  isLoop?: boolean
  /**
   * Condition label for router-originated edges.
   * When a router node has multiple outgoing edges, each edge can carry a
   * `conditionLabel` that maps to a RouterRule.label. The router activates
   * only the edge whose conditionLabel matches the winning rule.
   * Edges without conditionLabel from a router are treated as the default
   * (catch-all) branch.
   */
  conditionLabel?: string
}

// ---------------------------------------------------------------------------
// Template (project-level, reusable)
// ---------------------------------------------------------------------------

export interface FlowTemplate {
  id: string
  /**
   * Project ID for isolation, or '__global__' for cross-project templates
   * that are shared across all projects.
   */
  projectId: string
  name: string
  description?: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  /** Entry node id (first node with no incoming edges, or explicitly set) */
  entryNodeId?: string
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Instance (attached to a conversation)
// ---------------------------------------------------------------------------

export type FlowRunStatus = 'idle' | 'running' | 'success' | 'error'

export interface FlowInstance {
  /** Conversation this instance belongs to */
  conversationId: string
  /** Template this instance was created from (null if built from scratch) */
  templateId: string | null
  nodes: FlowNode[]
  edges: FlowEdge[]
  entryNodeId?: string
  // Runtime state (not persisted, kept in store memory)
  lastRunAt?: number | null
  lastRunStatus?: FlowRunStatus
}

// ---------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------

export type FlowNodeStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

/**
 * A single step in an LLM node's execution trace.
 * Captures the agent's reasoning, tool calls, and tool results so the user
 * can inspect the full chain-of-thought and intermediate actions.
 */
export interface FlowNodeTraceStep {
  /** Step type */
  type: 'thinking' | 'tool_call' | 'tool_result' | 'text'
  /** Timestamp (ms) when this step occurred */
  timestamp: number
  /** For 'thinking': the reasoning text */
  thinking?: string
  /** For 'tool_call': tool name + arguments */
  toolName?: string
  toolArgs?: Record<string, unknown>
  /** For 'tool_result': the tool's output (truncated for display) */
  toolResult?: string
  /** For 'tool_result': whether the tool call errored */
  isError?: boolean
  /** For 'text': partial assistant text */
  text?: string
}

export interface FlowNodeRunResult {
  nodeId: string
  nodeLabel?: string
  nodeKind?: string
  status: FlowNodeStatus
  output?: unknown
  error?: string
  /** Review score (0-100), only for review nodes */
  score?: number
  /** Retry attempts made */
  attempts?: number
  /**
   * Execution trace for LLM/review nodes — captures reasoning, tool calls,
   * and tool results in chronological order.
   */
  trace?: FlowNodeTraceStep[]
}

export interface FlowRunResult {
  status: 'success' | 'error'
  /** Node-level results in execution order */
  nodeResults: FlowNodeRunResult[]
  /** Total execution time (ms) */
  durationMs: number
  /** Error message if status is 'error' */
  error?: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a unique node id */
export function generateNodeId(): string {
  return `n_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** Generate a unique template id */
export function generateTemplateId(): string {
  return `tpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

/** Infer the variable name for a node's output */
export function getNodeVarName(node: FlowNode): string {
  return node.id
}

/** Create an empty flow template */
export function createEmptyTemplate(projectId: string, name = '未命名工作流'): FlowTemplate {
  const now = Date.now()
  return {
    id: generateTemplateId(),
    projectId,
    name,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  }
}
