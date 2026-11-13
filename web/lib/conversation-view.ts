/**
 * Whether the user is looking at this conversation right now.
 *
 * Uses the store's active conversation (the value the UI renders) instead of
 * parsing the URL: the app has both /projects/:id/workspaces/:conversationId and
 * /chats/:chatId, and a URL regex silently misses the routes it was not written for.
 */
export function isViewingConversation(
  activeConversationId: string | null | undefined,
  conversationId: string,
  visibilityState: DocumentVisibilityState
): boolean {
  return activeConversationId === conversationId && visibilityState === 'visible'
}
