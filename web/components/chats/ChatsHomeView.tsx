'use client'

import { useCallback, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { useConversationStore } from '@/store/conversation.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useProjectStore } from '@/store/project.store'
import { useT } from '@/i18n'
import { ChatsHome, type StandaloneChatListItem } from '@/components/chats/ChatsHome'

/**
 * ChatsHomeView — store-connected ChatsHome for the /chats route.
 *
 * Pulls kind='direct' conversations from the conversation store (message
 * counts come from the store's loaded message arrays when available, else
 * null → the row omits the count — messages are lazily loaded per
 * conversation) and owns the create flow: createNew(kind:'direct') →
 * /chats/:id (instant-create, same pattern as the New Chat button).
 */
export default function ChatsHomeView() {
  const router = useRouter()

  const loaded = useConversationStore((s) => s.loaded)
  const loadFromDB = useConversationStore((s) => s.loadFromDB)
  const loadError = useConversationStore((s) => s.loadError)
  const createNew = useConversationStore((s) => s.createNew)
  const t = useT()
  const conversations = useConversationStore((s) =>
    s.conversations.map((c): StandaloneChatListItem => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      // kind must ride along: the filter below drops everything otherwise
      // (every row would be kind=undefined ≡ not 'direct' → empty list).
      kind: c.kind,
      messageCount: c.messagesLoaded ? c.messages.length : null,
      lastActivityAt:
        c.messagesLoaded && c.messages.length > 0
          ? (c.messages[c.messages.length - 1]?.timestamp ?? c.updatedAt)
          : c.updatedAt,
    })),
  )

  // Workspace store readiness — same settle gate the /projects route uses so
  // switchWorkspace inside the chat route never races a half-initialized store.
  const workspaceInitialized = useConversationContextStore((s) => s.initialized)
  const projectLoading = useProjectStore((s) => s.isLoading)

  // Load persisted conversations (the store is global; /chats may be the
  // first route the user lands on, so nothing else has triggered the load).
  useEffect(() => {
    if (!loaded && workspaceInitialized && !projectLoading) loadFromDB()
  }, [loaded, loadError, loadFromDB, workspaceInitialized, projectLoading])

  const chats = useMemo(
    () =>
      conversations
        .filter((c) => c.kind === 'direct')
        .sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  )

  const handleCreateChat = useCallback(() => {
    const conv = createNew(t('chats.home.newChatTitle'), { kind: 'direct' })
    router.push(`/chats/${conv.id}`)
  }, [createNew, router, t])

  return (
    <ChatsHome
      chats={chats}
      isLoading={!loaded}
      onCreateChat={handleCreateChat}
      onOpenChat={(id: string) => router.push(`/chats/${id}`)}
    />
  )
}
