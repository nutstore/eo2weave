'use client'

/**
 * Canonical standalone chat URL. The actual chat UI is rendered by the parent
 * layout (kept mounted across chat switches — see layout.tsx); this page
 * exists only so the URL resolves and the [chatId] segment is part of the
 * route (useParams() in the layout reads it).
 */
export default function ChatByIdPage() {
  return null
}
