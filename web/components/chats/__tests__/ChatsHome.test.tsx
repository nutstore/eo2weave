import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ChatsHome, type StandaloneChatListItem } from '@/components/chats/ChatsHome'

// Pure presentation component — i18n via a key→copy map.
const t = (key: string, params?: Record<string, string | number>) => {
  const messages: Record<string, string> = {
    'chats.home.title': '独立对话',
    'chats.home.subtitle': '与项目无关的对话——无文件访问，随时开聊',
    'chats.home.newChat': '开始新的独立对话',
    'chats.home.emptyWelcome': '随便聊聊，或问我任何问题…',
    'chats.home.openChat': '打开对话',
    'chats.home.messageCount': '{count} 条消息',
    'chats.home.backToProjects': '返回项目',
  }
  let text = messages[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

vi.mock('@/i18n', () => ({
  useT: () => t,
  useLocale: () => ['zh-CN'],
}))

// BrandButton comes from the ui package — render children plainly.
vi.mock('@creatorweave/ui', () => ({
  BrandButton: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

const chat = (overrides: Partial<StandaloneChatListItem>): StandaloneChatListItem => ({
  id: 'chat-1',
  title: 'A standalone chat',
  updatedAt: Date.now(),
  messageCount: 3,
  lastActivityAt: Date.now(),
  kind: 'direct',
  ...overrides,
})

describe('ChatsHome — standalone chats home', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders title, subtitle and the big create button', () => {
    render(
      <ChatsHome chats={[]} onCreateChat={vi.fn()} onOpenChat={vi.fn()} />,
    )

    expect(screen.getByRole('heading', { name: '独立对话' })).toBeInTheDocument()
    expect(screen.getByText('与项目无关的对话——无文件访问，随时开聊')).toBeInTheDocument()
    expect(screen.getByTestId('create-standalone-chat')).toHaveTextContent('开始新的独立对话')
  })

  it('creates a new chat from the dashed button', async () => {
    const user = userEvent.setup()
    const onCreateChat = vi.fn()
    render(
      <ChatsHome chats={[]} onCreateChat={onCreateChat} onOpenChat={vi.fn()} />,
    )

    await user.click(screen.getByTestId('create-standalone-chat'))
    expect(onCreateChat).toHaveBeenCalledTimes(1)
  })

  it('opens a chat when its row is clicked', async () => {
    const user = userEvent.setup()
    const onOpenChat = vi.fn()
    render(
      <ChatsHome
        chats={[chat({ id: 'chat-9', title: 'Recent ideas' })]}
        onCreateChat={vi.fn()}
        onOpenChat={onOpenChat}
      />,
    )

    await user.click(screen.getByTestId('standalone-chat-row'))
    expect(onOpenChat).toHaveBeenCalledWith('chat-9')
  })

  it('shows the welcome empty state when no chats exist', () => {
    render(
      <ChatsHome chats={[]} onCreateChat={vi.fn()} onOpenChat={vi.fn()} />,
    )

    expect(screen.getByText('随便聊聊，或问我任何问题…')).toBeInTheDocument()
  })

  it('renders every chat row with title and message count', () => {
    render(
      <ChatsHome
        chats={[
          chat({ id: 'a', title: 'First', messageCount: 2 }),
          chat({ id: 'b', title: 'Second', messageCount: null }),
        ]}
        onCreateChat={vi.fn()}
        onOpenChat={vi.fn()}
      />,
    )

    const rows = screen.getAllByTestId('standalone-chat-row')
    expect(rows).toHaveLength(2)
    expect(within(rows[0]).getByText('First')).toBeInTheDocument()
    // Relative time + count render inside one <span> as separate text nodes —
    // match on textContent; getAllByText because outer spans also contain it.
    const countMatches = within(rows[0]).getAllByText((_, el) => (el?.textContent ?? '').includes('2 条消息'))
    expect(countMatches.length).toBeGreaterThan(0)
    // messageCount null → count omitted, not "0"
    expect(within(rows[1]).getByText('Second')).toBeInTheDocument()
    expect(within(rows[1]).queryByText(/条消息/)).not.toBeInTheDocument()
  })
})
