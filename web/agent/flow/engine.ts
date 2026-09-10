/**
 * Flow Engine — DAG execution engine for visual workflows.
 *
 * Executes a flow by:
 * 1. Topologically sorting nodes (ignoring loop edges)
 * 2. For each node, resolving template variables from upstream outputs
 * 3. Executing the node (tool call, LLM call, file read/write, review)
 * 4. Storing the output for downstream nodes
 * 5. Handling review-loop retries
 *
 * The engine is decoupled from React and the store — it takes a flow
 * definition and a context, returns run results via callbacks.
 */

import { getToolRegistry } from '@/agent/tool-registry'
import { AgentLoop } from '@/agent/agent-loop'
import { ContextManager } from '@/agent/context-manager'
import { createLLMProvider } from '@/agent/llm/provider-factory'
import { resolveArgs, resolveDateVars } from './template-resolver'
import { extractTextContent } from '@/agent/loop/message-mappers'
import { generateId, type Message } from '@/agent/message-types'
import type { ToolContext } from '@/agent/tools/tool-types'
import type {
  FlowNode,
  FlowEdge,
  FlowInstance,
  FlowNodeRunResult,
  FlowRunResult,
  FlowNodeTraceStep,
  RouterNodeConfig,
  RouterRule,
} from './types'

// ---------------------------------------------------------------------------
// NodeOutputStore — stores outputs for cross-node variable resolution
// ---------------------------------------------------------------------------

export class NodeOutputStore {
  private store = new Map<string, unknown>()

  set(nodeId: string, output: unknown): void {
    this.store.set(nodeId, output)
  }

  get(nodeId: string): unknown {
    return this.store.get(nodeId)
  }

  /** Get all variables as a Map for template resolution */
  toVariables(): Map<string, unknown> {
    return new Map(this.store)
  }

  /**
   * Get the "input" alias — the output of the first upstream node.
   * Determined by the edges passed in.
   *
   * When there is exactly one upstream node, its output is returned directly
   * (preserves existing single-input behaviour).
   */
  getInputAlias(nodeId: string, edges: FlowEdge[]): unknown {
    const upstreamIds = edges
      .filter((e) => e.to === nodeId && !e.isLoop)
      .map((e) => e.from)
    const outputs = upstreamIds
      .map((id) => this.store.get(id))
      .filter((v) => v !== undefined)
    return outputs.length > 0 ? outputs[0] : undefined
  }

  /**
   * Get all upstream outputs for a node, keyed by node label.
   *
   * Used by multi-input (fan-in / join) nodes to receive the full set of
   * upstream outputs rather than just the first one. Each upstream node's
   * label is used as the key so the consuming prompt reads naturally.
   *
   * Returns a structured object like `{ "分析A": "...", "分析B": "..." }`,
   * or `undefined` when there are no upstream outputs.
   */
  getAllUpstreamOutputs(nodeId: string, edges: FlowEdge[], nodes: FlowNode[]): Record<string, string> | undefined {
    const upstreamIds = edges
      .filter((e) => e.to === nodeId && !e.isLoop)
      .map((e) => e.from)
    const entries: Array<[string, string]> = []
    for (const upId of upstreamIds) {
      const val = this.store.get(upId)
      if (val === undefined) continue
      const node = nodes.find((n) => n.id === upId)
      const label = node?.label || upId
      // De-duplicate labels that collide across upstream nodes.
      const used = new Set(entries.map((e) => e[0]))
      const uniqueLabel = used.has(label) ? `${label} (${upId.slice(0, 4)})` : label
      entries.push([uniqueLabel, formatUpstreamData(val)])
    }
    if (entries.length === 0) return undefined
    return Object.fromEntries(entries)
  }
}

// ---------------------------------------------------------------------------
// Engine options
// ---------------------------------------------------------------------------

export interface RunFlowOptions {
  /** The flow to execute */
  flow: FlowInstance
  /** Tool execution context (from conversation/workspace) */
  context: ToolContext
  /** LLM configuration */
  llm: {
    apiKey: string
    providerType: string
    baseUrl: string
    model: string
    apiMode?: 'chat-completions' | 'responses'
  }
  /** User-provided initial input (for the first node that references {{input}}) */
  userInput?: string
  /** Abort signal */
  abortSignal?: AbortSignal

  // Progress callbacks
  onNodeStart?: (nodeId: string, kind: FlowNode['kind']) => void
  onNodeComplete?: (nodeId: string, output: unknown) => void
  onNodeError?: (nodeId: string, error: string) => void
  /** Called immediately after each node finishes (with full result incl. trace). */
  onNodeResult?: (result: FlowNodeRunResult) => void
}

export async function runFlow(options: RunFlowOptions): Promise<FlowRunResult> {
  const { flow, context, llm, abortSignal } = options
  const startTime = Date.now()
  const outputStore = new NodeOutputStore()
  const nodeResults: FlowNodeRunResult[] = []

  // Build layered execution order (nodes within a layer run in parallel)
  const layers = topoSortLayered(flow.nodes, flow.edges)

  // Group loop edges for review handling: reviewNodeId → upstreamNodeId
  const loopTargets = new Map<string, string>() // reviewId → retryTargetId
  for (const edge of flow.edges) {
    if (edge.isLoop) {
      loopTargets.set(edge.from, edge.to)
    }
  }

  // Seed the output store with user-provided input, available as {{input}}
  // for the first node (entry node with no upstream).
  if (options.userInput) {
    outputStore.set('__user_input__', options.userInput)
  }

  // ── Router conditional routing ──
  // When a router node selects a branch, all OTHER downstream branches are
  // added to this set and skipped entirely during execution.
  const skippedNodes = new Set<string>()

  try {
    for (const layer of layers) {
      if (abortSignal?.aborted) throw new Error('Flow aborted')

      // Filter out skipped nodes (from router branch decisions)
      const activeNodeIds = layer.filter((id) => !skippedNodes.has(id))

      // Mark skipped nodes in this layer as 'skipped' in results
      for (const skippedId of layer) {
        if (skippedNodes.has(skippedId)) {
          const skipNode = flow.nodes.find((n) => n.id === skippedId)
          const skipResult: FlowNodeRunResult = {
            nodeId: skippedId,
            nodeLabel: skipNode?.label,
            nodeKind: skipNode?.kind,
            status: 'skipped',
          }
          nodeResults.push(skipResult)
          options.onNodeResult?.(skipResult)
        }
      }

      // Execute all (non-skipped) nodes in this layer in parallel
      const layerResults = await Promise.all(
        activeNodeIds.map(async (nodeId) => {
          const node = flow.nodes.find((n) => n.id === nodeId)
          if (!node) return null

          const inputAlias = outputStore.getInputAlias(nodeId, flow.edges)
          // Collect ALL upstream outputs (multi-input fan-in / join support).
          const allUpstream = outputStore.getAllUpstreamOutputs(nodeId, flow.edges, flow.nodes)

          // For entry nodes (no upstream), use user input as {{input}} if available
          const hasUpstream = flow.edges.some((e) => e.to === nodeId && !e.isLoop)
          const effectiveInput = (!hasUpstream && options.userInput)
            ? options.userInput
            : inputAlias

          // Execute node
          return executeNode(node, {
            context,
            llm,
            outputStore,
            inputAlias: effectiveInput,
            upstreamOutputs: allUpstream,
            nodes: flow.nodes,
            abortSignal,
            loopTargets,
            onNodeStart: options.onNodeStart,
            onNodeComplete: options.onNodeComplete,
            onNodeError: options.onNodeError,
            onNodeResult: options.onNodeResult,
            nodeResults,
          })
        })
      )

      // Check for failures in this layer
      for (const result of layerResults) {
        if (!result) continue
        nodeResults.push(result)
        // Push each completed node's result to the callback immediately
        options.onNodeResult?.(result)
        if (result.status === 'failed') {
          return {
            status: 'error',
            nodeResults,
            durationMs: Date.now() - startTime,
            error: result.error,
          }
        }
      }

      // ── Process router branch decisions after each layer ──
      // For each completed router node, evaluate its rules against the upstream
      // output and mark non-matching downstream branches as skipped.
      for (const result of layerResults) {
        if (!result || result.status !== 'completed') continue
        const node = flow.nodes.find((n) => n.id === result.nodeId)
        if (!node || node.kind !== 'router') continue

        const routerConfig = node.config as RouterNodeConfig
        if (!routerConfig.rules?.length) continue

        // Resolve the winning rule.
        // If the upstream output is a JSON object, flatten its top-level fields
        // into the outputStore so rules can reference them directly, e.g.
        // `{{score}} >= 80` instead of the unwieldy `{{n_xxx.score}}`.
        const inputAlias = outputStore.getInputAlias(node.id, flow.edges)
        if (inputAlias !== null && typeof inputAlias === 'object' && !Array.isArray(inputAlias)) {
          for (const [key, val] of Object.entries(inputAlias as Record<string, unknown>)) {
            outputStore.set(key, val)
          }
        }
        const winningRule = resolveRouterRule(routerConfig.rules, inputAlias, outputStore)
        const winningLabel = winningRule?.label

        // Find all outgoing edges from this router
        const outEdges = flow.edges.filter((e) => e.from === node.id && !e.isLoop)

        // If no winning rule found (e.g. no rule matched and no 'true' catch-all),
        // skip ALL downstream branches.
        if (!winningLabel) {
          for (const edge of outEdges) {
            markBranchSkipped(edge.to, flow.nodes, flow.edges, skippedNodes)
          }
          continue
        }

        // Otherwise: skip branches whose conditionLabel does NOT match the winning rule.
        // An edge with no conditionLabel is treated as the default/catch-all branch —
        // it is skipped unless it's the only outgoing edge.
        for (const edge of outEdges) {
          const edgeLabel = edge.conditionLabel
          if (edgeLabel === winningLabel) continue // keep the matching branch
          // If the winning rule has a targetLabel, also match by that
          if (winningRule?.targetLabel) {
            const targetNode = flow.nodes.find((n) => n.id === edge.to)
            if (targetNode?.label === winningRule.targetLabel) continue
          }
          markBranchSkipped(edge.to, flow.nodes, flow.edges, skippedNodes)
        }
      }
    }

    return {
      status: 'success',
      nodeResults,
      durationMs: Date.now() - startTime,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return {
      status: 'error',
      nodeResults,
      durationMs: Date.now() - startTime,
      error: msg,
    }
  }
}

// ---------------------------------------------------------------------------
// Per-node execution
// ---------------------------------------------------------------------------

interface ExecuteNodeParams {
  context: ToolContext
  llm: RunFlowOptions['llm']
  outputStore: NodeOutputStore
  inputAlias: unknown
  /** All upstream outputs keyed by node label (for multi-input fan-in). */
  upstreamOutputs?: Record<string, string>
  abortSignal?: AbortSignal
  loopTargets: Map<string, string>
  /** The flow's node list — lets review nodes locate their retry target. */
  nodes: FlowNode[]
  onNodeStart?: (nodeId: string, kind: FlowNode['kind']) => void
  onNodeComplete?: (nodeId: string, output: unknown) => void
  onNodeError?: (nodeId: string, error: string) => void
  onNodeResult?: (result: FlowNodeRunResult) => void
  nodeResults: FlowNodeRunResult[]
}

async function executeNode(
  node: FlowNode,
  params: ExecuteNodeParams
): Promise<FlowNodeRunResult> {
  const { context, llm, outputStore, inputAlias, upstreamOutputs } = params
  const config = node.config as Record<string, unknown>
  const variables = outputStore.toVariables()

  params.onNodeStart?.(node.id, node.kind)

  try {
    let output: unknown
    let score: number | undefined
    let nodeTrace: FlowNodeTraceStep[] | undefined

    switch (node.kind) {
      // ── Input nodes ──
      case 'input': {
        const inputType = config.inputType as string
        if (inputType === 'today') {
          const path = `Daily/${todayStr()}.md`
          output = await callTool('read', { path }, context)
        } else if (inputType === 'file') {
          const rawPath = (config.path as string) || ''
          const path = resolveDateVars(rawPath)
          output = await callTool('read', { path }, context)
        } else {
          output = config.value ?? ''
        }
        break
      }

      // ── Tool nodes ──
      case 'tool': {
        const toolName = (config.toolName as string) || 'read'
        const resolvedArgs = resolveArgs(
          config.args as Record<string, unknown> | undefined,
          variables,
          inputAlias
        )
        output = await callTool(toolName, resolvedArgs, context)
        break
      }

      // ── LLM nodes (full agent: tools, skills, MCP, context management) ──
      case 'llm': {
        const rawPrompt = (config.prompt as string) || ''
        const resolvedPrompt = resolveArgs(
          { prompt: rawPrompt },
          variables,
          inputAlias
        ).prompt as string

        // Build the user message with upstream data appended.
        // For multi-input (fan-in) nodes, list every upstream node by label;
        // for single-input nodes, keep the flat "上游数据" block unchanged.
        const upstreamData = buildUpstreamSection(inputAlias, upstreamOutputs)

        // Append JSON format instruction if outputFormat is 'json'
        const outputFormat = (config.outputFormat as string) ?? 'text'
        const jsonSchema = (config.jsonSchema as string) || ''
        let finalPrompt = resolvedPrompt
        if (outputFormat === 'json') {
          finalPrompt += '\n\n请仅输出合法的 JSON，不要包含 markdown 代码块标记。'
          if (jsonSchema) {
            finalPrompt += `\nJSON 结构要求：${jsonSchema}`
          }
        }

        const userMessage = upstreamData
          ? `${finalPrompt}\n\n---\n${upstreamData}`
          : finalPrompt

        const agentResult = await runAgentNode(llm, userMessage, params.context, params.abortSignal)
        const rawOutput = agentResult.output
        nodeTrace = agentResult.trace

        // Parse JSON output if outputFormat is 'json'
        if (outputFormat === 'json') {
          try {
            // Extract JSON from response (handle markdown code blocks)
            const jsonStr = extractJson(rawOutput)
            output = JSON.parse(jsonStr)
          } catch {
            // If parsing fails, keep raw text as output
            output = rawOutput
          }
        } else {
          output = rawOutput
        }
        break
      }

      // ── Review nodes (also use full agent for structured scoring) ──
      case 'review': {
        const criteria = (config.criteria as string) || '符合质量要求'
        const minScore = (config.minScore as number) ?? 80
        const maxRetries = node.retry ?? 1
        // For review nodes, present upstream outputs as a labelled list when
        // there are multiple (matches the llm-node behaviour), without the
        // "上游数据：" header since the review prompt adds its own "待审内容：".
        let currentUpstreamData = formatUpstreamForReview(inputAlias, upstreamOutputs)

        // Find the upstream node to re-run on failure (via loop edge)
        const retryTargetId = params.loopTargets.get(node.id)
        const retryNode = retryTargetId
          ? params.nodes.find((n) => n.id === retryTargetId)
          : undefined

        let attempt = 0
        let reviewResult = ''
        let parsed: { score: number; passed: boolean; issues: string[] } = { score: 0, passed: false, issues: [] }

        // Review loop: evaluate → if fail and retry available → re-run upstream → re-evaluate
        // eslint-disable-next-line no-constant-condition -- bounded retry loop, exits via break when review passes or retries are exhausted
        while (true) {
          const reviewPrompt = `你是质量评审员。请根据以下标准评审内容：\n\n验收标准：${criteria}\n\n待审内容：\n${currentUpstreamData}\n\n请返回 JSON 格式：{"score": 数字, "passed": 布尔, "issues": [问题列表]}`
          const agentResult = await runAgentNode(
            llm,
            reviewPrompt,
            params.context,
            params.abortSignal
          )
          reviewResult = agentResult.output
          nodeTrace = agentResult.trace
          parsed = parseReviewScore(reviewResult)
          score = parsed.score

          // Passed?
          if (parsed.score >= minScore && parsed.passed) {
            break // success
          }

          // Failed — can we retry?
          if (attempt >= maxRetries || !retryNode) {
            params.onNodeError?.(node.id, `评审未通过 (得分 ${parsed.score}/${minScore})，已用完重试次数`)
            break // no more retries
          }

          // Retry: re-run the upstream node with feedback
          attempt++
          params.onNodeError?.(node.id, `评审未通过 (得分 ${parsed.score}/${minScore})，重试 ${attempt}/${maxRetries}`)

          // Build feedback prompt for the upstream retry
          const feedback = `上一次的输出未通过质量评审。\n\n评审反馈：${parsed.issues.join('；') || '未达标'}\n\n请重新生成，注意改进上述问题。\n\n原始要求：\n${(retryNode.config as Record<string, unknown>).prompt ?? ''}`

          // Re-run the upstream node
          const retryAgentResult = await runAgentNode(
            llm,
            feedback,
            params.context,
            params.abortSignal
          )
          const retryOutput = retryAgentResult.output
          // Update output store so downstream sees the improved version
          outputStore.set(retryNode.id, retryOutput)
          // Use the improved output for the next review
          currentUpstreamData = retryOutput

          // Merge trace from the (re-)run that produced the improved output
          if (retryAgentResult.trace) {
            nodeTrace = [...(nodeTrace ?? []), ...retryAgentResult.trace]
          }
        }

        if (parsed.score >= minScore && parsed.passed) {
          // Review passed — pass through the (possibly improved) upstream data
          output = currentUpstreamData
        } else {
          // Review gate FAILED after retries — block the pipeline instead of
          // silently passing a "failed review" blob downstream.
          throw new Error(
            `评审未通过 (得分 ${parsed.score}/${minScore})：${parsed.issues.join('；') || '不符合验收标准'}`
          )
        }
        break
      }

      // ── Output nodes ──
      case 'output': {
        const rawPath = (config.path as string) || ''
        if (rawPath) {
          const path = resolveDateVars(rawPath)
          // Multi-input: include all upstream outputs in the written file;
          // single-input: write just that output.
          const content = upstreamOutputs && Object.keys(upstreamOutputs).length > 1
            ? buildUpstreamSection(inputAlias, upstreamOutputs)
            : formatUpstreamData(inputAlias)
          output = await callTool('write', { path, content }, context)
        } else {
          output = inputAlias
        }
        break
      }

      // ── Router nodes (conditional branching) ──
      // The router itself doesn't produce a new value — it passes through the
      // upstream output. The actual branch decision (which downstream nodes
      // to activate / skip) is handled by the layer loop in runFlow() after
      // this node completes.
      case 'router': {
        // Pass through the upstream data unchanged.
        output = inputAlias
        break
      }

      default:
        output = null
    }

    outputStore.set(node.id, output)
    params.onNodeComplete?.(node.id, output)

    return {
      nodeId: node.id,
      nodeLabel: node.label,
      nodeKind: node.kind,
      status: 'completed',
      output,
      score,
      trace: nodeTrace,
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    params.onNodeError?.(node.id, msg)
    return {
      nodeId: node.id,
      nodeLabel: node.label,
      nodeKind: node.kind,
      status: 'failed',
      error: msg,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Topological sort with layer grouping for parallel execution.
 * Returns an array of layers, where each layer is an array of node ids
 * that can execute in parallel. Nodes within a layer have no dependency
 * on each other.
 */
function topoSortLayered(nodes: FlowNode[], edges: FlowEdge[]): string[][] {
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const node of nodes) {
    inDegree.set(node.id, 0)
    adjacency.set(node.id, [])
  }

  for (const edge of edges) {
    if (edge.isLoop) continue
    const deg = inDegree.get(edge.to)
    const neighbors = adjacency.get(edge.from)
    if (deg !== undefined && neighbors) {
      neighbors.push(edge.to)
      inDegree.set(edge.to, deg + 1)
    }
  }

  const layers: string[][] = []
  let currentLayer = nodes
    .filter((n) => (inDegree.get(n.id) ?? 0) === 0)
    .map((n) => n.id)

  while (currentLayer.length > 0) {
    layers.push(currentLayer)
    const nextLayer: string[] = []
    for (const id of currentLayer) {
      for (const neighbor of adjacency.get(id) || []) {
        const d = inDegree.get(neighbor)
        if (d !== undefined) {
          inDegree.set(neighbor, d - 1)
          if (d - 1 === 0) nextLayer.push(neighbor)
        }
      }
    }
    currentLayer = nextLayer
  }

  // Fallback: any nodes not visited (shouldn't happen in valid DAG)
  const visited = new Set(layers.flat())
  const remaining = nodes.filter((n) => !visited.has(n.id)).map((n) => n.id)
  if (remaining.length > 0) layers.push(remaining)

  return layers
}

// ---------------------------------------------------------------------------
// Router condition evaluation helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate a router rule's expression against the upstream output.
 *
 * The expression supports `{{var}}` template references which are resolved
 * from the NodeOutputStore (upstream node outputs) before evaluation.
 *
 * Unlike prompt-template resolution, values are inserted with type-awareness:
 * - numbers/booleans → inserted as-is (`{{score}}` → `75`)
 * - strings → wrapped in quotes (`{{status}}` → `"review"`)
 * This makes expressions like `{{status}} === "published"` work correctly.
 *
 * The resolved expression is then evaluated in a restricted scope.
 *
 * @returns `true` if the expression evaluates to a truthy value.
 */
function evaluateRuleExpr(
  expr: string,
  inputAlias: unknown,
  outputStore: NodeOutputStore
): boolean {
  const variables = outputStore.toVariables()

  // We do manual replacement because the prompt-template resolver doesn't
  // add quotes around string values (correct for prompts, wrong for expressions).
  const exprResolved = expr.replace(/{{(\w+)}}/g, (_match, varName: string) => {
    let val: unknown
    if (varName === 'input') {
      val = inputAlias
    } else {
      val = variables.get(varName)
    }
    if (val === undefined || val === null) return 'undefined'
    if (typeof val === 'string') return JSON.stringify(val)
    if (typeof val === 'number' || typeof val === 'boolean') return String(val)
    try { return JSON.stringify(val) } catch { return 'undefined' }
  })

  const parseLiteral = (value: string): unknown => {
    const trimmed = value.trim()
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false
    if (trimmed === 'null') return null
    if (/^-?(?:\d+\.?\d*|\.\d+)$/.test(trimmed)) return Number(trimmed)
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) return JSON.parse(trimmed)
    throw new Error('unsupported router literal')
  }

  try {
    // Router expressions are deliberately a tiny, data-only grammar. Values
    // have already been converted to JSON literals above, so no identifiers,
    // calls, member access, or page globals can reach an evaluator.
    if (exprResolved.trim() === 'true') return true
    if (exprResolved.trim() === 'false') return false
    const match = /^\s*(.+?)\s*(===|!==|>=|<=|>|<)\s*(.+?)\s*$/.exec(exprResolved)
    if (!match) return false
    const [, leftText, operator, rightText] = match
    const left = parseLiteral(leftText)
    const right = parseLiteral(rightText)
    switch (operator) {
      case '===': return left === right
      case '!==': return left !== right
      case '>': return typeof left === 'number' && typeof right === 'number' && left > right
      case '>=': return typeof left === 'number' && typeof right === 'number' && left >= right
      case '<': return typeof left === 'number' && typeof right === 'number' && left < right
      case '<=': return typeof left === 'number' && typeof right === 'number' && left <= right
      default: return false
    }
  } catch {
    return false
  }
}

/**
 * Evaluate router rules top-to-bottom and return the FIRST matching rule.
 * Returns `undefined` if no rule matches (not even a catch-all).
 */
function resolveRouterRule(
  rules: RouterRule[],
  inputAlias: unknown,
  outputStore: NodeOutputStore
): RouterRule | undefined {
  for (const rule of rules) {
    if (evaluateRuleExpr(rule.expr, inputAlias, outputStore)) {
      return rule
    }
  }
  return undefined
}

/**
 * Recursively mark a node and all its downstream descendants as skipped.
 *
 * When a router selects one branch, the other branches' entire downstream
 * chains must be skipped (not just the immediate child). This walks the DAG
 * forward from the given node, following non-loop edges.
 */
function markBranchSkipped(
  nodeId: string,
  nodes: FlowNode[],
  edges: FlowEdge[],
  skippedNodes: Set<string>
): void {
  if (skippedNodes.has(nodeId)) return
  skippedNodes.add(nodeId)

  // Walk downstream (skip loop edges — they belong to review nodes, not router branches)
  for (const edge of edges) {
    if (edge.isLoop) continue
    if (edge.from === nodeId && !skippedNodes.has(edge.to)) {
      markBranchSkipped(edge.to, nodes, edges, skippedNodes)
    }
  }
}

/** Call a tool via the ToolRegistry */
async function callTool(
  name: string,
  args: Record<string, unknown>,
  context: ToolContext
): Promise<unknown> {
  const registry = getToolRegistry()
  const raw = await registry.execute(name, args, context)
  let parsed: { ok?: boolean; data?: unknown; error?: { message?: string } }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return raw
  }
  if (parsed.ok === false) {
    throw new Error(parsed.error?.message || `Tool ${name} failed`)
  }
  return parsed.data ?? raw
}

/**
 * Run an LLM node via the full AgentLoop — same engine as the main chat.
 *
 * This gives the flow node access to ALL agent capabilities:
 * - Tool calling (read, write, web_search, search_tools, MCP, …)
 * - Skill injection
 * - Context management (token trimming, summarization)
 * - System prompt enhancement
 *
 * We construct a lightweight AgentLoop with skipEnhancements=false so it
 * behaves exactly like the main conversation agent, then extract the final
 * assistant text as the node output.
 */
async function runAgentNode(
  llm: RunFlowOptions['llm'],
  userMessage: string,
  context: ToolContext,
  abortSignal?: AbortSignal
): Promise<{ output: string; trace: FlowNodeTraceStep[] }> {
  const provider = createLLMProvider({
    apiKey: llm.apiKey,
    providerType: llm.providerType as never,
    baseUrl: llm.baseUrl,
    model: llm.model,
    apiMode: llm.apiMode,
  })

  const contextManager = new ContextManager({
    maxContextTokens: provider.maxContextTokens,
    reserveTokens: 8192,
    enableSummarization: true,
    maxMessageGroups: 50,
  })

  const toolRegistry = getToolRegistry()

  const agentLoop = new AgentLoop({
    provider,
    toolRegistry,
    contextManager,
    mode: 'act',
    sessionId: `flow-${generateId()}`,
    toolContext: {
      ...context,
      agentMode: 'act',
      // Ensure readFileState exists (required by some tools)
      readFileState: context.readFileState ?? new Map(),
    },
    // Enable full enhancements: skills, MCP, tool docs — same as main chat
    skipEnhancements: false,
    maxIterations: 20,
  })

  // Build the initial message list (just the user prompt)
  const initialMessages: Message[] = [
    {
      id: generateId(),
      role: 'user',
      content: userMessage,
      timestamp: Date.now(),
    },
  ]

  // Bridge external abortSignal → agentLoop.cancel()
  // AgentLoop manages its own internal AbortController; calling cancel()
  // aborts the in-flight run. Clean up the listener after completion.
  let onAbort: (() => void) | null = null
  if (abortSignal) {
    if (abortSignal.aborted) {
      agentLoop.cancel()
    } else {
      onAbort = () => agentLoop.cancel()
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }
  }

  let finalMessages: Message[]
  try {
    finalMessages = await agentLoop.run(initialMessages)
  } finally {
    if (onAbort && abortSignal) {
      abortSignal.removeEventListener('abort', onAbort)
    }
  }

  // ── Build execution trace from the message history ──
  // Walk through all messages in order, extracting:
  // - assistant reasoning (thinking)
  // - tool calls (name + args)
  // - tool results (output + error flag)
  // - assistant text
  const trace: FlowNodeTraceStep[] = []
  let finalText = ''

  for (const msg of finalMessages) {
    if (msg.role === 'assistant') {
      // Extract reasoning (chain-of-thought)
      if (msg.reasoning) {
        trace.push({
          type: 'thinking',
          timestamp: msg.timestamp,
          thinking: msg.reasoning,
        })
      }
      // Extract tool calls
      if (msg.toolCalls?.length) {
        for (const tc of msg.toolCalls) {
          let parsedArgs: Record<string, unknown> = {}
          try {
            parsedArgs = JSON.parse(tc.function.arguments || '{}')
          } catch {
            parsedArgs = { _raw: tc.function.arguments }
          }
          trace.push({
            type: 'tool_call',
            timestamp: msg.timestamp,
            toolName: tc.function.name,
            toolArgs: parsedArgs,
          })
        }
      }
      // Extract text content
      const text = extractTextContent(msg.contentParts ?? msg.content)
      if (text) {
        finalText = text
        trace.push({
          type: 'text',
          timestamp: msg.timestamp,
          text,
        })
      }
    } else if (msg.role === 'tool') {
      // Tool result message
      const text = extractTextContent(msg.contentParts ?? msg.content) || ''
      trace.push({
        type: 'tool_result',
        timestamp: msg.timestamp,
        toolResult: text.length > 500 ? text.slice(0, 500) + '...' : text,
        isError: text.startsWith('Error:') || text.startsWith('{"ok":false'),
        toolName: msg.name,
      })
    }
  }

  return { output: finalText, trace }
}

/** Extract JSON string from LLM response, handling markdown code blocks */
function extractJson(text: string): string {
  // Try to extract from ```json ... ``` block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (codeBlockMatch) return codeBlockMatch[1].trim()
  // Try to find raw JSON object/array
  const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
  if (jsonMatch) return jsonMatch[0]
  return text.trim()
}

/** Format upstream data for LLM consumption */
function formatUpstreamData(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/**
 * Build the "上游数据" section appended to llm/review prompts.
 *
 * - Single upstream node  → flat `上游数据：\n<output>` (unchanged behaviour)
 * - Multiple upstream     → labelled list, e.g.
 *     上游数据：
 *     【分析A】
 *     <output A>
 *
 *     【分析B】
 *     <output B>
 * - No upstream           → empty string (the caller omits the section)
 *
 * This is what enables the classic fan-in / join pattern: two AI nodes run
 * concurrently, then a downstream node receives BOTH outputs to synthesise.
 */
function buildUpstreamSection(
  inputAlias: unknown,
  upstreamOutputs?: Record<string, string>
): string {
  // Multi-input: list each upstream node by label
  if (upstreamOutputs && Object.keys(upstreamOutputs).length > 1) {
    const blocks = Object.entries(upstreamOutputs).map(
      ([label, text]) => `【${label}】\n${text}`
    )
    return `上游数据：\n\n${blocks.join('\n\n')}`
  }
  // Single input (or no upstreamOutputs map provided): flat block
  if (inputAlias !== undefined) {
    return `上游数据：\n${formatUpstreamData(inputAlias)}`
  }
  return ''
}

/**
 * Like {@link buildUpstreamSection} but WITHOUT the "上游数据：" header —
 * the review prompt wraps the content in its own "待审内容：" context.
 *
 * - Multiple upstream → labelled list (`【分析A】\n...`)
 * - Single upstream   → flat output text
 * - No upstream       → empty string
 */
function formatUpstreamForReview(
  inputAlias: unknown,
  upstreamOutputs?: Record<string, string>
): string {
  if (upstreamOutputs && Object.keys(upstreamOutputs).length > 1) {
    const blocks = Object.entries(upstreamOutputs).map(
      ([label, text]) => `【${label}】\n${text}`
    )
    return blocks.join('\n\n')
  }
  return inputAlias !== undefined ? formatUpstreamData(inputAlias) : ''
}

/** Parse review score from LLM response */
function parseReviewScore(raw: string): { score: number; passed: boolean; issues: string[] } {
  const jsonMatch = raw.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    return { score: 50, passed: false, issues: ['无法解析评审结果'] }
  }
  try {
    const parsed = JSON.parse(jsonMatch[0])
    return {
      score: typeof parsed.score === 'number' ? parsed.score : 50,
      passed: typeof parsed.passed === 'boolean' ? parsed.passed : false,
      issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    }
  } catch {
    return { score: 50, passed: false, issues: ['评审结果JSON解析失败'] }
  }
}

/** Today's date as YYYY-MM-DD */
function todayStr(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
