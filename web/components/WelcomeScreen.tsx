/**
 * WelcomeScreen - setup onboarding with local folder mount
 *
 * State machine: welcome → api-key → select-model → mount-folder → ready
 * - welcome: shown only to first-time users (no project created + not seen)
 * - api-key: shown when no API key configured
 * - select-model: shown when a provider key exists but no default
 *   provider/model is selected yet (onboarding completion requires BOTH)
 * - mount-folder: shown when model ok but no folder mounted
 *   (SKIPPED entirely in side-panel mode — sidebar users almost never
 *    need a mounted local folder)
 * - ready: shows quick-start prompts + rich input
 *
 * Steps are conditional, so use setup labels instead of a linear step count.
 */

import { useState, useCallback, useEffect } from 'react'
import { Send, FolderOpen, Sparkles, KeyRound, ChevronRight, Shield, Loader2, ImageIcon, ArrowRight, Check, Cable, CircleHelp } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useSettingsStore } from '@/store/settings.store'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { useAssetStore } from '@/store/asset.store'
import { useT } from '@/i18n'
import { useI18nStore } from '@/i18n/store'
import { docsPath } from '@/lib/route-paths'
import { AgentRichInput, type AgentRichInputValue, type AgentInfo } from './agent/AgentRichInput'
import type { FileMentionItem } from './agent/FileMentionExtension'
import { useGatewayLogin, isLLMGatewayConfigured } from '@/hooks/useGatewayLogin'
import { useNativeHostPing } from '@/hooks/useNativeHostPing'
import { DeviceCodeFlowDialog } from './agent/DeviceCodeFlowDialog'
import { PageScreenshotCropDialog } from './agent/PageScreenshotCropDialog'
import type { SettingsTab } from '@/components/settings/SettingsDialog'
import { supportsImageInput } from '@/agent/llm/pi-ai-model-resolver'
import { isSidePanelMode } from '@/agent/workspace-assistant-context'
import { captureTab, isPageActionAvailable } from '@/agent/tools/page-action-bridge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@creatorweave/ui'

type OnboardingStep = 'welcome' | 'api-key' | 'select-model' | 'mount-folder' | 'ready'

// Side-panel (browser sidebar) mode skips the folder-mount step: that
// workflow is for the full workbench, not the per-tab assistant panel.
function needsFolderMount(folderCount: number): boolean {
  return !isSidePanelMode() && folderCount === 0
}

/** "Connected" for onboarding purposes = provider key saved AND a default
 *  provider/model selected. Keys alone don't make the app usable. */
type ProviderReadiness = {
  hasApiKey: boolean
  hasUsableModel: boolean
}

function providerStep(readiness: ProviderReadiness): OnboardingStep {
  if (!readiness.hasApiKey) return 'api-key'
  if (!readiness.hasUsableModel) return 'select-model'
  return 'ready'
}

function getInitialStep(
  readiness: ProviderReadiness,
  folderCount: number,
  hasCreatedProject: boolean
): OnboardingStep {
  const welcomeSeen = typeof window !== 'undefined'
    && localStorage.getItem('creatorweave:onboarding:welcome-seen') === 'true'

  if (!hasCreatedProject && !welcomeSeen) return 'welcome'
  const provider = providerStep(readiness)
  if (provider !== 'ready') return provider
  if (needsFolderMount(folderCount)) return 'mount-folder'
  return 'ready'
}

interface WelcomeScreenProps {
  onStartConversation: (text: string) => void
  onOpenSettings?: (tab?: SettingsTab) => void
}

/** "?" entry in the top-right corner of a setup card — opens the
 *  model-configuration user guide. Tooltip explains what it does; hover
 *  intent delay keeps it from flashing during normal click-through. */
function SetupGuideLink() {
  const t = useT()
  const router = useRouter()
  const locale = useI18nStore((s) => s.locale)
  const docsLanguage = locale === 'zh-CN' ? 'zh' : 'en'
  return (
    // Own provider: this link renders inside setup-card headers, which sit
    // OUTSIDE the screen-level TooltipProvider (that one only wraps the
    // screenshot button). Radix throws "Tooltip must be used within
    // TooltipProvider" without it.
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => router.push(docsPath(docsLanguage, 'user', 'model-setup'))}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-100"
            aria-label={t('welcome.setupGuideTooltip')}
          >
            <CircleHelp className="h-4 w-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={4}>
          <p className="font-medium">{t('welcome.setupGuideLinkTitle')}</p>
          <p className="text-xs opacity-80">{t('welcome.setupGuideLinkDesc')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export function WelcomeScreen({ onStartConversation, onOpenSettings }: WelcomeScreenProps) {
  const [inputValue, setInputValue] = useState('')
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null)
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false)
  const hasApiKey = useSettingsStore((s) => s.hasApiKey)
  const hasApiKeyLoaded = useSettingsStore((s) => s.hasApiKeyLoaded)
  const checkHasApiKey = useSettingsStore((s) => s.checkHasApiKey)
  const providerType = useSettingsStore((s) => s.providerType)
  const modelName = useSettingsStore((s) => s.modelName)
  const folderRoots = useFolderAccessStore((s) => s.roots)
  const addRoot = useFolderAccessStore((s) => s.addRoot)
  const addNativeHostRoot = useFolderAccessStore((s) => s.addNativeHostRoot)
  const [isAddingNativeHost, setIsAddingNativeHost] = useState(false)
  const t = useT()
  // Availability = full-chain ping (page → extension → Rust host), not just
  // "bridge function exists" — hides the entry when the Rust app is not
  // installed (click would fail with a raw Chrome "host not found" error).
  // Re-probes on window focus.
  const nativeHostAvailable = useNativeHostPing() === 'available'
  const gatewayAvailable = isLLMGatewayConfigured()
  const supportsVision = supportsImageInput(modelName)
  const canCaptureScreenshot = supportsVision && isPageActionAvailable()
  const screenshotLabel = !supportsVision
    ? t('agent.vision.unsupported')
    : canCaptureScreenshot
      ? t('agent.vision.capture')
      : t('agent.vision.supported')

  const hasCreatedProject = typeof window !== 'undefined'
    && localStorage.getItem('creatorweave:auto-default-project-created') === '1'

  // Track whether folder-access hydration has completed for the current
  // project. Until then we don't know whether `folderRoots` is genuinely
  // empty (user has no folder mounted) or just hasn't been populated from
  // disk yet — rendering the mount-folder step in the latter case would
  // flash a misleading prompt to users who already have a folder mounted.
  const rootsHydrated = useFolderAccessStore((s) => s.rootsHydrated)

  const readiness: ProviderReadiness = {
    hasApiKey,
    hasUsableModel: !!providerType && !!modelName,
  }

  const [step, setStep] = useState<OnboardingStep>(() =>
    getInitialStep(readiness, folderRoots.length, hasCreatedProject)
  )

  useEffect(() => {
    void checkHasApiKey().catch((err) => {
      console.error('[WelcomeScreen] checkHasApiKey failed:', err)
    })
  }, [checkHasApiKey])

  const { authState, isRunning: isGatewayLoginRunning, login: gatewayLogin, reset: resetGatewayLogin } = useGatewayLogin()

  // Auto-advance step when API key / model-selection / folder state changes.
  // The provider gate is two-fold: no key → api-key step; key saved but no
  // default provider/model chosen → select-model step (guides the user to
  // pick one instead of silently failing every send later). This does NOT
  // auto-select a model — the user stays in control of their default.
  useEffect(() => {
    if (!hasApiKeyLoaded) return
    setStep((prev) => {
      if (prev === 'welcome') return prev
      const provider = providerStep(readiness)
      if (provider !== 'ready') return provider
      if (needsFolderMount(folderRoots.length)) return 'mount-folder'
      return 'ready'
    })
  }, [readiness.hasApiKey, readiness.hasUsableModel, hasApiKeyLoaded, folderRoots.length])

  const advanceFromWelcome = useCallback(() => {
    localStorage.setItem('creatorweave:onboarding:welcome-seen', 'true')
    const provider = providerStep(readiness)
    if (provider !== 'ready') setStep(provider)
    else if (needsFolderMount(folderRoots.length)) setStep('mount-folder')
    else setStep('ready')
  }, [readiness.hasApiKey, readiness.hasUsableModel, folderRoots.length])

  const advanceFromMount = useCallback(() => {
    setStep('ready')
  }, [])

  const handleSubmit = useCallback(() => {
    const text = inputValue.trim()
    if (!text) return
    onStartConversation(text)
    setInputValue('')
  }, [inputValue, onStartConversation])

  const handleSelectFolder = useCallback(async () => {
    try {
      await addRoot()
    } catch (error) {
      console.error('Failed to open folder:', error)
    }
  }, [addRoot])

  const handleAddNativeHostRoot = useCallback(async () => {
    if (!nativeHostAvailable || isAddingNativeHost) return
    setIsAddingNativeHost(true)
    try {
      await addNativeHostRoot()
    } finally {
      setIsAddingNativeHost(false)
    }
  }, [addNativeHostRoot, isAddingNativeHost, nativeHostAvailable])

  const handleInputChange = useCallback(
    ({ text }: AgentRichInputValue) => {
      setInputValue(text)
    },
    [],
  )

  const handleCaptureScreenshot = useCallback(async () => {
    if (!canCaptureScreenshot || isCapturingScreenshot) return
    setIsCapturingScreenshot(true)
    try {
      const result = await captureTab('png')
      if (!result.ok || !result.dataUrl) {
        throw new Error(result.error || t('agent.pageScreenshot.captureFailed'))
      }
      setScreenshotDataUrl(result.dataUrl)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('agent.pageScreenshot.captureFailed'))
    } finally {
      setIsCapturingScreenshot(false)
    }
  }, [canCaptureScreenshot, isCapturingScreenshot, t])

  const handleScreenshotConfirm = useCallback((file: File) => {
    useAssetStore.getState().addFiles([file])
    setScreenshotDataUrl(null)
  }, [])

  const handleSearchFiles = useCallback(
    async (_query: string): Promise<FileMentionItem[]> => [],
    [],
  )

  // Block rendering any step until BOTH the API-key check AND folder-roots
  // hydration have settled. Without the `rootsHydrated` gate, a user who
  // already has a folder mounted would briefly see the "select a folder"
  // prompt during the cold-start race between loadFromDB and loadRoots.
  // (`hasApiKey` defaults to false, so we also gate on `hasApiKeyLoaded` for
  // the same reason — see settings.store.hasApiKeyLoaded.)
  const isLoading = !hasApiKeyLoaded || !rootsHydrated

  return (
    <main className="flex h-full flex-col items-center justify-center bg-background px-4 dark:bg-neutral-950">
      <div className="w-full max-w-2xl">
        {/* Logo & Tagline */}
        <div className="mb-6 text-center">
          <img
            src="/favicon.svg"
            alt=""
            className="mb-4 inline-block h-12 w-12"
          />
          <h1 className="mb-2 text-3xl font-semibold text-foreground">
            {t('welcome.title')}
          </h1>
          <p className="text-base text-neutral-500 dark:text-neutral-400">{t('welcome.tagline')}</p>
        </div>

        {isLoading ? (
          /* ── Loading state ── */
          <div
            role="status"
            aria-live="polite"
            className="flex h-32 items-center justify-center rounded-xl border border-neutral-200 bg-card px-4 dark:border-neutral-800 dark:bg-neutral-900"
          >
            <Loader2 className="h-4 w-4 animate-spin text-neutral-400 dark:text-neutral-500" />
            <span className="ml-2 text-sm text-neutral-500 dark:text-neutral-400">
              {t('welcome.checkingConfig')}
            </span>
          </div>
        ) : step === 'welcome' ? (
          /* ── Welcome ── */
          <div className="rounded-xl border border-border bg-card p-6 text-center">
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-primary-600">
              {t('welcome.welcomeLabel')}
            </p>
            <h2 className="mb-2 text-xl font-semibold text-foreground">
              {t('welcome.welcomeHeading')}
            </h2>
            <p className="mb-6 text-sm text-neutral-500 dark:text-neutral-400">
              {t('welcome.welcomeSubtitle')}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={advanceFromWelcome}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary-600 px-5 text-sm font-medium text-white transition-colors hover:bg-primary-700"
              >
                {t('welcome.continueButton')}
                <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={advanceFromWelcome}
                className="inline-flex h-10 items-center justify-center rounded-lg border border-border px-5 text-sm font-medium text-secondary transition-colors hover:bg-muted"
              >
                {t('welcome.skipButton')}
              </button>
            </div>
          </div>
        ) : step === 'api-key' ? (
          /* ── AI connection setup ── */
          <div className="overflow-hidden rounded-xl border border-amber-200 bg-amber-50/50 text-left dark:border-amber-800/50 dark:bg-amber-950/10">
            <div className="flex items-center justify-between border-b border-amber-200/60 px-4 py-3 dark:border-amber-800/40">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
                <p className="text-sm font-medium text-amber-900 dark:text-amber-200">
                  {t('welcome.setupCardTitle')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <span className="text-[10px] font-medium uppercase tracking-wider">
                  {t('welcome.apiKeyLabel')}
                </span>
                <SetupGuideLink />
              </div>
            </div>

            {gatewayAvailable && (
              <button
                type="button"
                onClick={async () => {
                  await gatewayLogin()
                }}
                disabled={isGatewayLoginRunning}
                className="flex w-full items-center gap-3 border-b border-amber-200/60 px-4 py-3.5 text-left transition-colors hover:bg-white/60 disabled:opacity-60 dark:border-amber-800/40 dark:hover:bg-neutral-900/40"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary-50 dark:bg-primary-50/40">
                  <Shield className="h-[18px] w-[18px] text-primary-600 dark:text-primary-500" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {t('welcome.setupGatewayTitle')}
                    </span>
                    <span className="rounded-full bg-primary-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                      {t('welcome.setupGatewayRecommend')}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {t('welcome.setupGatewayDesc')}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
              </button>
            )}

            <button
              type="button"
              onClick={() => onOpenSettings?.('llm')}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/60 dark:hover:bg-neutral-900/40"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-neutral-100 dark:bg-neutral-800">
                <KeyRound className="h-[18px] w-[18px] text-neutral-600 dark:text-neutral-400" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">
                  {t('welcome.setupApiKeyTitle')}
                </span>
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('welcome.setupApiKeyDesc')}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
            </button>

            {/* Skip — users who already configured a key and came Back from
                step 3 have no auto-advance; this is their forward exit. */}
            <div className="flex justify-center px-4 pb-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  if (needsFolderMount(folderRoots.length)) setStep('mount-folder')
                  else setStep('ready')
                }}
                className="inline-flex h-8 items-center text-xs text-neutral-500 transition-colors hover:text-foreground"
              >
                {t('welcome.skipButton')}
              </button>
            </div>
          </div>
        ) : step === 'select-model' ? (
          /* ── Default provider/model selection ──
              A provider key exists (api-key step passed), but no default
              provider+model is selected yet — without one every send would
              fail with "model not configured". Guide the user to pick one
              instead of auto-selecting on their behalf. */
          <div className="overflow-hidden rounded-xl border border-primary-200 bg-primary-50/50 text-left dark:border-primary-800/50 dark:bg-primary-950/10">
            <div className="flex items-center justify-between border-b border-primary-200/60 px-4 py-3 dark:border-primary-800/40">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" />
                <p className="text-sm font-medium text-primary-900 dark:text-primary-200">
                  {t('welcome.selectModelCardTitle')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-primary-600 dark:text-primary-400">
                <span className="text-[10px] font-medium uppercase tracking-wider">
                  {t('welcome.apiKeyLabel')}
                </span>
                <SetupGuideLink />
              </div>
            </div>

            <button
              type="button"
              onClick={() => onOpenSettings?.('llm')}
              className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-white/60 dark:hover:bg-neutral-900/40"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white dark:bg-neutral-800">
                <Sparkles className="h-[18px] w-[18px] text-primary-600 dark:text-primary-500" />
              </div>
              <div className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-foreground">
                  {t('welcome.selectModelActionTitle')}
                </span>
                <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                  {t('welcome.selectModelActionDesc')}
                </p>
              </div>
              <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
            </button>

            {/* Skip — picking a default is recommended but not blocking; the
                top-bar switcher stays available for later. */}
            <div className="flex justify-center px-4 pb-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  if (needsFolderMount(folderRoots.length)) setStep('mount-folder')
                  else setStep('ready')
                }}
                className="inline-flex h-8 items-center text-xs text-neutral-500 transition-colors hover:text-foreground"
              >
                {t('welcome.skipButton')}
              </button>
            </div>
          </div>
        ) : step === 'mount-folder' ? (
          /* ── Local folder setup ── */
          <div className="rounded-xl border border-border bg-card p-6 text-center">
            <p className="mb-1 text-xs font-medium uppercase tracking-wider text-primary-600">
              {t('welcome.mountFolderLabel')}
            </p>
            <div className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-primary-50/80 shadow-sm">
              <FolderOpen className="h-6 w-6 text-primary-600" />
            </div>
            <h2 className="mb-2 text-xl font-semibold text-foreground">
              {t('welcome.mountFolderTitle')}
            </h2>
            <p className="mx-auto mb-6 max-w-md text-sm text-neutral-500 dark:text-neutral-400">
              {t('welcome.mountFolderDesc')}
            </p>
            <button
              type="button"
              onClick={() => void handleSelectFolder()}
              data-tour="welcome-open-folder"
              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-5 text-sm font-medium text-white transition-colors hover:bg-primary-700"
            >
              <FolderOpen className="h-4 w-4" />
              {t('welcome.mountFolderButton')}
            </button>
            {nativeHostAvailable && (
              <button
                type="button"
                onClick={() => void handleAddNativeHostRoot()}
                disabled={isAddingNativeHost}
                title={t('folderSelector.localConnectionDescription')}
                className="ml-3 inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-primary-200 bg-white px-5 text-sm font-medium text-primary-700 transition-colors hover:bg-primary-50 disabled:cursor-wait disabled:opacity-70 dark:border-primary-800 dark:bg-card dark:text-primary-300 dark:hover:bg-muted"
              >
                {isAddingNativeHost
                  ? <Loader2 className="h-4 w-4 animate-spin text-primary-600" />
                  : <Cable className="h-4 w-4" />}
                {t('folderSelector.localConnection')}
              </button>
            )}
            {/* Already mounted folders */}
            {folderRoots.length > 0 && (
              <div className="mt-4 space-y-2">
                <p className="text-xs font-medium uppercase tracking-wider text-neutral-400">
                  {t('welcome.mountFolderMounted')}
                </p>
                {folderRoots.map((root) => (
                  <div key={root.id} className="flex items-center justify-center gap-2 text-xs text-secondary">
                    <Check className="h-3 w-3 text-success" />
                    <span className="truncate">{root.name}</span>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={advanceFromMount}
                  className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-lg border border-primary-200 bg-primary-50 px-4 text-sm font-medium text-primary-700 transition-colors hover:bg-primary-100"
                >
                  {t('welcome.continueButton')}
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {/* Skip + Back */}
            <div className="mt-6 flex justify-center gap-4">
              <button
                type="button"
                onClick={() => setStep('api-key')}
                className="inline-flex h-8 items-center text-xs text-neutral-500 transition-colors hover:text-foreground"
              >
                {t('welcome.mountFolderBack')}
              </button>
              <button
                type="button"
                onClick={advanceFromMount}
                className="inline-flex h-8 items-center text-xs text-neutral-500 transition-colors hover:text-foreground"
              >
                {t('welcome.skipButton')}
              </button>
            </div>
          </div>
        ) : (
          /* ── Ready: Active input ── */
          <>
            {/* One-line hint replacing the quick-start buttons */}
            <p className="mb-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
              {t('welcome.readyHint')}
            </p>
            <div className="relative mb-6" data-tour="welcome-input">
              <AgentRichInput
                placeholder={t('welcome.placeholder')}
                ariaLabel={t('conversation.input.ariaLabel')}
                agents={[]}
                onSearchFiles={handleSearchFiles}
                activeAgentId={null}
                allAgents={[]}
                onSetActiveAgent={async () => {}}
                onCreateAgent={async (_id: string): Promise<AgentInfo | null> => null}
                onDeleteAgent={async () => false}
                onChange={handleInputChange}
                onSubmit={handleSubmit}
                leadingAccessory={(
                  <TooltipProvider delayDuration={250}>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex">
                          <button
                            type="button"
                            aria-label={screenshotLabel}
                            disabled={!canCaptureScreenshot || isCapturingScreenshot}
                            onClick={() => void handleCaptureScreenshot()}
                            className={`inline-flex h-8 w-8 items-center justify-center rounded-xl transition-colors disabled:cursor-not-allowed ${
                              supportsVision
                                ? 'bg-primary-50 text-primary-600 dark:bg-primary-50/40 dark:text-primary-700'
                                : 'bg-neutral-50 text-neutral-400 dark:bg-neutral-900 text-neutral-600'
                            }`}
                          >
                            {isCapturingScreenshot
                              ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                              : <ImageIcon className="h-4 w-4" aria-hidden="true" />}
                          </button>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="top" sideOffset={6}>{screenshotLabel}</TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
              />
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!inputValue.trim()}
                className="absolute bottom-4 right-4 z-10 rounded-xl bg-primary-600 p-2 text-white shadow-sm transition-colors hover:bg-primary-700 disabled:opacity-30 disabled:hover:bg-primary-600"
                title={t('welcome.send')}
              >
                <Send className="h-4 w-4" />
              </button>
            </div>
          </>
        )}

        {screenshotDataUrl && (
          <PageScreenshotCropDialog
            imageDataUrl={screenshotDataUrl}
            onConfirm={handleScreenshotConfirm}
            onCancel={() => setScreenshotDataUrl(null)}
          />
        )}

        {/* Local-first privacy hint */}
        {!isLoading && step !== 'welcome' && (
          <p className="mt-7 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
            {t('welcome.setupLocalFirstHint')}
          </p>
        )}

      </div>

      {/* Device Code Flow Dialog */}
      <DeviceCodeFlowDialog
        open={!!authState}
        authState={authState}
        onClose={resetGatewayLogin}
      />
    </main>
  )
}
