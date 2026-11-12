import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolCallDisplay } from '../ToolCallDisplay'
import { useSubagentTaskStore } from '@/store/subagent-task.store'
import type { ToolCall } from '@/agent/message-types'

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

vi.mock('@/store/workspace.store', () => ({
  useWorkspaceStore: {
    subscribe: vi.fn(),
    getState: () => ({ activeWorkspaceId: null }),
  },
}))

vi.mock('../SubagentDetailPanel', () => ({
  SubagentDetailPanel: ({ agentId, conversationId }: { agentId: string; conversationId?: string }) => (
    <div data-testid="subagent-detail">{agentId}:{conversationId}</div>
  ),
}))

beforeEach(() => useSubagentTaskStore.setState({ tasks: {} }))

describe('ToolCallDisplay', () => {
  it('renders explicit run_code output images and retains text on script failure', () => {
    const toolCall: ToolCall = {id:'code',type:'function',function:{name:'run_code',arguments:JSON.stringify({purpose:'Inspect image',code:'image(...); throw new Error("failed")'})}}
    const result = JSON.stringify({ok:true,tool:'run_code',version:2,data:{ok:false,error:{code:'FAILED',message:'failed'},output:[{type:'text',text:'before failure'},{type:'image',data:'iVBORw0KGgo=',mimeType:'image/png'}]}})
    const {container} = render(<ToolCallDisplay toolCall={toolCall} result={result} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('img',{name:'Inspect image'})).toHaveAttribute('src','data:image/png;base64,iVBORw0KGgo=')
    expect(screen.getByText('before failure')).toBeInTheDocument()
    expect(container.textContent).not.toContain('iVBORw0KGgo=')
    expect(container.querySelector('.lucide-circle-x')).not.toBeNull()
  })
  it('previews direct read_image JSON without displaying image bytes as text', () => {
    const toolCall: ToolCall = {id:'image',type:'function',function:{name:'read_image',arguments:JSON.stringify({path:'chart.png'})}}
    const result = JSON.stringify({ok:true,tool:'read_image',version:2,data:{type:'image',data:'iVBORw0KGgo=',mimeType:'image/png',width:1,height:1}})
    const {container} = render(<ToolCallDisplay toolCall={toolCall} result={result} />)
    expect(screen.getByRole('img',{name:'chart.png'})).toBeInTheDocument()
    expect(container.textContent).not.toContain('iVBORw0KGgo=')
  })
  it('shows run_code success when a failed child was handled by the program', () => {
    const toolCall: ToolCall = {id:'code',type:'function',function:{name:'run_code',arguments:JSON.stringify({purpose:'Recover'})}}
    const result = JSON.stringify({ok:true,tool:'run_code',version:2,data:{ok:true,value:1,output:[]},meta:{calls:[{id:'child',name:'read',status:'failed',args:{},result:'{"error":"handled"}'}]}})
    const {container} = render(<ToolCallDisplay toolCall={toolCall} result={result} />)
    expect(container.querySelector('.lucide-circle-x')).toBeNull()
    expect(container.querySelector('svg.text-green-500')).not.toBeNull()
  })
  it('renders subagent result content as markdown', () => {
    const toolCall: ToolCall = {
      id: 'tc-1',
      type: 'function',
      function: {
        name: 'spawn_subagent',
        arguments: JSON.stringify({ description: 'run task', subagent_type: 'explorer' }),
      },
    }

    const result = JSON.stringify({
      ok: true,
      tool: 'spawn_subagent',
      version: 2,
      data: {
        content: '# Execution Result\n- Completed step A',
      },
    })

    const { container } = render(
      <ToolCallDisplay toolCall={toolCall} result={result} isExecuting={false} />
    )

    expect(screen.getByRole('button', { name: /run task/ })).toBeInTheDocument()
    expect(screen.queryByText('Explorer')).not.toBeInTheDocument()
    expect(screen.queryByText('spawn_subagent')).toBeNull()

    // Collapsed by default: markdown details should be hidden.
    expect(screen.queryByRole('heading', { name: 'Execution Result' })).toBeNull()

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByRole('heading', { name: 'Execution Result' })).toBeInTheDocument()
    expect(screen.getByText('Completed step A')).toBeInTheDocument()
    expect(container.textContent || '').toContain('Execution Result')
  })

  it('renders a read_image contentParts preview without exposing its base64 payload', () => {
    const toolCall: ToolCall = {
      id: 'tc-read-image',
      type: 'function',
      function: { name: 'read_image', arguments: JSON.stringify({ path: 'photos/chart.png' }) },
    }
    const result = JSON.stringify({
      ok: true,
      tool: 'read_image',
      version: 2,
      data: { path: 'photos/chart.png', mimeType: 'image/png', mode: 'vision' },
      contentParts: [
        { type: 'text', text: 'Read image photos/chart.png' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    })

    render(<ToolCallDisplay toolCall={toolCall} result={result} />)

    expect(screen.getByRole('img', { name: 'photos/chart.png' })).toBeInTheDocument()
    expect(screen.queryByText(/aGVsbG8=/)).not.toBeInTheDocument()
  })

  it('passes the conversation ID to recovered subagent detail panels', async () => {
    const toolCall: ToolCall = {
      id: 'tc-1',
      type: 'function',
      function: {
        name: 'spawn_subagent',
        arguments: JSON.stringify({ description: 'run task' }),
      },
    }
    const result = JSON.stringify({ data: { agentId: 'subagent-1' } })

    render(<ToolCallDisplay toolCall={toolCall} result={result} conversationId="conversation-1" />)

    fireEvent.click(screen.getByRole('button'))

    expect(screen.queryByTestId('subagent-detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /conversation.backgroundTasks.details/ }))
    expect(await screen.findByTestId('subagent-detail')).toHaveTextContent('subagent-1:conversation-1')
  })

  it('replays failed batch task panels from the committed result', async () => {
    const toolCall: ToolCall = {
      id: 'tc-batch',
      type: 'function',
      function: {
        name: 'batch_spawn',
        arguments: JSON.stringify({ tasks: [{ description: 'will fail', prompt: 'run' }] }),
      },
    }
    const result = JSON.stringify({
      data: { completed: [], failed: [{ agentId: 'subagent-failed-1' }] },
    })

    render(<ToolCallDisplay toolCall={toolCall} result={result} conversationId="conversation-2" />)

    fireEvent.click(screen.getByRole('button'))

    fireEvent.click(screen.getByRole('button', { name: /conversation.backgroundTasks.details/ }))
    expect(await screen.findByTestId('subagent-detail')).toHaveTextContent(
      'subagent-failed-1:conversation-2'
    )
  })

  it('shows accepted async work as submitted and keeps every trace closed initially', async () => {
    const toolCall: ToolCall = { id: 'accepted', type: 'function', function: { name: 'batch_spawn', arguments: '{}' } }
    const result = JSON.stringify({ ok: true, data: { accepted: [{ agentId: 'new-child', description: 'Inspect docs', status: 'pending' }], rejected: [] } })
    const { container } = render(<ToolCallDisplay toolCall={toolCall} result={result} conversationId="original" />)
    expect(container.querySelector('svg.text-green-500')).toBeNull()
    expect(screen.getByText('conversation.backgroundTasks.submitted')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.queryByTestId('subagent-detail')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /conversation.backgroundTasks.details/ }))
    expect(await screen.findByTestId('subagent-detail')).toHaveTextContent('new-child:original')
  })

  it('updates accepted receipts from the independent task projection after the parent stops', () => {
    const toolCall: ToolCall = { id: 'async-card', type: 'function', function: { name: 'spawn_subagent', arguments: '{}' } }
    render(<ToolCallDisplay toolCall={toolCall} result={JSON.stringify({ data: { agentId: 'async-child', status: 'pending' } })} conversationId="original" />)
    expect(screen.getByText('conversation.backgroundTasks.submitted')).toBeInTheDocument()
    const task = { agentId: 'async-child', conversationId: 'original', description: 'Inspect documents', role: 'worker' as const, status: 'running' as const, createdAt: 1, updatedAt: 2, lastActivity: 2, isAsync: true, executionId: 'one', messages: [] }
    act(() => useSubagentTaskStore.getState().publish(task))
    expect(screen.getByText('conversation.backgroundTasks.running')).toBeInTheDocument()
    act(() => useSubagentTaskStore.getState().publish({ ...task, status: 'completed', deliveryPhase: 'handled' }))
    expect(screen.getByText('conversation.backgroundTasks.completed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getByRole('button', { name: /conversation.backgroundTasks.details: Inspect documents/ })).toBeInTheDocument()
    expect(screen.queryByTestId('subagent-detail')).toBeNull()
  })

  // ─── Failure-badge regression coverage ───────────────────────
  // The badge logic must trust structured envelope fields only; scanning the
  // raw result for the literal "error" flagged successful calls whose payload
  // merely embeds arbitrary content (fetched bodies, stdout, inner traces).

  function renderTool(name: string, result: string) {
    const toolCall: ToolCall = {
      id: 'tc-badge',
      type: 'function',
      function: { name, arguments: JSON.stringify({}) },
    }
    return render(<ToolCallDisplay toolCall={toolCall} result={result} isExecuting={false} />)
  }

  function queryStatusIcon(container: HTMLElement) {
    // StatusIcon renders XCircle (red, failed) or CheckCircle2 (green, done)
    return {
      failed: container.querySelector('.text-red-500') !== null,
      succeeded: container.querySelector('.text-green-500') !== null,
    }
  }

  it('shows SUCCESS when a v2 ok envelope embeds the literal "error" in nested data', () => {
    const { container } = renderTool('web_fetch', JSON.stringify({
      ok: true, tool: 'web_fetch', version: 2,
      data: { status: 200, body: '{"error": "not_found"}' },
    }))
    expect(queryStatusIcon(container).succeeded).toBe(true)
    expect(queryStatusIcon(container).failed).toBe(false)
  })

  it('shows SUCCESS when ok envelope carries error:null (legacy schedule payload shape)', () => {
    const { container } = renderTool('get_schedule', JSON.stringify({
      ok: true, tool: 'get_schedule', version: 2,
      data: { id: 's1', error: null },
    }))
    expect(queryStatusIcon(container).succeeded).toBe(true)
    expect(queryStatusIcon(container).failed).toBe(false)
  })

  it('shows SUCCESS for run_code whose inner tool trace failed (meta.calls embeds error)', () => {
    const { container } = renderTool('run_code', JSON.stringify({
      ok: true, tool: 'run_code', version: 2,
      data: { value: 42 },
      meta: { calls: [{ id: 't1', name: 'read', status: 'failed', result: '{"error":"no such file"}' }] },
    }))
    expect(queryStatusIcon(container).succeeded).toBe(true)
    expect(queryStatusIcon(container).failed).toBe(false)
  })

  it('shows SUCCESS when Python stdout mentions "error" (execute tool)', () => {
    const { container } = renderTool('execute', JSON.stringify({
      ok: true, tool: 'execute', version: 2,
      data: { stdout: 'print: {"error": "handled gracefully"}', executionTime: 12 },
    }))
    expect(queryStatusIcon(container).succeeded).toBe(true)
    expect(queryStatusIcon(container).failed).toBe(false)
  })

  it('still shows FAILURE for ok:false envelope', () => {
    const { container } = renderTool('read', JSON.stringify({
      ok: false, tool: 'read', version: 2,
      error: { code: 'NOT_FOUND', message: 'no such file', retryable: false },
    }))
    expect(queryStatusIcon(container).failed).toBe(true)
  })

  it('still shows FAILURE for legacy top-level error value (non-null)', () => {
    const { container } = renderTool('legacy_tool', JSON.stringify({ error: 'boom' }))
    expect(queryStatusIcon(container).failed).toBe(true)
  })

  it('still shows FAILURE for success:false payloads', () => {
    const { container } = renderTool('delete', JSON.stringify({
      success: false, total: 2, deleted: ['a'], deletedDirs: [],
      failed: [{ path: 'b', reason: 'locked' }],
    }))
    expect(queryStatusIcon(container).failed).toBe(true)
  })
})
