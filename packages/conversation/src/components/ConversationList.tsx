/**
 * ConversationList - displays list of conversations with active indication.
 * Matches the host's Sidebar styles for consistency.
 */

import type { Conversation } from '../types/conversation'

interface ConversationListProps {
  conversations: Conversation[]
  activeConversationId: string | null
  onSelectConversation: (id: string) => void
  className?: string
  /** Show running status indicator (when conversation is active/running) */
  isConversationRunning?: (id: string) => boolean
}

export function ConversationList({
  conversations,
  activeConversationId,
  onSelectConversation,
  className = '',
  isConversationRunning,
}: ConversationListProps) {
  if (conversations.length === 0) {
    return (
      <div className={`flex h-full items-center justify-center text-neutral-400 ${className}`}>
        <p>暂无会话</p>
      </div>
    )
  }

  return (
    <div className={`space-y-0.5 overflow-y-auto ${className}`}>
      {conversations.map((conv) => {
        const isRunning = isConversationRunning?.(conv.id)
        return (
          <div
            key={conv.id}
            className={`group flex cursor-pointer items-center rounded-md px-2.5 py-1.5 text-xs ${
              conv.id === activeConversationId
                ? 'bg-primary-100 font-medium text-primary-700'
                : 'text-neutral-600 hover:bg-neutral-200'
            }`}
            onClick={() => onSelectConversation(conv.id)}
          >
            {/* Running status indicator */}
            {isRunning && (
              <span className="mr-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-yellow-500" />
            )}
            <span className="min-w-0 flex-1 truncate">{conv.title}</span>
            {conv.hasMore && (
              <span className="ml-1.5 shrink-0 text-[10px] text-neutral-400">
                +
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
