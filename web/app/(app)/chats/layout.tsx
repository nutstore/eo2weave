'use client'

import { useSidePanelSettle } from '@/hooks/useSidePanelSettle'

/**
 * Client layout for /chats/** — shared by the chats home (bare /chats) and
 * individual chats. useSidePanelSettle re-arms the Edge side-panel URL settle
 * on every route change, same as the /projects layouts.
 */
export default function ChatsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  useSidePanelSettle()
  return children
}
