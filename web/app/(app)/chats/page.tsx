'use client'

import dynamic from 'next/dynamic'

// ChatsHomeView is browser-only (stores + SQLite). Keep it out of the server
// bundle with dynamic(ssr:false) — same pattern as the projects home.
const ChatsHomeView = dynamic(() => import('@/components/chats/ChatsHomeView'), {
  ssr: false,
})

/**
 * Standalone chats home (/chats) — lists every kind='direct' conversation and
 * offers instant creation (createNew(kind:'direct') → /chats/:id).
 */
export default function ChatsPage() {
  return <ChatsHomeView />
}
