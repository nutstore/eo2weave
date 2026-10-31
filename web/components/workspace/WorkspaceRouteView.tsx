'use client'

import { useRouter, useParams } from 'next/navigation'
import { WorkspaceLayout } from '@/components/layout/WorkspaceLayout'
import { useProjectStore } from '@/store/project.store'
import { useConversationStore } from '@/store/conversation.store'
import { InitErrorBanner } from '@/components/project/InitErrorBanner'
import { useWorkspaceRouteSync } from '@/hooks/useWorkspaceRouteSync'
import { projectWorkspacePath, projectsPath } from '@/lib/route-paths'

/**
 * WorkspaceRouteView — the real view for all three workspace URL shapes:
 *
 *   /projects/:projectId                       (bare)
 *   /projects/:projectId/workspace             (legacy singular — HTTP 308 → bare)
 *   /projects/:projectId/workspaces/:workspaceId  (canonical)
 *
 * Each page file is a thin client shell that dynamically loads this view
 * (browser-only module graph: monaco via WorkspaceLayout etc.). Next owns
 * URL matching; this component only syncs URL params → stores (ported from
 * the legacy WorkspaceRoute.syncFromRoute) and renders WorkspaceLayout.
 *
 * React 18 note: next/navigation's useParams() returns params synchronously
 * (no Promise unwrapping needed — React.use() is React-19-only and must not
 * be used here).
 */
export default function WorkspaceRouteView() {
  const router = useRouter()
  const params = useParams<{ projectId: string; workspaceId?: string }>()

  // Next's App Router already decodes URI components in route params.
  const projectId = params.projectId ?? ''
  const workspaceId = params.workspaceId ?? undefined

  useWorkspaceRouteSync(projectId, workspaceId)

  const projects = useProjectStore((s) => s.projects)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const initError = useProjectStore((s) => s.initError)
  const activeConversationTitle = useConversationStore((s) => {
    const { activeConversationId, conversations } = s
    if (!activeConversationId) return undefined
    return conversations.find((c) => c.id === activeConversationId)?.title
  })

  const activeProject = projects.find((project) => project.id === activeProjectId)

  // Initialization failure on a DIRECT workspace URL (open/refresh
  // /projects/:id/...): useWorkspaceRouteSync returns early while the store
  // is uninitialized and WorkspaceLayout would render an unusable empty shell
  // with no error and no action (Sourcery: "Workspace route stays unusable").
  // Surface the same banner + Retry the projects page shows.
  if (initError) {
    return <InitErrorBanner />
  }

  return (
    <WorkspaceLayout
      onBackToProjects={() => router.replace(projectsPath())}
      projectName={activeProject?.name}
      conversationName={activeConversationTitle}
      onSwitchProject={async (targetProjectId: string) => {
        router.push(projectWorkspacePath(targetProjectId))
      }}
      onCreateProject={() => router.push(projectsPath())}
      onManageProjects={() => router.push(projectsPath())}
      onSelectWorkspace={(wsId: string) => {
        router.push(projectWorkspacePath(projectId, wsId))
      }}
      onDraftConversationCreated={(wsId: string) => {
        // First message sent from the WelcomeScreen (bare URL): replace, not
        // push, so the welcome state leaves no history entry.
        router.replace(projectWorkspacePath(projectId, wsId))
      }}
    />
  )
}
