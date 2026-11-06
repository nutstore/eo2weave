'use client'

import { useSidePanelSessionRecovery } from '@/hooks/useSidePanelSessionRecovery'

/**
 * Client layout for /chats/** — shared by the chats home (bare /chats) and
 * individual chats. Mirrors the /projects layouts: recover side-panel
 * bindings after reloads; route changes stay inside the web app and do not
 * reconfigure the browser's side-panel entry URL.
 */
export default function ChatsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  useSidePanelSessionRecovery()
  return children
}
