/**
 * UserSkillDropZone - Import a skill (folder OR zip) into OPFS `.skills/user/`.
 *
 * This is the "My Skills" counterpart to ProjectSkillDropZone. It supports
 * two import modes:
 * - Drag-and-drop / pick a **folder** (via FileSystemDirectoryHandle)
 * - Drag-and-drop / pick a **.zip file** (unzipped in-memory via fflate)
 *
 * Both paths share the same flow: validate SKILL.md → preview → confirm → write
 * to OPFS `.skills/user/<dirName>/`.
 *
 * Shared helpers (containsSkillMd, readFileTree, FileEntry) live in
 * @/skills/skill-folder-utils.
 */

import { useState, useCallback, useRef } from 'react'
import { Upload, FolderOpen, CheckCircle, AlertCircle, FileText, Folder, FileArchive, AlertTriangle } from 'lucide-react'
import { BrandButton } from '@creatorweave/ui'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n'
import {
  containsSkillMd,
  readFileTree,
  type FileEntry,
} from '@/skills/skill-folder-utils'
import {
  importUserSkillFolder,
  importUserSkillZip,
  previewUserSkillZip,
  userSkillDirExists,
  type ZipSkillPreview,
} from '@/skills/user-skills-scanner'

interface UserSkillDropZoneProps {
  onImported: () => void
  onClose: () => void
}

type UploadStatus = 'idle' | 'dragover' | 'confirm' | 'uploading' | 'success' | 'error'

/** Unified pending-skill state — either a folder handle or a zip preview. */
interface PendingSkill {
  /** Display name for the skill directory (first skill for bundles) */
  dirName: string
  /** Preview file tree (for folder or single-skill zip) */
  fileTree: FileEntry[]
  /** File count */
  fileCount: number
  /** Whether this is a zip import */
  isZip: boolean
  /** Whether this is a multi-skill bundle import */
  isBundle: boolean
  /** Skill entries (for bundle display) */
  bundleSkills?: Array<{ dirName: string; fileCount: number }>
  /** Folder handle (when isZip=false) */
  dirHandle?: FileSystemDirectoryHandle
  /** Zip preview data (when isZip=true) */
  zipPreview?: ZipSkillPreview
}

export function UserSkillDropZone({ onImported, onClose }: UserSkillDropZoneProps) {
  const t = useT()
  const [status, setStatus] = useState<UploadStatus>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const dropRef = useRef<HTMLDivElement>(null)

  // Confirmation preview state (unified for folder + zip)
  const [pending, setPending] = useState<PendingSkill | null>(null)
  const [pendingOverwrite, setPendingOverwrite] = useState(false)

  // Overwrite-sensitive existence check (#185): a storage failure must NOT
  // read as "not installed" — the next import would silently replace an
  // existing skill without the overwrite warning. An unknown state is
  // treated as a possible overwrite so the user is asked.
  const checkOverwrite = async (dirName: string): Promise<boolean> => {
    try {
      return await userSkillDirExists(dirName)
    } catch (err) {
      console.warn('[UserSkillDropZone] existence check failed for', dirName, err)
      return true
    }
  }

  // ── Stage 1a: validate folder & prepare preview ───────────────────────

  async function handleFolder(dirHandle: FileSystemDirectoryHandle) {
    const hasSkillMd = await containsSkillMd(dirHandle)
    if (!hasSkillMd) {
      setStatus('error')
      setErrorMsg(t('skillUpload.noSkillMd') || 'Folder must contain a SKILL.md file')
      return
    }

    const { entries, count } = await readFileTree(dirHandle)
    const overwrite = await checkOverwrite(dirHandle.name)

    setPending({
      dirName: dirHandle.name,
      fileTree: entries,
      fileCount: count,
      isZip: false,
      isBundle: false,
      dirHandle,
    })
    setPendingOverwrite(overwrite)
    setStatus('confirm')
  }

  // ── Stage 1b: validate zip & prepare preview ──────────────────────────

  async function handleZip(zipFile: File) {
    try {
      const preview = await previewUserSkillZip(zipFile)

      if (preview.isBundle && preview.skills) {
        // Bundle mode — multiple skills in one zip
        const skills = preview.skills
        // Check overwrite for each skill
        const overwriteChecks = await Promise.all(
          skills.map((s) => checkOverwrite(s.dirName)),
        )
        const overwrite = overwriteChecks.some(Boolean)

        setPending({
          dirName: `${skills.length} skills`,
          fileTree: [],
          fileCount: skills.reduce((sum, s) => sum + s.fileCount, 0),
          isZip: true,
          isBundle: true,
          bundleSkills: skills.map((s) => ({ dirName: s.dirName, fileCount: s.fileCount })),
          zipPreview: preview,
        })
        setPendingOverwrite(overwrite)
      } else if (preview.skill) {
        // Single skill
        const skill = preview.skill
        const overwrite = await checkOverwrite(skill.dirName)
        setPending({
          dirName: skill.dirName,
          fileTree: skill.entries,
          fileCount: skill.fileCount,
          isZip: true,
          isBundle: false,
          zipPreview: preview,
        })
        setPendingOverwrite(overwrite)
      }

      setStatus('confirm')
    } catch (err) {
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Failed to read ZIP archive')
    }
  }

  // ── Stage 2: confirmed — execute the actual write ─────────────────────

  async function handleConfirmUpload() {
    if (!pending) return

    setStatus('uploading')
    setErrorMsg(null)

    try {
      const count = pending.isZip
        ? await importUserSkillZip(pending.zipPreview!)
        : await importUserSkillFolder(pending.dirHandle!)

      setStatus('success')
      setSuccessMsg(
        pending.isBundle
          ? (t('skillUpload.bundleSuccess') || 'Imported {count} file(s) across {n} skills')
              .replace('{count}', String(count))
              .replace('{n}', String(pending.bundleSkills?.length ?? 0))
          : (t('skillUpload.success') || 'Imported {count} file(s) to .skills/{name}/')
              .replace('{count}', String(count))
              .replace('{name}', pending.dirName),
      )
      setPending(null)
      onImported()
    } catch (err) {
      console.error('[UserSkillDropZone] Import failed:', err)
      setStatus('error')
      setErrorMsg(
        err instanceof Error ? err.message : (t('skillUpload.failed') || 'Import failed'),
      )
    }
  }

  /** Cancel the confirmation and go back to idle */
  function handleCancelConfirm() {
    setPending(null)
    setPendingOverwrite(false)
    setStatus('idle')
  }

  // ── Drag & Drop handlers ──────────────────────────────────────────────

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setStatus('dragover')
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (dropRef.current && !dropRef.current.contains(e.relatedTarget as Node)) {
      setStatus('idle')
    }
  }, [])

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setStatus('idle')

      // ── CRITICAL: collect DataTransfer synchronously ──
      // The DataTransferItemList becomes invalid after the first `await`.
      // We must grab files + handle-promises synchronously, then resolve
      // them asynchronously.
      const items = e.dataTransfer.items
      const files = Array.from(e.dataTransfer.files) // sync snapshot

      // Check if the browser supports FileSystemHandle API (Chrome 86+)
      const supportsDirHandle =
        items.length > 0 && typeof items[0].getAsFileSystemHandle === 'function'

      // If supported, synchronously grab all handle promises before any await
      const handlePromises: Promise<FileSystemHandle | null>[] = []
      if (supportsDirHandle) {
        for (let i = 0; i < items.length; i++) {
          const p = items[i].getAsFileSystemHandle?.()
          if (p) handlePromises.push(p)
        }
      }

      // First pass: check for directory handles
      if (supportsDirHandle) {
        for (const promise of handlePromises) {
          const handle = await promise
          if (handle?.kind === 'directory') {
            await handleFolder(handle as FileSystemDirectoryHandle)
            return
          }
        }
      }

      // Second pass: check for .zip files (collected synchronously above)
      if (files.length > 0) {
        const zipFile = files.find((f) => f.name.toLowerCase().endsWith('.zip'))
        if (zipFile) {
          await handleZip(zipFile)
          return
        }
      }

      // Nothing recognized
      if (items.length > 0 && !supportsDirHandle) {
        setStatus('error')
        setErrorMsg(
          t('skillUpload.browserNotSupported') ||
            'Your browser does not support folder drag-and-drop. Please use the browse button.',
        )
      } else {
        setStatus('error')
        setErrorMsg(
          t('skillUpload.dropFolderOrZipOnly') ||
            'Please drop a skill folder or a .zip file',
        )
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  // ── Picker fallback: supports both folder and file selection ──────────

  const handlePick = useCallback(async () => {
    // Try directory picker first (Chrome 86+). If user cancels, abort silently.
    try {
      const dirHandle = await window.showDirectoryPicker({ mode: 'read' })
      await handleFolder(dirHandle)
      return
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return
      // Directory picker failed (e.g. Firefox) — fall through to file picker
    }

    // Fallback: file picker for .zip
    try {
      const fileHandle = await (window as unknown as {
        showOpenFilePicker?: (opts: {
          types: Array<{ description: string; accept: Record<string, string[]> }>
          multiple: boolean
        }) => Promise<FileSystemFileHandle[]>
      }).showOpenFilePicker!({
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
        multiple: false,
      })
      const file = await fileHandle[0].getFile()
      await handleZip(file)
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return
      console.error('[UserSkillDropZone] Picker error:', err)
      setStatus('error')
      setErrorMsg(err instanceof Error ? err.message : 'Failed to pick file')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── Render helpers ────────────────────────────────────────────────────

  function renderFileTree(entries: FileEntry[], depth = 0): React.ReactNode {
    return entries.map((entry) => (
      <div key={entry.name} style={{ paddingLeft: depth * 16 }}>
        <div className="flex items-center gap-1.5 py-0.5 text-sm">
          {entry.kind === 'directory' ? (
            <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500" />
          ) : (
            <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500" />
          )}
          <span className={cn(
            'truncate',
            entry.name.toLowerCase() === 'skill.md'
              ? 'font-medium text-blue-600 dark:text-blue-400'
              : 'text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400',
          )}>
            {entry.name}
          </span>
        </div>
        {entry.children && renderFileTree(entry.children, depth + 1)}
      </div>
    ))
  }

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 p-6">
      {/* ── Confirmation preview ── */}
      {status === 'confirm' && pending ? (
        <div className="space-y-3">
          {/* Source badge (folder vs zip) */}
          <div className="flex items-center gap-1.5 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            {pending.isZip ? (
              <><FileArchive className="h-3.5 w-3.5" /> ZIP archive</>
            ) : (
              <><Folder className="h-3.5 w-3.5" /> Folder</>
            )}
          </div>

          {/* Target path */}
          {pending.isBundle ? (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-800/50">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
                {t('skillUpload.confirmTarget') || 'Import Target'}
              </p>
              <p className="text-sm text-neutral-800 dark:text-foreground">
                {(t('skillUpload.bundleDetected') || '{count} skills detected — all will be imported to .skills/user/')
                  .replace('{count}', String(pending.bundleSkills?.length ?? 0))}
              </p>
            </div>
          ) : (
            <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 dark:border-neutral-700 dark:bg-neutral-800/50">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
                {t('skillUpload.confirmTarget') || 'Import Target'}
              </p>
              <p className="font-mono text-sm text-neutral-800 dark:text-foreground">
                .skills/user/<span className="font-semibold text-blue-600 dark:text-blue-400">{pending.dirName}</span>/
              </p>
            </div>
          )}

          {/* Overwrite warning */}
          {pendingOverwrite && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/30">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {pending.isBundle
                  ? (t('skillUpload.bundleOverwriteWarning') || 'Some skills already exist and will be replaced.')
                  : (t('skillUpload.overwriteWarning') || 'A skill named "{name}" already exists. It will be replaced.')
                    .replace('{name}', pending.dirName)}
              </p>
            </div>
          )}

          {/* File tree preview (single) / skill list (bundle) */}
          {pending.isBundle ? (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-700">
              <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
                <FolderOpen className="h-4 w-4 text-neutral-500" />
                <span className="text-sm font-medium text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300">
                  {pending.bundleSkills?.length ?? 0} {t('skillUpload.skillsLabel') || 'skills'}
                </span>
                <span className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
                  ({pending.fileCount} {t('skillUpload.files') || 'files'})
                </span>
              </div>
              <div className="max-h-40 space-y-1 overflow-y-auto p-3">
                {pending.bundleSkills?.map((s) => (
                  <div key={s.dirName} className="flex items-center gap-1.5 py-0.5 text-sm">
                    <Folder className="h-3.5 w-3.5 shrink-0 text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500" />
                    <span className="font-mono text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300">{s.dirName}</span>
                    <span className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">({s.fileCount})</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-700">
              <div className="flex items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-700">
                <FolderOpen className="h-4 w-4 text-neutral-500" />
                <span className="text-sm font-medium text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300">
                  {pending.dirName}
                </span>
                <span className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
                  ({pending.fileCount} {t('skillUpload.files') || 'files'})
                </span>
              </div>
              <div className="max-h-40 overflow-y-auto p-3">
                {renderFileTree(pending.fileTree)}
              </div>
            </div>
          )}
        </div>
      ) : status === 'uploading' ? (
        /* ── Uploading spinner ── */
        <div
          className={cn(
            'flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed',
            'border-blue-300 bg-blue-50/50 dark:border-blue-400 dark:bg-blue-950/20',
          )}
        >
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-neutral-300 border-t-blue-500" />
          <p className="text-sm text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
            {t('skillUpload.uploading') || 'Importing...'}
          </p>
        </div>
      ) : status === 'success' ? (
        /* ── Success ── */
        <div
          className={cn(
            'flex min-h-[180px] flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed',
            'border-green-500 bg-green-50/50 dark:border-green-400 dark:bg-green-950/20',
          )}
        >
          <CheckCircle className="h-8 w-8 text-green-500" />
          <p className="text-sm font-medium text-green-700 dark:text-green-300">
            {successMsg}
          </p>
        </div>
      ) : status === 'error' ? (
        /* ── Error ── */
        <div
          ref={dropRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handlePick}
          className={cn(
            'flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed',
            'border-red-500 bg-red-50/50 dark:border-red-400 dark:bg-red-950/20',
          )}
        >
          <AlertCircle className="h-8 w-8 text-red-500" />
          <p className="text-sm text-red-600 dark:text-red-400">{errorMsg}</p>
          <p className="text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
            {t('skillUpload.retryHint') || 'Click to try again'}
          </p>
        </div>
      ) : (
        /* ── Idle / dragover drop zone ── */
        <div
          ref={dropRef}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={handlePick}
          className={cn(
            'flex min-h-[180px] cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed transition-colors',
            status === 'dragover'
              ? 'border-blue-500 bg-blue-50/50 dark:border-blue-400 dark:bg-blue-950/20'
              : 'border-neutral-300 bg-neutral-50/50 hover:border-neutral-400 dark:border-neutral-700 dark:bg-neutral-900/50 dark:hover:border-neutral-500',
          )}
        >
          <Upload
            className={cn(
              'h-8 w-8 transition-colors',
              status === 'dragover'
                ? 'text-blue-500'
                : 'text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500',
            )}
          />
          <div className="text-center">
            <p className="text-sm font-medium text-neutral-700 text-neutral-300 text-neutral-300 dark:text-neutral-300">
              {status === 'dragover'
                ? (t('skillUpload.dropHere') || 'Drop skill folder or .zip here')
                : (t('skillUpload.dropOrClick') || 'Drop a skill folder or .zip here, or click to browse')}
            </p>
            <p className="mt-1 text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">
              {t('skillUpload.requirement') || 'Must contain a SKILL.md file'}
            </p>
          </div>
        </div>
      )}

      {/* ── Action buttons ── */}
      {status === 'confirm' ? (
        <div className="flex items-center justify-between">
          <BrandButton variant="outline" onClick={handleCancelConfirm}>
            {t('common.cancel') || 'Cancel'}
          </BrandButton>
          <BrandButton onClick={handleConfirmUpload}>
            <Upload className="mr-1.5 h-4 w-4" />
            {pendingOverwrite
              ? (t('skillUpload.confirmOverwrite') || 'Replace & Import')
              : (t('skillUpload.confirmUpload') || 'Import')}
          </BrandButton>
        </div>
      ) : status === 'success' ? (
        <div className="flex justify-end">
          <BrandButton onClick={onClose}>
            {t('common.close') || 'Close'}
          </BrandButton>
        </div>
      ) : status === 'uploading' ? (
        <div className="flex justify-end">
          <BrandButton variant="outline" disabled>
            {t('skillUpload.uploading') || 'Importing...'}
          </BrandButton>
        </div>
      ) : (
        <div className="flex justify-end">
          <BrandButton variant="outline" onClick={onClose}>
            {t('common.cancel') || 'Cancel'}
          </BrandButton>
        </div>
      )}
    </div>
  )
}
