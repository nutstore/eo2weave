/**
 * FlowEditor — main visual workflow editor.
 *
 * Combines:
 * - React Flow canvas (drag nodes, connect edges)
 * - Right-side properties panel
 * - Top toolbar (add nodes, run, save)
 *
 * Reads/writes the FlowStore's activeInstance.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ReactFlowProvider, useNodesState, useEdgesState, type Connection, type EdgeChange } from '@xyflow/react'
import { Play, Square, FileInput, Wrench, Sparkles, ShieldCheck, CornerDownRight, ListTree, GitBranch } from 'lucide-react'
import { toast } from 'sonner'
import { cn, BrandButton } from '@creatorweave/ui'
import { FlowCanvas } from './FlowCanvas'
import { NodePropertiesPanel } from './NodePropertiesPanel'
import { FlowRunResultPanel, useFlowRun } from './FlowRunOverlay'
import { FlowTemplateManager } from './FlowTemplateManager'
import { FlowStepBar } from './FlowStepBar'
import { flowToReactFlow, type FlowFlowNode, type FlowFlowEdge } from './flow-converter'
import { useFlowStore } from '@/store/flow.store'
import { useSettingsStore } from '@/store/settings.store'
import { useConversationStore } from '@/store/conversation.store'
import { isCustomProviderType } from '@/agent/providers/types'
import { useAgentStore } from '@/store/agent.store'
import type { FlowNode, FlowNodeKind } from '@/agent/flow/types'
import type { ToolContext } from '@/agent/tools/tool-types'

// ---------------------------------------------------------------------------
// Add-node toolbar items
// ---------------------------------------------------------------------------

const ADD_ITEMS: Array<{ kind: FlowNodeKind; label: string; icon: React.ComponentType<{ className?: string }>; color: string }> = [
  { kind: 'input', label: '输入', icon: FileInput, color: 'text-blue-500' },
  { kind: 'llm', label: 'AI', icon: Sparkles, color: 'text-violet-500' },
  { kind: 'tool', label: '工具', icon: Wrench, color: 'text-cyan-500' },
  { kind: 'review', label: '评审', icon: ShieldCheck, color: 'text-amber-500' },
  { kind: 'router', label: '路由', icon: GitBranch, color: 'text-purple-500' },
  { kind: 'output', label: '输出', icon: CornerDownRight, color: 'text-emerald-500' },
]

const DEFAULT_CONFIGS: Record<FlowNodeKind, FlowNode['config']> = {
  input: { inputType: 'file', path: 'Daily/{{date}}.md' },
  tool: { toolName: 'read', args: {} },
  llm: { prompt: '' },
  review: { criteria: '', minScore: 80 },
  router: { rules: [{ label: '默认', expr: 'true' }] },
  output: { path: 'Output/{{date}}.md' },
}

// ---------------------------------------------------------------------------
// Inner editor (needs to be inside ReactFlowProvider)
// ---------------------------------------------------------------------------

function FlowEditorInner({ isFullscreen }: { isFullscreen?: boolean }) {
  const activeInstance = useFlowStore((s) => s.activeInstance)
  const addNode = useFlowStore((s) => s.addNode)
  const updateNode = useFlowStore((s) => s.updateNode)
  const removeNode = useFlowStore((s) => s.removeNode)
  const connectNodes = useFlowStore((s) => s.connectNodes)
  const removeEdge = useFlowStore((s) => s.removeEdge)
  const updateNodePosition = useFlowStore((s) => s.updateNodePosition)
  // Subscribe to real-time node results so trace shows up as nodes complete
  const liveNodeResults = useFlowStore((s) => s.nodeResults)

  const [nodeStatuses, setNodeStatuses] = useState<Record<string, 'pending' | 'running' | 'completed' | 'failed'>>({})
  const [showStepBar, setShowStepBar] = useState(true)

  // Convert flow model → React Flow
  const initialFlow = useMemo(() => {
    if (!activeInstance) return { nodes: [], edges: [] }
    return flowToReactFlow(activeInstance.nodes, activeInstance.edges)
  }, [activeInstance?.nodes, activeInstance?.edges])

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowFlowNode>(initialFlow.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowFlowEdge>(initialFlow.edges)
  const [selectedId, setSelectedId] = useSelectedNodeId()

  // Sync from store when instance changes externally (e.g. AI adds nodes)
  useEffect(() => {
    if (!activeInstance) return
    const flow = flowToReactFlow(activeInstance.nodes, activeInstance.edges)
    setNodes(flow.nodes)
    setEdges(flow.edges)
  }, [activeInstance?.nodes, activeInstance?.edges])

  const [userInput, setUserInput] = useState('')
  const [showInputDialog, setShowInputDialog] = useState(false)

  // Detect if the flow has entry nodes that need external input
  const needsUserInput = useMemo(() => {
    if (!activeInstance) return false
    return activeInstance.nodes.some((node) => {
      const hasUpstream = activeInstance.edges.some(
        (e) => e.to === node.id && !e.isLoop
      )
      // Entry nodes (no upstream) that are llm/tool nodes typically need input
      return !hasUpstream && (node.kind === 'llm' || node.kind === 'tool')
    })
  }, [activeInstance])

  // Track selection on nodes + apply run-status highlighting
  useEffect(() => {
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        selected: n.id === selectedId,
        data: {
          ...n.data,
          runStatus: nodeStatuses[n.id],
        },
      }))
    )
  }, [selectedId, nodeStatuses])

  const selectedNode = useMemo(
    () => activeInstance?.nodes.find((n) => n.id === selectedId) ?? null,
    [activeInstance, selectedId]
  )

  // ── Handlers ──

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      // Detect loop: target is to the left of source (back-edge)
      const sourceNode = nodes.find((n) => n.id === connection.source)
      const targetNode = nodes.find((n) => n.id === connection.target)
      const isLoop = !!(sourceNode && targetNode && targetNode.position.x < sourceNode.position.x)

      connectNodes(connection.source, connection.target, { isLoop })

      // Add edge to React Flow state immediately
      const newEdge: FlowFlowEdge = {
        id: `${connection.source}-${connection.target}-${Date.now()}`,
        source: connection.source,
        target: connection.target,
        type: isLoop ? 'flowLoopEdge' : 'flowEdge',
        animated: isLoop,
        data: { isLoop },
      }
      setEdges((eds) => [...eds, newEdge])
    },
    [nodes, connectNodes, setEdges]
  )

  const handleNodeDragStop = useCallback(
    (nodeId: string, position: { x: number; y: number }) => {
      updateNodePosition(nodeId, position)
    },
    [updateNodePosition]
  )

  const handleAddNode = useCallback(
    (kind: FlowNodeKind) => {
      if (!activeInstance) return
      // Place new node near center of viewport
      const x = 100 + Math.random() * 200
      const y = 100 + Math.random() * 100
      addNode(kind, DEFAULT_CONFIGS[kind] ? getNodeLabel(kind) : kind, { x, y }, DEFAULT_CONFIGS[kind])
    },
    [activeInstance, addNode]
  )

  const handleUpdateNode = useCallback(
    (nodeId: string, patch: Partial<FlowNode>) => {
      updateNode(nodeId, patch)
      // Sync React Flow node data
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                data: {
                  ...n.data,
                  ...patch,
                  config: patch.config ?? n.data.config,
                  label: patch.label ?? n.data.label,
                },
              }
            : n
        )
      )
    },
    [updateNode, setNodes]
  )

  const handleDeleteNode = useCallback(
    (nodeId: string) => {
      removeNode(nodeId)
      setNodes((nds) => nds.filter((n) => n.id !== nodeId))
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId))
      setSelectedId(null)
    },
    [removeNode, setNodes, setEdges, setSelectedId]
  )

  // Intercept React Flow edge changes to sync removals back to the FlowStore.
  // Without this, deleting an edge (select + Backspace) only updates local
  // React Flow state — the edge survives in activeInstance.edges and reappears
  // on the next store-driven re-render.
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<FlowFlowEdge>[]) => {
      onEdgesChange(changes)
      for (const change of changes) {
        if (change.type === 'remove') {
          const edge = edges.find((e) => e.id === change.id)
          if (edge) {
            removeEdge(edge.source, edge.target)
          }
        }
      }
    },
    [onEdgesChange, edges, removeEdge]
  )

  // ── Run flow ──
  // Read settings reactively (not getState) so the button updates when config changes
  const effectiveConfig = useSettingsStore((s) => s.getEffectiveProviderConfig?.() ?? null)
  const providerType = useSettingsStore((s) => s.providerType)
  const directoryHandle = useAgentStore((s) => s.directoryHandle)

  // Direct conversations (kind='direct') have no folder authorization. The
  // flow's ToolContext must carry directMode so ToolRegistry.execute's
  // guard rejects folder-dependent tools — without it, a flow run from a
  // standalone chat inherits the host directoryHandle and read/write/ls
  // nodes silently bypass the direct-mode boundary.
  // Read through the store so a mid-session upgrade (direct → project)
  // applies from the next run onward.
  const flowDirectMode = useConversationStore((s) => {
    const id = s.activeConversationId
    if (!id) return false
    return s.conversations.find((c) => c.id === id)?.kind === 'direct'
  })

  const toolContext: ToolContext | null = useMemo(() => {
    // Standalone chats (directMode) run with NO folder: ToolContext carries a
    // null directoryHandle — same shape the agent loop uses for kind='direct'
    // conversations. Folder-dependent tools are still blocked twice: the
    // definition filter hides them from LLM nodes, and ToolRegistry.execute
    // rejects name-based calls from visual-flow tool nodes. Project flows
    // unchanged: without a mounted folder there is nothing to run against.
    if (!flowDirectMode && !directoryHandle) return null
    return {
      directoryHandle: directoryHandle ?? null,
      workspaceId: activeInstance?.conversationId ?? null,
      projectId: null,
      agentMode: 'act',
      directMode: flowDirectMode || undefined,
    }
  }, [directoryHandle, activeInstance?.conversationId, flowDirectMode])

  // llmConfig without apiKey — apiKey resolved at click time
  const llmConfigBase = useMemo(() => {
    if (!effectiveConfig?.baseUrl || !effectiveConfig.modelName) return null
    return {
      providerType,
      baseUrl: effectiveConfig.baseUrl,
      model: effectiveConfig.modelName,
    }
  }, [effectiveConfig, providerType])

  const flowRun = useFlowRun({
    flow: activeInstance,
    context: toolContext,
    llm: null, // Will be set at run time via the imperative handle
    onNodeStatusChange: setNodeStatuses,
  })

  const handleRun = useCallback(async () => {
    if (!llmConfigBase || !toolContext) return

    // If entry nodes need input and user hasn't provided it, show dialog
    if (needsUserInput && !userInput.trim()) {
      setShowInputDialog(true)
      return
    }

    setShowInputDialog(false)

    // Resolve API key at click time. Custom providers may run keyless
    // (e.g. Ollama at localhost:11434/v1) — an absent key is fine for them.
    const { getApiKeyRepository } = await import('@/sqlite/repositories/api-key.repository')
    const apiKeyRepo = getApiKeyRepository()
    const apiKey = await apiKeyRepo.load(effectiveConfig?.apiKeyProviderKey ?? '')
    if (!apiKey && !isCustomProviderType(providerType)) {
      toast.error('请先在设置中配置 API Key')
      return
    }

    // Inject the resolved config + key + user input into the run
    await flowRun.runWithConfig({
      flow: activeInstance!,
      context: toolContext,
      llm: { ...llmConfigBase, apiKey: apiKey || '' },
      userInput: userInput.trim() || undefined,
    })
  }, [llmConfigBase, toolContext, flowRun, activeInstance, effectiveConfig, providerType, userInput, needsUserInput])

  const canRun = !!(activeInstance && activeInstance.nodes.length > 0 && llmConfigBase && toolContext)

  if (!activeInstance) {
    return (
      <div className="flex h-full items-center justify-center text-neutral-400">
        <p className="text-sm">没有活动的工作流</p>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header toolbar */}
      <header className="flex h-11 shrink-0 items-center gap-1.5 border-b border-neutral-200/80 bg-white px-3 dark:border-neutral-700/80 dark:bg-neutral-900">
        <div className="flex shrink-0 items-center gap-1.5">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-primary-100 dark:bg-primary-950/40">
            <Sparkles className="h-3 w-3 text-primary-500" />
          </div>
          <span className="whitespace-nowrap text-[12px] font-semibold text-foreground">工作流</span>

          {/* Outline panel toggle */}
          <button
            onClick={() => setShowStepBar(!showStepBar)}
            className={cn(
              'ml-1 flex h-6 w-6 items-center justify-center rounded-md transition-colors',
              showStepBar
                ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200'
                : 'text-neutral-400 hover:bg-neutral-100 hover:text-neutral-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300'
            )}
            title="步骤条"
          >
            <ListTree className="h-3 w-3" />
          </button>
        </div>

        <div className="flex-1" />

        {/* Add node buttons — icon only to save space */}
        <div className="flex shrink-0 items-center gap-0.5">
          {ADD_ITEMS.map((item) => (
            <button
              key={item.kind}
              onClick={() => handleAddNode(item.kind)}
              className={cn(
                'flex items-center gap-1 rounded-md text-[11px] font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-300',
                isFullscreen ? 'h-7 px-2' : 'h-7 w-7 justify-center'
              )}
              title={`添加${item.label}节点`}
            >
              <item.icon className={cn('h-3.5 w-3.5', item.color)} />
              {isFullscreen && item.label}
            </button>
          ))}
        </div>

        <div className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-700" />

        {/* Template buttons */}
        <FlowTemplateManager conversationId={activeInstance.conversationId} showLabels={isFullscreen} />

        <div className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-700" />

        {flowRun.isRunning ? (
          <BrandButton
            variant="danger"
            onClick={flowRun.cancel}
            className="h-7 gap-1.5 px-2.5 text-[11px]"
          >
            <Square className="h-3 w-3" />
            停止
          </BrandButton>
        ) : (
          <BrandButton
            variant="secondary"
            disabled={!canRun}
            onClick={handleRun}
            className="h-7 gap-1.5 px-2.5 text-[11px]"
          >
            <Play className="h-3 w-3" />
            运行
          </BrandButton>
        )}
      </header>

      {/* Main: canvas + properties */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {/* Step bar — horizontal execution overview */}
        {showStepBar && (
          <FlowStepBar
            selectedId={selectedId}
            onSelectNode={(id) => setSelectedId(id)}
          />
        )}

        {/* Canvas + properties side by side */}
        <div className="relative flex min-h-0 flex-1">
          {/* Canvas — always shown */}
          <div className="relative min-w-0 flex-1 overflow-hidden">
            <FlowCanvas
              nodes={nodes}
              edges={edges}
              onNodesChange={onNodesChange}
              onEdgesChange={handleEdgesChange}
              onConnect={handleConnect}
              onNodeDragStop={handleNodeDragStop}
              onNodeClick={(id) => setSelectedId(id)}
              onPaneClick={() => setSelectedId(null)}
            />
          </div>

          {/* Properties panel */}
          <div className="w-[260px] shrink-0 border-l border-neutral-200/80 bg-white/95 backdrop-blur-sm dark:border-neutral-700/80 dark:bg-neutral-900/95">
            <NodePropertiesPanel
              selectedNode={selectedNode}
              onUpdateNode={handleUpdateNode}
              onDeleteNode={handleDeleteNode}
              runResult={liveNodeResults.find((r) => r.nodeId === selectedId) ?? null}
            />
          </div>
        </div>
      </div>

      {/* Run result overlay */}
      {flowRun.result && (
        <FlowRunResultPanel result={flowRun.result} onClose={flowRun.reset} />
      )}

      {/* Input dialog — shown when entry nodes need external input */}
      {showInputDialog && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/30"
          onClick={() => setShowInputDialog(false)}
        >
          <div
            className="w-[420px] rounded-xl border border-neutral-200 bg-white p-4 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-2 text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
              输入运行参数
            </h3>
            <p className="mb-3 text-[11px] text-neutral-500 dark:text-neutral-400">
              这个工作流需要外部输入才能运行，请在下方填写内容：
            </p>
            <textarea
              autoFocus
              value={userInput}
              onChange={(e) => setUserInput(e.target.value)}
              rows={4}
              placeholder="例如：写一篇关于 AI Agent 架构的技术博客"
              className="w-full resize-none rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] text-neutral-700 placeholder:text-neutral-400 focus:border-primary-300 focus:outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  handleRun()
                }
              }}
            />
            <div className="mt-3 flex items-center justify-end gap-2">
              <button
                onClick={() => setShowInputDialog(false)}
                className="rounded-md px-3 py-1.5 text-[11px] font-medium text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                onClick={handleRun}
                disabled={!userInput.trim()}
                className="flex items-center gap-1.5 rounded-md bg-primary-500 px-4 py-1.5 text-[11px] font-semibold text-white transition-colors hover:bg-primary-600 disabled:opacity-40"
              >
                <Play className="h-3 w-3" />
                开始运行
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Public component with ReactFlowProvider wrapper
// ---------------------------------------------------------------------------

export function FlowEditor({ isFullscreen }: { isFullscreen?: boolean }) {
  return (
    <ReactFlowProvider>
      <FlowEditorInner isFullscreen={isFullscreen} />
    </ReactFlowProvider>
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNodeLabel(kind: FlowNodeKind): string {
  const labels: Record<FlowNodeKind, string> = {
    input: '输入',
    tool: '工具调用',
    llm: 'AI处理',
    review: '质量评审',
    router: '条件路由',
    output: '输出',
  }
  return labels[kind]
}

// Small hook
function useSelectedNodeId() {
  return useState<string | null>(null)
}
