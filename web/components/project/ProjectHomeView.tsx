'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useT, useLocale } from '@/i18n'
import { useProjectStore } from '@/store/project.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useOPFSStore } from '@/store/opfs.store'
import { useConversationStore } from '@/store/conversation.store'
import { clearSQLiteAndProjectsDirectory, RESET_REQUIRES_TAB_CLOSURE } from '@/storage'
import type { Project } from '@/sqlite/repositories/project.repository'
import { ProjectHome } from '@/components/project/ProjectHome'
import { projectWorkspacePath, projectsPath, docsPath } from '@/lib/route-paths'

/**
 * ProjectHomeView — store-connected ProjectHome for the /projects route.
 *
 * Previously ProjectHome received its props from AppReady (WorkspaceApp.tsx);
 * this wrapper pulls state from the stores directly and owns the handler
 * logic (create/rename/archive/delete/clear-local-data + toasts) that used
 * to live in AppReady.
 */
export default function ProjectHomeView() {
  const router = useRouter()
  const t = useT()
  const [locale] = useLocale()
  const docsLanguage: 'zh' | 'en' = locale === 'zh-CN' ? 'zh' : 'en'

  const projects = useProjectStore((s) => s.projects)
  const projectStats = useProjectStore((s) => s.projectStats)
  const projectLoading = useProjectStore((s) => s.isLoading)
  const activeProjectId = useProjectStore((s) => s.activeProjectId)
  const createProject = useProjectStore((s) => s.createProject)
  const renameProject = useProjectStore((s) => s.renameProject)
  const setProjectArchived = useProjectStore((s) => s.setProjectArchived)
  const deleteProject = useProjectStore((s) => s.deleteProject)

  const [isClearingLocalData, setIsClearingLocalData] = useState(false)

  const handleCreateProject = async (name: string) => {
    const project = await createProject(name)
    if (project) {
      router.push(projectWorkspacePath(project.id))
      toast.success(t('app.projectCreated', { name: project.name }))
    } else {
      toast.error(t('app.createProjectFailed'))
    }
  }

  const handleRenameProject = async (projectId: string, name: string) => {
    const ok = await renameProject(projectId, name)
    if (ok) {
      toast.success(t('app.projectRenamed'))
    } else {
      toast.error(t('app.renameFailed'))
    }
  }

  const handleArchiveProject = async (projectId: string, archived: boolean) => {
    const ok = await setProjectArchived(projectId, archived)
    if (ok) {
      toast.success(archived ? t('app.projectArchived') : t('app.projectUnarchived'))
    } else {
      toast.error(archived ? t('app.archiveFailed') : t('app.unarchiveFailed'))
    }
  }

  const handleDeleteProject = async (projectId: string) => {
    const ok = await deleteProject(projectId)
    if (ok) {
      toast.success(t('app.projectDeleted'))
    } else {
      toast.error(t('app.deleteFailed'))
    }
  }

  const handleOpenProject = async (projectId: string) => {
    router.push(projectWorkspacePath(projectId))
  }

  const handleExportProjectUsage = async (project: Project) => {
    const toastId = toast.loading(t('app.projectUsageExporting'))
    try {
      const { exportProjectUsageCSV } = await import('@/services/export/project-usage-export')
      const result = await exportProjectUsageCSV(project)
      if (!result.success) throw new Error(result.error || 'Export failed')
      toast.success(t('app.projectUsageExported', { filename: result.filename }), { id: toastId })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('app.projectUsageExportFailed', { error: message }), { id: toastId })
    }
  }

  const handleClearLocalData = async () => {
    setIsClearingLocalData(true)
    try {
      await clearSQLiteAndProjectsDirectory()

      // Reset auto-default-project flags so re-init can auto-create again
      localStorage.removeItem('creatorweave:auto-default-project-created')
      sessionStorage.removeItem('creatorweave:auto-default-redirected')

      useProjectStore.setState({
        activeProjectId: '',
        projects: [],
        projectStats: {},
        initialized: false,
        isLoading: false,
        error: null,
      })
      useConversationContextStore.setState({
        ...(await import('@/store/workspace.store')).PENDING_RESET_PATCH,
        activeWorkspaceId: null,
        workspaces: [],
        initialized: false,
      })
      useOPFSStore.setState({
        workspaceId: null,
        initialized: false,
        pendingChanges: [],
        approvedNotSyncedPaths: new Set<string>(),
        cachedPaths: [],
        isLoading: false,
        error: null,
      })
      useConversationStore.setState({
        conversations: [],
        activeConversationId: null,
        loaded: true,
        loadError: null,
        suggestedFollowUps: new Map(),
        mountedConversations: new Map(),
      })

      const { useConversationRuntimeStore } = await import('@/store/conversation-runtime.store')
      useConversationRuntimeStore.setState({
        runtimes: new Map(),
        suggestedFollowUps: new Map(),
        cancelledRunIds: new Set(),
        mountedConversations: new Map(),
      })

      await useProjectStore.getState().initialize()
      await useConversationContextStore.getState().initialize()
      await useOPFSStore.getState().initialize()

      router.replace(projectsPath())
      toast.success(t('app.localDataCleared'))
    } catch (error) {
      console.error('[App] Failed to clear local data:', error)
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes(RESET_REQUIRES_TAB_CLOSURE)) {
        toast.error(t('app.clearFailedCloseOtherTabs'))
      } else {
        toast.error(t('app.clearLocalDataFailed'))
      }
    } finally {
      setIsClearingLocalData(false)
    }
  }

  return (
    <ProjectHome
      projects={projects}
      projectStats={projectStats}
      activeProjectId={activeProjectId}
      isLoading={projectLoading}
      onOpenProject={handleOpenProject}
      onCreateProject={handleCreateProject}
      onRenameProject={handleRenameProject}
      onArchiveProject={handleArchiveProject}
      onDeleteProject={handleDeleteProject}
      onExportProjectUsage={handleExportProjectUsage}
      onClearLocalData={handleClearLocalData}
      onOpenDocs={() => router.push(docsPath(docsLanguage))}
      isClearingLocalData={isClearingLocalData}
    />
  )
}
