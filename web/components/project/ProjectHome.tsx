import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatDistanceToNow, isToday, isYesterday, isThisWeek, isThisMonth } from 'date-fns'
import { zhCN, enUS, ja, ko } from 'date-fns/locale'
import type { Locale as DateFnsLocale } from 'date-fns'
import type { Project, ProjectStats } from '@/sqlite/repositories/project.repository'
import { ActivityHeatmap } from '@/components/activity/ActivityHeatmap'
import {
  BrandButton,
  BrandCheckbox,
  BrandDialog,
  BrandDialogBody,
  BrandDialogContent,
  BrandDialogFooter,
  BrandDialogHeader,
  BrandDialogTitle,
  BrandInput,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@creatorweave/ui'
import {
  MoreHorizontal,
  Archive,
  ArchiveRestore,
  Pencil,
  Trash2,
  Plus,
  ArrowRight,
  Clock,
  FolderOpen,
  Sparkles,
  Shield,
  RotateCcw,
  Palette,
  Sun,
  Moon,
  Globe,
  FileText,
  RefreshCw,
  Github,
  Stethoscope,
  Copy,
  Check,
  Download,
  Upload,
  ChevronDown,
  AlertTriangle,
} from 'lucide-react'
import { useTheme, ACCENT_COLORS, type AccentColor } from '@/store/theme.store'
import { useT, useLocale, LOCALE_LABELS, type Locale } from '@/i18n'
import { useExtensionStore } from '@/store/extension.store'
import { ExtensionBanner } from '@/components/extension'
import { runDiagnostics, copyMarkdownToClipboard } from '@/storage/diagnostics'
import { RESET_REQUIRES_TAB_CLOSURE } from '@/storage/init'
import { SiteFooter } from '@/components/layout/SiteFooter'
import { toast } from 'sonner'

// Design system styles
const designStyles = `
  /* Typography - local/system font stack only */

  :root {
    --home-serif: 'Fraunces', 'Noto Serif SC', Georgia, serif;
    --home-sans: system-ui, -apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif;
  }

  /* Entry animations */
  @keyframes revealUp {
    from {
      opacity: 0;
      transform: translateY(24px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes revealScale {
    from {
      opacity: 0;
      transform: scale(0.96);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  @keyframes subtleFloat {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-4px); }
    80% { transform: translateY(-1px); }
  }

  @keyframes grain {
    0%, 100% { transform: translate(0, 0); }
    10% { transform: translate(-1%, -1%); }
    20% { transform: translate(1%, 1%); }
    30% { transform: translate(-0.5%, 0.5%); }
    40% { transform: translate(0.5%, -0.5%); }
    50% { transform: translate(-1%, 0.5%); }
    60% { transform: translate(0.5%, 1%); }
    70% { transform: translate(-0.5%, -1%); }
    80% { transform: translate(1%, -0.5%); }
    90% { transform: translate(-1%, 1%); }
  }

  @keyframes pulseGlow {
    0%, 100% { opacity: 0.4; }
    50% { opacity: 0.7; }
  }

  .home-reveal {
    animation: revealUp 0.7s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    opacity: 0;
  }

  .home-reveal-scale {
    animation: revealScale 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
    opacity: 0;
  }

  .home-delay-1 { animation-delay: 0.1s; }
  .home-delay-2 { animation-delay: 0.2s; }
  .home-delay-3 { animation-delay: 0.3s; }
  .home-delay-4 { animation-delay: 0.4s; }
  .home-delay-5 { animation-delay: 0.5s; }
  .home-delay-6 { animation-delay: 0.6s; }

  /* Reduced motion preference */
  @media (prefers-reduced-motion: reduce) {
    .home-reveal,
    .home-reveal-scale {
      animation: none;
      opacity: 1;
    }
    .home-float,
    .home-grain::before {
      animation: none;
    }
    .home-timeline-item::before,
    .home-action-card::before,
    .home-action-card:hover {
      transition: none;
      transform: none;
    }
  }

  /* Hero background */
  .home-hero-bg {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }

  .home-hero-bg::before {
    content: '';
    position: absolute;
    top: -50%;
    right: -20%;
    width: 80%;
    height: 150%;
    background: radial-gradient(
      ellipse at center,
      oklch(var(--primary) / 0.08) 0%,
      transparent 70%
    );
    animation: pulseGlow 8s ease-in-out infinite;
  }

  .home-hero-bg::after {
    content: '';
    position: absolute;
    bottom: -30%;
    left: -10%;
    width: 50%;
    height: 80%;
    background: radial-gradient(
      ellipse at center,
      oklch(220 0.15 0.5 / 0.05) 0%,
      transparent 60%
    );
  }

  /* Texture overlay */
  .home-grain::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
    opacity: 0.02;
    pointer-events: none;
    animation: grain 20s steps(10) infinite;
  }

  /* Typography */
  .home-title-serif {
    font-family: var(--home-serif);
    font-weight: 500;
    font-optical-sizing: auto;
    letter-spacing: -0.02em;
  }

  .home-title-sans {
    font-family: var(--home-sans);
    font-weight: 600;
    letter-spacing: -0.03em;
  }

  .home-body {
    font-family: var(--home-sans);
    letter-spacing: 0.01em;
  }

  .home-mono {
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
    font-size: 0.85em;
    letter-spacing: 0.02em;
  }

  /* Project timeline */
  .home-timeline {
    position: relative;
  }

  .home-timeline::before {
    content: '';
    position: absolute;
    left: 11px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: linear-gradient(
      to bottom,
      transparent,
      hsl(var(--border)) 10%,
      hsl(var(--border)) 90%,
      transparent
    );
  }

  .home-timeline-item {
    position: relative;
    padding-left: 36px;
    transition: transform 0.2s ease;
  }

  .home-timeline-item::before {
    content: '';
    position: absolute;
    left: 6px;
    top: 50%;
    transform: translateY(-50%);
    width: 11px;
    height: 11px;
    border-radius: 50%;
    background: hsl(var(--background));
    border: 2px solid hsl(var(--border));
    transition: border-color 0.2s ease, background-color 0.2s ease;
  }

  .home-timeline-item:hover::before {
    border-color: hsl(var(--primary));
    background: hsl(var(--primary-50));
  }

  .home-timeline-item.is-active::before {
    border-color: hsl(var(--primary));
    background: hsl(var(--primary));
  }

  .home-timeline-item.is-archived {
    /* archived state is expressed via muted text color in JSX (not opacity),
       so child text contrast stays ≥4.5:1 (WCAG AA). */
  }

  .home-timeline-item.is-archived::before {
    border-style: dashed;
  }

  /* Quick action cards */
  .home-action-card {
    position: relative;
    overflow: hidden;
    transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.3s cubic-bezier(0.16, 1, 0.3, 1);
  }

  .home-action-card::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(
      135deg,
      oklch(var(--primary) / 0.05) 0%,
      transparent 50%
    );
    opacity: 0;
    transition: opacity 0.3s ease;
    pointer-events: none;
  }

  .home-action-card:hover::before {
    opacity: 1;
  }

  .home-action-card:hover {
    transform: translateY(-2px);
    border-color: hsl(var(--primary) / 0.3);
  }

  /* Search input */
  .home-search-input {
    background: hsl(var(--background));
    border: 1px solid hsl(var(--border));
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }

  .home-search-input:focus {
    border-color: hsl(var(--primary));
    box-shadow: 0 0 0 3px oklch(var(--primary) / 0.1);
    outline: none;
  }

  /* Empty state */
  .home-empty-state {
    position: relative;
  }

  .home-empty-state::before {
    content: '';
    position: absolute;
    inset: 0;
    background: radial-gradient(
      circle at 50% 50%,
      oklch(var(--primary) / 0.03) 0%,
      transparent 50%
    );
    pointer-events: none;
  }
`

// Get date-fns locale
const getDateFnsLocale = (locale: string): DateFnsLocale => {
  const localeMap: Record<string, DateFnsLocale> = {
    'zh-CN': zhCN,
    'en-US': enUS,
    'ja-JP': ja,
    'ko-KR': ko,
  }
  return localeMap[locale] || zhCN
}

// Format relative time - needs to be used inside component
const formatRelativeTimeWithLocale = (date: number | Date, locale: DateFnsLocale) => {
  return formatDistanceToNow(new Date(date), { addSuffix: true, locale })
}

// Time grouping
type TimeGroup = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'older'

const getTimeGroup = (date: number | Date): TimeGroup => {
  const d = new Date(date)
  if (isToday(d)) return 'today'
  if (isYesterday(d)) return 'thisWeek'
  if (isThisWeek(d)) return 'thisWeek'
  if (isThisMonth(d)) return 'thisMonth'
  return 'older'
}

const timeGroupOrder: TimeGroup[] = ['today', 'thisWeek', 'thisMonth', 'older']

interface ProjectHomeProps {
  projects: Project[]
  projectStats?: Record<string, ProjectStats>
  activeProjectId: string
  isLoading?: boolean
  onOpenProject: (projectId: string) => void | Promise<void>
  onCreateProject: (name: string) => void | Promise<void>
  onRenameProject: (projectId: string, name: string) => void | Promise<void>
  onArchiveProject: (projectId: string, archived: boolean) => void | Promise<void>
  onDeleteProject: (projectId: string) => void | Promise<void>
  onExportProjectUsage?: (project: Project) => void | Promise<void>
  onClearLocalData: () => void | Promise<void>
  onOpenDocs?: () => void | Promise<void>
  isClearingLocalData?: boolean
}

const SKIP_ARCHIVE_CONFIRM_KEY = 'project-home:skip-archive-confirm'

export function ProjectHome({
  projects,
  projectStats = {},
  activeProjectId,
  isLoading = false,
  onOpenProject,
  onCreateProject,
  onRenameProject,
  onArchiveProject,
  onDeleteProject,
  onExportProjectUsage,
  onClearLocalData,
  onOpenDocs,
  isClearingLocalData = false,
}: ProjectHomeProps) {
  // Theme
  const { mode: themeMode, setTheme, accentColor, setAccentColor } = useTheme()
  const currentAccentColor = accentColor || 'teal'

  // I18n
  const t = useT()
  const [locale, setLocale] = useLocale()
  const dateFnsLocale = getDateFnsLocale(locale)

  // Format relative time
  const formatRelativeTime = (date: number | Date) => {
    return formatRelativeTimeWithLocale(date, dateFnsLocale)
  }

  const getProjectActivityAt = useCallback(
    (project: Project) => {
      const workspaceActivityAt = projectStats[project.id]?.lastWorkspaceAccessAt || 0
      return Math.max(project.updatedAt, workspaceActivityAt)
    },
    [projectStats]
  )

  const handleOpenProject = useCallback(
    (projectId: string) => {
      void onOpenProject(projectId)
    },
    [onOpenProject]
  )

  // Time group labels
  const getTimeGroupLabels = (): Record<TimeGroup, string> => ({
    today: t('projectHome.timeline.today'),
    yesterday: t('projectHome.timeline.yesterday'),
    thisWeek: t('projectHome.timeline.thisWeek'),
    thisMonth: t('projectHome.timeline.thisMonth'),
    older: t('projectHome.timeline.older'),
  })
  const timeGroupLabels = getTimeGroupLabels()

  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'archived'>('all')
  const [isCreating, setIsCreating] = useState(false)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createDialogName, setCreateDialogName] = useState('')
  const [isComposition, setIsComposition] = useState(false)
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [archivingProject, setArchivingProject] = useState<Project | null>(null)
  const [skipArchiveConfirm, setSkipArchiveConfirm] = useState(false)
  const [archiveDontAskAgain, setArchiveDontAskAgain] = useState(false)
  const [deletingProject, setDeletingProject] = useState<Project | null>(null)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [isActionSubmitting, setIsActionSubmitting] = useState(false)
  const [pendingProjectAction, setPendingProjectAction] = useState<{
    projectId: string
    type: 'rename' | 'archive' | 'unarchive' | 'delete' | 'export_usage'
  } | null>(null)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showClearDataDialog, setShowClearDataDialog] = useState(false)
  const [clearDataConfirmText, setClearDataConfirmText] = useState('')
  const [isClearingCache, setIsClearingCache] = useState(false)
  const [isExportingDB, setIsExportingDB] = useState(false)
  const [isImportingDB, setIsImportingDB] = useState(false)
  const [importBackupFile, setImportBackupFile] = useState<File | null>(null)
  const [showExportConfirm, setShowExportConfirm] = useState(false)
  const importInputRef = useRef<HTMLInputElement>(null)

  // Diagnostic report state
  const [diagOpen, setDiagOpen] = useState(false)
  const [diagRunning, setDiagRunning] = useState(false)
  const [diagReport, setDiagReport] = useState<string>('')
  const [diagCopied, setDiagCopied] = useState(false)

  const createInputRef = useRef<HTMLInputElement>(null)

  // Confirm text for clearing local data (needs to match translated placeholder)
  const startFreshConfirmText = t('projectHome.dialogs.startFreshConfirmPlaceholder')

  // Clear local data confirmation
  const handleClearDataConfirm = async () => {
    if (clearDataConfirmText !== startFreshConfirmText) return
    setIsActionSubmitting(true)
    try {
      await onClearLocalData()
      setShowClearDataDialog(false)
      setClearDataConfirmText('')
    } finally {
      setIsActionSubmitting(false)
    }
  }

  // Clear Service Worker cache and reload
  const handleClearCache = async () => {
    if (!navigator.serviceWorker.controller) {
      toast.error(t('projectHome.dialogs.clearCacheUnavailable'))
      return
    }
    setIsClearingCache(true)
    navigator.serviceWorker.controller.postMessage({ type: 'CLEAR_CACHE' })
    // Wait a bit for SW to process, then reload
    await new Promise((resolve) => setTimeout(resolve, 200))
    window.location.reload()
  }

  // Export the entire OPFS (SQLite db + workspace files) as a downloadable zip.
  // Gated by a confirmation dialog because the archive carries the device
  // encryption key + login tokens — it must be treated as sensitive.
  const performExportBackup = async () => {
    setIsExportingDB(true)
    const toastId = toast.loading(t('projectHome.sidebar.backingUp'))
    try {
      const { downloadOPFSBackup } = await import('@/opfs')
      const { filename, includesDeviceKey } = await downloadOPFSBackup()
      // Surface whether API keys are actually restorable — a silent
      // credential-less backup is exactly the class of bug users can't see.
      toast.success(
        includesDeviceKey
          ? t('app.backupSuccessWithKey', { filename })
          : t('app.backupSuccess', { filename }),
        { id: toastId, duration: includesDeviceKey ? 5000 : 10000 }
      )
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('[ProjectHome] Failed to export OPFS backup:', error)
      toast.error(t('app.backupFailed', { error: errorMsg }), {
        id: toastId,
        action: {
          label: t('projectHome.dialogs.retry'),
          onClick: () => void performExportBackup(),
        },
      })
    } finally {
      setIsExportingDB(false)
    }
  }

  // Import a full OPFS backup zip — picked via hidden file input, then a
  // confirmation dialog (destructive: replaces ALL current data), then the
  // restore itself. The page must reload afterwards so everything
  // re-initializes from the restored files.
  const handleImportBackupSelected = () => {
    const input = importInputRef.current
    if (!input) return
    input.value = '' // allow re-picking the same file
    input.accept = '.zip'
    input.click()
  }

  const handleImportFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] ?? null
    if (file) setImportBackupFile(file)
    e.target.value = '' // allow re-picking the same file
  }

  const handleImportBackupConfirm = async () => {
    const file = importBackupFile
    if (!file) return
    setIsImportingDB(true)
    const toastId = toast.loading(t('projectHome.sidebar.restoringBackup'))
    try {
      const { importOPFSBackup } = await import('@/opfs')
      const { fileCount } = await importOPFSBackup(file)
      toast.success(t('app.restoreSuccess', { fileCount }), { id: toastId, duration: 8000 })
      setImportBackupFile(null)
      // Give the toast a moment to paint before the hard reload wipes it
      await new Promise((resolve) => setTimeout(resolve, 1200))
      window.location.reload()
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('[ProjectHome] Failed to import OPFS backup:', error)
      // Multi-tab lock failures carry the same marker the clear-data flow
      // uses — surface the actionable "close other tabs" message instead
      // of the raw (cryptic) error text.
      const message = errorMsg.includes(RESET_REQUIRES_TAB_CLOSURE)
        ? t('app.clearFailedCloseOtherTabs')
        : t('app.restoreFailed', { error: errorMsg })
      toast.error(message, { id: toastId, duration: 10000 })
      setIsImportingDB(false)
      // OPFS may be in a partial state — a reload re-inits from whatever is
      // on disk, which is the safest recoverable posture for the user.
      // Keep the dialog open so the user can retry with another archive.
    }
  }

  // Run storage diagnostics and show the report dialog
  const handleRunDiagnostics = async () => {
    setDiagOpen(true)
    setDiagRunning(true)
    setDiagReport('')
    setDiagCopied(false)
    try {
      const report = await runDiagnostics()
      setDiagReport(report.markdown)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      setDiagReport(`${t('projectHome.dialogs.diagnosticsFailed')}\n\n${detail}`)
    } finally {
      setDiagRunning(false)
    }
  }

  const handleCopyReport = async () => {
    if (!diagReport) return
    const ok = await copyMarkdownToClipboard(diagReport)
    if (ok) {
      setDiagCopied(true)
      window.setTimeout(() => setDiagCopied(false), 2000)
    }
  }

  const openCreateDialog = useCallback(() => {
    if (isLoading || isCreating) return
    setShowCreateDialog(true)
    window.setTimeout(() => createInputRef.current?.focus(), 80)
  }, [isCreating, isLoading])

  // Projects grouped by time
  const groupedProjects = useMemo(() => {
    let filtered = [...projects]

    // Apply status filter
    if (statusFilter === 'active') {
      filtered = filtered.filter((p) => p.status !== 'archived')
    } else if (statusFilter === 'archived') {
      filtered = filtered.filter((p) => p.status === 'archived')
    }

    // Sort by project activity time
    const sorted = filtered.sort((a, b) => getProjectActivityAt(b) - getProjectActivityAt(a))

    // Apply search
    const keyword = search.trim().toLowerCase()
    const searched = keyword ? sorted.filter((p) => p.name.toLowerCase().includes(keyword)) : sorted

    // Group by time
    const groups: Record<TimeGroup, Project[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      thisMonth: [],
      older: [],
    }

    searched.forEach((project) => {
      const group = getTimeGroup(getProjectActivityAt(project))
      groups[group].push(project)
    })

    return groups
  }, [getProjectActivityAt, projects, search, statusFilter])

  // Recent project
  const recentProject = useMemo(() => {
    const active = projects.filter((p) => p.status !== 'archived')
    return active.sort((a, b) => getProjectActivityAt(b) - getProjectActivityAt(a))[0] || null
  }, [getProjectActivityAt, projects])

  // Project stats
  const totalProjects = projects.filter((p) => p.status !== 'archived').length
  const totalWorkspaces = Object.values(projectStats).reduce(
    (sum, stats) => sum + (stats?.workspaceCount || 0),
    0
  )

  useEffect(() => {
    if (typeof window === 'undefined') return
    const saved = window.localStorage.getItem(SKIP_ARCHIVE_CONFIRM_KEY)
    setSkipArchiveConfirm(saved === '1')
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'n') return
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (showCreateDialog) return

      const target = event.target
      if (target instanceof HTMLElement) {
        const tag = target.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) {
          return
        }
      }

      event.preventDefault()
      openCreateDialog()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showCreateDialog, openCreateDialog])

  // Submit from create dialog
  const handleCreateFromDialog = async () => {
    const name = createDialogName.trim()
    if (!name) return
    setIsCreating(true)
    try {
      await onCreateProject(name)
      setCreateDialogName('')
      setShowCreateDialog(false)
    } finally {
      setIsCreating(false)
    }
  }

  const handleRenameOpen = (project: Project) => {
    setRenamingProjectId(project.id)
    setRenameDraft(project.name)
  }

  const handleRenameConfirm = async () => {
    if (!renamingProjectId || !renameDraft.trim()) return
    setIsActionSubmitting(true)
    setPendingProjectAction({ projectId: renamingProjectId, type: 'rename' })
    try {
      await onRenameProject(renamingProjectId, renameDraft.trim())
      setRenamingProjectId(null)
      setRenameDraft('')
    } finally {
      setIsActionSubmitting(false)
      setPendingProjectAction(null)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deletingProject) return
    if (deleteConfirmText !== deletingProject.name) return
    setIsActionSubmitting(true)
    setPendingProjectAction({ projectId: deletingProject.id, type: 'delete' })
    try {
      await onDeleteProject(deletingProject.id)
      setDeletingProject(null)
      setDeleteConfirmText('')
    } finally {
      setIsActionSubmitting(false)
      setPendingProjectAction(null)
    }
  }

  const handleArchiveClick = async (project: Project, isArchived: boolean) => {
    if (isArchived) {
      setPendingProjectAction({ projectId: project.id, type: 'unarchive' })
      try {
        await onArchiveProject(project.id, false)
      } finally {
        setPendingProjectAction(null)
      }
      return
    }

    if (skipArchiveConfirm) {
      setPendingProjectAction({ projectId: project.id, type: 'archive' })
      try {
        await onArchiveProject(project.id, true)
      } finally {
        setPendingProjectAction(null)
      }
      return
    }

    setArchiveDontAskAgain(false)
    setArchivingProject(project)
  }

  const handleArchiveConfirm = async () => {
    if (!archivingProject) return
    setIsActionSubmitting(true)
    setPendingProjectAction({ projectId: archivingProject.id, type: 'archive' })
    try {
      await onArchiveProject(archivingProject.id, true)
      if (archiveDontAskAgain && typeof window !== 'undefined') {
        window.localStorage.setItem(SKIP_ARCHIVE_CONFIRM_KEY, '1')
        setSkipArchiveConfirm(true)
      }
      setArchivingProject(null)
    } finally {
      setIsActionSubmitting(false)
      setPendingProjectAction(null)
    }
  }

  const handleExportUsage = async (project: Project) => {
    if (!onExportProjectUsage) return
    setPendingProjectAction({ projectId: project.id, type: 'export_usage' })
    try {
      await onExportProjectUsage(project)
    } finally {
      setPendingProjectAction(null)
    }
  }

  // Render project timeline item
  const renderProjectItem = (project: Project, index: number) => {
    const isActive = project.id === activeProjectId
    const stats = projectStats[project.id]
    const isArchived = project.status === 'archived'
    const isProjectActionPending = pendingProjectAction?.projectId === project.id
    const isRenamePending = isProjectActionPending && pendingProjectAction?.type === 'rename'
    const activityAt = getProjectActivityAt(project)

    return (
      <div
        key={project.id}
        className={`home-timeline-item py-4 home-reveal ${isActive ? 'is-active' : ''} ${isArchived ? 'is-archived' : ''}`}
        style={{ animationDelay: `${Math.min(index * 0.05, 0.3)}s` }}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => handleOpenProject(project.id)}
              disabled={isLoading || isActionSubmitting}
              className="group w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 rounded-lg"
              aria-label={t('projectHome.project.openProject', { name: project.name })}
            >
              <div className="flex items-center gap-2 mb-1">
                <h3 className={`home-title-sans text-base truncate group-hover:text-primary/70 transition-colors ${
                  isArchived ? 'text-muted-foreground' : 'text-secondary dark:text-foreground'
                }`}>
                  {project.name}
                </h3>
                {isArchived && (
                  <span className="home-mono text-[10px] uppercase tracking-wider text-tertiary dark:text-muted px-1.5 py-0.5 rounded bg-muted dark:bg-muted">
                    {t('projectHome.project.archived')}
                  </span>
                )}
              </div>
              <div className={`home-body flex items-center gap-3 text-xs ${
                isArchived ? 'text-muted-foreground' : 'text-tertiary dark:text-muted'
              }`}>
                <span className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  {formatRelativeTime(activityAt)}
                </span>
                <span className="flex items-center gap-1">
                  <FolderOpen className="w-3 h-3" />
                  {t('projectHome.project.workspaceCount', { count: stats?.workspaceCount || 0 })}
                </span>
              </div>
            </button>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <BrandButton
                  variant="ghost"
                  iconButton
                  disabled={isProjectActionPending}
                  aria-label={t('projectHome.project.moreActions')}
                >
                  <MoreHorizontal className="h-4 w-4" />
                </BrandButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[10rem] max-w-[14rem]">
                <DropdownMenuItem
                  onSelect={() => handleRenameOpen(project)}
                  disabled={isProjectActionPending || isActionSubmitting}
                >
                  <Pencil className="mr-2 h-4 w-4" />
                  {isRenamePending
                    ? t('common.processing')
                    : t('projectHome.project.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void handleExportUsage(project)}
                  disabled={!onExportProjectUsage || isProjectActionPending || isActionSubmitting}
                >
                  <Download className="mr-2 h-4 w-4" />
                  {isProjectActionPending && pendingProjectAction?.type === 'export_usage'
                    ? t('projectHome.project.exportingUsage')
                    : t('projectHome.project.exportUsage')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onSelect={() => void handleArchiveClick(project, isArchived)}
                  disabled={isProjectActionPending || isActionSubmitting}
                >
                  {isArchived ? (
                    <>
                      <ArchiveRestore className="mr-2 h-4 w-4" />
                      {t('projectHome.project.unarchive')}
                    </>
                  ) : (
                    <>
                      <Archive className="mr-2 h-4 w-4" />
                      {t('projectHome.project.archive')}
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    setDeletingProject(project)
                    setDeleteConfirmText('')
                  }}
                  disabled={isProjectActionPending || isActionSubmitting}
                  className="text-danger hover:bg-danger/10 hover:text-danger focus:text-danger focus:bg-danger/10"
                >
                  <Trash2 className="mr-2 h-4 w-4" />
                  {t('projectHome.project.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="relative min-h-screen bg-background home-grain">
      <style>{designStyles}</style>

      {/* Extension install banner */}
      <ExtensionBanner onInstallClick={() => useExtensionStore.getState().openInstallGuide()} />

      {/* Hero section */}
      <header className="relative overflow-hidden">
        <div className="home-hero-bg" />
        <div className="relative z-10 max-w-5xl mx-auto px-6 pt-8 pb-8 sm:pt-10 sm:pb-10">
          <div className="home-reveal">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary-50 dark:bg-primary/10 border border-primary/10 dark:border-primary/20">
                <Shield className="w-3.5 h-3.5 text-primary-600 dark:text-primary-600" />
                <span className="home-body text-xs text-primary-600 dark:text-primary-600 font-medium">
                  {t('projectHome.hero.badge')}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <BrandButton
                  variant="outline"
                  className="h-9 px-3 text-xs"
                  onClick={() => {
                    void onOpenDocs?.()
                  }}
                >
                  <FileText className="w-3.5 h-3.5 mr-1.5" />
                  {t('projectHome.hero.docsHub')}
                </BrandButton>
                <a
                  href="https://github.com/nutstore/eo2weave"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 h-9 px-3 text-xs rounded-lg border border-gray-200 bg-transparent text-secondary hover:bg-gray-50 hover:text-primary dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800 dark:hover:text-foreground font-medium transition-colors"
                >
                  <Github className="w-3.5 h-3.5 mr-1.5" />
                  GitHub
                </a>
              </div>
            </div>
          </div>

          <h1 className="home-title-serif home-reveal home-delay-1">
            <span className="block text-4xl sm:text-5xl lg:text-6xl text-secondary dark:text-foreground leading-tight">
              {t('projectHome.hero.title')}
            </span>
          </h1>

          <p className="home-body home-reveal home-delay-2 mt-4 text-lg sm:text-xl text-secondary dark:text-secondary-foreground max-w-xl leading-relaxed">
            {t('projectHome.hero.description')}
            <span className="text-tertiary dark:text-muted">{t('projectHome.hero.descriptionSuffix')}</span>
          </p>

          {/* Quick stats */}
          <div className="home-reveal home-delay-3 mt-8 flex items-center gap-6">
            <div className="home-mono text-sm">
              <span className="text-secondary dark:text-foreground font-medium">{totalProjects}</span>
              <span className="text-tertiary dark:text-muted ml-1">{t('projectHome.hero.projectCount', { count: '' }).trim()}</span>
            </div>
            <div className="w-px h-4 bg-border" />
            <div className="home-mono text-sm">
              <span className="text-secondary dark:text-foreground font-medium">{totalWorkspaces}</span>
              <span className="text-tertiary dark:text-muted ml-1">{t('projectHome.hero.workspaceCount', { count: '' }).trim()}</span>
            </div>
          </div>
        </div>
      </header>

      {/* Main content area */}
      <main className="relative z-10 max-w-5xl mx-auto px-6 pb-10">
        {/* Mobile-first quick entry: continue work */}
        {recentProject && (
          <div className="mb-4 lg:hidden">
            <div className="home-reveal home-delay-3 home-action-card rounded-xl border border-border bg-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-4 h-4 text-primary-600 dark:text-primary-600" />
                <span className="home-mono text-xs font-medium text-muted-foreground">
                  {t('projectHome.sidebar.continueWork')}
                </span>
              </div>
              <h3 className="home-title-sans text-base text-secondary dark:text-foreground mb-1 truncate">
                {recentProject.name}
              </h3>
              <p className="home-body text-xs text-tertiary dark:text-muted mb-4">
                {formatRelativeTime(getProjectActivityAt(recentProject))}
              </p>
              <BrandButton
                onClick={() => handleOpenProject(recentProject.id)}
                variant="primary"
                className="w-full"
                disabled={isLoading}
              >
                {t('projectHome.sidebar.continueWork')}
                <ArrowRight className="w-4 h-4 ml-1" />
              </BrandButton>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8">
          {/* Left sidebar: Quick actions */}
          <aside className="order-2 lg:order-1 lg:col-span-4 space-y-4">
            {/* Continue working */}
            {recentProject && (
              <div className="hidden lg:block home-reveal home-delay-3 home-action-card rounded-xl border border-border bg-card p-5">
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="w-4 h-4 text-primary-600 dark:text-primary-600" />
                  <span className="home-mono text-xs font-medium text-muted-foreground">
                    {t('projectHome.sidebar.continueWork')}
                  </span>
                </div>
                <h3 className="home-title-sans text-base text-secondary dark:text-foreground mb-1 truncate">
                  {recentProject.name}
                </h3>
                <p className="home-body text-xs text-tertiary dark:text-muted mb-4">
                  {formatRelativeTime(getProjectActivityAt(recentProject))}
                </p>
                <BrandButton
                  onClick={() => handleOpenProject(recentProject.id)}
                  variant="primary"
                  className="w-full"
                  disabled={isLoading}
                >
                  {t('projectHome.sidebar.continueWork')}
                  <ArrowRight className="w-4 h-4 ml-1" />
                </BrandButton>
              </div>
            )}

            {/* Create new project */}
            <button
              type="button"
              onClick={openCreateDialog}
              disabled={isLoading}
              className="home-reveal home-delay-4 home-action-card rounded-xl border border-border bg-card p-5 text-left w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
              aria-label={t('projectHome.dialogs.createProject')}
            >
              <div className="flex items-center gap-2 mb-3">
                <Plus className="w-4 h-4 text-primary-600 dark:text-primary-600" />
                <span className="home-mono text-xs font-medium text-muted-foreground">
                  {t('projectHome.sidebar.createNew')}
                </span>
              </div>
              <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
                {t('projectHome.sidebar.createNewDescription')}
              </p>
              <p className="home-mono text-[11px] text-tertiary dark:text-muted mb-3">{t('projectHome.sidebar.shortcutHint')}</p>
              <div
                className="inline-flex items-center justify-center w-full h-10 px-5 text-sm rounded-md border border-border bg-transparent text-secondary font-medium pointer-events-none"
                aria-hidden="true"
              >
                {t('projectHome.sidebar.createProject')}
              </div>
            </button>

            {/* Appearance settings */}
            <div className="home-reveal home-delay-6 rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Palette className="w-4 h-4 text-tertiary" />
                <span className="home-mono text-xs font-medium text-muted-foreground">
                  {t('projectHome.sidebar.appearance')}
                </span>
              </div>

              {/* Theme mode toggle */}
              <div className="mb-4">
                <p className="home-body text-xs text-tertiary dark:text-muted mb-2">{t('projectHome.theme.modeTitle')}</p>
                <div className="flex gap-2">
                  <button
                    onClick={() => setTheme('light')}
                    className={`flex-1 flex items-center justify-center gap-1.5 min-h-[32px] sm:min-h-[28px] px-3 rounded-lg text-xs transition-all ${
                      themeMode === 'light'
                        ? 'bg-primary-50 dark:bg-primary/10 text-primary-600 dark:text-primary-600 border border-primary/20'
                        : 'bg-muted/30 dark:bg-muted/30 text-tertiary dark:text-muted hover:bg-muted/50'
                    }`}
                  >
                    <Sun className="w-3.5 h-3.5" />
                    <span>{t('projectHome.theme.light')}</span>
                  </button>
                  <button
                    onClick={() => setTheme('dark')}
                    className={`flex-1 flex items-center justify-center gap-1.5 min-h-[32px] sm:min-h-[28px] px-3 rounded-lg text-xs transition-all ${
                      themeMode === 'dark'
                        ? 'bg-primary-50 dark:bg-primary/10 text-primary-600 dark:text-primary-600 border border-primary/20'
                        : 'bg-muted/30 dark:bg-muted/30 text-tertiary dark:text-muted hover:bg-muted/50'
                    }`}
                  >
                    <Moon className="w-3.5 h-3.5" />
                    <span>{t('projectHome.theme.dark')}</span>
                  </button>
                </div>
              </div>

              {/* Language selection */}
              <div className="mb-4">
                <p className="home-body text-xs text-tertiary dark:text-muted mb-2">{t('projectHome.theme.languageTitle')}</p>
                <div className="grid grid-cols-2 gap-2">
                  {(['zh-CN', 'en-US', 'ja-JP', 'ko-KR'] as Locale[]).map((lang) => (
                    <button
                      key={lang}
                      onClick={() => setLocale(lang)}
                      className={`flex items-center justify-center gap-1.5 min-h-[32px] sm:min-h-[28px] px-3 rounded-lg text-xs transition-all ${
                        locale === lang
                          ? 'bg-primary-50 dark:bg-primary/10 text-primary-600 dark:text-primary-600 border border-primary/20'
                          : 'bg-muted/30 dark:bg-muted/30 text-tertiary dark:text-muted hover:bg-muted/50'
                      }`}
                    >
                      <Globe className="w-3.5 h-3.5" />
                      <span>{LOCALE_LABELS[lang]}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Accent color selection */}
              <div>
                <p className="home-body text-xs text-tertiary dark:text-muted mb-2">{t('projectHome.theme.accentColorTitle')}</p>
                <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
                  {(Object.keys(ACCENT_COLORS) as AccentColor[]).map((color) => {
                    const config = ACCENT_COLORS[color]
                    const isSelected = currentAccentColor === color
                    const colorName = t(`projectHome.accentColors.${color}`)
                    return (
                      <button
                        key={color}
                        onClick={() => setAccentColor(color)}
                        className={`min-h-[44px] p-1 rounded-lg transition-all ${
                          isSelected
                            ? 'ring-2 ring-offset-2 ring-offset-background'
                            : 'hover:ring-1 hover:ring-muted'
                        }`}
                        style={{
                          backgroundColor: `hsl(${config.hue}, ${config.saturation}%, ${config.lightness}%)`,
                          ['--tw-ring-color' as string]: `hsl(${config.hue}, ${config.saturation}%, ${config.lightness}%)`,
                        }}
                        title={colorName}
                        aria-label={colorName}
                      />
                    )
                  })}
                </div>
              </div>
</div>

            {/* Advanced / Data Management — collapsed by default */}
            <div className="rounded-xl border border-border/40 overflow-hidden">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/30"
              >
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-3.5 w-3.5 text-warning shrink-0" />
                  <span className="home-mono text-xs font-medium text-muted-foreground">
                    {t('projectHome.sidebar.advanced')}
                  </span>
                  <span className="text-[10px] text-warning/80 italic hidden sm:inline">
                    — {t('projectHome.sidebar.advancedHint')}
                  </span>
                </div>
                <ChevronDown
                  className={`h-4 w-4 text-tertiary transition-transform ${showAdvanced ? '' : '-rotate-90'}`}
                />
              </button>
              {showAdvanced && (
                <div className="space-y-4 border-t border-border/40 p-4">
                  {/* Start fresh (moved here from above) */}
                  <div className="rounded-xl border border-border/60 bg-card p-5">
                    <div className="flex items-center gap-2 mb-3">
                      <RotateCcw className="w-4 h-4 text-tertiary" />
                      <span className="home-mono text-xs font-medium text-muted-foreground">
                        {t('projectHome.sidebar.startFresh')}
                      </span>
                    </div>
                    <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
                      {t('projectHome.sidebar.startFreshDescription')}
                    </p>
                    <BrandButton
                      variant="ghost"
                      className="w-full text-xs text-tertiary hover:text-danger hover:border-danger/50"
                      onClick={() => setShowClearDataDialog(true)}
                      disabled={isClearingLocalData || isLoading}
                    >
                      {isClearingLocalData ? t('projectHome.sidebar.resetting') : t('projectHome.sidebar.resetApp')}
                    </BrandButton>
                  </div>

            {/* Clear cache */}
            <div className="home-reveal home-delay-6 rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <RefreshCw className="w-4 h-4 text-tertiary" />
                <span className="home-mono text-xs font-medium text-muted-foreground">
                  {t('projectHome.sidebar.cache')}
                </span>
              </div>
              <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
                {t('projectHome.sidebar.cacheDescription')}
              </p>
              <BrandButton
                variant="ghost"
                className="w-full text-tertiary hover:text-primary hover:border-primary/50"
                onClick={() => void handleClearCache()}
                disabled={isClearingCache}
              >
                {isClearingCache ? t('projectHome.sidebar.clearing') : t('projectHome.sidebar.clearCache')}
              </BrandButton>
            </div>

            {/* Data backup */}
            <div className="home-reveal home-delay-6 rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Download className="w-4 h-4 text-tertiary" />
                <span className="home-mono text-xs font-medium text-muted-foreground">
                  {t('projectHome.sidebar.backup')}
                </span>
              </div>
              <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
                {t('projectHome.sidebar.backupDescription')}
              </p>
              <div className="flex flex-col gap-2">
                <BrandButton
                  variant="ghost"
                  className="w-full text-tertiary hover:text-primary hover:border-primary/50"
                  onClick={() => setShowExportConfirm(true)}
                  disabled={isExportingDB || isImportingDB}
                >
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  {t('projectHome.sidebar.exportBackup')}
                </BrandButton>
                <BrandButton
                  variant="ghost"
                  className="w-full text-tertiary hover:text-primary hover:border-primary/50"
                  onClick={handleImportBackupSelected}
                  disabled={isExportingDB || isImportingDB}
                >
                  <Upload className="w-3.5 h-3.5 mr-1.5" />
                  {t('projectHome.sidebar.importBackup')}
                </BrandButton>
              </div>
            </div>

            {/* Diagnostics */}
            <div className="home-reveal home-delay-6 rounded-xl border border-border/60 bg-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Stethoscope className="w-4 h-4 text-tertiary" />
                <span className="home-mono text-xs font-medium text-muted-foreground">
                  {t('projectHome.sidebar.diagnostics')}
                </span>
              </div>
              <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
                {t('projectHome.sidebar.diagnosticsDescription')}
              </p>
              <BrandButton
                variant="ghost"
                className="w-full text-tertiary hover:text-primary hover:border-primary/50"
                onClick={() => void handleRunDiagnostics()}
                disabled={diagRunning}
              >
                <Stethoscope className="w-3.5 h-3.5 mr-1.5" />
                {diagRunning
                  ? t('projectHome.dialogs.diagnosticsInProgress')
                  : t('projectHome.sidebar.runDiagnostics')}
              </BrandButton>
            </div>
                </div>
              )}
            </div>
          </aside>

          {/* Right: Activity heatmap + Project list */}
          <section className="order-1 lg:order-2 lg:col-span-8 space-y-6">
            {/* Activity Heatmap */}
            <ActivityHeatmap />
            {/* Search and filter */}
            <div className="home-reveal home-delay-4 flex flex-col sm:flex-row gap-3 mb-6">
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('projectHome.filters.searchPlaceholder')}
                className="home-search-input home-body flex-1 h-10 px-4 rounded-lg text-sm"
              />
              <div className="flex rounded-lg border border-border p-1 bg-muted/30 dark:bg-muted/30">
                {(['all', 'active', 'archived'] as const).map((filter) => (
                  <button
                    key={filter}
                    onClick={() => setStatusFilter(filter)}
                    className={`home-body min-h-[32px] sm:min-h-[24px] px-3 text-xs rounded-md transition-all ${
                      statusFilter === filter
                        ? 'bg-card dark:bg-card text-secondary dark:text-foreground shadow-sm'
                        : 'text-tertiary dark:text-muted hover:text-secondary dark:hover:text-secondary-foreground'
                    }`}
                  >
                    {t(`projectHome.filters.${filter}`)}
                  </button>
                ))}
              </div>
            </div>

            {/* Project timeline */}
            <div className="home-timeline">
              {timeGroupOrder.map((group) => {
                const groupProjects = groupedProjects[group]
                if (groupProjects.length === 0) return null

                return (
                  <div key={group} className="mb-8 last:mb-0">
                    <h2 className="home-reveal home-delay-5 home-body text-xs font-medium text-muted-foreground mb-4 pl-9">
                      {timeGroupLabels[group]}
                    </h2>
                    <div className="divide-y divide-border/50">
                      {groupProjects.map((project, index) => renderProjectItem(project, index))}
                    </div>
                  </div>
                )
              })}

              {/* Empty state */}
              {timeGroupOrder.every((g) => groupedProjects[g].length === 0) && (
                <div className="home-reveal home-delay-5 home-empty-state rounded-xl border border-dashed border-border py-16 text-center">
                  <div className="relative z-10">
                    <p className="home-body text-secondary dark:text-secondary-foreground mb-4">
                      {search ? t('projectHome.empty.noResults') : t('projectHome.empty.noProjects')}
                    </p>
                    {!search && projects.length === 0 && (
                      <BrandButton
                        variant="primary"
                        onClick={openCreateDialog}
                      >
                        <Plus className="w-4 h-4 mr-2" />
                        {t('projectHome.empty.createFirst')}
                      </BrandButton>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      {/* Compliance footer — /projects only (not the editor workspace) */}
      <SiteFooter />

      {/* Dialogs */}
      <BrandDialog
        open={!!renamingProjectId}
        onOpenChange={(open) => {
          if (!open && !isActionSubmitting) {
            setRenamingProjectId(null)
          }
        }}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('projectHome.dialogs.renameProject')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <BrandInput
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              placeholder={t('projectHome.dialogs.renamePlaceholder')}
              disabled={isActionSubmitting}
            />
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              onClick={() => setRenamingProjectId(null)}
              disabled={isActionSubmitting}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              onClick={() => void handleRenameConfirm()}
              disabled={isActionSubmitting || !renameDraft.trim()}
            >
              {isActionSubmitting ? t('common.processing') : t('common.save')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      <BrandDialog
        open={!!archivingProject}
        onOpenChange={(open) => {
          if (!open && !isActionSubmitting) {
            setArchivingProject(null)
          }
        }}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('projectHome.dialogs.archiveProject')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <p className="home-body text-sm text-secondary dark:text-secondary-foreground">
              {t('projectHome.dialogs.archiveConfirm', { name: archivingProject?.name || '' })}
            </p>
            <label className="mt-3 flex cursor-pointer items-center gap-2 text-sm text-secondary dark:text-secondary-foreground">
              <BrandCheckbox
                checked={archiveDontAskAgain}
                onCheckedChange={(checked) => setArchiveDontAskAgain(Boolean(checked))}
                disabled={isActionSubmitting}
              />
              <span>{t('projectHome.dialogs.dontAskAgain')}</span>
            </label>
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              onClick={() => setArchivingProject(null)}
              disabled={isActionSubmitting}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton onClick={() => void handleArchiveConfirm()} disabled={isActionSubmitting}>
              {isActionSubmitting ? t('common.processing') : t('projectHome.dialogs.archiveProject')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      <BrandDialog
        modal
        open={!!deletingProject}
        onOpenChange={(open) => {
          if (!open && !isActionSubmitting) {
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
            <p className="home-body text-sm text-secondary dark:text-secondary-foreground">
              {t('projectHome.dialogs.deleteConfirm', { name: deletingProject?.name || '' })}
            </p>
            <p className="home-mono mt-3 text-xs text-tertiary dark:text-muted">{t('projectHome.dialogs.deleteConfirmHint')}</p>
            <BrandInput
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder={deletingProject?.name || ''}
              disabled={isActionSubmitting}
              className="mt-2"
            />
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              onClick={() => setDeletingProject(null)}
              disabled={isActionSubmitting}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              variant="danger"
              onClick={() => void handleDeleteConfirm()}
              disabled={
                isActionSubmitting ||
                !deletingProject ||
                deleteConfirmText !== deletingProject.name
              }
            >
              {isActionSubmitting ? t('common.processing') : t('projectHome.dialogs.deleteProject')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Create project dialog */}
      <BrandDialog
        modal
        open={showCreateDialog}
        onOpenChange={(open) => {
          if (!open && !isCreating) {
            setShowCreateDialog(false)
            setCreateDialogName('')
          }
        }}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('projectHome.dialogs.createProject')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
              {t('projectHome.dialogs.createProjectDescription')}
            </p>
            <BrandInput
              ref={createInputRef}
              value={createDialogName}
              onChange={(e) => setCreateDialogName(e.target.value)}
              placeholder={t('projectHome.dialogs.projectNamePlaceholder')}
              onCompositionStart={() => setIsComposition(true)}
              onCompositionEnd={() => setIsComposition(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isComposition && createDialogName.trim()) {
                  void handleCreateFromDialog()
                }
              }}
              disabled={isCreating}
            />
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              onClick={() => {
                setShowCreateDialog(false)
                setCreateDialogName('')
              }}
              disabled={isCreating}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              onClick={() => void handleCreateFromDialog()}
              disabled={isCreating || !createDialogName.trim()}
            >
              {isCreating ? t('projectHome.dialogs.creating') : t('projectHome.dialogs.createButton')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Reset app dialog */}
      <BrandDialog
        modal
        open={showClearDataDialog}
        onOpenChange={(open) => {
          if (!open && !isClearingLocalData) {
            setShowClearDataDialog(false)
            setClearDataConfirmText('')
          }
        }}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('projectHome.dialogs.startFreshTitle')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
              {t('projectHome.dialogs.startFreshDescription')}
            </p>
            <ul className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4 space-y-2 pl-4">
              <li>• {t('projectHome.dialogs.startFreshItems.projects')}</li>
              <li>• {t('projectHome.dialogs.startFreshItems.conversations')}</li>
              <li>• {t('projectHome.dialogs.startFreshItems.files')}</li>
            </ul>
            <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
              {t('projectHome.dialogs.startFreshNote')}
            </p>
            <p className="home-mono text-xs text-tertiary dark:text-muted mb-2">
              {t('projectHome.dialogs.startFreshConfirmHint')}
            </p>
            <BrandInput
              value={clearDataConfirmText}
              onChange={(e) => setClearDataConfirmText(e.target.value)}
              placeholder={t('projectHome.dialogs.startFreshConfirmPlaceholder')}
              disabled={isClearingLocalData}
              className="mt-1"
            />
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              onClick={() => {
                setShowClearDataDialog(false)
                setClearDataConfirmText('')
              }}
              disabled={isClearingLocalData}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              variant="danger"
              onClick={() => void handleClearDataConfirm()}
              disabled={isClearingLocalData || clearDataConfirmText !== t('projectHome.dialogs.startFreshConfirmPlaceholder')}
            >
              {isClearingLocalData ? t('projectHome.dialogs.resetting') : t('projectHome.dialogs.confirmReset')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Export backup confirmation — the archive carries credentials */}
      <BrandDialog
        modal
        open={showExportConfirm}
        onOpenChange={(open) => {
          if (!open && !isExportingDB) setShowExportConfirm(false)
        }}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('projectHome.dialogs.exportBackupTitle')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 mb-4">
              <Shield className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="home-body text-sm text-secondary dark:text-secondary-foreground">
                {t('projectHome.dialogs.exportBackupSensitive')}
              </p>
            </div>
            <p className="home-body text-sm text-secondary dark:text-secondary-foreground">
              {t('projectHome.dialogs.exportBackupHint')}
            </p>
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              onClick={() => setShowExportConfirm(false)}
              disabled={isExportingDB}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              onClick={() => void performExportBackup()}
              disabled={isExportingDB}
            >
              <Download className="w-3.5 h-3.5 mr-1.5" />
              {isExportingDB
                ? t('projectHome.sidebar.backingUp')
                : t('projectHome.dialogs.exportBackupConfirm')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Import backup: hidden file picker + confirmation dialog */}
      <input
        ref={importInputRef}
        type="file"
        accept=".zip"
        className="hidden"
        onChange={handleImportFileChange}
      />

      <BrandDialog
        modal
        open={importBackupFile !== null}
        onOpenChange={(open) => {
          if (!open && !isImportingDB) setImportBackupFile(null)
        }}
      >
        <BrandDialogContent className="max-w-md">
          <BrandDialogHeader>
            <BrandDialogTitle>{t('projectHome.dialogs.importBackupTitle')}</BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 mb-4">
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="home-body text-sm text-secondary dark:text-secondary-foreground">
                {t('projectHome.dialogs.importBackupWarning')}
              </p>
            </div>
            <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
              {t('projectHome.dialogs.importBackupFile', { name: importBackupFile?.name ?? '' })}
            </p>
            <p className="home-body text-sm text-secondary dark:text-secondary-foreground mb-4">
              {t('projectHome.dialogs.importBackupHint')}
            </p>
            <p className="home-mono text-xs text-tertiary dark:text-muted">
              {t('projectHome.dialogs.importBackupSecurityNote')}
            </p>
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              onClick={() => setImportBackupFile(null)}
              disabled={isImportingDB}
            >
              {t('common.cancel')}
            </BrandButton>
            <BrandButton
              variant="danger"
              onClick={() => void handleImportBackupConfirm()}
              disabled={isImportingDB}
            >
              {isImportingDB
                ? t('projectHome.sidebar.restoringBackup')
                : t('projectHome.dialogs.importBackupConfirm')}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Diagnostics dialog */}
      <BrandDialog open={diagOpen} onOpenChange={setDiagOpen}>
        <BrandDialogContent className="max-w-2xl">
          <BrandDialogHeader>
            <BrandDialogTitle>
              {t('projectHome.dialogs.diagnosticsTitle')}
            </BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            {diagRunning ? (
              <div className="flex items-center justify-center py-12">
                <RefreshCw className="w-5 h-5 animate-spin text-tertiary mr-2" />
                <span className="text-sm text-secondary dark:text-secondary-foreground">
                  {t('projectHome.dialogs.diagnosticsRunning')}
                </span>
              </div>
            ) : (
              <>
                <pre className="home-mono text-[11px] leading-relaxed text-secondary dark:text-secondary-foreground bg-muted/40 dark:bg-muted/20 border border-border/60 rounded-lg p-3 max-h-[50vh] overflow-auto whitespace-pre-wrap break-words">
                  {diagReport}
                </pre>
                <p className="home-body text-xs text-tertiary dark:text-muted mt-3">
                  {t('projectHome.dialogs.diagnosticsHint')}
                </p>
              </>
            )}
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton
              variant="ghost"
              onClick={() => setDiagOpen(false)}
              disabled={diagRunning}
            >
              {t('common.close')}
            </BrandButton>
            <BrandButton
              variant="primary"
              onClick={() => void handleCopyReport()}
              disabled={diagRunning || !diagReport}
            >
              {diagCopied ? (
                <>
                  <Check className="w-3.5 h-3.5 mr-1.5" />
                  {t('projectHome.dialogs.copied')}
                </>
              ) : (
                <>
                  <Copy className="w-3.5 h-3.5 mr-1.5" />
                  {t('projectHome.dialogs.copyReport')}
                </>
              )}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>
    </div>
  )
}
