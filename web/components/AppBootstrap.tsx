'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast, Toaster } from 'sonner'
import { UnsupportedBrowser } from '@/components/UnsupportedBrowser'
import { applyServiceWorkerUpdate } from '@/pwa/register-service-worker'
import { StorageLoading } from '@/components/StorageLoading'
import { DatabaseRefreshDialog } from '@/components/DatabaseRefreshDialog'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { useProjectStore } from '@/store/project.store'
import { useOPFSStore } from '@/store/opfs.store'
import { initStorage, setupAutoSave, getRuntimeCapability } from '@/storage'
import { useRouter } from 'next/navigation'
import { useT } from '@/i18n'
import { useExtensionStore } from '@/store/extension.store'
import { ExtensionInstallGuide } from '@/components/extension'
// Side-panel recipe opt-in: when the panel opens on a recipe-hosting site
// (jmail.world archive / JMessage) whose injection switch is still off,
// ask the user once whether to enable it (enables + reloads upstream page).
import { RecipeOptInModal } from '@/components/sidepanel/RecipeOptInModal'
import { getPendingRecipePrompt, RECIPE_REPROBE_INTERVAL_MS, type RecipePromptStatus } from '@/agent/sidepanel-recipe-prompt'
// Unified authorization modal (PR-1) — replaces both PageWriteAuthModal and
// ExecAuthModal. They now forward into the shared tool-auth.store queue.
import { ToolAuthModal } from '@/components/agent/ToolAuthModal'
import { ServiceWorkerBridge } from '@/components/ServiceWorkerBridge'
import { PwaInstallCard } from '@/components/pwa/PwaInstallCard'

/**
 * AppBootstrap — storage-initialization gate + global chrome.
 *
 * Extracted from WorkspaceApp's `App` component (init state machine, loading /
 * error / database-inaccessible gates) plus AppReady's non-route chrome
 * (ServiceWorkerBridge, auth modals, Toaster...). The tree only
 * renders `children` once storage init completed successfully.
 *
 * This component is client-only and must be loaded via next/dynamic with
 * `{ ssr: false }` behind a `mounted` gate (see app/(app)/layout.tsx) — the
 * module graph it pulls in (monaco-editor via WorkspaceLayout etc.) reads
 * `window` at module scope.
 */
export function AppBootstrap({ children }: { children?: React.ReactNode }) {
  const [isRuntimeSupported, setIsRuntimeSupported] = useState(true)
  const [isStorageReady, setIsStorageReady] = useState(false)
  const [loadingProgress, setLoadingProgress] = useState<number | undefined>(undefined)
  const [storageError, setStorageError] = useState<string | null>(null)
  const [canResetDatabase, setCanResetDatabase] = useState(false)
  const [isDatabaseInaccessible, setIsDatabaseInaccessible] = useState(false)
  const [inaccessibleErrorMessage, setInaccessibleErrorMessage] = useState<string | null>(null)
  const t = useT() // i18n hook
  const tRef = useRef(t)
  tRef.current = t

  // Extension status check (runs even before storage is ready)
  const extensionCheckStatus = useExtensionStore((s) => s.checkStatus)
  const extensionGuideOpen = useExtensionStore((s) => s.installGuideOpen)
  const extensionCloseGuide = useExtensionStore((s) => s.closeInstallGuide)

  useEffect(() => {
    let disposed = false
    let stopWebMCPSyncLoop: (() => void) | null = null

    // Install Codex bridge fetch wrapper once at app startup.
    // This wraps globalThis.fetch to intercept chatgpt.com requests
    // and route them through the extension bridge when available.
    import('@/agent/loop/codex-bridge-fetch').then(({ installCodexBridgeFetch }) => {
      installCodexBridgeFetch()
    })

    // Keep WebMCP tab tools in sync for AI calls and settings UI.
    import('@/webmcp').then(({ startWebMCPSyncLoop }) => {
      if (disposed) return
      stopWebMCPSyncLoop = startWebMCPSyncLoop()
    })

    const initial = setTimeout(extensionCheckStatus, 1000)
    const interval = setInterval(extensionCheckStatus, 5000)
    return () => {
      disposed = true
      clearTimeout(initial)
      clearInterval(interval)
      if (stopWebMCPSyncLoop) stopWebMCPSyncLoop()
    }
  }, [extensionCheckStatus])

  const runInitStep = useCallback(async <T,>(
    label: string,
    fn: () => Promise<T>,
    timeoutMs = 15000
  ): Promise<T> => {
    const started = performance.now()
    console.log(`[App Init] ▶ ${label} start`)
    const timeoutId = window.setTimeout(() => {
      const elapsed = Math.round(performance.now() - started)
      console.warn(`[App Init] ⏳ ${label} still running after ${elapsed}ms`)
    }, timeoutMs)
    try {
      const result = await fn()
      const elapsed = Math.round(performance.now() - started)
      console.log(`[App Init] ✅ ${label} done (${elapsed}ms)`)
      return result
    } catch (error) {
      const elapsed = Math.round(performance.now() - started)
      console.error(`[App Init] ❌ ${label} failed (${elapsed}ms):`, error)
      throw error
    } finally {
      window.clearTimeout(timeoutId)
    }
  }, [])

  // StrictMode guard - track if async init has already completed
  const initCompleteRef = useRef(false)

  async function handleResetDatabase() {
    try {
      const { resetSQLiteDB } = await import('@/sqlite')
      await resetSQLiteDB()
    } catch (error) {
      console.error('[App] Failed to reset database:', error)
      toast.error(t('app.resetDatabaseFailed'))
    }
  }

  /**
   * Export the OPFS database file as a download. Runs on the main thread so
   * it works even when the SQLite worker failed to initialize (which is the
   * situation the user is in when they see this button).
   */
  async function handleExportDatabase() {
    try {
      const { downloadSQLiteDBBackup } = await import('@/sqlite')
      const filename = await downloadSQLiteDBBackup()
      toast.success(
        tRef.current('app.exportDatabaseSuccess', { filename })
      )
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error('[App] Failed to export database:', error)
      toast.error(
        tRef.current('app.exportDatabaseFailed', { error: errorMsg })
      )
    }
  }

  useEffect(() => {
    // Skip if already completed (from previous StrictMode render)
    if (initCompleteRef.current) {
      setIsStorageReady(true)
      return
    }

    let mounted = true
    let toastId: string | number | undefined

    async function initializeApp() {
      const capability = getRuntimeCapability()
      if (!mounted) return
      setIsRuntimeSupported(capability.canRunApp)

      if (!capability.canRunApp) return

      // Initialize SQLite storage
      toastId = toast.loading(tRef.current('app.initializing'), { id: 'storage-init' })

      try {
        const result = await initStorage({
          allowFallback: false,
          onProgress: (progress) => {
            console.log('[Storage]', progress.step, progress.details)

            switch (progress.step) {
              case 'init':
                setLoadingProgress(undefined)
                break
              case 'migration':
                if (progress.total > 0) {
                  setLoadingProgress(Math.round((progress.current / progress.total) * 100))
                }
                toast.loading(`${tRef.current('app.migrationInProgress')}: ${progress.details}`, {
                  id: 'storage-init',
                })
                break
              case 'complete':
                setLoadingProgress(100)
                break
              case 'warning':
              case 'error':
                if (progress.step === 'error' && progress.details) {
                  const details = progress.details.toLowerCase()
                  const isCorruption =
                    details.includes('corrupt') ||
                    details.includes('malformed') ||
                    details.includes('cantopen') ||
                    details.includes('database')

                  if (details.includes('database_inaccessible')) {
                    console.error('[App] Database inaccessible - showing refresh dialog')
                    // Keep the first error — it's usually the root cause; later ones may be downstream noise.
                    setInaccessibleErrorMessage((prev) => prev ?? progress.details)
                    setIsDatabaseInaccessible(true)
                    return
                  }

                  if (isCorruption) {
                    setStorageError(progress.details)
                    setCanResetDatabase(true)
                  } else {
                    setStorageError(progress.details)
                  }
                }
                break
            }
          },
        })

        if (result.success) {
          if (result.mode === 'sqlite-memory') {
            toast.warning(tRef.current('app.sessionStorageOnly'), {
              id: 'storage-init',
              duration: 8000,
            })
          } else if (result.mode === 'indexeddb-fallback') {
            toast.warning(tRef.current('app.localStorageMode'), {
              id: 'storage-init',
              duration: 8000,
            })
          } else {
            toast.success(tRef.current('app.initComplete'), { id: 'storage-init' })
          }
        } else {
          const errorMsg = result.error || tRef.current('app.initFailed')

          if (errorMsg.toLowerCase().includes('database_inaccessible')) {
            console.error('[App] Database inaccessible - showing refresh dialog')
            setInaccessibleErrorMessage((prev) => prev ?? errorMsg)
            setIsDatabaseInaccessible(true)
            return
          }

          const isDatabaseError =
            errorMsg.toLowerCase().includes('database') ||
            errorMsg.toLowerCase().includes('sqlite') ||
            errorMsg.toLowerCase().includes('corrupt')

          if (isDatabaseError) {
            setStorageError(errorMsg)
            setCanResetDatabase(true)
          } else {
            setStorageError(errorMsg)
          }

          toast.error(errorMsg, { id: 'storage-init', duration: 10000 })
          console.error('[App] Storage initialization failed:', errorMsg)
          return
        }
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error)
        console.error('[App] Failed to initialize storage:', error)

        if (errorMsg.toLowerCase().includes('database_inaccessible')) {
          console.error('[App] Database inaccessible - showing refresh dialog')
          setInaccessibleErrorMessage((prev) => prev ?? errorMsg)
          setIsDatabaseInaccessible(true)
          return
        }

        const isDatabaseError =
          errorMsg.toLowerCase().includes('database') ||
          errorMsg.toLowerCase().includes('sqlite') ||
          errorMsg.toLowerCase().includes('corrupt') ||
          errorMsg.toLowerCase().includes('migration failed')

        if (isDatabaseError) {
          setStorageError(errorMsg)
          setCanResetDatabase(true)
        } else {
          setStorageError(errorMsg)
        }

        toast.error(t('app.storageInitError') + `: ${errorMsg}`, { id: 'storage-init' })
        return
      }

      setupAutoSave()

      if (!mounted) return

      try {
        await runInitStep('initializeProjects', () => useProjectStore.getState().initialize())
        await runInitStep('initializeWorkspaces', () => useConversationContextStore.getState().initialize())
        await runInitStep('initializeOPFS', () => useOPFSStore.getState().initialize())
      } catch (err) {
        console.error('[App] Failed to initialize projects/workspaces:', err)
      }

      try {
        const { useSettingsStore } = await import('@/store/settings.store')
        await runInitStep('checkHasApiKey', () => useSettingsStore.getState().checkHasApiKey())
      } catch (err) {
        console.error('[App] Failed to check API key:', err)
      }

      // Hydrate snapshot retention watermarks from SQLite's app_settings
      // so cross-device values (or values set another tab) override
      // the localStorage copy. Best-effort — failures fall back to
      // localStorage values / hardcoded defaults.
      try {
        const { hydrateSnapshotWatermarksFromDb } = await import('@/store/settings.store')
        await runInitStep('hydrateSnapshotWatermarksFromDb', () => hydrateSnapshotWatermarksFromDb())
      } catch (err) {
        console.error('[App] Failed to hydrate snapshot watermarks from DB:', err)
      }

      // Register LLM Gateway provider + restore session from saved access_token
      try {
        const { registerLLMGatewayProvider, updateGatewayModels, getLLMGatewayApiKeyProviderKey, getLLMGatewayBaseURL, getLLMGatewayClientId } = await import('@/agent/providers/llm-gateway-provider')
        const { getValidAccessToken } = await import('@/agent/providers/llm-gateway-auth')
        registerLLMGatewayProvider()
        const clientId = getLLMGatewayClientId()
        const baseURL = getLLMGatewayBaseURL()
        if (clientId) {
          const token = await getValidAccessToken(baseURL, clientId)
          if (token) {
            // Persist refreshed access_token back so SQLite stays in sync
            const { saveApiKey } = await import('@/security/api-key-store')
            await saveApiKey(getLLMGatewayApiKeyProviderKey(), token)
            await updateGatewayModels(token)
          }
        }
      } catch (err) {
        console.error('[App] Failed to register LLM Gateway provider:', err)
        // Registration failed (e.g. network error, saved token invalid).
        // Flush the API-key cache so the UI doesn't stay stuck in a stale
        // "has API key" state from a previous session — re-evaluate with
        // flush:true so a missing/failed provider config resolves to "no".
        try {
          const { useSettingsStore } = await import('@/store/settings.store')
          await useSettingsStore.getState().checkHasApiKey({ flush: true })
        } catch (flushErr) {
          console.error('[App] checkHasApiKey flush failed:', flushErr)
        }
      }

      // Restore custom-* providers from persisted settings and re-check the
      // API key. Without this, `getProviderConfig('custom-xxx')` returns
      // null on startup and the user would see a spurious "no API key"
      // setup card for providers they've already configured.
      //
      // NOTE: deliberately NOT using `{ flush: true }` here. We only restored
      // custom-* providers in this step; for extension-managed providers
      // (codex-oauth), the registration happens asynchronously in
      // extension.store.checkStatus() which runs on a 1s timer. Flushing
      // here would force a false "no API key" conclusion for codex users
      // before the extension has had a chance to register, causing the
      // welcome screen to flash the setup card.
      try {
        const { useSettingsStore } = await import('@/store/settings.store')
        useSettingsStore.getState()._restoreDynamicProviders()
        await useSettingsStore.getState().checkHasApiKey()
      } catch (err) {
        console.error('[App] Failed to restore dynamic providers:', err)
      }

      if (mounted) {
        console.log('[App Init] ✅ setting isStorageReady=true')
        initCompleteRef.current = true
        setIsStorageReady(true)
      }
    }

    initializeApp()

    return () => {
      mounted = false
      if (toastId !== undefined) {
        toast.dismiss(toastId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Global error handler for DATABASE_INACCESSIBLE errors
  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      const errorMsg = event.error?.message || event.message || ''
      if (errorMsg.toLowerCase().includes('database_inaccessible')) {
        console.error('[App] Database inaccessible detected in global handler')
        setInaccessibleErrorMessage((prev) => prev ?? errorMsg)
        setIsDatabaseInaccessible(true)
        event.preventDefault()
      }
    }

    const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
      const errorMsg = event.reason?.message || String(event.reason) || ''
      if (errorMsg.toLowerCase().includes('database_inaccessible')) {
        console.error('[App] Database inaccessible detected in promise handler')
        setInaccessibleErrorMessage((prev) => prev ?? errorMsg)
        setIsDatabaseInaccessible(true)
        event.preventDefault()
      }
    }

    window.addEventListener('error', handleError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)

    return () => {
      window.removeEventListener('error', handleError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [])

  // Request persistent storage and restore directory handle on first user interaction
  useEffect(() => {
    console.log('[Storage] Setting up persistent storage listener...')

    const handleFirstInteraction = async (_e: Event) => {
      console.log('[Storage] User interaction detected, requesting persistent storage...')
      let persisted = false

      try {
        if ('storage' in navigator && 'persist' in navigator.storage) {
          persisted = await navigator.storage.persist()
        }
      } catch (err) {
        console.error('[Storage] Error requesting persistent storage:', err)
      }

      console.log('[Storage] Persistent storage result:', persisted ? 'GRANTED ✅' : 'DENIED ❌')

      try {
        const { useFolderAccessStore } = await import('@/store/folder-access.store')
        const folderState = useFolderAccessStore.getState()
        const folderRecord = folderState.getRecord()

        if (folderRecord?.status === 'needs_user_activation' && folderRecord.projectId) {
          console.log('[Storage] Folder needs activation, requesting permission...')
          const granted = await folderState.requestPermission(folderRecord.projectId)
          console.log('[Storage] Handle permission result:', granted ? 'GRANTED ✅' : 'DENIED ❌')

          if (granted) {
            const { useAgentStore } = await import('@/store/agent.store')
            const updatedRecord = folderState.getRecord()
            if (updatedRecord) {
              useAgentStore.setState({
                directoryHandle: updatedRecord.handle,
                directoryName: updatedRecord.folderName,
                pendingHandle: updatedRecord.persistedHandle,
              })
            }
          }
        }
      } catch (err) {
        console.error('[Storage] Error handling folder permission:', err)
      }
    }

    window.addEventListener('click', handleFirstInteraction, { once: true })
    window.addEventListener('keydown', handleFirstInteraction, { once: true })
    window.addEventListener('touchstart', handleFirstInteraction, { once: true })

    return () => {
      window.removeEventListener('click', handleFirstInteraction)
      window.removeEventListener('keydown', handleFirstInteraction)
      window.removeEventListener('touchstart', handleFirstInteraction)
    }
  }, [])

  // Set up offline queue monitoring
  useEffect(() => {
    import('@/store/offline-queue.store').then(({ setupOfflineMonitoring }) => {
      return setupOfflineMonitoring()
    })
  }, [])

  // ── Workspace Assistant: side panel URL params are captured synchronously
  //    at module load by workspace-assistant-context.ts. Page context itself
  //    is pulled fresh on every LLM call via fetchSidePanelContext() in
  //    enhancements.ts — no React-side hook needed. We only handle project
  //    routing here (was in AppReady; lives in the bootstrap so every
  //    storage-gated route gets it, not just `/`).
  const router = useRouter()
  const initialized = useProjectStore((s) => s.initialized)
  useEffect(() => {
    // Project initialization completes before all storage gates finish. Wait
    // until the app can render the target Next.js route, then consume the
    // one-shot side-panel request; this also gives RootPage a deterministic
    // pending marker to defer its ordinary / → /projects redirect.
    if (!initialized || !isStorageReady) return
    void import('@/agent/workspace-assistant-context').then(({ handleWorkspaceAssistantOnReady }) => {
      return handleWorkspaceAssistantOnReady((path: string) => router.replace(path))
    })
  }, [initialized, isStorageReady, router])

  // ── Side-panel recipe opt-in prompt ──
  // When the side panel opens on a recipe-hosting site (jmail.world
  // archive / JMessage) whose injection switch is still off, offer a one-time
  // enable (writes extension consent storage + reloads the upstream page so
  // injection takes effect). Non-side-panel sessions never even reach the
  // bridge probe (getPendingRecipePrompt returns null without a binding).
  const [recipePrompt, setRecipePrompt] = useState<RecipePromptStatus | null>(null)
  const probeRecipePrompt = useCallback(() => {
    console.info('[SidePanelRecipePrompt] probing for pending recipe opt-in…')
    getPendingRecipePrompt()
      .then((status) => {
        if (status) {
          console.info('[SidePanelRecipePrompt] showing opt-in modal for', status.recipe?.id)
          setRecipePrompt(status)
        }
      })
      .catch(() => {
        // probe failure must never surface — best-effort by design
      })
  }, [])
  useEffect(() => {
    if (!initialized || !isStorageReady) return
    if (recipePrompt) return
    let cancelled = false
    // Delay past the project-route navigation so the workspace UI settles
    // first; a consent dialog popping over the loading screen reads as a bug.
    const timer = setTimeout(() => {
      if (cancelled) return
      probeRecipePrompt()
    }, 1200)
    // ── Host-change re-probe ──
    // The upstream tab can navigate to a DIFFERENT hostname after the
    // panel opened (movie.douban.com → search.douban.com: two hosts, two
    // recipes — the open-time probe only saw the first). Re-probe on an
    // interval and when the user focuses the panel; the 1-day dismissal
    // cooldown inside getPendingRecipePrompt bounds any nagging.
    const interval = setInterval(() => {
      if (!cancelled) probeRecipePrompt()
    }, RECIPE_REPROBE_INTERVAL_MS)
    const onFocus = () => probeRecipePrompt()
    window.addEventListener('focus', onFocus)
    return () => {
      cancelled = true
      clearTimeout(timer)
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [initialized, isStorageReady, recipePrompt, probeRecipePrompt])

  // --- Service Worker update prompt (was in AppReady) ---
  const swUpdateToastShownRef = useRef(false)

  const handleSwUpdate = useCallback(() => {
    // Avoid showing duplicate toasts if the event fires multiple times
    if (swUpdateToastShownRef.current) return
    swUpdateToastShownRef.current = true

    toast.info(t('app.updateAvailable'), {
      duration: Infinity,
      action: {
        label: t('app.updateNow'),
        onClick: () => {
          applyServiceWorkerUpdate()
        },
      },
      onDismiss: () => {
        // Allow re-showing if user dismissed and a new check finds update again
        swUpdateToastShownRef.current = false
      },
    })
  }, [t])

  useEffect(() => {
    window.addEventListener('sw-update-available', handleSwUpdate)
    return () => {
      window.removeEventListener('sw-update-available', handleSwUpdate)
    }
  }, [handleSwUpdate])

  if (!isRuntimeSupported) {
    return <UnsupportedBrowser />
  }

  if (isDatabaseInaccessible) {
    return (
      <>
        <DatabaseRefreshDialog
          isOpen={true}
          errorMessage={inaccessibleErrorMessage}
        />
        <Toaster position="bottom-right" />
      </>
    )
  }

  if (!isStorageReady) {
    return (
      <StorageLoading
        progress={loadingProgress}
        error={storageError}
        canReset={canResetDatabase}
        onReset={handleResetDatabase}
        onExport={handleExportDatabase}
      />
    )
  }

  // Storage ready — render the app tree plus global chrome.
  return (
    <>
      {children}
      <ServiceWorkerBridge />
      <DatabaseRefreshDialog isOpen={false} errorMessage={null} />
      <ExtensionInstallGuide
        open={extensionGuideOpen}
        onOpenChange={(open) => { if (!open) extensionCloseGuide() }}
      />
      {recipePrompt?.recipe && (
        <RecipeOptInModal
          recipe={recipePrompt.recipe}
          onClose={() => setRecipePrompt(null)}
        />
      )}
      <ToolAuthModal />
      {/* PWA install offer — after storage init so it never competes with the
          loading/error gates; dismissal state is owned by pwa/install-prompt. */}
      <PwaInstallCard />
      <Toaster position="bottom-right" />
    </>
  )
}

export default AppBootstrap
