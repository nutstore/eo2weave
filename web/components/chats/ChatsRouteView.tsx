'use client'

import { useRouter, useParams } from 'next/navigation'
import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout'
import { useConversationStore } from '@/store/conversation.store'
import { useWorkspaceRouteSyncStandalone } from '@/hooks/useWorkspaceRouteSyncStandalone'
import { chatPath, chatsPath } from '@/lib/route-paths'
import { useT } from '@/i18n'

/**
 * ChatsRouteView — the real view for the standalone-chat URL shape:
 *
 *   /chats/:chatId  (canonical)
 *
 * Standalone chats are kind='direct' conversations rendered through the SAME
 * WorkspaceLayout/ConversationView as project workspaces — the workspace ↔
 * conversation 1:1 binding is unchanged; only the route shape differs (no
 * /projects/:projectId prefix, the chats home is the fallback target).
 *
 * Route-gating: the persistent WorkspaceLayout renders whatever conversation
 * the ACTIVE pointer holds. During a chat switch (A → B) the route is already
 * B while `useWorkspaceRouteSyncStandalone` is still awaiting the workspace
 * switch and activation for B — without a gate the B URL would briefly show
 * conversation A, and a fast send could target the wrong conversation. The
 * view therefore renders the existing loading spinner until the active
 * conversation matches the route id (the same spinner pattern the layout's
 * own `!loaded || !workspaceReady` gate uses).
 */
export default function ChatsRouteView() {
  const router = useRouter()
  const params = useParams<{ chatId: string }>()
  const chatId = params.chatId ?? ''
  const t = useT()

  useWorkspaceRouteSyncStandalone(chatId)

  const activeConversationTitle = useConversationStore((s) => {
    const { activeConversationId, conversations } = s
    if (!activeConversationId) return undefined
    return conversations.find((c) => c.id === activeConversationId)?.title
  })
  // The gate: the mounted conversation surface must show the ROUTE's chat.
  // Also true when no chat is active at all (bare state) — the layout's own
  // loaded/workspaceReady gates then decide between Welcome and spinner, and
  // this component must not block that settled empty state.
  const activeMatchesRoute = useConversationStore((s) => {
    const active = s.activeConversationId
    return !active || active === chatId
  })

  if (!activeMatchesRoute) {
    // Activation for this route's chat is still in flight (workspace switch
    // + setActive awaited by the sync hook). Nothing interactive renders, so
    // a fast send cannot target the stale conversation.
    return (
      <div
        role="status"
        aria-live="polite"
        aria-label={t('common.loading')}
        className="flex h-64 w-full items-center justify-center bg-background dark:bg-neutral-950"
      >
        <div className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-primary-600 dark:border-neutral-700 dark:border-t-primary-500" />
        <span className="sr-only">{t('common.loading')}</span>
      </div>
    )
  }

  return (
    <WorkspaceLayout
      routeSpace="chats"
      onBackToProjects={() => router.replace(chatsPath())}
      conversationName={activeConversationTitle}
      onSwitchProject={async () => {
        // No project semantics in the standalone chat space.
        router.replace(chatsPath())
      }}
      onSelectWorkspace={(wsId: string) => {
        router.push(chatPath(wsId))
      }}
      onDraftConversationCreated={(wsId: string) => {
        // First message sent from the WelcomeScreen: replace, not push, so the
        // welcome state leaves no history entry.
        router.replace(chatPath(wsId))
      }}
    />
  )
}
