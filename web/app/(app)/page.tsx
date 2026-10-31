'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useProjectStore } from '@/store/project.store'
import { projectWorkspacePath, projectsPath } from '@/lib/route-paths'
import { hasPendingSidePanelProjectRoute } from '@/agent/workspace-assistant-context'

/**
 * Root page (`/`). The legacy client router's catch-all redirected `/` to
 * `/projects`; this page reproduces that plus the first-run auto-redirect
 * into the auto-created default project (previously in AppReady).
 */
export default function RootPage() {
  const router = useRouter()
  const initialized = useProjectStore((s) => s.initialized)
  const projects = useProjectStore((s) => s.projects)
  const initError = useProjectStore((s) => s.initError)

  // Auto-navigate to default project for first-time users ──────────
  // When a brand-new user's default project was auto-created during init,
  // redirect them into it immediately instead of landing on the empty
  // ProjectHome list. Uses a session-level flag so it only fires once
  // per browser session (avoids hijacking navigation for returning users).
  //
  // An initialized empty project list is TERMINAL, not transitional:
  //   - initialize() holds initialized=false until its final atomic set
  //     (projects + initialized + isLoading together), so an initialized
  //     empty list is never a load-in-progress state.
  //   - When the user deleted every project, the auto-default flag stays
  //     set (only clear-local-data removes it), so the list stays empty
  //     forever. Redirecting to /projects restores the legacy catch-all:
  //     ProjectHome's empty state offers project creation instead of a
  //     blank root page.
  useEffect(() => {
    // Init failed (e.g. SQLite worker couldn't open OPFS): don't run the
    // first-run redirect flow. Redirect to /projects so the error banner
    // with Retry (ProjectHomeView) is what the user sees, not a blank page.
    // Keyed on initError — the init-specific field — so an unrelated
    // project-action failure (`error`) can never lock the root page into
    // the /projects redirect (Sourcery: "Project actions lock the page").
    if (initError) {
      router.replace(projectsPath())
      return
    }
    if (!initialized) return
    if (projects.length === 0) {
      router.replace(projectsPath())
      return
    }
    // A side-panel launch carries a one-shot routing request. Let
    // AppBootstrap consume it after storage is ready; redirecting the root
    // route here first would race that handler and leave the panel at the
    // generic projects list instead of its per-hostname project.
    if (hasPendingSidePanelProjectRoute()) return
    const JUST_REDIRECTED_KEY = 'creatorweave:auto-default-redirected'
    if (sessionStorage.getItem(JUST_REDIRECTED_KEY)) {
      // First-run redirect already happened this session (or user is a
      // returning user) — fall through to the default projects redirect.
      router.replace(projectsPath())
      return
    }
    const autoCreated = localStorage.getItem('creatorweave:auto-default-project-created')
    if (!autoCreated) {
      router.replace(projectsPath())
      return
    }
    if (projects.length !== 1) {
      router.replace(projectsPath())
      return
    }
    const targetProject = projects[0]
    if (!targetProject) {
      router.replace(projectsPath())
      return
    }
    sessionStorage.setItem(JUST_REDIRECTED_KEY, '1')
    router.replace(projectWorkspacePath(targetProject.id))
  }, [initialized, projects, initError, router])

  return null
}
