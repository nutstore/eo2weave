import { describe, it, expect, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MessageBubble } from '../MessageBubble'
import type { Message } from '@/agent/message-types'

// Minimal i18n mock — MessageBubble uses useT for edit/cancel labels
vi.mock('@/i18n', () => ({ useT: () => (k: string) => k }))

function userMsg(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    role: 'user',
    content: '',
    timestamp: 1700000000000,
    ...overrides,
  }
}

const asset = {
  id: 'a1',
  name: 'photo.png',
  mimeType: 'image/png',
  size: 1024,
  createdAt: 1700000000000,
  direction: 'upload' as const,
}

it('renders a background result as an application event without human edit actions', () => {
  const edit = vi.fn()
  const content = 'Document inspection finished\n\nTrace: subagent child, execution attempt'
  const { container } = render(<MessageBubble message={userMsg({ content, subagentCompletion: { eventIds: ['child:attempt'] } })} onEditAndResend={edit} />)
  const disclosure = screen.getByRole('button', { name: 'conversation.backgroundTasks.viewResult' })
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Document inspection finished')).not.toBeInTheDocument()
  expect(screen.queryByText(/Trace: subagent/)).not.toBeInTheDocument()
  fireEvent.click(disclosure)
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText('Document inspection finished')).toBeInTheDocument()
  expect(screen.getByText('Trace: subagent child, execution attempt')).toBeInTheDocument()
  fireEvent.click(disclosure)
  expect(screen.queryByText('Document inspection finished')).not.toBeInTheDocument()
  expect(container.querySelector('.bg-primary-600')).toBeNull()
  expect(container.querySelector('.lucide-user')).toBeNull()
  expect(screen.queryByRole('button', { name: /edit/i })).toBeNull()
})

describe('MessageBubble — attachment-only user message (plan A)', () => {
  it('renders no text bubble when content is empty but assets exist', () => {
    const { container } = render(<MessageBubble message={userMsg({ assets: [asset] })} />)
    // The primary-600 text bubble must be absent
    const bubbles = container.querySelectorAll('.bg-primary-600')
    expect(bubbles.length).toBe(0)
  })

  it('renders the text bubble when content is present', () => {
    render(<MessageBubble message={userMsg({ content: 'hello' })} />)
    expect(screen.getByText('hello')).toBeTruthy()
  })
})
