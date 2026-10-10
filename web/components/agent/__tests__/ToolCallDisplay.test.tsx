import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolCallDisplay } from '../ToolCallDisplay'
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
    fireEvent.click(screen.getByRole('button'))
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

    expect(screen.getByText('Explorer')).toBeInTheDocument()
    expect(screen.queryByText('spawn_subagent')).toBeNull()

    // Collapsed by default: markdown details should be hidden.
    expect(screen.queryByRole('heading', { name: 'Execution Result' })).toBeNull()

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByRole('heading', { name: 'Execution Result' })).toBeInTheDocument()
    expect(screen.getByText('Completed step A')).toBeInTheDocument()
    expect(container.textContent || '').toContain('Execution Result')
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

    expect(await screen.findByTestId('subagent-detail')).toHaveTextContent(
      'subagent-failed-1:conversation-2'
    )
  })
})
