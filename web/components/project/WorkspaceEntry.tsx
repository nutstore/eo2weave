'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useProjectStore } from '@/store/project.store'
import { projectWorkspacePath } from '@/lib/route-paths'
import { hasPendingSidePanelProjectRoute } from '@/agent/workspace-assistant-context'

/** Open the newly created default project once, without overriding side-panel routing. */
export function WorkspaceEntry() {
  const router = useRouter()
  const initialized = useProjectStore((state) => state.initialized)
  const projects = useProjectStore((state) => state.projects)
  const initError = useProjectStore((state) => state.initError)

  useEffect(() => {
    if (initError || !initialized || projects.length !== 1) return
    if (hasPendingSidePanelProjectRoute()) {
      sessionStorage.removeItem('creatorweave:auto-default-pending-entry')
      return
    }
    if (sessionStorage.getItem('creatorweave:auto-default-redirected')) return
    if (!sessionStorage.getItem('creatorweave:auto-default-pending-entry')) return
    sessionStorage.removeItem('creatorweave:auto-default-pending-entry')
    sessionStorage.setItem('creatorweave:auto-default-redirected', '1')
    router.replace(projectWorkspacePath(projects[0].id))
  }, [initialized, projects, initError, router])

  return null
}
