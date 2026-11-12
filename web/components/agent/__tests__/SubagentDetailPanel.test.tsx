import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SubagentDetailPanel } from '../SubagentDetailPanel'
import { useSubagentTaskStore } from '@/store/subagent-task.store'

const findByWorkspaceId = vi.fn()

vi.mock('@/sqlite', () => ({
  getSubagentRepository: () => ({ findByWorkspaceId }),
}))

vi.mock('@/store/conversation-runtime.store', () => ({
  useConversationRuntimeStore: (selector: (state: { subagentDrafts: Map<string, unknown> }) => unknown) =>
    selector({ subagentDrafts: new Map() }),
}))

vi.mock('../ToolCallDisplay', () => ({
  ToolCallDisplay: ({ toolCall, result, conversationId }: { toolCall: { function: { name: string; arguments: string } }; result?: string; conversationId?: string }) =>
    <div data-testid="tool-call">{toolCall.function.name}:{toolCall.function.arguments}:{result}:{conversationId}</div>,
}))

vi.mock('../ReasoningSection', () => ({
  ReasoningSection: ({ reasoning, durationMs }: { reasoning: string; durationMs?: number }) => (
    <div>{`${reasoning}${durationMs === undefined ? '' : ` (${durationMs})`}`}</div>
  ),
}))

beforeEach(() => useSubagentTaskStore.setState({ tasks: {} }))

describe('SubagentDetailPanel', () => {
  it('keeps receiving execution traces after the parent draft is cleared', async () => {
    const task = { agentId: 'live-child', conversationId: 'original', description: 'Inspect', role: 'explorer' as const, status: 'running' as const, createdAt: 1, updatedAt: 1, lastActivity: 1, isAsync: true, messages: [{ id: 'live', role: 'assistant' as const, content: 'Reading files', timestamp: 1 }] }
    useSubagentTaskStore.getState().publish(task)
    render(<SubagentDetailPanel agentId="live-child" conversationId="original" />)
    expect(await screen.findByText('Reading files')).toBeInTheDocument()
    act(() => useSubagentTaskStore.getState().publish({ ...task, messages: [{ ...task.messages[0], content: 'Finished reading files' }] }))
    expect(screen.getByText('Finished reading files')).toBeInTheDocument()
  })

  it('restores saved subagent messages when live draft state is gone', async () => {
    findByWorkspaceId.mockResolvedValueOnce([
      {
        agentId: 'subagent-1',
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '刷新后恢复的回答',
            timestamp: 1,
          },
        ],
      },
    ])

    render(<SubagentDetailPanel agentId="subagent-1" conversationId="conversation-1" />)

    expect(await screen.findByText('刷新后恢复的回答')).toBeInTheDocument()
    expect(findByWorkspaceId).toHaveBeenCalledWith('conversation-1')
  })

  it('restores the actual tool name, arguments, error result, and original conversation', async () => {
    findByWorkspaceId.mockResolvedValueOnce([{ agentId: 'saved-tool-child', messages: [
      { id: 'assistant', role: 'assistant', content: '', timestamp: 1, toolCalls: [{ id: 'read-call', type: 'function', function: { name: 'read', arguments: '{"path":"notes.md"}' } }] },
      { id: 'result', role: 'tool', toolCallId: 'read-call', content: '{"error":"Permission denied"}', timestamp: 2 },
    ] }])
    render(<SubagentDetailPanel agentId="saved-tool-child" conversationId="original" />)
    const tool = await screen.findByTestId('tool-call')
    expect(tool).toHaveTextContent('read:{"path":"notes.md"}:{"error":"Permission denied"}:original')
  })

  it('passes a persisted reasoning duration to the reasoning section', async () => {
    findByWorkspaceId.mockResolvedValueOnce([
      {
        agentId: 'subagent-1',
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: 'Done',
            reasoning: 'Analyzing',
            reasoningDurationMs: 2_500,
            timestamp: 1,
          },
        ],
      },
    ])

    render(<SubagentDetailPanel agentId="subagent-1" conversationId="conversation-1" />)

    expect(await screen.findByText('Analyzing (2500)')).toBeInTheDocument()
  })
})
