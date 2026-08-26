import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProjectHome } from './ProjectHome'

// ProjectHome embeds ActivityHeatmap, which navigates via next/navigation.
// There is no App Router in unit tests — provide a minimal mock.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/activity/ActivityHeatmap', () => ({
  ActivityHeatmap: () => null,
}))

vi.mock('@/store/theme.store', () => ({
  useTheme: () => ({
    mode: 'light',
    setTheme: vi.fn(),
    accentColor: 'teal',
    setAccentColor: vi.fn(),
  }),
  ACCENT_COLORS: {
    teal: { hue: 170, saturation: 35, lightness: 45 },
    rose: { hue: 350, saturation: 50, lightness: 55 },
    amber: { hue: 35, saturation: 60, lightness: 50 },
    violet: { hue: 270, saturation: 50, lightness: 55 },
    emerald: { hue: 145, saturation: 45, lightness: 45 },
    slate: { hue: 220, saturation: 12, lightness: 45 },
  },
}))

const localeSetter = vi.fn()
const t = (key: string, params?: Record<string, string | number>) => {
  const messages: Record<string, string> = {
    'projectHome.hero.badge': 'Local First',
    'projectHome.hero.title': 'Start creating here',
    'projectHome.hero.description': 'desc',
    'projectHome.hero.descriptionSuffix': 'suffix',
    'projectHome.hero.projectCount': 'Projects',
    'projectHome.hero.workspaceCount': 'Workspaces',
    'projectHome.hero.docsHub': 'Docs Hub',
    'projectHome.hero.userDocs': 'User Docs',
    'projectHome.hero.developerDocs': 'Developer Docs',
    'projectHome.sidebar.createNew': 'New',
    'projectHome.sidebar.createNewDescription': 'Create description',
    'projectHome.sidebar.shortcutHint': 'Shortcut: N',
    'projectHome.sidebar.createProject': 'Create Project',
    'projectHome.sidebar.continueWork': 'Continue Work',
    'projectHome.sidebar.startFresh': 'Start Fresh',
    'projectHome.sidebar.startFreshDescription': 'Reset description',
    'projectHome.sidebar.resetApp': 'Reset App',
    'projectHome.sidebar.helpDocs': 'Help Docs',
    'projectHome.sidebar.helpDocsDescription': 'View user and developer docs.',
    'projectHome.sidebar.openDocs': 'Open Docs Hub',
    'projectHome.sidebar.appearance': 'Appearance',
    'projectHome.theme.modeTitle': 'Theme Mode',
    'projectHome.theme.light': 'Light',
    'projectHome.theme.dark': 'Dark',
    'projectHome.theme.languageTitle': 'Language',
    'projectHome.theme.accentColorTitle': 'Accent Color',
    'projectHome.filters.searchPlaceholder': 'Search projects...',
    'projectHome.filters.all': 'All',
    'projectHome.filters.active': 'Active',
    'projectHome.filters.archived': 'Archived',
    'projectHome.timeline.today': 'Today',
    'projectHome.timeline.yesterday': 'Yesterday',
    'projectHome.timeline.thisWeek': 'This Week',
    'projectHome.timeline.thisMonth': 'This Month',
    'projectHome.timeline.older': 'Older',
    'projectHome.empty.noProjects': 'No projects yet',
    'projectHome.empty.noResults': 'No results',
    'projectHome.empty.createFirst': 'Create your first project',
    'projectHome.dialogs.createProject': 'Create New Project',
    'projectHome.dialogs.createProjectDescription': 'Description',
    'projectHome.dialogs.projectNamePlaceholder': 'Enter project name',
    'projectHome.dialogs.createButton': 'Create',
    'projectHome.dialogs.creating': 'Creating',
    'projectHome.dialogs.startFreshConfirmPlaceholder': 'Start fresh',
    'projectHome.project.open': 'Open',
    'projectHome.project.openProject': 'Open project {name}',
    'projectHome.project.moreActions': 'More actions',
    'projectHome.project.exportUsage': 'Export model & usage',
    'projectHome.project.exportingUsage': 'Exporting…',
    'projectHome.accentColors.teal': 'Teal',
    'projectHome.accentColors.rose': 'Rose',
    'projectHome.accentColors.amber': 'Amber',
    'projectHome.accentColors.violet': 'Violet',
    'projectHome.accentColors.emerald': 'Emerald',
    'projectHome.accentColors.slate': 'Slate',
    'common.cancel': 'Cancel',
    'common.processing': 'Processing',
    'common.save': 'Save',
  }
  let text = messages[key] ?? key
  if (params) {
    for (const [name, value] of Object.entries(params)) {
      text = text.replaceAll(`{${name}}`, String(value))
    }
  }
  return text
}

vi.mock('@/i18n', () => ({
  useT: () => t,
  useLocale: () => ['zh-CN', localeSetter],
  LOCALE_LABELS: {
    'zh-CN': 'Simplified Chinese',
    'en-US': 'English',
    'ja-JP': 'Japanese',
    'ko-KR': 'Korean',
  },
}))

describe('ProjectHome docs entry', () => {
  it('shows single docs hub action in hero', async () => {
    const user = userEvent.setup()
    const onOpenDocs = vi.fn()

    render(
      <ProjectHome
        projects={[]}
        projectStats={{}}
        activeProjectId=""
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn()}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
        onOpenDocs={onOpenDocs}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Docs Hub' }))

    expect(onOpenDocs).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: 'User Docs' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Developer Docs' })).not.toBeInTheDocument()
  })

  it('prefers recent project activity for continue work', async () => {
    const user = userEvent.setup()
    const onOpenProject = vi.fn()
    const now = Date.now()

    render(
      <ProjectHome
        projects={[
          {
            id: 'project-a',
            name: 'Recent Work Project',
            status: 'active',
            createdAt: now - 86400000 * 30,
            updatedAt: now - 86400000 * 30,
          },
          {
            id: 'project-b',
            name: 'Just Created Project',
            status: 'active',
            createdAt: now - 1000 * 60 * 10,
            updatedAt: now - 1000 * 60 * 10,
          },
        ]}
        projectStats={{
          'project-a': {
            projectId: 'project-a',
            workspaceCount: 1,
            lastWorkspaceAccessAt: now - 1000 * 60 * 2,
          },
          'project-b': {
            projectId: 'project-b',
            workspaceCount: 1,
            lastWorkspaceAccessAt: now - 1000 * 60 * 20,
          },
        }}
        activeProjectId=""
        onOpenProject={onOpenProject}
        onCreateProject={vi.fn()}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Continue Work' }))

    expect(onOpenProject).toHaveBeenCalledWith('project-a')
  })

  it('opens the project directly when clicking its name', async () => {
    const user = userEvent.setup()
    const onOpenProject = vi.fn()

    render(
      <ProjectHome
        projects={[
          {
            id: 'project-name-click',
            name: 'Clickable Project',
            status: 'active',
            createdAt: Date.now() - 1000 * 60 * 60,
            updatedAt: Date.now() - 1000 * 60 * 30,
          },
        ]}
        projectStats={{
          'project-name-click': {
            projectId: 'project-name-click',
            workspaceCount: 2,
          },
        }}
        activeProjectId=""
        onOpenProject={onOpenProject}
        onCreateProject={vi.fn()}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Open project Clickable Project' }))

    expect(onOpenProject).toHaveBeenCalledWith('project-name-click')
  })

  it('does not inject Google Fonts imports in inline styles', () => {
    const { container } = render(
      <ProjectHome
        projects={[]}
        projectStats={{}}
        activeProjectId=""
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn()}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
      />
    )

    const inlineStyle = container.querySelector('style')

    expect(inlineStyle?.textContent).not.toContain('fonts.googleapis.com')
    expect(inlineStyle?.textContent).not.toContain('@import url(')
  })

  it('exports model, token, and cost usage from the project action menu', async () => {
    const user = userEvent.setup()
    const project = {
      id: 'project-export',
      name: 'Exportable Project',
      status: 'active' as const,
      createdAt: Date.now() - 1000,
      updatedAt: Date.now(),
    }
    const onExportProjectUsage = vi.fn()

    render(
      <ProjectHome
        projects={[project]}
        projectStats={{}}
        activeProjectId=""
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn()}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onExportProjectUsage={onExportProjectUsage}
        onClearLocalData={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByText('Export model & usage'))

    expect(onExportProjectUsage).toHaveBeenCalledWith(project)
  })
})
