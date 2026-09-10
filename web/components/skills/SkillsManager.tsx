/**
 * SkillsManager - Main skills management dialog.
 *
 * Displays skills in simple sections grouped by source (project/user/builtin)
 * with search, filter, and inline action buttons.
 */

import { useState, useMemo, useEffect, useCallback, useRef } from 'react'
import { Plus, FolderOpen, User, Building, X, Inbox, Upload, ChevronDown, ChevronRight } from 'lucide-react'
import {
  BrandDialog,
  BrandDialogContent,
  BrandDialogHeader,
  BrandDialogTitle,
  BrandDialogBody,
  BrandDialogFooter,
  BrandDialogClose,
  BrandButton,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@creatorweave/ui'
import { SkillCard } from './SkillCard'
import { SkillEditor } from './SkillEditor'
import { SkillFileEditor } from './SkillFileEditor'
import { CreateSkillDialog } from './CreateSkillDialog'
import { ProjectSkillDropZone } from './ProjectSkillDropZone'
import { UserSkillDropZone } from './UserSkillDropZone'
import { SkillDiscover } from './SkillDiscover'
import { SkillSearchInput, SkillSegmentFilter, SkillRefreshButton } from './SkillToolbar'
import { useSkillsStore } from '@/store/skills.store'
import type { SkillMetadata } from '@/skills/skill-types'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import { getSkillManager } from '@/skills/skill-manager'
import { useProjectStore } from '@/store/project.store'
import { getAllSecretNames } from '@/security/secret-store'
import { exportSkillAsZip } from '@/skills/skill-export'
import type { SkillFilterOption } from './SkillToolbar'

interface SkillsManagerProps {
  open: boolean
  onClose: () => void
  directoryHandle?: FileSystemDirectoryHandle | null
  roots?: Array<{ name: string; handle: FileSystemDirectoryHandle }>
}

type FilterType = 'all' | 'enabled' | 'disabled'
type EditorMode = 'view' | 'edit' | undefined
type ViewMode = 'manage' | 'discover'

export function SkillsManager({ open, onClose, directoryHandle = null, roots = [] }: SkillsManagerProps) {
  // Select narrow slices from the store to avoid re-rendering the whole
  // component on any unrelated store change. Zustand selectors are referentially
  // stable when their slice is unchanged.
  const skills = useSkillsStore((s) => s.skills)
  const loadSkills = useSkillsStore((s) => s.loadSkills)
  const bumpSkillsScanVersion = useSkillsStore((s) => s.bumpSkillsScanVersion)
  const toggleSkill = useSkillsStore((s) => s.toggleSkill)
  const deleteSkill = useSkillsStore((s) => s.deleteSkill)
  const activeProjectId = useProjectStore((s) => s.activeProjectId || null)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [filterType, setFilterType] = useState<FilterType>('all')
  const [refreshing, setRefreshing] = useState(false)
  const t = useT()

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value)
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(() => setDebouncedQuery(value), 300)
  }, [])

  useEffect(() => {
    return () => { if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current) }
  }, [])

  const [fileEditorOpen, setFileEditorOpen] = useState(false)
  const [formEditorOpen, setFormEditorOpen] = useState(false)
  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<SkillMetadata | undefined>()
  const [editorMode, setEditorMode] = useState<EditorMode>()
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [userImportOpen, setUserImportOpen] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('manage')

  // Collapsed state for each section
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})

  // Load configured secret names so SkillCard can show ✅/❌ status.
  // getAllSecretNames returns the union of project + global scopes.
  const [configuredSecrets, setConfiguredSecrets] = useState<Set<string>>(new Set())
  useEffect(() => {
    if (!open) return
    let cancelled = false
    getAllSecretNames(activeProjectId || undefined)
      .then((names) => {
        if (!cancelled) setConfiguredSecrets(new Set(names))
      })
      .catch(() => {
        // Non-critical — SkillCard just won't show secret status
      })
    return () => { cancelled = true }
  }, [open, activeProjectId])

  // Reload skills every time the dialog opens, not just the first time.
  // Agent (or external code) may have written/deleted skill files in OPFS
  // since the last open — we need to re-scan to reflect those changes.
  // loadSkills() has its own `loading` guard to prevent concurrent runs.
  useEffect(() => {
    if (open) loadSkills()
  }, [open, loadSkills])

  const { projectSkills, userSkills, builtinSkills, totalFiltered } = useMemo(() => {
    let filtered = skills
    if (debouncedQuery) {
      const query = debouncedQuery.toLowerCase()
      filtered = filtered.filter(
        (s) => s.name.toLowerCase().includes(query) || s.description.toLowerCase().includes(query) || s.tags.some((tag) => tag.toLowerCase().includes(query))
      )
    }
    if (filterType === 'enabled') filtered = filtered.filter((s) => s.enabled)
    else if (filterType === 'disabled') filtered = filtered.filter((s) => !s.enabled)
    return {
      projectSkills: filtered.filter((s) => s.source === 'project'),
      userSkills: filtered.filter((s) => s.source === 'user'),
      builtinSkills: filtered.filter((s) => s.source === 'builtin'),
      totalFiltered: filtered.length,
    }
  }, [skills, debouncedQuery, filterType])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      if (directoryHandle) {
        const manager = getSkillManager()
        await manager.scanProject(directoryHandle, activeProjectId)
      }
      await loadSkills()
    } finally { setRefreshing(false) }
  }, [directoryHandle, loadSkills, activeProjectId])

  const handleToggle = useCallback(async (id: string, enabled: boolean) => { await toggleSkill(id, enabled) }, [loadSkills, bumpSkillsScanVersion])
  const handleDeleteConfirm = useCallback(async () => {
    if (deleteTarget) { await deleteSkill(deleteTarget.id); setDeleteTarget(null) }
  }, [deleteSkill, deleteTarget])
  // Determine which editor to use based on skill source.
  // user/builtin → SkillFileEditor (VSCode-style file tree + Monaco)
  // project/import → SkillEditor (form-based, since files are on native FS not OPFS)
  // Plain predicate (no hooks) — the "use" prefix would trip rules-of-hooks.
  const resolveFileEditor = (skill: SkillMetadata) => skill.source === 'user' || skill.source === 'builtin'

  const handleView = useCallback((skill: SkillMetadata) => {
    setEditingSkill(skill); setEditorMode('view')
    if (resolveFileEditor(skill)) setFileEditorOpen(true)
    else setFormEditorOpen(true)
  }, [])
  const handleEdit = useCallback((skill: SkillMetadata) => {
    setEditingSkill(skill); setEditorMode('edit')
    if (resolveFileEditor(skill)) setFileEditorOpen(true)
    else setFormEditorOpen(true)
  }, [])
  const handleCreateNew = useCallback(() => { setCreateDialogOpen(true) }, [])
  // After the CreateSkillDialog generates a skeleton, look up the freshly
  // scanned skill metadata and open the file editor on it — unifying the
  // create and edit experience through the same SkillFileEditor.
  const handleCreated = useCallback((skillId: string) => {
    setCreateDialogOpen(false)
    const created = skills.find((s) => s.id === skillId)
    if (created) {
      setEditingSkill(created)
      setEditorMode('edit')
      setFileEditorOpen(true)
    }
  }, [skills])
  const handleUploadDone = useCallback(() => {
    setUploadOpen(false); bumpSkillsScanVersion(); void loadSkills()
  }, [loadSkills, bumpSkillsScanVersion])
  const handleUserImportDone = useCallback(() => {
    setUserImportOpen(false); bumpSkillsScanVersion(); void loadSkills()
  }, [loadSkills, bumpSkillsScanVersion])
  const handleEditorClose = useCallback(() => { setFileEditorOpen(false); setEditingSkill(undefined); setEditorMode(undefined) }, [])
  const handleFormEditorClose = useCallback(() => { setFormEditorOpen(false); setEditingSkill(undefined); setEditorMode(undefined) }, [])
  const handleExport = useCallback(async (skill: SkillMetadata) => {
    try {
      await exportSkillAsZip(skill.id, skill.name, activeProjectId)
    } catch (e) {
      console.error('[SkillsManager] Export failed:', e)
      alert(t('skillCard.exportFailed') + ': ' + (e instanceof Error ? e.message : String(e)))
    }
  }, [activeProjectId, t])

  const toggleCollapse = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
  }, [])

  const totalCount = skills.length
  const enabledCount = skills.filter((s) => s.enabled).length
  const disabledCount = totalCount - enabledCount

  const filterOptions: SkillFilterOption[] = [
    { value: 'all', label: t('skills.filterAll'), count: totalCount },
    { value: 'enabled', label: t('skills.filterEnabled'), count: enabledCount },
    { value: 'disabled', label: t('skills.filterDisabled'), count: disabledCount },
  ]

  const sections: Array<{
    key: string
    icon: React.ReactNode
    label: string
    skills: SkillMetadata[]
    isReadOnly?: boolean
    onDelete?: (id: string) => void
    onExport?: (skill: SkillMetadata) => void
    action?: { label: string; icon: React.ReactNode; onClick: () => void; primary?: boolean }
    secondaryAction?: { label: string; icon: React.ReactNode; onClick: () => void }
  }> = [
    {
      key: 'project',
      icon: <FolderOpen className="h-4 w-4 text-amber-500 dark:text-amber-400" />,
      label: t('skills.projectSkills'),
      skills: projectSkills,
      isReadOnly: true,
      onDelete: (id) => {
        const skill = skills.find((s) => s.id === id)
        if (skill) setDeleteTarget({ id, name: skill.name })
      },
      onExport: handleExport,
      action: roots.length > 0
        ? { label: t('skills.importSkill'), icon: <Upload className="h-4 w-4" />, onClick: () => setUploadOpen(true) }
        : undefined,
    },
    {
      key: 'user',
      icon: <User className="h-4 w-4 text-blue-500 dark:text-blue-400" />,
      label: t('skills.mySkills'),
      skills: userSkills,
      onDelete: (id) => {
        const skill = skills.find((s) => s.id === id)
        if (skill) setDeleteTarget({ id, name: skill.name })
      },
      onExport: handleExport,
      action: { label: t('skills.createNew'), icon: <Plus className="h-4 w-4" />, onClick: handleCreateNew, primary: true },
      secondaryAction: { label: t('skills.importSkill'), icon: <Upload className="h-4 w-4" />, onClick: () => setUserImportOpen(true) },
    },
    {
      key: 'builtin',
      icon: <Building className="h-4 w-4 text-emerald-500 dark:text-emerald-400" />,
      label: t('skills.builtinSkills'),
      skills: builtinSkills,
      isReadOnly: true,
    },
  ]

  return (
    <>
      <BrandDialog open={open} onOpenChange={onClose}>
        <BrandDialogContent className="flex max-h-[min(700px,85vh)] max-w-2xl flex-col overflow-hidden p-0">
          {/* Header */}
          <BrandDialogHeader className="border-b border-neutral-200 dark:border-neutral-700">
            <div className="flex flex-1 items-center">
              <BrandDialogTitle className="text-lg font-semibold">
                {t('skills.title')}
              </BrandDialogTitle>
            </div>
            <BrandDialogClose className="text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200">
              <X className="h-5 w-5" />
            </BrandDialogClose>
          </BrandDialogHeader>

          {/* Top-level view tabs (own row, border below) */}
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
            <TabsList variant="underline" className="px-6">
              <TabsTrigger variant="underline" value="manage" className="text-sm">
                {t('skills.discover.tabManage')}
              </TabsTrigger>
              <TabsTrigger variant="underline" value="discover" className="text-sm">
                {t('skills.discover.tabDiscover')}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Body content — both views are always mounted and toggled via CSS
              so that SkillDiscover is not remounted on tab switch (which would
              reset its manifest state to null and cause a full-dialog height
              flicker). */}
          {/* Manage view */}
          <div className={cn('flex min-h-0 flex-1 flex-col', viewMode !== 'manage' && 'hidden')}>
              {/* Toolbar — search + filter + refresh */}
              <div className="flex items-center gap-2 px-6 py-3">
                <SkillSearchInput
                  value={searchQuery}
                  onChange={handleSearchChange}
                  placeholder={t('skills.searchPlaceholder')}
                />
                <SkillSegmentFilter
                  value={filterType}
                  onChange={(v) => setFilterType(v as FilterType)}
                  options={filterOptions}
                />
                <SkillRefreshButton
                  onClick={handleRefresh}
                  disabled={refreshing}
                  label={t('common.refresh')}
                />
              </div>

              {/* Skills List */}
              <div className="custom-scrollbar flex-1 overflow-y-auto px-6 pb-5">
                {totalFiltered === 0 && (debouncedQuery || filterType !== 'all') ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-16 text-xs text-neutral-500 dark:text-neutral-500">
                    <Inbox className="h-8 w-8 opacity-40" />
                    <p>{t('skills.noResults')}</p>
                    {debouncedQuery && (
                      <p className="text-xs text-neutral-600 dark:text-neutral-400">&quot;{debouncedQuery}&quot;</p>
                    )}
                  </div>
                ) : (
                  <div className="space-y-6">
                    {sections.map((section) => (
                      <SkillSection
                        key={section.key}
                        icon={section.icon}
                        label={section.label}
                        skills={section.skills}
                        isCollapsed={collapsed[section.key] ?? false}
                        onToggleCollapse={() => toggleCollapse(section.key)}
                        isReadOnly={section.isReadOnly}
                        onToggle={handleToggle}
                        onView={handleView}
                        onEdit={handleEdit}
                        onDelete={section.onDelete}
                        onExport={section.onExport}
                        action={section.action}
                        secondaryAction={section.secondaryAction}
                        configuredSecrets={configuredSecrets}
                        t={t}
                      />
                    ))}
                  </div>
                )}
              </div>
          </div>

          {/* Discover view — always mounted to preserve SkillDiscover state. */}
          <div className={cn('custom-scrollbar flex-1 overflow-y-auto px-6 py-4', viewMode !== 'discover' && 'hidden')}>
              <SkillDiscover
                onInstalled={() => {
                  void loadSkills()
                }}
              />
          </div>

        </BrandDialogContent>
      </BrandDialog>

      {/* Skill File Editor — VSCode-style file tree + Monaco editor.
          Used for user and builtin skills (stored in OPFS .skills/). */}
      {editingSkill && resolveFileEditor(editingSkill) && (
        <SkillFileEditor skill={editingSkill} open={fileEditorOpen} onClose={handleEditorClose} />
      )}

      {/* Create Skill Dialog — collects dir name + name + description,
          then hands off to SkillFileEditor for the unified editing experience. */}
      <CreateSkillDialog
        open={createDialogOpen}
        onClose={() => setCreateDialogOpen(false)}
        onCreated={handleCreated}
      />

      {/* Skill Form Editor — for creating new skills and viewing project/import skills */}
      <SkillEditor skill={editingSkill} open={formEditorOpen} onClose={handleFormEditorClose} readOnly={editorMode === 'view'} />

      {/* Delete Confirmation */}
      <BrandDialog open={deleteTarget !== null} onOpenChange={(isOpen) => { if (!isOpen) setDeleteTarget(null) }}>
        <BrandDialogContent className="max-w-sm">
          <BrandDialogHeader>
            <BrandDialogTitle>
              {t('skills.deleteTitle') || 'Delete Skill'}
            </BrandDialogTitle>
          </BrandDialogHeader>
          <BrandDialogBody>
            <p className="text-sm text-secondary">
              {(t('skills.deleteConfirmMessage') || 'Are you sure you want to delete "{name}"? This action cannot be undone.').replace('{name}', deleteTarget?.name || '')}
            </p>
          </BrandDialogBody>
          <BrandDialogFooter>
            <BrandButton variant="outline" onClick={() => setDeleteTarget(null)}>
              {t('common.cancel') || 'Cancel'}
            </BrandButton>
            <BrandButton variant="danger" onClick={handleDeleteConfirm}>
              {t('skills.deleteConfirm') || 'Delete'}
            </BrandButton>
          </BrandDialogFooter>
        </BrandDialogContent>
      </BrandDialog>

      {/* Upload Dialog */}
      <ImportDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        title={t('skills.importSkill')}
      >
        <ProjectSkillDropZone roots={roots} onUploaded={handleUploadDone} onClose={handleUploadDone} />
      </ImportDialog>

      {/* User Skill Import Dialog — imports a folder into OPFS .skills/user/ */}
      <ImportDialog
        open={userImportOpen}
        onOpenChange={setUserImportOpen}
        title={t('skillUpload.importUserSkill')}
      >
        <UserSkillDropZone onImported={handleUserImportDone} onClose={handleUserImportDone} />
      </ImportDialog>
    </>
  )
}

// ============================================================================
// SkillSection — plain section with header + card list
// ============================================================================

interface SkillSectionAction {
  label: string
  icon: React.ReactNode
  onClick: () => void
  primary?: boolean
}

/** Common wrapper for skill import dialogs (project + user). */
interface ImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  children: React.ReactNode
}

function ImportDialog({ open, onOpenChange, title, children }: ImportDialogProps) {
  return (
    <BrandDialog open={open} onOpenChange={onOpenChange}>
      <BrandDialogContent className="max-w-lg p-0">
        <BrandDialogHeader>
          <BrandDialogTitle className="text-lg font-semibold">{title}</BrandDialogTitle>
          <BrandDialogClose className="text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300">
            <X className="h-5 w-5" />
          </BrandDialogClose>
        </BrandDialogHeader>
        {children}
      </BrandDialogContent>
    </BrandDialog>
  )
}

interface SkillSectionProps {
  icon: React.ReactNode
  label: string
  skills: SkillMetadata[]
  isCollapsed: boolean
  onToggleCollapse: () => void
  isReadOnly?: boolean
  onToggle: (id: string, enabled: boolean) => void
  onView: (skill: SkillMetadata) => void
  onEdit: (skill: SkillMetadata) => void
  onDelete?: (id: string) => void
  onExport?: (skill: SkillMetadata) => void
  action?: SkillSectionAction
  secondaryAction?: SkillSectionAction
  configuredSecrets: Set<string>
  t: (key: string) => string
}

function SkillSection({
  icon, label, skills, isCollapsed, onToggleCollapse,
  isReadOnly, onToggle, onView, onEdit, onDelete, onExport, action, secondaryAction, configuredSecrets, t,
}: SkillSectionProps) {
  return (
    <section>
      {/* Section header: collapse toggle, title + count, action buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-expanded={!isCollapsed}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {icon}
          {label}
          <span className="text-xs font-normal text-neutral-500 dark:text-neutral-500">
            {skills.length}
          </span>
        </button>

        {/* Group action buttons as one right-aligned cluster so a single
            `ml-auto` pushes the whole pair to the right (otherwise two
            `ml-auto`s would split the free space and push the primary
            action to the middle of the row). */}
        {(action || secondaryAction) && (
          <div className="ml-auto flex items-center gap-2">
            {secondaryAction && (
              <button
                type="button"
                onClick={secondaryAction.onClick}
                className="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800"
              >
                {secondaryAction.icon}
                {secondaryAction.label}
              </button>
            )}
            {action && (
              <button
                type="button"
                onClick={action.onClick}
                className={cn(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                  action.primary
                    ? 'text-blue-600 hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/30'
                    : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700 dark:text-neutral-400 dark:hover:bg-neutral-800',
                )}
              >
                {action.icon}
                {action.label}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Card list */}
      {!isCollapsed && (
        <div className="mt-1.5 space-y-1.5">
          {skills.length === 0 ? (
            <div className="flex items-center gap-2 py-3 text-[10px] text-neutral-500 dark:text-neutral-500">
              <Inbox className="h-3.5 w-3.5 opacity-40" />
              <p>{t('skills.empty')}</p>
            </div>
          ) : (
            skills.map((skill) => (
              <SkillCard
                key={skill.id}
                skill={skill}
                isReadOnly={isReadOnly}
                configuredSecrets={configuredSecrets}
                onToggle={onToggle}
                onView={onView}
                onEdit={isReadOnly ? onView : onEdit}
                onDelete={onDelete}
                onExport={onExport}
              />
            ))
          )}
        </div>
      )}
    </section>
  )
}
