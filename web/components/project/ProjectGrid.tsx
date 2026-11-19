import { useCallback, useMemo, useState } from 'react'
import { Search, ChevronDown } from 'lucide-react'
import type { Project, ProjectStats } from '@/sqlite/repositories/project.repository'
import { useT } from '@/i18n'
import { ProjectCard } from './ProjectCard'

export type ProjectStatusFilter = 'all' | 'active' | 'archived'

export interface ProjectGridProps {
  projects: Project[]
  projectStats?: Record<string, ProjectStats>
  activeProjectId?: string
  /** Disable interactive elements (used while a parent action is submitting). */
  isDisabled?: boolean
  /** Set of project IDs with a pending destructive/mutation action. */
  pendingActionIds?: Set<string>
  /** Header subtitle to render next to the title (e.g. "8 projects, 138 conversations"). */
  headerSubtitle?: React.ReactNode
  onOpenProject: (projectId: string) => void
  onRenameProject: (project: Project) => void
  onArchiveToggle: (project: Project, isArchived: boolean) => void
  onDeleteProject: (project: Project) => void
  onExportUsage?: (project: Project) => void
}

const FILTER_OPTIONS: ProjectStatusFilter[] = ['all', 'active', 'archived']

const FILTER_LABEL_KEY: Record<ProjectStatusFilter, string> = {
  all: 'projectHome.filters.all',
  active: 'projectHome.filters.active',
  archived: 'projectHome.filters.archived',
}

export function ProjectGrid({
  projects,
  projectStats = {},
  activeProjectId,
  isDisabled = false,
  pendingActionIds,
  headerSubtitle,
  onOpenProject,
  onRenameProject,
  onArchiveToggle,
  onDeleteProject,
  onExportUsage,
}: ProjectGridProps) {
  const t = useT()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ProjectStatusFilter>('active')
  const [filterMenuOpen, setFilterMenuOpen] = useState(false)

  const getProjectActivityAt = useCallback(
    (project: Project): number => {
      const workspaceActivityAt =
        projectStats[project.id]?.lastWorkspaceAccessAt ?? 0
      return Math.max(project.updatedAt, workspaceActivityAt)
    },
    [projectStats],
  )

  const visibleProjects = useMemo(() => {
    const keyword = search.trim().toLowerCase()
    return projects
      .filter((project) => {
        if (filter === 'active' && project.status === 'archived') return false
        if (filter === 'archived' && project.status !== 'archived') return false
        if (keyword && !project.name.toLowerCase().includes(keyword)) return false
        return true
      })
      .sort((a, b) => getProjectActivityAt(b) - getProjectActivityAt(a))
  }, [projects, filter, search, getProjectActivityAt])

  const filterLabel = t(FILTER_LABEL_KEY[filter])

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-base font-semibold text-secondary dark:text-secondary-foreground">
            {t('projectHome.grid.title')}
          </h2>
          {headerSubtitle && (
            <span className="text-xs text-muted-foreground">{headerSubtitle}</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Always-expanded search input */}
          <div className="flex h-9 w-44 items-center gap-2 rounded-lg border border-border bg-card px-2.5">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('projectHome.filters.searchPlaceholder')}
              aria-label={t('projectHome.grid.search')}
              className="min-w-0 flex-1 bg-transparent text-sm text-secondary placeholder:text-muted-foreground focus:outline-none"
            />
          </div>

          {/* Filter dropdown (active / all / archived) */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setFilterMenuOpen((open) => !open)}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm text-secondary transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              aria-haspopup="listbox"
              aria-expanded={filterMenuOpen}
            >
              <span>{filterLabel}</span>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${
                  filterMenuOpen ? 'rotate-180' : ''
                }`}
              />
            </button>
            {filterMenuOpen && (
              <ul
                role="listbox"
                className="absolute right-0 top-full z-50 mt-1.5 w-32 overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground py-1 shadow-lg ring-1 ring-black/5"
              >
                {FILTER_OPTIONS.map((option) => {
                  const isSelected = option === filter
                  return (
                    <li key={option}>
                      <button
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        onClick={() => {
                          setFilter(option)
                          setFilterMenuOpen(false)
                        }}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-sm transition-colors hover:bg-muted ${
                          isSelected
                            ? 'font-semibold text-primary'
                            : 'text-secondary'
                        }`}
                      >
                        <span>{t(FILTER_LABEL_KEY[option])}</span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </div>
      </header>

      {visibleProjects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <p className="text-sm text-muted-foreground">
            {search
              ? t('projectHome.empty.noResults')
              : t('projectHome.empty.noProjects')}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              stats={projectStats[project.id]}
              activityAt={getProjectActivityAt(project)}
              isActive={project.id === activeProjectId}
              isActionPending={pendingActionIds?.has(project.id) ?? false}
              isDisabled={isDisabled}
              onOpen={onOpenProject}
              onRename={onRenameProject}
              onArchiveToggle={onArchiveToggle}
              onDelete={onDeleteProject}
              onExportUsage={onExportUsage}
            />
          ))}
        </div>
      )}
    </section>
  )
}