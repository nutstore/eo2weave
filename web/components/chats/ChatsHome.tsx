'use client'

import { memo } from 'react'
import Link from 'next/link'
import { ArrowLeft, MessageCircle, Plus } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN, enUS, ja, ko } from 'date-fns/locale'
import type { Locale as DateFnsLocale } from 'date-fns'
import { useT, useLocale } from '@/i18n'
import { BrandButton } from '@creatorweave/ui'
import { ChatActions } from './ChatActions'

const LOCALE_MAP: Record<string, DateFnsLocale> = { 'zh-CN': zhCN, 'en-US': enUS, 'ja-JP': ja, 'ko-KR': ko }

export interface StandaloneChatListItem {
  id: string
  title: string
  updatedAt: number
  messageCount: number | null
  lastActivityAt: number
  preview?: string
  kind?: 'project' | 'direct'
}

interface ChatsHomeProps {
  chats: StandaloneChatListItem[]
  isLoading?: boolean
  loadError?: string | null
  onRetry?: () => void
  onCreateChat: () => void
  onOpenChat: (id: string) => void
}

const ChatRow = memo(function ChatRow({ chat, onOpen, messagesLabel }: {
  chat: StandaloneChatListItem
  onOpen: (id: string) => void
  messagesLabel: string
}) {
  const [locale] = useLocale()
  const activityLabel = chat.lastActivityAt
    ? formatDistanceToNow(new Date(chat.lastActivityAt), { addSuffix: true, locale: LOCALE_MAP[locale] ?? enUS })
    : ''
  return (
    <div className="group flex items-center gap-1 border-b border-border/70 transition-colors hover:bg-muted/40 sm:gap-3">
      <button
        type="button"
        data-testid="standalone-chat-row"
        onClick={() => onOpen(chat.id)}
        className="flex min-w-0 flex-1 items-center gap-3 py-5 pr-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 sm:gap-4 sm:pr-3"
      >
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary" aria-hidden>
          <MessageCircle className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold text-foreground sm:text-[15px]">{chat.title}</span>
          <span className="mt-1 block truncate text-xs text-muted-foreground sm:text-sm">
            {chat.preview || (chat.messageCount !== null ? messagesLabel : null)}
            {activityLabel && <span className={chat.preview || chat.messageCount !== null ? 'sm:hidden' : ''}>{chat.preview || chat.messageCount !== null ? ` · ${activityLabel}` : activityLabel}</span>}
          </span>
        </span>
        {(chat.preview || chat.messageCount !== null) && <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{activityLabel}</span>}
      </button>
      <ChatActions id={chat.id} title={chat.title} />
    </div>
  )
})

export function ChatsHome({ chats, isLoading = false, loadError = null, onRetry, onCreateChat, onOpenChat }: ChatsHomeProps) {
  const t = useT()

  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <main className="mx-auto w-full max-w-4xl px-5 pb-16 pt-7 sm:px-8 sm:pt-12">
        <Link href="/projects" className="mb-7 inline-flex items-center gap-2 rounded-md text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:mb-10">
          <ArrowLeft className="h-4 w-4" aria-hidden />{t('chats.home.backToProjects')}
        </Link>
        <header className="flex flex-col items-start justify-between gap-5 sm:flex-row sm:items-end">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('chats.home.title')}</h1>
            <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">{t('chats.home.subtitle')}</p>
          </div>
          <button type="button" data-testid="create-standalone-chat" onClick={onCreateChat} disabled={isLoading} className="inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 disabled:opacity-50">
            <Plus className="h-4 w-4" aria-hidden />{t('chats.home.newChat')}
          </button>
        </header>
        <section aria-label={t('chats.home.title')} className="mt-10 sm:mt-14">
          <div className="flex items-center justify-between border-b border-border pb-4">
            <h2 className="text-sm font-semibold text-foreground">{t('chats.home.recentChats')}</h2>
            {!isLoading && !loadError && <span className="text-xs tabular-nums text-muted-foreground">{chats.length}</span>}
          </div>
          {loadError && !isLoading ? (
            <div role="alert" className="flex flex-col items-center gap-3 px-4 py-16 text-center">
              <p className="text-sm text-muted-foreground">{t('chats.home.loadError')}<span className="mt-1 block text-xs text-muted-foreground/70">{loadError}</span></p>
              {onRetry && <BrandButton variant="outline" onClick={onRetry}>{t('chats.home.retry')}</BrandButton>}
            </div>
          ) : isLoading ? (
            <div role="status" aria-live="polite" className="flex items-center justify-center py-16"><span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-300 border-t-primary-600 dark:border-neutral-700 dark:border-t-primary-500" /><span className="sr-only">{t('common.loading')}</span></div>
          ) : chats.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-20 text-center">
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary"><MessageCircle className="h-5 w-5" aria-hidden /></span>
              <p className="text-sm text-muted-foreground">{t('chats.home.emptyWelcome')}</p>
            </div>
          ) : chats.map((chat) => <ChatRow key={chat.id} chat={chat} onOpen={onOpenChat} messagesLabel={t('chats.home.messageCount', { count: chat.messageCount ?? 0 })} />)}
        </section>
      </main>
    </div>
  )
}
