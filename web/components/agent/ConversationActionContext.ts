/**
 * ConversationActionContext — provides conversation action callbacks
 * to deeply nested components without prop drilling.
 *
 * Currently exposes:
 * - setInput: set the conversation input text (for "follow up" from selection)
 * - insertQuote: insert a quoted selection into the composer as a quote block
 * - sendMessage: send a user message and trigger AI response
 */

import { createContext, useContext } from 'react'

export interface ConversationActionContextValue {
  /** Set the conversation input text */
  setInput: (text: string) => void
  /** Insert a quoted selection into the composer, below any existing draft */
  insertQuote: (lines: string[]) => void
  /** Send a user message and trigger AI response; `consumePendingAssets: false`
   *  for internal resume sends keeps the composer's staged files intact */
  sendMessage: (text: string, options?: { consumePendingAssets?: boolean }) => void
}

export const ConversationActionContext = createContext<ConversationActionContextValue | null>(null)

/**
 * Hook to access conversation actions from context.
 * Throws if used outside of ConversationActionContext.Provider.
 */
export function useConversationActions(): ConversationActionContextValue {
  const ctx = useContext(ConversationActionContext)
  if (!ctx) {
    throw new Error('useConversationActions must be used within ConversationActionContext.Provider')
  }
  return ctx
}
