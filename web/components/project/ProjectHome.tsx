import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BrandButton,
  BrandDialog,
  BrandDialogBody,
  BrandDialogContent,
  BrandDialogFooter,
  BrandDialogHeader,
  BrandDialogTitle,
  BrandCheckbox,
  BrandInput,
} from '@creatorweave/ui'
import { Plus, Settings as SettingsIcon, ChevronRight } from 'lucide-react'
import type { Project, ProjectStats } from '@/sqlite/repositories/project.repository'
import { useT } from '@/i18n'
import { useExtensionStore } from '@/store/extension.store'
import { ExtensionBanner } from '@/components/extension'
import { isMobileDeviceForExtension } from '@/lib/extension-distribution'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { ActivityHeatmap } from '@/components/activity/ActivityHeatmap'
import { ProjectGrid } from './ProjectGrid'
import { CreateProjectDialog } from './CreateProjectDialog'
import { HomeSettingsDrawer } from './HomeSettingsDrawer'
import { HelpPopover } from './HelpPopover'
import { ContinueWorkCard } from './ContinueWorkCard'
import { DocumentReviewIllustration } from './DocumentReviewIllustration'

// Minimal styles for the slim hero — no grain texture, no serif title,
// no animated reveals. The original `designStyles` block was removed with
// the timeline/sidebar sections.
const skillHomeStyles = `
  .home-hero {
    background-color: hsl(var(--card));
  }
`

export interface ProjectHomeProps {
  projects: Project[]
  projectStats?: Record<string, ProjectStats>
  activeProjectId: string
  isLoading?: boolean
  /** kind='direct' conversations — preview data for the standalone-chats card */
  standaloneChats?: Array<{ id: string; title: string; updatedAt: number }>
  onOpenProject: (projectId: string) => void | Promise<void>
  /**
   * Create the project. Returns the new project's id, or null on failure.
   * Callers should navigate after a successful id is returned.
   */
  onCreateProject: (name: string) => Promise<string | null>
  onRenameProject: (projectId: string, name: string) => void | Promise<void>
  onArchiveProject: (projectId: string, archived: boolean) => void | Promise<void>
  onDeleteProject: (projectId: string) => void | Promise<void>
  onExportProjectUsage?: (project: Project) => void | Promise<void>
  onClearLocalData: () => void | Promise<void>
  onOpenDocs?: () => void | Promise<void>
  /** Navigate to the standalone chats home (/chats) */
  onOpenStandaloneChats?: () => void
  isClearingLocalData?: boolean
}

const SKIP_ARCHIVE_CONFIRM_KEY = 'project-home:skip-archive-confirm'

export function ProjectHome({
  projects,
  projectStats = {},
  activeProjectId,
  isLoading = false,
  standaloneChats = [],
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  onExportProjectUsage,
  onClearLocalData,
  onOpenDocs,
  onOpenStandaloneChats,
  isClearingLocalData = false,
}: ProjectHomeProps) {
  const t = useT()

  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [showSettingsDrawer, setShowSettingsDrawer] = useState(false)

  // Per-project dialog state.
  const [renamingProject, setRenamingProject] = useState<Project | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [archiveDialogProject, setArchiveDialogProject] = useState<Project | null>(null)
  const [archiveDontAskAgain, setArchiveDontAskAgain] = useState(false)
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [pendingActionIds, setPendingActionIds] = useState<Set<string>>(new Set())
  const [skipArchiveConfirm, setSkipArchiveConfirm] = useState(false)

  // Restore the "don't ask again" preference for the archive flow.
  useEffect(() => {
    if (typeof window === 'undefined') return
    setSkipArchiveConfirm(window.localStorage.getItem(SKIP_ARCHIVE_CONFIRM_KEY) === '1')
  }, [])

  const { activeProjects, totalWorkspaces, recentProject } = useMemo(() => {
    const active = projects.filter((p) => p.status !== 'archived')
    const workspaces = Object.values(projectStats).reduce(
      (sum, stats) => sum + (stats?.workspaceCount || 0),
      0,
    )
    // Most recent active project by activity (max of project.updatedAt and
    // the latest workspace access). Used to power the "Continue work" card.
    const getActivityAt = (project: Project) => {
      const workspaceActivityAt = projectStats[project.id]?.lastWorkspaceAccessAt ?? 0
      return Math.max(project.updatedAt, workspaceActivityAt)
    }
    const recent =
      active.length > 0
        ? [...active].sort((a, b) => getActivityAt(b) - getActivityAt(a))[0]
        : null
    return { activeProjects: active, totalWorkspaces: workspaces, recentProject: recent }
  }, [projects, projectStats])

  const headerSubtitle = (
    <>
      <span>{t('projectHome.statsSummary', { projects: activeProjects.length })}</span>
      <span className="mx-2 text-muted-foreground/40">|</span>
      <span>
        {t('projectHome.statsConversations', { count: totalWorkspaces })}
      </span>
    </>
  )

  // Most recent standalone chat (kind='direct') — powers the hero card preview.
  const latestChatTitle = useMemo(() => {
    const direct = standaloneChats
    if (direct.length === 0) return null
    const latest = [...direct].sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return latest?.title ?? null
  }, [standaloneChats])

  const wrapWithPending = useCallback(
    (projectId: string, action: () => Promise<void> | void) => {
      return async () => {
        setPendingActionIds((prev) => {
          const next = new Set(prev)
          next.add(projectId)
          return next
        })
        try {
          await action()
        } finally {
          setPendingActionIds((prev) => {
            const next = new Set(prev)
            next.delete(projectId)
            return next
          })
        }
      }
    },
    [],
  )

  const handleOpenProject = useCallback(
    (projectId: string) => {
      void onOpenProject(projectId)
    },
    [onOpenProject],
  )

  const handleRenameOpen = useCallback((project: Project) => {
    setRenamingProject(project)
    setRenameDraft(project.name)
  }, [])

  const handleRenameConfirm = useCallback(async () => {
    if (!renamingProject || !renameDraft.trim()) return
    await wrapWithPending(renamingProject.id, async () => {
      await onRenameProject(renamingProject.id, renameDraft.trim())
      setRenamingProject(null)
      setRenameDraft('')
    })()
  }, [renamingProject, renameDraft, onRenameProject, wrapWithPending])

  const handleArchiveClick = useCallback(
    (project: Project, isArchived: boolean) => {
      if (isArchived) {
        void wrapWithPending(project.id, async () => {
          await onArchiveProject(project.id, false)
        })()
        return
      }
      if (skipArchiveConfirm) {
        void wrapWithPending(project.id, async () => {
          await onArchiveProject(project.id, true)
        })()
        return
      }
      setArchiveDontAskAgain(false)
      setArchiveDialogProject(project)
    },
    [onArchiveProject, skipArchiveConfirm, wrapWithPending],
  )

  const handleArchiveConfirm = useCallback(async () => {
    if (!archiveDialogProject) return
    await wrapWithPending(archiveDialogProject.id, async () => {
      await onArchiveProject(archiveDialogProject.id, true)
      if (archiveDontAskAgain && typeof window !== 'undefined') {
        window.localStorage.setItem(SKIP_ARCHIVE_CONFIRM_KEY, '1')
        setSkipArchiveConfirm(true)
      }
      setArchiveDialogProject(null)
    })()
  }, [archiveDialogProject, archiveDontAskAgain, onArchiveProject, wrapWithPending])

  const handleDeleteClick = useCallback((project: Project) => {
    setDeletingProject(project)
    setDeleteConfirmText('')
  }, [])

  const handleDeleteConfirm = useCallback(async () => {
    if (!deletingProject) return
    if (deleteConfirmText !== deletingProject.name) return
    await wrapWithPending(deletingProject.id, async () => {
      await onDeleteProject(deletingProject.id)
      setDeletingProject(null)
      setDeleteConfirmText('')
    })()
  }, [deletingProject, deleteConfirmText, onDeleteProject, wrapWithPending])

  const handleExportUsage = useCallback(
    (project: Project) => {
      if (!onExportProjectUsage) return
      void wrapWithPending(project.id, () =>
        Promise.resolve(onExportProjectUsage(project)),
      )()
    },
    [onExportProjectUsage, wrapWithPending],
  )

  const handleCreateProject = useCallback(
    async (name: string): Promise<string | null> => {
      return onCreateProject(name)
    },
    [onCreateProject],
  )

  const handleCreateClick = useCallback(() => {
    if (isLoading) return
    setShowCreateDialog(true)
  }, [isLoading])

  return (
    <div className="relative min-h-screen bg-background">
      <style>{skillHomeStyles}</style>

      {/* Header: brand + spacer + help + settings (single grouped button bar) */}
      <header className="sticky top-0 z-30 border-b border-border bg-card backdrop-blur supports-[backdrop-filter]:bg-card/95">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-3 px-6">
          <div className="flex items-center gap-2.5 text-base font-semibold text-secondary dark:text-secondary-foreground">
            <img
              src="/favicon.svg"
              alt=""
              aria-hidden
              className="h-7 w-7"
            />
            <span>{t('projectHome.brand')}</span>
          </div>
          {/* Standalone-chats entry (◇) beside the help/settings button group.
              No overflow-hidden on the settings group: HelpPopover's dropdown is
              absolutely positioned BELOW the buttons, so clipping the group would
              cut the whole menu away (it was invisible and unclickable). The
              buttons have no background, so nothing needs clipping for the
              rounded look. */}
          <div className="flex items-center gap-2">
            <BrandButton
              variant="outline"
              className="h-8 gap-1.5 px-3 text-xs"
              onClick={() => onOpenStandaloneChats?.()}
              data-testid="standalone-chats-header-button"
            >
              <span aria-hidden className="leading-none">◇</span>
              {t('projectHome.standaloneChats.cardTitle')}
            </BrandButton>
            <div className="flex items-center rounded-lg border border-border bg-card">
              <HelpPopover onOpenDocs={() => void onOpenDocs?.()} />
              <span className="h-5 w-px bg-border" aria-hidden />
              <button
                type="button"
                aria-label={t('projectHome.openSettings')}
                onClick={() => setShowSettingsDrawer(true)}
                className="grid h-9 w-9 place-items-center text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              >
                <SettingsIcon className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-5xl space-y-6 px-6 pb-8 pt-4">
        {/* Extension install banner — hidden on mobile (browsers can't install there) */}
        {!isMobileDeviceForExtension() && (
          <ExtensionBanner onInstallClick={() => useExtensionStore.getState().openInstallGuide()} />
        )}

        {/* Standalone chats hero card — project-independent conversations.
            Sits above the projects grid: a first-class space, not a project. */}
        <button
          type="button"
          data-testid="standalone-chats-card"
          onClick={onOpenStandaloneChats}
          className="group flex w-full items-center gap-4 rounded-2xl border border-border/80 bg-card px-5 py-4 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
        >
          <span
            aria-hidden
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-lg text-primary"
          >
            ◇
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold text-secondary dark:text-secondary-foreground">
              {t('projectHome.standaloneChats.cardTitle')}
            </span>
            <span className="mt-0.5 block truncate text-sm text-muted-foreground">
              {latestChatTitle
                ? t('projectHome.standaloneChats.cardPreview', { title: latestChatTitle })
                : t('projectHome.standaloneChats.cardDescription')}
            </span>
          </span>
          <ChevronRight
            aria-hidden
            className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5"
          />
        </button>

        {/* Hero — text left, undraw illustration right (desktop only) */}
        <section className="home-hero relative mt-2 grid grid-cols-1 items-center gap-6 overflow-hidden rounded-2xl border border-border/80 bg-card px-5 py-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,240px)] lg:gap-10 lg:px-6 lg:py-6">
          <div className="relative">
            <h1 className="text-2xl font-semibold tracking-tight text-secondary dark:text-secondary-foreground sm:text-3xl">
              {t('projectHome.hero.title')}
            </h1>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground sm:text-base">
              {t('projectHome.hero.description')}
              <span className="ml-1 text-muted-foreground/70">
                {t('projectHome.hero.descriptionSuffix')}
              </span>
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <BrandButton variant="primary" onClick={handleCreateClick} disabled={isLoading}>
                <Plus className="mr-1.5 h-4 w-4" />
                {t('projectHome.grid.newProject')}
              </BrandButton>
              {recentProject && (
                <ContinueWorkCard
                  project={recentProject}
                  stats={projectStats[recentProject.id]}
                  onOpen={handleOpenProject}
                  isActionPending={pendingActionIds.size > 0}
                />
              )}
            </div>
          </div>
          <div className="hidden text-primary lg:block">
            <DocumentReviewIllustration className="mx-auto h-auto w-full max-w-[240px] select-none" />
          </div>
        </section>

        {/* Projects grid (replaces old timeline) */}
        <ProjectGrid
          projects={projects}
          projectStats={projectStats}
          activeProjectId={activeProjectId}
          isDisabled={isLoading}
          pendingActionIds={pendingActionIds}
          headerSubtitle={headerSubtitle}
          onOpenProject={handleOpenProject}
          onRenameProject={handleRenameOpen}
          onArchiveToggle={handleArchiveClick}
          onDeleteProject={handleDeleteClick}
          onExportUsage={onExportProjectUsage ? handleExportUsage : undefined}
        />

        {/* Activity */}
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-secondary dark:text-secondary-foreground">
            {t('projectHome.activity.title')}
          </h2>
          <ActivityHeatmap />
        </section>
      </main>

      <SiteFooter />

      {/* Create project dialog (with N:M folder picker) */}
      <CreateProjectDialog
        open={showCreateDialog}
        onOpenChange={setShowCreateDialog}
        onCreate={handleCreateProject}
        onProjectCreated={handleOpenProject}
      />

      {/* Settings drawer (appearance + advanced) */}
      <HomeSettingsDrawer
        open={showSettingsDrawer}
        onOpenChange={setShowSettingsDrawer}
        onClearLocalData={() => onClearLocalData()}
        isClearingLocalData={isClearingLocalData}
      />

      {/* Rename dialog */}
      <BrandDialog
        open={!!renamingProject}
        onOpenChange={(next) => {
          if (!next) setRenamingProject(null)
        }}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('projectHome.dialogs.renameProject')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <BrandInput
              value={renameDraft}
              onChange={(event) => setRenameDraft(event.target.value)}
              placeholder={t('projectHome.dialogs.renamePlaceholder')}
              autoFocus
            />
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton variant="ghost" onClick={() => setRenamingProject(null)}>
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              variant="primary"
              onClick={() => void handleRenameConfirm()}
              disabled={!renameDraft.trim() || pendingActionIds.size > 0}
            >
              {t('common.save')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Archive confirmation */}
      <BrandDialog
        open={!!archiveDialogProject}
        onOpenChange={(next) => {
          if (!next) setArchiveDialogProject(null)
        }}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('projectHome.dialogs.archiveProject')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <p className="text-sm text-secondary">
              {t('projectHome.dialogs.archiveConfirm', {
                name: archiveDialogProject?.name || '',
              })}
            </p>
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-secondary">
              <BrandCheckbox
                checked={archiveDontAskAgain}
                onCheckedChange={(checked) => setArchiveDontAskAgain(Boolean(checked))}
              />
              <span>{t('projectHome.dialogs.dontAskAgain')}</span>
            </label>
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton variant="ghost" onClick={() => setArchiveDialogProject(null)}>
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              variant="primary"
              onClick={() => void handleArchiveConfirm()}
              disabled={pendingActionIds.size > 0}
            >
              {t('projectHome.dialogs.archiveProject')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Delete confirmation (typed name required) */}
      <BrandDialog
        modal
        open={!!deletingProject}
        onOpenChange={(next) => {
          if (!next) {
            setDeletingProject(null)
            setDeleteConfirmText('')
          }
        }}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('projectHome.dialogs.deleteProject')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <p className="text-sm text-secondary">
              {t('projectHome.dialogs.deleteConfirm', {
                name: deletingProject?.name || '',
              })}
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              {t('projectHome.dialogs.deleteConfirmHint')}
            </p>
            <BrandInput
              value={deleteConfirmText}
              onChange={(event) => setDeleteConfirmText(event.target.value)}
              placeholder={deletingProject?.name || ''}
              className="mt-2"
            />
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              onClick={() => {
                setDeletingProject(null)
                setDeleteConfirmText('')
              }}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              variant="danger"
              onClick={() => void handleDeleteConfirm()}
              disabled={
                !deletingProject ||
                deleteConfirmText !== deletingProject.name ||
                pendingActionIds.size > 0
              }
            >
              {t('projectHome.dialogs.deleteProject')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>
    </div>
  )
}