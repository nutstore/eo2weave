'use client'

import dynamic from 'next/dynamic'
import { useSidePanelSessionRecovery } from '@/hooks/useSidePanelSessionRecovery'
import { StorageLoading } from '@/components/StorageLoading'

// The real workspace UI lives in the LAYOUT, not the leaf pages: Next.js
// preserves a layout across navigations between its child pages, including
// dynamic-param changes like workspaces/A → workspaces/B. Hosting the view
// here means switching conversations does NOT remount WorkspaceLayout /
// Sidebar / the conversation view (no replayed entry animations, no scroll
// resets) — matching the old hand-rolled router, where every workspace URL
// shared one WorkspaceRoute component instance.
// The leaf page.tsx files render null; they exist only for URL matching.
const WorkspaceRouteView = dynamic(() => import('@/components/workspace/WorkspaceRouteView'), {
  ssr: false,
  loading: () => <StorageLoading />,
})

/**
 * Client layout for /projects/[projectId]/**
 *
 * Matches three URL shapes (bare / canonical / legacy-singular-via-308);
 * WorkspaceRouteView reads the full route params via useParams() and keeps
 * the stores in sync (see useWorkspaceRouteSync).
 *
 * Recover side-panel bindings after reloads. Route changes stay inside the
 * web app and do not reconfigure the browser's side-panel entry URL.
 */
export default function ProjectWorkspaceLayout({
  children,
}: {
  children: React.ReactNode
}) {
  useSidePanelSessionRecovery()
  return (
    <>
      <WorkspaceRouteView />
      {children}
    </>
  )
}
