/**
 * ConversationEmptyState — placeholder when no messages exist.
 */

import { MessageSquare } from 'lucide-react'
import { useT } from '@/i18n'
import { useConversationStore } from '@/store/conversation.store'

export function ConversationEmptyState() {
  const t = useT()
  // Direct conversations get their own positioning copy (casual-chat framing).
  const isDirect = useConversationStore(
    (s) => !!s.activeConversationId && s.conversations.find((c) => c.id === s.activeConversationId)?.kind === 'direct'
  )

  return (
    <div className="flex h-full items-center justify-center">
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4">
        <div className="flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-primary-500 to-primary-600 shadow-xl shadow-primary-500/20">
            <MessageSquare className="h-8 w-8 text-white" />
          </div>
          <h3 className="mb-2 text-lg font-semibold text-foreground">
            {t('conversation.empty.title')}
          </h3>
          <p className="max-w-md text-sm leading-relaxed text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
            {isDirect ? t('conversation.directChat.inputPlaceholder') : t('conversation.empty.description')}
          </p>
        </div>
      </div>
    </div>
  )
}
