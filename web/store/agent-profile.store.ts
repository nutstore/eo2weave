/**
 * Agent Profile Store
 *
 * Owns the open/closed state of the Agent Profile panel.
 * The panel is shared between WelcomeScreen and ConversationView, so it lives in its own store.
 */

import { create } from 'zustand'

interface AgentProfileState {
  /** Whether the panel is open */
  isOpen: boolean
  /** Id of the agent currently being edited in the panel */
  agentId: string | null

  open: (agentId: string) => void
  close: () => void
}

export const useAgentProfileStore = create<AgentProfileState>()((set) => ({
  isOpen: false,
  agentId: null,

  open: (agentId) => set({ isOpen: true, agentId }),
  close: () => set({ isOpen: false, agentId: null }),
}))

export type { AgentProfileState }
