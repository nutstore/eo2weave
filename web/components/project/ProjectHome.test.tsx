import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ProjectHome } from './ProjectHome'
import * as nativeDiskExecutor from '@/opfs/native-disk/executor'
// ProjectHome embeds ActivityHeatmap (navigates via next/navigation) and
// uses the new folder-access store for the create-with-folders flow. In
// unit tests we don't have either, so we provide minimal mocks.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useSearchParams: () => new URLSearchParams(),
}))

vi.mock('@/components/activity/ActivityHeatmap', () => ({
  ActivityHeatmap: () => null,
}))

// `vi.mock` factories are hoisted to the top of the file — use vi.hoisted
// to share state between the factory body and the test bodies below.
const { folderStore, setHandleSpy, addNativeHostRootSpy } = vi.hoisted(() => {
  const setHandle = vi.fn().mockResolvedValue(undefined)
  const addNativeHostRoot = vi.fn().mockResolvedValue(false)
  type FolderRoot = {
    id: string
    name: string
    projectId: string
    backend?: 'fsaccess' | 'native-host'
    scopeId?: string | null
  }
  const store = {
    setHandle,
    addNativeHostRoot,
    roots: [] as FolderRoot[],
  }
  return { folderStore: store, setHandleSpy: setHandle, addNativeHostRootSpy: addNativeHostRoot }
})

vi.mock('@/store/folder-access.store', () => ({
  useFolderAccessStore: Object.assign(
    (selector: (state: typeof folderStore) => unknown) => selector(folderStore),
    { getState: () => folderStore },
  ),
}))

// Native host is gated on `isNativeHostAvailable()` (checks `__agentWeb.nativeHostCall`).
// Tests inject a fake by stubbing the module so we can flip it per-test.
vi.mock('@/opfs/native-disk/executor', async () => {
  const actual = await vi.importActual<typeof nativeDiskExecutor>('@/opfs/native-disk/executor')
  return {
    ...actual,
    isNativeHostAvailable: vi.fn(() => false),
  }
})

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
    'projectHome.brand': 'Brand',
    'projectHome.openSettings': 'Open settings',
    'projectHome.statsSummary': '{projects} projects',
    'projectHome.statsConversations': '{count} conversations',
    'projectHome.hero.title': 'Start creating here',
    'projectHome.hero.description': 'desc',
    'projectHome.hero.descriptionSuffix': 'suffix',
    'projectHome.standaloneChats.cardTitle': '独立对话',
    'projectHome.standaloneChats.cardDescription': '不挂项目、随时开聊',
    'projectHome.standaloneChats.cardPreview': '最近：{title}',
    'projectHome.grid.title': 'My Projects',
    'projectHome.grid.newProject': 'New Project',
    'projectHome.grid.search': 'Search projects',
    'projectHome.filters.searchPlaceholder': 'Search projects...',
    'projectHome.filters.all': 'All',
    'projectHome.filters.active': 'Active',
    'projectHome.filters.archived': 'Archived',
    'projectHome.help.label': 'Help',
    'projectHome.help.docsHub': 'Docs Hub',
    'projectHome.help.privacy': 'Privacy',
    'projectHome.drawer.title': 'Display Preferences',
    'projectHome.activity.title': 'Activity',
    'projectHome.empty.noProjects': 'No projects yet',
    'projectHome.empty.noResults': 'No results',
    'projectHome.dialogs.createProject': 'Create New Project',
    'projectHome.dialogs.createProjectDescription': 'description',
    'projectHome.dialogs.projectNameLabel': 'Project name',
    'projectHome.dialogs.projectNamePlaceholder': 'Enter project name',
    'projectHome.dialogs.createButton': 'Create',
    'projectHome.dialogs.creating': 'Creating',
    'projectHome.dialogs.creatingProject': 'Creating',
    'projectHome.dialogs.folderFieldTitle': 'Authorize folders',
    'projectHome.dialogs.folderFieldRecommended': 'Recommended',
    'projectHome.dialogs.folderFieldHint': 'Pick folders the app can access.',
    'projectHome.dialogs.folderPickerUnsupported': 'Not supported',
    'projectHome.dialogs.chooseLocalFolder': 'Choose folder',
    'projectHome.dialogs.addAnotherFolder': 'Add another',
    'projectHome.dialogs.nativeHostButton': 'Authorize local',
    'projectHome.dialogs.nativeHostHint': 'Bridge to native FS',
    'projectHome.dialogs.nativeHostBadge': 'Native',
    'projectHome.dialogs.folderAlreadyAdded': 'Already added',
    'projectHome.dialogs.pickFailed': 'Pick failed',
    'projectHome.dialogs.removeFolder': 'Remove {name}',
    'projectHome.dialogs.renameProject': 'Rename Project',
    'projectHome.dialogs.renamePlaceholder': 'New name',
    'projectHome.dialogs.archiveProject': 'Archive Project',
    'projectHome.dialogs.archiveConfirm': 'Archive {name}?',
    'projectHome.dialogs.dontAskAgain': "Don't ask again",
    'projectHome.dialogs.deleteProject': 'Delete Project',
    'projectHome.dialogs.deleteConfirm': 'Delete {name}?',
    'projectHome.dialogs.deleteConfirmHint': 'Type name',
    'projectHome.dialogs.startFreshConfirmPlaceholder': 'Start fresh',
    'projectHome.dialogs.startFreshConfirmHint': 'Type "Start fresh"',
    'projectHome.dialogs.clearCacheUnavailable': 'SW not active',
    'projectHome.dialogs.diagnosticsInProgress': 'Running',
    'projectHome.dialogs.confirmReset': 'Reset',
    'projectHome.dialogs.retry': 'Retry',
    'projectHome.dialogs.resetting': 'Resetting',
    'projectHome.dialogs.importBackupTitle': 'Import',
    'projectHome.dialogs.importBackupWarning': 'Warning',
    'projectHome.dialogs.importBackupFile': 'File {name}',
    'projectHome.dialogs.importBackupHint': 'Restores',
    'projectHome.dialogs.importBackupConfirm': 'Restore',
    'projectHome.dialogs.importBackupSecurityNote': 'Sensitive',
    'projectHome.dialogs.exportBackupTitle': 'Export',
    'projectHome.dialogs.exportBackupSensitive': 'Sensitive',
    'projectHome.dialogs.exportBackupHint': 'Includes',
    'projectHome.dialogs.exportBackupConfirm': 'Export',
    'projectHome.dialogs.diagnosticsTitle': 'Diagnostics',
    'projectHome.dialogs.diagnosticsRunning': 'Running',
    'projectHome.dialogs.diagnosticsHint': 'Copy',
    'projectHome.dialogs.diagnosticsFailed': 'Failed',
    'projectHome.dialogs.copyReport': 'Copy',
    'projectHome.dialogs.copied': 'Copied',
    'projectHome.sidebar.backingUp': 'Backing up',
    'projectHome.sidebar.restoringBackup': 'Restoring',
    'projectHome.sidebar.appearance': 'Appearance',
    'projectHome.sidebar.advanced': 'Advanced',
    'projectHome.sidebar.advancedHint': 'reset, backup',
    'projectHome.sidebar.startFresh': 'Start Fresh',
    'projectHome.sidebar.startFreshDescription': 'reset all',
    'projectHome.sidebar.resetApp': 'Reset App',
    'projectHome.sidebar.resetting': 'Resetting',
    'projectHome.sidebar.cache': 'Cache',
    'projectHome.sidebar.cacheDescription': 'cache',
    'projectHome.sidebar.clearCache': 'Clear',
    'projectHome.sidebar.clearing': 'Clearing',
    'projectHome.sidebar.backup': 'Backup',
    'projectHome.sidebar.backupDescription': 'export',
    'projectHome.sidebar.exportBackup': 'Export',
    'projectHome.sidebar.importBackup': 'Import',
    'projectHome.sidebar.backupToLocal.title': 'Local backup',
    'projectHome.sidebar.backupToLocal.description': 'pick dir',
    'projectHome.sidebar.backupToLocal.pickDirectory': 'Pick',
    'projectHome.sidebar.backupToLocal.changeDirectory': 'Change',
    'projectHome.sidebar.backupToLocal.directoryLabel': 'Dir',
    'projectHome.sidebar.backupToLocal.lastBackupAt': 'Last: {time}',
    'projectHome.sidebar.backupToLocal.backingUp': 'Backing up',
    'projectHome.sidebar.backupToLocal.backupNow': 'Back up now',
    'projectHome.sidebar.backupToLocal.success': 'OK {directory}',
    'projectHome.sidebar.backupToLocal.failed': 'Failed {error}',
    'projectHome.sidebar.backupToLocal.permissionDenied': 'Denied',
    'projectHome.sidebar.backupToLocal.pickDirectoryFirst': 'Pick first',
    'projectHome.sidebar.backupToLocal.pickFailed': 'Failed',
    'projectHome.sidebar.diagnostics': 'Diagnostics',
    'projectHome.sidebar.diagnosticsDescription': 'collect info',
    'projectHome.sidebar.runDiagnostics': 'Run',
    'projectHome.sidebar.storage': 'Storage',
    'projectHome.sidebar.storageDescription': 'storage',
    'projectHome.sidebar.storageReclaim': 'Reclaim',
    'projectHome.sidebar.storageReclaiming': 'Reclaiming',
    'projectHome.sidebar.storageReclaimed': '{size}',
    'projectHome.sidebar.storageOptimal': 'Optimal',
    'projectHome.sidebar.storageReclaimFailed': 'Failed',
    'projectHome.theme.modeTitle': 'Theme',
    'projectHome.theme.light': 'Light',
    'projectHome.theme.dark': 'Dark',
    'projectHome.theme.accentColorTitle': 'Accent',
    'projectHome.theme.languageTitle': 'Language',
    'projectHome.accentColors.teal': 'Teal',
    'projectHome.accentColors.rose': 'Rose',
    'projectHome.accentColors.amber': 'Amber',
    'projectHome.accentColors.violet': 'Violet',
    'projectHome.accentColors.emerald': 'Emerald',
    'projectHome.accentColors.slate': 'Slate',
    'projectHome.project.openProject': 'Open project {name}',
    'projectHome.project.moreActions': 'More actions',
    'projectHome.project.rename': 'Rename',
    'projectHome.project.archive': 'Archive',
    'projectHome.project.unarchive': 'Unarchive',
    'projectHome.project.delete': 'Delete',
    'projectHome.project.archived': 'Archived',
    'projectHome.project.exportUsage': 'Export model & usage',
    'projectHome.project.exportingUsage': 'Exporting…',
    'projectHome.project.workspaceCount': '{count} conversations',
    'common.cancel': 'Cancel',
    'common.processing': 'Processing',
    'common.save': 'Save',
    'common.close': 'Close',
    'app.backupSuccess': '{filename}',
    'app.backupSuccessWithKey': '{filename} with key',
    'app.backupFailed': 'Failed {error}',
    'app.restoreSuccess': '{fileCount}',
    'app.restoreFailed': 'Failed {error}',
    'app.clearFailedCloseOtherTabs': 'Close tabs',
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

describe('ProjectHome — new homepage layout', () => {
  it('opens the docs hub from the header help popover', async () => {
    const user = userEvent.setup()
    const onOpenDocs = vi.fn()

    render(
      <ProjectHome
        projects={[]}
        projectStats={{}}
        activeProjectId=""
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn().mockResolvedValue(null)}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
        onOpenDocs={onOpenDocs}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Help' }))
    await user.click(screen.getByRole('menuitem', { name: 'Docs Hub' }))

    expect(onOpenDocs).toHaveBeenCalledTimes(1)
  })

  it('opens the most recent active project from the grid', async () => {
    const user = userEvent.setup()
    const onOpenProject = vi.fn()
    const now = Date.now()

    render(
      <ProjectHome
        projects={[
          {
            id: 'project-a',
            name: 'Stale Project',
            status: 'active',
            createdAt: now - 86400000 * 30,
            updatedAt: now - 86400000 * 30,
          },
          {
            id: 'project-b',
            name: 'Recent Project',
            status: 'active',
            createdAt: now - 1000 * 60 * 10,
            updatedAt: now - 1000 * 60 * 10,
          },
        ]}
        projectStats={{
          'project-b': {
            projectId: 'project-b',
            workspaceCount: 1,
            lastWorkspaceAccessAt: now - 1000 * 60 * 2,
          },
        }}
        activeProjectId=""
        onOpenProject={onOpenProject}
        onCreateProject={vi.fn().mockResolvedValue(null)}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Open project Recent Project' }))

    expect(onOpenProject).toHaveBeenCalledWith('project-b')
  })

  it('does not inject Google Fonts imports in inline styles', () => {
    const { container } = render(
      <ProjectHome
        projects={[]}
        projectStats={{}}
        activeProjectId=""
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn().mockResolvedValue(null)}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
      />,
    )

    const inlineStyle = container.querySelector('style')
    expect(inlineStyle?.textContent).not.toContain('fonts.googleapis.com')
    expect(inlineStyle?.textContent).not.toContain('@import url(')
  })

  it('exports model & usage from the project action menu', async () => {
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
        onCreateProject={vi.fn().mockResolvedValue(null)}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onExportProjectUsage={onExportProjectUsage}
        onClearLocalData={vi.fn()}
      />,
    )

    const card = screen.getByRole('button', { name: 'Open project Exportable Project' }).closest('article')
    expect(card).not.toBeNull()
    await user.click(within(card!).getByRole('button', { name: 'More actions' }))
    await user.click(await screen.findByText('Export model & usage'))

    expect(onExportProjectUsage).toHaveBeenCalledWith(project)
  })

  it('creates a project when the dialog submits a valid name', async () => {
    const user = userEvent.setup()
    const onCreateProject = vi.fn().mockResolvedValue('new-project-id')

    render(
      <ProjectHome
        projects={[]}
        projectStats={{}}
        activeProjectId=""
        onOpenProject={vi.fn()}
        onCreateProject={onCreateProject}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
      />,
    )

    // Open from the hero CTA — the homepage keeps a single "New Project"
    // entry (the hero button).
    await user.click(screen.getByRole('button', { name: 'New Project' }))

    await user.type(
      screen.getByPlaceholderText('Enter project name'),
      'My Brand New Project',
    )
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreateProject).toHaveBeenCalledWith('My Brand New Project')
  })

  it('binds pre-picked folder handles to the new project on submit', async () => {
    const user = userEvent.setup()
    const onCreateProject = vi.fn().mockResolvedValue('new-project-id')
    setHandleSpy.mockClear()

    // Fake two folder handles picked in the modal — CreateProjectDialog calls
    // showDirectoryPicker and stashes the handles locally before submit.
    const handleA = { name: 'docs', kind: 'directory' } as unknown as FileSystemDirectoryHandle
    const handleB = { name: 'photos', kind: 'directory' } as unknown as FileSystemDirectoryHandle
    const picker = vi.fn().mockResolvedValueOnce(handleA).mockResolvedValueOnce(handleB)
    Object.defineProperty(window, 'showDirectoryPicker', {
      configurable: true,
      value: picker,
    })

    render(
      <ProjectHome
        projects={[]}
        projectStats={{}}
        activeProjectId=""
        onOpenProject={vi.fn()}
        onCreateProject={onCreateProject}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'New Project' }))
    await user.type(screen.getByPlaceholderText('Enter project name'), 'Project With Folders')
    await user.click(screen.getByRole('button', { name: 'Choose folder' }))
    await user.click(screen.getByRole('button', { name: 'Add another' }))
    await user.click(screen.getByRole('button', { name: 'Create' }))

    expect(onCreateProject).toHaveBeenCalledWith('Project With Folders')
    expect(setHandleSpy).toHaveBeenCalledTimes(2)
    expect(setHandleSpy).toHaveBeenNthCalledWith(1, 'new-project-id', handleA)
    expect(setHandleSpy).toHaveBeenNthCalledWith(2, 'new-project-id', handleB)
  })

  it('binds a native-host root eagerly when the picker is available', async () => {
    const user = userEvent.setup()
    // Flip native-host availability on for this test only.
    const nativeAvailSpy = nativeDiskExecutor.isNativeHostAvailable as unknown as ReturnType<typeof vi.fn>
    nativeAvailSpy.mockReturnValue(true)
    // Simulate the real store side effect: addNativeHostRoot appends a root
    // row (backend=native-host, scopeId) and loadRoots() pulls it into the
    // snapshot. The mock captures the projectId passed in.
    addNativeHostRootSpy.mockImplementationOnce(async (projectId: string) => {
      folderStore.roots.push({
        id: 'root-1',
        name: '/Users/me/Documents',
        projectId,
      })
      return true
    })

    const onCreateProject = vi.fn().mockResolvedValue('new-project-id')

    render(
      <ProjectHome
        projects={[]}
        projectStats={{}}
        activeProjectId=""
        onOpenProject={vi.fn()}
        onCreateProject={onCreateProject}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'New Project' }))
    await user.type(screen.getByPlaceholderText('Enter project name'), 'Native Host Project')
    await user.click(screen.getByRole('button', { name: 'Authorize local' }))

    // Project must have been created BEFORE addNativeHostRoot runs (eager).
    expect(onCreateProject).toHaveBeenCalledWith('Native Host Project')
    expect(addNativeHostRootSpy).toHaveBeenCalledWith('new-project-id')
    // Chip with the new root name should be visible.
    expect(await screen.findByText('/Users/me/Documents')).toBeInTheDocument()

    // Cleanup so the mock returns to its default for sibling tests.
    nativeAvailSpy.mockReturnValue(false)
    addNativeHostRootSpy.mockReset()
    folderStore.roots = []
  })

  it('opens /chats from the standalone-chats hero card', async () => {
    const user = userEvent.setup()
    const onOpenStandaloneChats = vi.fn()

    render(
      <ProjectHome
        projects={[]}
        projectStats={{}}
        activeProjectId=""
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn().mockResolvedValue(null)}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
        onOpenStandaloneChats={onOpenStandaloneChats}
      />,
    )

    await user.click(screen.getByTestId('standalone-chats-card'))
    expect(onOpenStandaloneChats).toHaveBeenCalledTimes(1)
    // Without chats, the card shows the generic description.
    expect(screen.getByTestId('standalone-chats-card')).toHaveTextContent('不挂项目、随时开聊')
  })

  it('previews the most recent standalone chat in the hero card', () => {
    const onOpenStandaloneChats = vi.fn()

    render(
      <ProjectHome
        projects={[]}
        projectStats={{}}
        activeProjectId=""
        standaloneChats={[
          { id: 'c1', title: 'Older chat', updatedAt: 1000 },
          { id: 'c2', title: 'Newest chat', updatedAt: 2000 },
        ]}
        onOpenProject={vi.fn()}
        onCreateProject={vi.fn().mockResolvedValue(null)}
        onRenameProject={vi.fn()}
        onArchiveProject={vi.fn()}
        onDeleteProject={vi.fn()}
        onClearLocalData={vi.fn()}
        onOpenStandaloneChats={onOpenStandaloneChats}
      />,
    )

    expect(screen.getByTestId('standalone-chats-card')).toHaveTextContent('最近：Newest chat')
  })
})