'use client'

import { Suspense, useCallback, useState } from 'react'
import dynamic from 'next/dynamic'
import { useSearchParams } from 'next/navigation'
import { FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { selectFolderReadWrite } from '@/services/fsAccess.service'
import { useT } from '@/i18n'

// useSearchParams must sit behind a Suspense boundary in the App Router.
const ToasterHost = dynamic(() => import('@/components/folder-pick/ToasterHost'), {
  ssr: false,
})

const PICK_CHANNEL = 'creatorweave-folder-pick'

/**
 * Dedicated full-tab folder picker: /folder-pick?projectId=...
 *
 * Chromium's showDirectoryPicker is unreliable inside the extension side
 * panel (crbug 40240444 family: it rejects with AbortError even after the
 * user successfully selects a folder — indistinguishable from a cancel).
 * A full tab is the reliable context, so the side panel opens this page,
 * the user picks here, and the handle flows back over IndexedDB +
 * BroadcastChannel; this tab then closes itself.
 */
function FolderPickView() {
  const t = useT()
  const searchParams = useSearchParams()
  const projectId = searchParams.get('projectId')
  const [state, setState] = useState<'idle' | 'picking' | 'failed' | 'done'>('idle')
  const [errorName, setErrorName] = useState<string | null>(null)

  const notifyPanelAndClose = useCallback(
    async (handle: FileSystemDirectoryHandle, name: string) => {
      try {
        // Stash the handle so the panel can adopt it after the broadcast.
        // sessionStorage can't hold FileSystemHandles; IndexedDB can.
        const { folderAccessRepo } = await import('@/services/folder-access.repository')
        if (projectId) {
          await folderAccessRepo.save({
            projectId,
            rootName: name,
            folderName: name,
            handle,
            persistedHandle: handle,
            status: 'ready',
            createdAt: Date.now(),
            updatedAt: Date.now(),
          })
        } else {
          // No project context (root page) — park the handle under a
          // well-known key; the panel adopts it into the active project.
          await folderAccessRepo.saveParkedHandle(handle)
        }
      } catch (error) {
        console.error('[FolderPick] Failed to persist handle:', error)
      }
      try {
        const channel = new BroadcastChannel(PICK_CHANNEL)
        channel.postMessage({ type: 'folder-picked', name })
        channel.close()
      } catch (error) {
        console.error('[FolderPick] Broadcast failed:', error)
      }
      // Give the panel a beat to receive the message before the tab closes.
      setTimeout(() => window.close(), 300)
    },
    [projectId]
  )

  const runPick = useCallback(async () => {
    setState('picking')
    setErrorName(null)
    try {
      const handle = await selectFolderReadWrite()
      if (!handle) {
        // Treated as a cancel — but in this dedicated tab the only reason
        // to be here is to pick, so offer a retry instead of silence.
        setState('failed')
        setErrorName(null)
        return
      }
      setState('done')
      await notifyPanelAndClose(handle, handle.name)
    } catch (error) {
      console.error('[FolderPick] picker failed:', error)
      setErrorName(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
      setState('failed')
    }
  }, [notifyPanelAndClose])

  // No auto-pick on mount: showDirectoryPicker requires a transient user
  // gesture, and the activation from the panel's button click does NOT
  // survive window.open() into this fresh tab (it expires during load).
  // The user clicks here instead — one extra click for a 100%-reliable
  // gesture inside the reliable full-tab context.
  if (state === 'idle') {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <FolderOpen className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-secondary">{t('folderPick.ready')}</p>
        <button
          type="button"
          onClick={() => void runPick()}
          className="flex h-9 items-center gap-2 rounded-md bg-primary-600 px-4 text-sm font-medium text-white transition-colors hover:bg-primary-700"
        >
          <FolderOpen className="h-4 w-4" />
          {t('folderPick.choose')}
        </button>
      </div>
    )
  }

  if (state === 'picking') {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-3 bg-background text-secondary">
        <Loader2 className="h-6 w-6 animate-spin text-primary-600" />
        <p className="text-sm">{t('folderPick.waiting')}</p>
      </div>
    )
  }

  if (state === 'done') {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-2 bg-background text-secondary">
        <p className="text-sm">{t('folderPick.done')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <FolderOpen className="h-8 w-8 text-muted-foreground" />
      <div>
        <p className="text-sm font-medium text-secondary">{t('folderPick.failedTitle')}</p>
        {errorName && <p className="mt-1 text-xs text-muted-foreground">{errorName}</p>}
      </div>
      <button
        type="button"
        onClick={() => void runPick()}
        className="flex h-9 items-center gap-2 rounded-md border border-border bg-white px-4 text-sm text-secondary transition-colors hover:border-primary-100 hover:bg-primary-50 hover:text-primary-600 dark:border-border dark:bg-card dark:hover:border-primary-600 dark:hover:bg-muted"
      >
        <RefreshCw className="h-4 w-4" />
        {t('folderPick.retry')}
      </button>
    </div>
  )
}

/** Standalone folder-pick page: /folder-pick?projectId=... */
export default function FolderPickPage() {
  return (
    <>
      <Suspense fallback={null}>
        <FolderPickView />
      </Suspense>
      <ToasterHost />
    </>
  )
}
