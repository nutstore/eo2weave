import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AssistantTurnBubble } from '../AssistantTurnBubble'
import type { DraftAssistantStep } from '@/agent/message-types'

vi.mock('@/i18n', () => ({
  useT: () => (key: string) => key,
}))

// The bubble navigates (branch conversation) via next/navigation; there is
// no App Router in unit tests — provide a minimal mock.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

describe('AssistantTurnBubble timeline ordering', () => {
  it('renders summary/runtime events by timestamp order during processing', () => {
    // Runtime steps arrive in LLM emission order: compression (250) completed
    // first, then the tool call (300) started. The timeline renders committed
    // messages first, then runtime steps in emission (array) order.
    const runtimeSteps: DraftAssistantStep[] = [
      {
        id: 'compression-1',
        timestamp: 250,
        type: 'compression',
        content: 'Context compressed and summary generated',
        streaming: false,
      },
      {
        id: 'tool-1',
        timestamp: 300,
        type: 'tool_call',
        toolCall: {
          id: 'tool-1',
          type: 'function',
          function: {
            name: 'test_tool',
            arguments: '{}',
          },
        },
        args: '{}',
        streaming: false,
      },
    ]

    const { container } = render(
      <AssistantTurnBubble
        turn={{
          type: 'assistant',
          messages: [
            {
              id: 'summary-1',
              role: 'user',
              content: 'Earlier conversation summary:\nCompressed summary content',
              kind: 'context_summary',
              timestamp: 200,
              toolCalls: [],
            },
          ],
          timestamp: 200,
          totalUsage: null,
        }}
        toolResults={new Map()}
        isProcessing={true}
        runtimeSteps={runtimeSteps}
      />
    )

    const text = container.textContent || ''
    const summaryIndex = text.indexOf('Compressed summary content')
    const compressionIndex = text.indexOf('Context compressed and summary generated')
    const toolIndex = text.indexOf('test_tool')

    expect(summaryIndex).toBeGreaterThanOrEqual(0)
    expect(compressionIndex).toBeGreaterThan(summaryIndex)
    expect(toolIndex).toBeGreaterThan(compressionIndex)
  })

  it('shows the final reasoning duration from a committed assistant message', () => {
    const { container } = render(
      <AssistantTurnBubble
        turn={{
          type: 'assistant',
          messages: [
            {
              id: 'assistant-reasoning',
              role: 'assistant',
              content: 'Done',
              reasoning: 'Inspecting the data flow.',
              reasoningDurationMs: 2_500,
              timestamp: 100,
            },
          ],
          timestamp: 100,
          totalUsage: null,
        }}
        toolResults={new Map()}
      />
    )

    expect(container.textContent).toContain('workflow.thinkingProcess')
    expect(container.textContent).toContain('2common.seconds')
  })

  it('does not render bot avatar when showAvatar is false', () => {
    const { container } = render(
      <AssistantTurnBubble
        turn={{ type: 'assistant', messages: [], timestamp: Date.now(), totalUsage: null }}
        toolResults={new Map()}
        isProcessing={true}
        showAvatar={false}
        runtimeSteps={[
          {
            id: 'compression-1',
            timestamp: Date.now(),
            type: 'compression',
            content: 'Context compressed and summary generated',
            streaming: false,
          },
        ]}
      />
    )

    expect(container.querySelector('.lucide-bot')).toBeNull()
  })

  it('does not duplicate executing tool call from committed message and runtime state', () => {
    const toolCall = {
      id: 'tool-dup-1',
      type: 'function' as const,
      function: {
        name: 'batch_spawn',
        arguments: '{}',
      },
    }

    // In real flows an executing tool call always has a streaming runtime
    // step; the committed message's copy is suppressed in favour of it.
    const runtimeSteps: DraftAssistantStep[] = [
      {
        id: 'tool-dup-1-step',
        timestamp: 150,
        type: 'tool_call',
        toolCall,
        args: '{}',
        streaming: true,
      },
    ]

    const { container } = render(
      <AssistantTurnBubble
        turn={{
          type: 'assistant',
          messages: [
            {
              id: 'assistant-1',
              role: 'assistant',
              content: 'Preparing to dispatch tasks',
              toolCalls: [toolCall],
              timestamp: 100,
            },
          ],
          timestamp: 100,
          totalUsage: null,
        }}
        toolResults={new Map()}
        isProcessing={true}
        runtimeSteps={runtimeSteps}
        currentToolCall={toolCall}
      />
    )

    // batch_spawn renders as a "Subagents" card; assert on the card title
    // count so the raw tool name never appears as a duplicate either.
    const text = container.textContent || ''
    const count = text.split('Subagents').length - 1
    expect(count).toBe(1)
  })

  it('does not duplicate executing tool call from runtime steps and current tool call', () => {
    const toolCall = {
      id: 'tool-dup-2',
      type: 'function' as const,
      function: {
        name: 'batch_spawn',
        arguments: '{}',
      },
    }

    const runtimeSteps: DraftAssistantStep[] = [
      {
        id: 'tool-step-1',
        timestamp: 200,
        type: 'tool_call',
        toolCall,
        args: '{}',
        streaming: true,
      },
    ]

    const { container } = render(
      <AssistantTurnBubble
        turn={{
          type: 'assistant',
          messages: [],
          timestamp: 100,
          totalUsage: null,
        }}
        toolResults={new Map()}
        isProcessing={true}
        runtimeSteps={runtimeSteps}
        currentToolCall={toolCall}
      />
    )

    const text = container.textContent || ''
    // batch_spawn renders as a "Subagents" card (see test above).
    const count = text.split('Subagents').length - 1
    expect(count).toBe(1)
  })

  it('hides stale compression step from a previous loop iteration', () => {
    const runtimeSteps: DraftAssistantStep[] = [
      {
        id: 'compression-1',
        timestamp: 200,
        type: 'compression',
        content: 'Context compressed and summary generated',
        streaming: false,
      },
      {
        id: 'tool-1',
        timestamp: 400,
        type: 'tool_call',
        toolCall: {
          id: 'tool-1',
          type: 'function',
          function: { name: 'read', arguments: '{}' },
        },
        args: '{}',
        streaming: true,
      },
    ]

    // A committed message with timestamp after the compression means the loop
    // has moved past that iteration — the compression card should be hidden.
    const { container } = render(
      <AssistantTurnBubble
        turn={{
          type: 'assistant',
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: 'I will read the file.',
              toolCalls: [],
              timestamp: 300,
            },
          ],
          timestamp: 300,
          totalUsage: null,
        }}
        toolResults={new Map()}
        isProcessing={true}
        runtimeSteps={runtimeSteps}
      />
    )

    const text = container.textContent || ''
    expect(text).not.toContain('Context compressed and summary generated')
    expect(text).toContain('read')
  })

  it('shows compression step when no committed messages are newer', () => {
    const runtimeSteps: DraftAssistantStep[] = [
      {
        id: 'compression-1',
        timestamp: 300,
        type: 'compression',
        content: 'Context compressed and summary generated',
        streaming: false,
      },
    ]

    const { container } = render(
      <AssistantTurnBubble
        turn={{
          type: 'assistant',
          messages: [
            {
              id: 'msg-1',
              role: 'assistant',
              content: 'Thinking...',
              toolCalls: [],
              timestamp: 200,
            },
          ],
          timestamp: 200,
          totalUsage: null,
        }}
        toolResults={new Map()}
        isProcessing={true}
        runtimeSteps={runtimeSteps}
      />
    )

    const text = container.textContent || ''
    expect(text).toContain('Context compressed and summary generated')
  })

  it('preserves committed message order even when context_summary timestamp is backdated', () => {
    const { container } = render(
      <AssistantTurnBubble
        turn={{
          type: 'assistant',
          messages: [
            {
              id: 'assistant-before-summary',
              role: 'assistant',
              content: 'Current loop response body',
              timestamp: 500,
              toolCalls: [],
            },
            {
              id: 'summary-backdated',
              role: 'user',
              content: 'Earlier conversation summary:\nBackdated summary',
              kind: 'context_summary',
              timestamp: 100,
              toolCalls: [],
            },
          ],
          timestamp: 500,
          totalUsage: null,
        }}
        toolResults={new Map()}
        isProcessing={true}
      />
    )

    const text = container.textContent || ''
    const responseIndex = text.indexOf('Current loop response body')
    const summaryIndex = text.indexOf('Backdated summary')
    expect(responseIndex).toBeGreaterThanOrEqual(0)
    expect(summaryIndex).toBeGreaterThan(responseIndex)
  })

  it('keeps completed runtime content visible after previous content was already committed', () => {
    const runtimeSteps: DraftAssistantStep[] = [
      {
        id: 'content-old',
        timestamp: 120,
        type: 'content',
        content: 'Old runtime content',
        streaming: false,
      },
      {
        id: 'content-new',
        timestamp: 220,
        type: 'content',
        content: 'New runtime content not yet committed',
        streaming: false,
      },
    ]

    const { container } = render(
      <AssistantTurnBubble
        turn={{
          type: 'assistant',
          messages: [
            {
              id: 'assistant-committed',
              role: 'assistant',
              content: 'Already committed content',
              timestamp: 200,
              toolCalls: [],
            },
          ],
          timestamp: 200,
          totalUsage: null,
        }}
        toolResults={new Map()}
        isProcessing={true}
        runtimeSteps={runtimeSteps}
      />
    )

    const text = container.textContent || ''
    expect(text).toContain('Already committed content')
    expect(text).toContain('New runtime content not yet committed')
    expect(text).not.toContain('Old runtime content')
  })

  it('does not duplicate a committed assistant reasoning when the runtime step is newer than the message', () => {
    // Race: the committed assistant message (with its reasoning text) is created
    // BEFORE the runtime reasoning step's timestamp (step clock runs ahead).
    // The step must be recognized as already-committed and hidden — otherwise
    // the same thinking block renders twice, which is the reported bug where
    // the Thinking component sometimes shows up duplicated.
    const runtimeSteps: DraftAssistantStep[] = [
      {
        id: 'reasoning-live',
        timestamp: 500, // AHEAD of the committed message (300)
        type: 'reasoning',
        content: 'Inspecting the data flow.',
        streaming: false, // completed, but not yet evicted from runtime state
      },
    ]

    const { container } = render(
      <AssistantTurnBubble
        turn={{
          type: 'assistant',
          messages: [
            {
              id: 'assistant-committed',
              role: 'assistant',
              content: 'Final answer',
              reasoning: 'Inspecting the data flow.',
              timestamp: 300,
              toolCalls: [],
            },
          ],
          timestamp: 300,
          totalUsage: null,
        }}
        toolResults={new Map()}
        isProcessing={true}
        runtimeSteps={runtimeSteps}
      />
    )

    const text = container.textContent || ''
    // ReasoningSection renders a collapsible "Thinking Process" toggle header
    // (the body only mounts when expanded). Counting the header occurrence is
    // the reliable way to detect a duplicated thinking block.
    const headerCount = text.split('workflow.thinkingProcess').length - 1
    expect(headerCount).toBe(1)
  })
})
