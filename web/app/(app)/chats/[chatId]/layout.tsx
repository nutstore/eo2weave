'use client'

import dynamic from 'next/dynamic'
import { useSidePanelSessionRecovery } from '@/hooks/useSidePanelSessionRecovery'

// Mirrors /projects/[projectId]/layout.tsx: the real view lives in the LAYOUT
// so navigating chats/A → chats/B never remounts the workspace UI (no replayed
// entry animations, no scroll resets). Leaf page.tsx files render null; they
// exist only for URL matching.
const ChatsRouteView = dynamic(() => import('@/components/chats/ChatsRouteView'), {
  ssr: false,
})

/**
 * Client layout for /chats/[chatId]/**
 *
 * Matches the bare and canonical standalone-chat URL shapes; the view reads
 * the full route params via useParams() and keeps the stores in sync.
 *
 * Mirrors the /projects layout: recover side-panel bindings after a reload.
 * Route changes stay inside the web app and do not reconfigure the browser's
 * side-panel entry URL.
 */
export default function ChatLayout({
  children,
}: {
  children: React.ReactNode
}) {
  useSidePanelSessionRecovery()
  return (
    <>
      <ChatsRouteView />
      {children}
    </>
  )
}
