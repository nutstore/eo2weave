'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, HardDrive, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  BrandButton,
  BrandDialog,
  BrandDialogBody,
  BrandDialogContent,
  BrandDialogFooter,
  BrandDialogHeader,
  BrandDialogTitle,
  BrandInput,
} from '@creatorweave/ui'
import { useT } from '@/i18n'
import { useFolderAccessStore } from '@/store/folder-access.store'
import type { NativeHostPickedRoot } from '@/types/folder-access'
import { getRuntimeCapability } from '@/storage/runtime-capability'
import { isNativeHostAvailable } from '@/opfs/native-disk/executor'

export interface CreateProjectDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * Create the project silently (no navigation). Returns the new project id
   * so the dialog can bind folder handles to it.
   */
  onCreate: (name: string) => Promise<string | null>
  /**
   * Called after a successful create + folder binding. Parent should navigate
   * the user to the new project's workspace.
   */
  onProjectCreated: (projectId: string) => void
}

/** Folders picked via the File System Access API (in-memory, bind at submit). */
interface PickedFsAccess {
  name: string
  handle: FileSystemDirectoryHandle
}

/** Native-host folders authorized by the OS picker (bound at submit). */
type PickedNativeRoot = NativeHostPickedRoot

/**
 * New project dialog. Optional multi-folder authorization (N:M):
 *
 * - FS Access path: user can pick one or more local folders BEFORE the project
 *   exists; on submit, each handle is bound via folderAccessStore.setHandle.
 * - Native Host path: clicking opens the native OS folder picker (renderer →
 *   extension → Rust) and authorizes the folder on the host. The host-side
 *   scope is project-agnostic, so nothing is bound yet — the picked scope is
 *   only remembered in dialog state and bound to the new project on submit.
 *
 * The project is therefore created exactly once, on submit, after every
 * authorization prompt has been answered. Cancelling the dialog leaves no
 * empty project and no project binding behind (a host-side scope the user
 * authorized without binding is harmless: the next pick of the same folder
 * reuses it, and `removeRoot` reference-counting never sees it).
 *
 * The dialog emits the new project id via `onProjectCreated` once folder
 * binding is done; the parent owns navigation.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
  onCreate,
  onProjectCreated,
}: CreateProjectDialogProps) {
  const t = useT()
  const [name, setName] = useState('')
  const [pickedFs, setPickedFs] = useState<PickedFsAccess[]>([])
  const [pickedNative, setPickedNative] = useState<PickedNativeRoot[]>([])
  const [projectId, setProjectId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [pickingNative, setPickingNative] = useState(false)
  const [composition, setComposition] = useState(false)
  const nameInputRef = useRef<HTMLInputElement>(null)

  const setHandle = useFolderAccessStore((s) => s.setHandle)
  const pickNativeHostRoot = useFolderAccessStore((s) => s.pickNativeHostRoot)
  const bindNativeHostRoot = useFolderAccessStore((s) => s.bindNativeHostRoot)
  const supportsFsAccess = getRuntimeCapability().canPickDirectory
  const supportsNativeHost = isNativeHostAvailable()
  const supportsAnyPicker = supportsFsAccess || supportsNativeHost

  // Reset state when the dialog is reopened.
  useEffect(() => {
    if (open) {
      setName('')
      setPickedFs([])
      setPickedNative([])
      setProjectId(null)
      setSubmitting(false)
      setPickingNative(false)
      const id = window.setTimeout(() => {
        nameInputRef.current?.focus()
      }, 80)
      return () => window.clearTimeout(id)
    }
    return undefined
  }, [open])

  /** Lazily create the project (no navigation) the first time we need it. */
  const ensureProject = useCallback(async (): Promise<string | null> => {
    if (projectId) return projectId
    const fallbackName = name.trim() || t('projectHome.defaultProjectName')
    const id = await onCreate(fallbackName)
    if (id) setProjectId(id)
    return id
  }, [projectId, name, onCreate, t])

  const handlePickFsAccess = useCallback(async () => {
    if (typeof window === 'undefined' || !window.showDirectoryPicker) return
    try {
      const handle = await window.showDirectoryPicker({ mode: 'read' })
      const folderName = handle.name
      setPickedFs((current) => {
        if (current.some((entry) => entry.name === folderName)) {
          toast.info(t('projectHome.dialogs.folderAlreadyAdded', { name: folderName }))
          return current
        }
        return [...current, { name: folderName, handle }]
      })
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') return
      console.error('[CreateProjectDialog] Folder pick failed:', error)
      toast.error(t('projectHome.dialogs.pickFailed'))
    }
  }, [t])

  const handlePickNativeHost = useCallback(async () => {
    if (submitting || pickingNative) return
    // Authorize first, bind later: the OS picker must run BEFORE the project
    // exists so a cancelled authorization never leaves a stray empty project
    // behind (the reported bug: project created, then the prompt appeared).
    setPickingNative(true)
    try {
      const picked = await pickNativeHostRoot()
      if (!picked) return
      if (pickedNative.some((entry) => entry.displayName === picked.displayName)) {
        toast.info(
          t('projectHome.dialogs.folderAlreadyAdded', { name: picked.displayName }),
        )
        return
      }
      setPickedNative((current) => [...current, picked])
    } finally {
      setPickingNative(false)
    }
  }, [submitting, pickingNative, pickedNative, pickNativeHostRoot, t])

  const handleRemoveFsFolder = useCallback((target: string) => {
    setPickedFs((current) => current.filter((entry) => entry.name !== target))
  }, [])

  const handleRemoveNativeFolder = useCallback((target: string) => {
    setPickedNative((current) => current.filter((entry) => entry.displayName !== target))
  }, [])

  const handleClose = useCallback(() => {
    if (submitting) return
    onOpenChange(false)
  }, [submitting, onOpenChange])

  const handleSubmit = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed || submitting) return
    setSubmitting(true)
    try {
      const pid = await ensureProject()
      if (!pid) {
        // Parent rejected creation — leave dialog open so the user can retry.
        setSubmitting(false)
        return
      }
      // Bind FS Access handles. setHandle is fire-and-persist (IndexedDB +
      // project_roots row).
      for (const entry of pickedFs) {
        try {
          await setHandle(pid, entry.handle)
        } catch (error) {
          console.error(
            `[CreateProjectDialog] Failed to bind folder "${entry.name}":`,
            error,
          )
        }
      }
      // Bind the native-host scopes authorized during this dialog session.
      for (const entry of pickedNative) {
        try {
          await bindNativeHostRoot(pid, entry)
        } catch (error) {
          console.error(
            `[CreateProjectDialog] Failed to bind native-host root "${entry.displayName}":`,
            error,
          )
        }
      }
      onProjectCreated(pid)
      onOpenChange(false)
    } catch (error) {
      console.error('[CreateProjectDialog] Create failed:', error)
      setSubmitting(false)
    }
  }, [name, pickedFs, pickedNative, submitting, ensureProject, setHandle, bindNativeHostRoot, onProjectCreated, onOpenChange])

  const canSubmit = name.trim().length > 0 && !submitting
  const hasPicks = pickedFs.length > 0 || pickedNative.length > 0

  return (
    <BrandDialog
      modal
      open={open}
      onOpenChange={(next) => {
        if (!next && !submitting) onOpenChange(false)
      }}
    >
      <BrandDialogContent className="max-w-lg">
        <BrandDialogHeader>
          <BrandDialogTitle>{t('projectHome.dialogs.createProject')}</BrandDialogTitle>
        </BrandDialogHeader>
        <BrandDialogBody>
          <p className="mb-4 text-sm text-muted-foreground">
            {t('projectHome.dialogs.createProjectDescription')}
          </p>

          <label
            htmlFor="create-project-name"
            className="mb-2 block text-sm font-medium text-secondary"
          >
            {t('projectHome.dialogs.projectNameLabel')}
          </label>
          <BrandInput
            id="create-project-name"
            ref={nameInputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('projectHome.dialogs.projectNamePlaceholder')}
            onCompositionStart={() => setComposition(true)}
            onCompositionEnd={() => setComposition(false)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !composition && canSubmit) {
                event.preventDefault()
                void handleSubmit()
              }
            }}
            disabled={submitting}
            autoComplete="off"
          />

          <div className="mt-5 rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-1.5 flex items-center gap-2">
              <span className="text-sm font-medium text-secondary">
                {t('projectHome.dialogs.folderFieldTitle')}
              </span>
              <span className="inline-flex h-5 items-center rounded bg-emerald-50 px-1.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
                {t('projectHome.dialogs.folderFieldRecommended')}
              </span>
            </div>
            <p className="mb-2 text-xs leading-relaxed text-muted-foreground">
              {t('projectHome.dialogs.folderFieldHint')}
            </p>

            {!supportsAnyPicker ? (
              <p className="rounded-md border border-dashed border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                {t('projectHome.dialogs.folderPickerUnsupported')}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {supportsFsAccess && (
                    <button
                      type="button"
                      onClick={() => void handlePickFsAccess()}
                      disabled={submitting}
                      className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-2 text-sm text-secondary transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-60"
                    >
                      <FolderOpen className="h-4 w-4" />
                      {pickedFs.length > 0
                        ? t('projectHome.dialogs.addAnotherFolder')
                        : t('projectHome.dialogs.chooseLocalFolder')}
                    </button>
                  )}
                  {supportsNativeHost && (
                    <button
                      type="button"
                      onClick={() => void handlePickNativeHost()}
                      disabled={submitting || pickingNative}
                      className="flex items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-2 text-sm text-secondary transition-colors hover:border-primary/40 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-60"
                      title={t('projectHome.dialogs.nativeHostHint')}
                    >
                      <HardDrive className="h-4 w-4" />
                      {t('projectHome.dialogs.nativeHostButton')}
                    </button>
                  )}
                </div>

                {hasPicks && (
                  <ul className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {pickedFs.map((entry) => (
                      <li
                        key={`fs:${entry.name}`}
                        className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-secondary"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                        <button
                          type="button"
                          onClick={() => handleRemoveFsFolder(entry.name)}
                          disabled={submitting}
                          aria-label={t('projectHome.dialogs.removeFolder', {
                            name: entry.name,
                          })}
                          className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-60"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                    {pickedNative.map((entry) => (
                      <li
                        key={`nh:${entry.scopeId}`}
                        className="flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-sm text-secondary"
                      >
                        <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{entry.displayName}</span>
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          {t('projectHome.dialogs.nativeHostBadge')}
                        </span>
                        <button
                          type="button"
                          onClick={() => handleRemoveNativeFolder(entry.displayName)}
                          disabled={submitting}
                          aria-label={t('projectHome.dialogs.removeFolder', {
                            name: entry.displayName,
                          })}
                          className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 disabled:opacity-60"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </div>
        </BrandDialogBody>
        <BrandDialogFooter>
          <BrandButton
            variant="ghost"
            onClick={handleClose}
            disabled={submitting}
          >
            {t('common.cancel')}
          </BrandButton>
          <BrandButton
            variant="primary"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
          >
            {submitting
              ? t('projectHome.dialogs.creating')
              : t('projectHome.dialogs.createButton')}
          </BrandButton>
        </BrandDialogFooter>
      </BrandDialogContent>
    </BrandDialog>
  )
}