'use client'

import { installBashCommandAPI } from '@/agent/bash-commands/public-api'
import { installAgentAbortRejectionFilter } from '@/lib/agent-abort'

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
// Unified authorization modal (PR-1) — replaces both PageWriteAuthModal and
// ExecAuthModal. They now forward into the shared tool-auth.store queue.
import { ToolAuthModal } from '@/components/agent/ToolAuthModal'
import { DeviceCodeFlowDialog } from '@/components/agent/DeviceCodeFlowDialog'
import { PackageOptInModal } from '@/components/sidepanel/PackageOptInModal'
import type { PackageOptInStatus } from '@/agent/sidepanel-package-prompt'
import { useGatewayReloginStore } from '@/store/gateway-relogin.store'
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
  useEffect(() => { installBashCommandAPI() }, [])
  // Suppress unhandled rejections that carry our own agent-cancelled AbortError
  // reasons (raw "signal is aborted without reason" would hit the dev overlay).
  useEffect(() => { installAgentAbortRejectionFilter() }, [])
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

    let stopProviderSkills: (() => void) | undefined
    import('@/skills/provider-skills').then(({ startProviderSkillSync }) => {
      if (!disposed) stopProviderSkills = startProviderSkillSync()
    })

    let stopProviders: (() => void) | undefined
    import('@/vfs/provider-registry').then(({ startProviderDiscovery }) => {
      if (!disposed) stopProviders = startProviderDiscovery()
    })

    const initial = setTimeout(extensionCheckStatus, 1000)
    const interval = setInterval(extensionCheckStatus, 5000)
    return () => {
      disposed = true
      clearTimeout(initial)
      clearInterval(interval)
      stopProviders?.()
      stopProviderSkills?.()
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
        } else if ((await import('@/store/settings.store')).useSettingsStore.getState().providerType === 'llm-gateway') {
          // The gateway can never register here (region-gated off on global
          // builds, or client id missing). A user carrying a persisted
          // llm-gateway providerType from a CN deployment would otherwise
          // keep checkHasApiKey deferred forever when some OTHER dynamic
          // provider registers successfully (e.g. codex-oauth) — flush so
          // the stale provider resolves to a definitive "no key".
          // NOTE: import inside this branch — the `useSettingsStore` binding
          // in the try block above is block-scoped and not visible here.
          const { useSettingsStore } = await import('@/store/settings.store')
          await useSettingsStore.getState().checkHasApiKey({ flush: true })
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

  // ── OpenRouter model reference auto-refresh ──
  // The bundled openrouter-models.json is a bootstrap fallback that lags
  // upstream (new DeepSeek/Qwen releases missing → wrong context window,
  // no pricing, vision dropped). Once a day, silently pull the live model
  // list in the background; failure is invisible (snapshot keeps serving).
  useEffect(() => {
    void import('@/agent/providers/openrouter-pricing').then(({ maybeRefreshOpenRouterModels }) => {
      maybeRefreshOpenRouterModels()
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

  // ── Side-panel package opt-in prompt (issue #100) ──
  // When the side panel opens on a site hosted by a builtin WebMCP package
  // (jmail.world, douban, …) whose activation is still off, offer a one-time
  // enable (writes the extension-side package config + reloads the upstream
  // page so the tools register). Non-side-panel sessions never even reach
  // the bridge probe (getPendingPackagePrompt returns null without a
  // binding).
  const [packagePrompt, setPackagePrompt] = useState<PackageOptInStatus | null>(null)
  useEffect(() => {
    if (!initialized || !isStorageReady) return
    if (packagePrompt) return
    let cancelled = false
    // Retry bookkeeping (findings: "a slow probe hides the prompt" +
    // "recovery skips the opt-in prompt"): transient probe failures
    // (timeout / bridge error) come back with `retryable: true` and are
    // re-probed with capped backoff. A terminal `null` (no binding yet) is
    // also re-probed a bounded number of times — clean-URL side-panel
    // recovery can restore the binding AFTER the first probe ran, and the
    // re-probe picks the session up then. Terminal outcomes that stay null
    // (no matching package, enabled, dismissed) just burn two cheap extra
    // probes and stop.
    const startedAt = Date.now()
    const MAX_RETRY_MS = 5 * 60 * 1000
    const MAX_NULL_PROBES = 3
    // Late-binding safety net (finding: "Late binding never gets a prompt"):
    // the bounded null probes above stop after MAX_NULL_PROBES, but the
    // bridge (`window.__agentWeb`) or the side-panel binding can appear at
    // ANY time — a slow extension handshake, a clean-URL session recovery.
    // A slow periodic re-probe (60s, unbounded but nearly free: one bridge
    // call a minute while no modal is shown) re-offers the prompt whenever
    // the binding appears, without keeping the aggressive startup backoff
    // alive forever.
    const LATE_PROBE_INTERVAL_MS = 60 * 1000
    let nullProbes = 0
    let lateTimer: ReturnType<typeof setInterval> | undefined
    const attempt = (delayMs: number) => {
      const timer = setTimeout(() => {
        if (cancelled) return
        // eslint-disable-next-line no-console
        console.info('[SidePanelPackagePrompt] probing for pending package opt-in…')
        import('@/agent/sidepanel-package-prompt')
          .then(({ getPendingPackagePrompt }) => getPendingPackagePrompt())
          .then(status => {
            if (cancelled) return
            if (status && 'package' in status && status.package) {
              // eslint-disable-next-line no-console
              console.info('[SidePanelPackagePrompt] showing opt-in modal for', status.package.id)
              setPackagePrompt(status as PackageOptInStatus)
              if (lateTimer) clearInterval(lateTimer)
              return
            }
            if (status && 'retryable' in status && status.retryable) {
              if (Date.now() - startedAt < MAX_RETRY_MS) {
                attempt(Math.min((Date.now() - startedAt) / 4, 8000))
              }
              return
            }
            // null (nothing to offer) — bounded re-probes for late binding
            // recovery; give up after MAX_NULL_PROBES. The slow periodic
            // probe below keeps watching for the binding afterwards.
            nullProbes += 1
            if (nullProbes < MAX_NULL_PROBES) attempt(5000)
          })
          .catch(() => {
            // probe failure must never surface — best-effort by design
          })
      }, delayMs)
      activeTimer = timer
    }
    let activeTimer: ReturnType<typeof setTimeout> | undefined
    // Delay past the project-route navigation so the workspace UI settles
    // first; a consent dialog popping over the loading screen reads as a bug.
    attempt(1200)
    lateTimer = setInterval(() => {
      if (cancelled) return
      import('@/agent/sidepanel-package-prompt')
        .then(({ getPendingPackagePrompt }) => getPendingPackagePrompt())
        .then(status => {
          if (cancelled) return
          if (status && 'package' in status && status.package) {
            // eslint-disable-next-line no-console
            console.info('[SidePanelPackagePrompt] late-bound probe found a prompt for', status.package.id)
            setPackagePrompt(status as PackageOptInStatus)
            if (lateTimer) clearInterval(lateTimer)
          }
        })
        .catch(() => {
          // probe failure must never surface — best-effort by design
        })
    }, LATE_PROBE_INTERVAL_MS)
    return () => {
      cancelled = true
      if (activeTimer) clearTimeout(activeTimer)
      if (lateTimer) clearInterval(lateTimer)
    }
  }, [initialized, isStorageReady, packagePrompt])

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
      <ToolAuthModal />
      {packagePrompt?.package && (
        <PackageOptInModal
          packageInfo={packagePrompt.package}
          legacy={packagePrompt.legacy === true}
          onClose={() => setPackagePrompt(null)}
        />
      )}
      {/* Gateway re-login dialog (issue #75) — driven by the relogin store so
          the credential-expired error card can open it from anywhere (chat
          view, side panel) without prop threading. Mounted at this stable root
          because the error banner is a memoized presentation component. */}
      <GatewayReloginDialogMount />
      {/* PWA install offer — after storage init so it never competes with the
          loading/error gates; dismissal state is owned by pwa/install-prompt. */}
      <PwaInstallCard />
      <Toaster position="bottom-right" />
    </>
  )
}

/**
 * Store-driven DeviceCodeFlowDialog for the gateway re-login flow. The open
 * state covers 'running' (requesting/waiting/polling) and 'error'; 'success'
 * closes immediately — the regenerate fires from the store's success callback.
 */
function GatewayReloginDialogMount() {
  const phase = useGatewayReloginStore((s) => s.phase)
  const authState = useGatewayReloginStore((s) => s.authState)
  const reset = useGatewayReloginStore((s) => s.reset)

  return (
    <DeviceCodeFlowDialog
      open={phase === 'running' || phase === 'error'}
      authState={authState}
      onClose={reset}
    />
  )
}

export default AppBootstrap
