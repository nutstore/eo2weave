'use client'

import { memo } from 'react'
import { MessageCircle, Plus } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN, enUS, ja, ko } from 'date-fns/locale'
import type { Locale as DateFnsLocale } from 'date-fns'
import { useT, useLocale } from '@/i18n'
import { BrandButton } from '@creatorweave/ui'

const LOCALE_MAP: Record<string, DateFnsLocale> = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': ja,
  'ko-KR': ko,
}

/** List-row projection of a standalone chat — fed by ChatsHomeView. */
export interface StandaloneChatListItem {
  id: string
  title: string
  updatedAt: number
  /** null = messages not loaded for this conversation (lazy per conversation) */
  messageCount: number | null
  lastActivityAt: number
  /** Present in store projection; ChatsHome rows are pre-filtered to 'direct'. */
  kind?: 'project' | 'direct'
}

interface ChatsHomeProps {
  chats: StandaloneChatListItem[]
  isLoading?: boolean
  onCreateChat: () => void
  onOpenChat: (id: string) => void
}

const ChatRow = memo(function ChatRow({
  chat,
  onOpen,
  title,
  messagesLabel,
}: {
  chat: StandaloneChatListItem
  onOpen: (id: string) => void
  title: string
  messagesLabel: string
}) {
  const [locale] = useLocale()
  const activityLabel = chat.lastActivityAt
    ? formatDistanceToNow(new Date(chat.lastActivityAt), {
        addSuffix: true,
        locale: LOCALE_MAP[locale] ?? zhCN,
      })
    : ''
  return (
    <button
      type="button"
      data-testid="standalone-chat-row"
      onClick={() => onOpen(chat.id)}
      className="flex w-full items-center gap-3 rounded-xl border border-border/60 bg-card px-4 py-3 text-left transition-colors hover:border-primary/40 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary" aria-hidden>
        <MessageCircle className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-secondary dark:text-secondary-foreground">
          {chat.title}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          {activityLabel}
          {chat.messageCount !== null && (
            <> · {messagesLabel}</>
          )}
        </span>
      </span>
      <span className="sr-only">{title}</span>
    </button>
  )
})

/**
 * ChatsHome — presentation component for /chats.
 *
 * Title + subtitle + big dashed "new chat" button + full standalone-chat list
 * (kind='direct'). P3: the site assistant will be pinned above the list
 * (TODO below).
 */
export function ChatsHome({ chats, isLoading = false, onCreateChat, onOpenChat }: ChatsHomeProps) {
  const t = useT()

  return (
    <div className="min-h-[100dvh] bg-background">
      <main className="mx-auto w-full max-w-3xl space-y-6 px-6 pb-12 pt-10">
        {/* TODO(P3 site assistant): pin the per-site assistant conversation at
            the top of this page once the embedded-instance loop lands. */}

        {/* Header */}
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-secondary dark:text-secondary-foreground">
            {t('chats.home.title')}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t('chats.home.subtitle')}
          </p>
        </header>

        {/* Primary create action */}
        <button
          type="button"
          data-testid="create-standalone-chat"
          onClick={onCreateChat}
          disabled={isLoading}
          className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border px-6 py-10 text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-50"
        >
          <Plus className="h-6 w-6" aria-hidden />
          <span className="text-sm font-medium">
            {t('chats.home.newChat')}
          </span>
        </button>

        {/* Chat list */}
        <section aria-label={t('chats.home.title')} className="space-y-2">
          {isLoading ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center justify-center py-12 text-sm text-muted-foreground"
            >
              <span className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-primary-600 dark:border-neutral-700 dark:border-t-primary-500" />
            </div>
          ) : chats.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border/60 bg-card px-6 py-12 text-center">
              <MessageCircle className="h-8 w-8 text-muted-foreground/50" aria-hidden />
              <p className="text-sm text-muted-foreground">
                {t('chats.home.emptyWelcome')}
              </p>
            </div>
          ) : (
            chats.map((chat) => (
              <ChatRow
                key={chat.id}
                chat={chat}
                onOpen={onOpenChat}
                title={t('chats.home.openChat')}
                messagesLabel={t('chats.home.messageCount', { count: chat.messageCount ?? 0 })}
              />
            ))
          )}
        </section>

        {/* Secondary escape hatch back to the projects space */}
        <div className="flex justify-center pt-2">
          <BrandButton
            variant="ghost"
            className="text-xs text-muted-foreground"
            onClick={() => {
              window.location.assign('/projects')
            }}
          >
            {t('chats.home.backToProjects')}
          </BrandButton>
        </div>
      </main>
    </div>
  )
}
