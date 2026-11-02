/**
 * ChatsRouteView route-gating tests (round-6 finding):
 *
 * `activeMatchesRoute` used to treat an EMPTY active pointer as a match
 * (`!active || active === chatId`). On a cold `/chats/:chatId` link the sync
 * hook is still mid-flight (workspace switch + setActive in queue) when the
 * workspace becomes interactive, so the gate opened with activeConversationId
 * still null — the layout fell through to WelcomeScreen and a fast send
 * could create/target a conversation other than the URL's chat. A nonempty
 * route id must keep the loading gate closed until
 * `activeConversationId === chatId`; only the intentionally empty bare state
 * (`/chats` without an id) passes while inactive.
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const t = (key: string) => (key === 'common.loading' ? '加载中…' : key)

const routeState = vi.hoisted(() => ({ chatId: '' }))
const conversationState = vi.hoisted(() => ({
  activeConversationId: null as string | null,
  conversations: [] as Array<{ id: string; title: string }>,
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useParams: () => ({ chatId: routeState.chatId }),
}))
vi.mock('@/i18n', () => ({ useT: () => t }))
vi.mock('@/hooks/useWorkspaceRouteSyncStandalone', () => ({
  useWorkspaceRouteSyncStandalone: vi.fn(),
}))
vi.mock('@/lib/route-paths', () => ({
  chatPath: (id: string) => `/chats/${id}`,
  chatsPath: () => '/chats',
}))

// WorkspaceLayout is the mount surface — a cheap stub whose text tells us
// which branch rendered (conversation surface vs welcome vs gate).
vi.mock('@/components/layout/WorkspaceLayout', () => ({
  WorkspaceLayout: () => <div data-testid="workspace-layout">layout-mounted</div>,
}))

const useConversationStoreState = (selector: (s: typeof conversationState) => unknown) =>
  selector(conversationState)

vi.mock('@/store/conversation.store', () => ({
  useConversationStore: Object.assign(
    (selector: (s: typeof conversationState) => unknown) => useConversationStoreState(selector),
    { getState: () => conversationState },
  ),
}))

import ChatsRouteView from '@/components/chats/ChatsRouteView'

describe('ChatsRouteView — route gate with a nonempty chatId', () => {
  beforeEach(() => {
    routeState.chatId = ''
    conversationState.activeConversationId = null
    conversationState.conversations = []
  })

  it('keeps the loading gate closed while activation for the URL chat is in flight', () => {
    routeState.chatId = 'chat-b'
    // Workspace interactive, active pointer still null: the sync hook has not
    // committed setActive('chat-b') yet.
    conversationState.activeConversationId = null

    render(<ChatsRouteView />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-layout')).not.toBeInTheDocument()
  })

  it('keeps the gate closed while a PREVIOUS chat is still active (switch in flight)', () => {
    routeState.chatId = 'chat-b'
    conversationState.activeConversationId = 'chat-a'
    conversationState.conversations = [{ id: 'chat-a', title: 'A' }]

    render(<ChatsRouteView />)

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.queryByTestId('workspace-layout')).not.toBeInTheDocument()
  })

  it('renders the workspace once the active pointer matches the route chat', () => {
    routeState.chatId = 'chat-b'
    conversationState.activeConversationId = 'chat-b'
    conversationState.conversations = [{ id: 'chat-b', title: 'B' }]

    render(<ChatsRouteView />)

    expect(screen.getByTestId('workspace-layout')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('still allows the intentionally empty bare state through when the route has no chatId', () => {
    // /chats without an id: active null is the settled empty state — the
    // layout's own loaded/workspaceReady gates decide Welcome vs spinner.
    routeState.chatId = ''
    conversationState.activeConversationId = null

    render(<ChatsRouteView />)

    expect(screen.getByTestId('workspace-layout')).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
