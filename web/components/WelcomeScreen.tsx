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
 *    need a mounted local folder; a user who dismissed it via "Skip for
 *    now" also never sees it again — the choice persists in localStorage)
 * - ready: shows the one-line hint above the rich input
 *
 * Steps are conditional, so use setup labels instead of a linear step count.
 *
 * NOTE: the rich input is deliberately mounted on EVERY step except
 * 'welcome' (and while loading). Readiness can flip back and forth while
 * the user edits provider keys in Settings (e.g. clear-then-paste while
 * replacing an API key), and the old ready-only rendering unmounted the
 * editor on each flip — silently discarding the user's unsent text.
 * Drafts additionally persist per project via useInputDraftStore, so
 * even a full WelcomeScreen remount restores the input.
 */

import { useState, useCallback, useEffect } from 'react'
import { FolderOpen, Sparkles, KeyRound, ChevronRight, Shield, Loader2, ImageIcon, ArrowRight, Check, Cable, CircleHelp, Puzzle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useSettingsStore } from '@/store/settings.store'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { useAssetStore } from '@/store/asset.store'
import { useProjectStore } from '@/store/project.store'
import { useInputDraftStore } from '@/store/input-draft.store'
import { useT } from '@/i18n'
import { useI18nStore } from '@/i18n/store'
import { docsPath } from '@/lib/route-paths'
import { AgentRichInput, type AgentRichInputValue, type AgentInfo } from './agent/AgentRichInput'
import type { FileMentionItem } from './agent/FileMentionExtension'
import { useGatewayLogin, isLLMGatewayConfigured } from '@/hooks/useGatewayLogin'
import { ENABLE_LLM_GATEWAY } from '@/lib/deploy-region'
import { useExtensionStore } from '@/store/extension.store'
import { isMobileDeviceForExtension } from '@/lib/extension-distribution'
import { useNativeHostPing } from '@/hooks/useNativeHostPing'
import { DeviceCodeFlowDialog } from './agent/DeviceCodeFlowDialog'
import { PageScreenshotCropDialog } from './agent/PageScreenshotCropDialog'
import type { SettingsTab } from '@/components/settings/SettingsDialog'
import { supportsImageInput } from '@/agent/llm/pi-ai-model-resolver'
import { isSidePanelMode } from '@/agent/workspace-assistant-context'
import { getRuntimeCapability } from '@/storage/runtime-capability'
import { captureTab, isPageActionAvailable } from '@/agent/tools/page-action-bridge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@creatorweave/ui'

type OnboardingStep = 'welcome' | 'api-key' | 'select-model' | 'mount-folder' | 'ready'

// Side-panel (browser sidebar) mode skips the folder-mount step: that
// workflow is for the full workbench, not the per-tab assistant panel.
// Browsers without the directory picker (e.g. mobile) skip it too — the
// step can never succeed there, so showing it would dead-end onboarding.
function needsFolderMount(folderCount: number): boolean {
  if (!getRuntimeCapability().canPickDirectory) return false
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
  const folderMountSkipped = typeof window !== 'undefined'
    && localStorage.getItem('creatorweave:onboarding:folder-mount-skipped') === 'true'
  // "Skip for now" on the AI-setup card persists too — otherwise a refresh
  // recomputes the provider gate and nags the skipped user all over again.
  // The flag is cleared once onboarding completes (readiness turns ready).
  const aiSetupSkipped = typeof window !== 'undefined'
    && localStorage.getItem('creatorweave:onboarding:ai-setup-skipped') === 'true'

  if (!hasCreatedProject && !welcomeSeen) return 'welcome'
  const provider = providerStep(readiness)
  if (provider !== 'ready' && !aiSetupSkipped) return provider
  if (needsFolderMount(folderCount) && !folderMountSkipped) return 'mount-folder'
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

  // ── Draft persistence (survives input remounts) ──
  // The rich input only renders in the 'ready' step, so any transient
  // readiness flip (e.g. clearing an API key while replacing it in
  // Settings) unmounts the editor and used to silently discard the
  // user's unsent text. WelcomeScreen serves a per-project draft
  // conversation (bare project URL), so the project id is the natural
  // draft key — same store the conversation view uses for per-workspace
  // drafts.
  const projectId = useProjectStore((s) => s.activeProjectId)
  // NOTE: `||` (not `??`) — activeProjectId is '' (not null) before the
  // project store hydrates, and '' must fall back to the same transient key
  // the orphan-migration effect below looks for. With `??` the fallback was
  // dead code and pre-hydration drafts landed under '' where nothing could
  // ever migrate them.
  const draftKey = projectId || 'welcome'
  const saveDraft = useCallback((text: string) => {
    useInputDraftStore.getState().saveDraft(draftKey, {
      text,
      mentionedAgentIds: [],
      selectedFiles: [],
    })
  }, [draftKey])

  // "bridge function exists" — hides the entry when the Rust app is not
  // installed (click would fail with a raw Chrome "host not found" error).
  // Re-probes on window focus.
  const nativeHostAvailable = useNativeHostPing() === 'available'
  // International (global) build onboarding: recommend the browser extension
  // (ChatGPT login → GPT models, e.g. GPT-6 Luna) instead of the Nutstore AI
  // gateway, which is CN-only. Clicking the card opens the existing install
  // guide; once the extension registers codex-oauth, the readiness effect
  // auto-advances the flow. Hidden on mobile (extensions can't install) and
  // once the extension is already installed.
  const extensionStatus = useExtensionStore((s) => s.status)
  const showExtensionCard = !ENABLE_LLM_GATEWAY
    && extensionStatus === 'not_installed'
    && !isMobileDeviceForExtension()
  const gatewayAvailable = isLLMGatewayConfigured()
  const supportsVision = supportsImageInput(modelName, providerType || undefined)
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
  // Mirror of the "folder-mount-skipped" localStorage flag, read once per
  // mount alongside the initial step. WelcomeScreen remounts for each new
  // conversation, so per-mount is sufficient to honor the skip. Kept in a
  // setter-pair so skipping this session also skips the rest of the session.
  const [folderMountSkipped, setFolderMountSkipped] = useState(() => typeof window !== 'undefined'
    && localStorage.getItem('creatorweave:onboarding:folder-mount-skipped') === 'true')
  // Same pattern for the AI-setup card's "Skip for now": without the mirror,
  // the auto-advance effect below would yank the user from wherever they went
  // straight back to the api-key/select-model card within this session.
  const [aiSetupSkipped, setAiSetupSkipped] = useState(() => typeof window !== 'undefined'
    && localStorage.getItem('creatorweave:onboarding:ai-setup-skipped') === 'true')

  useEffect(() => {
    void checkHasApiKey().catch((err) => {
      console.error('[WelcomeScreen] checkHasApiKey failed:', err)
    })
  }, [checkHasApiKey])

  const { authState, isRunning: isGatewayLoginRunning, login: gatewayLogin, reset: resetGatewayLogin } = useGatewayLogin()

  // Open the standard extension install guide (store / zip flows). The card
  // itself does not log in — after install + ChatGPT authorization the
  // extension store registers codex-oauth and the readiness effect below
  // auto-advances from this step.
  const handleExtensionSetup = useCallback(() => {
    useExtensionStore.getState().openInstallGuide()
  }, [])

  // Auto-advance step when API key / model-selection / folder state changes.
  // The provider gate is two-fold: no key → api-key step; key saved but no
  // default provider/model chosen → select-model step (guides the user to
  // pick one instead of silently failing every send later). This does NOT
  // auto-select a model — the user stays in control of their default.
  // A persisted AI-setup skip downgrades the provider gate: the user said
  // "not now", so they land on mount-folder/ready instead of the setup card.
  useEffect(() => {
    if (!hasApiKeyLoaded) return
    setStep((prev) => {
      if (prev === 'welcome') return prev
      const provider = providerStep(readiness)
      if (provider !== 'ready' && !aiSetupSkipped) return provider
      if (folderRoots.length > 0 || folderMountSkipped) return 'ready'
      return 'mount-folder'
    })
  }, [readiness.hasApiKey, readiness.hasUsableModel, hasApiKeyLoaded, folderRoots.length, folderMountSkipped, aiSetupSkipped])

  // Onboarding completed (key + default model configured): the AI-setup skip
  // has served its purpose. Clear it so a LATER deliberate unconfigure (user
  // clears their key) correctly re-prompts instead of staying silenced.
  useEffect(() => {
    if (!hasApiKeyLoaded) return
    if (readiness.hasApiKey && readiness.hasUsableModel && aiSetupSkipped) {
      localStorage.removeItem('creatorweave:onboarding:ai-setup-skipped')
      setAiSetupSkipped(false)
    }
  }, [readiness.hasApiKey, readiness.hasUsableModel, hasApiKeyLoaded, aiSetupSkipped])

  const advanceFromWelcome = useCallback(() => {
    localStorage.setItem('creatorweave:onboarding:welcome-seen', 'true')
    const provider = providerStep(readiness)
    if (provider !== 'ready' && !aiSetupSkipped) setStep(provider)
    else if (folderRoots.length > 0 || folderMountSkipped) setStep('ready')
    else setStep('mount-folder')
  }, [readiness.hasApiKey, readiness.hasUsableModel, folderRoots.length, folderMountSkipped, aiSetupSkipped])

  // "Skip for now" on the AI-setup cards (api-key / select-model) persists,
  // mirroring the mount-folder skip: a refresh must not resurrect the card
  // the user just dismissed. The flag self-clears once onboarding completes
  // (see the readiness effect above), so a later deliberate unconfigure
  // re-prompts. Sending is still blocked until ready (see handleSubmit).
  const skipAiSetup = useCallback(() => {
    localStorage.setItem('creatorweave:onboarding:ai-setup-skipped', 'true')
    setAiSetupSkipped(true)
    if (folderRoots.length > 0 || folderMountSkipped) setStep('ready')
    else setStep('mount-folder')
  }, [folderRoots.length, folderMountSkipped])

  // "Skip" on the mount-folder step persists, so new conversations start at
  // ready instead of nagging again. setFolderMountSkipped(true) matters on
  // the very first skip: the state initializer ran before the flag existed,
  // so without it the auto-advance effect would yank the user from ready
  // back to mount-folder in this same session. Mounting later (Sidebar/
  // FolderSelector/exec flow) still works and auto-completes onboarding
  // once a root exists.
  const advanceFromMount = useCallback(() => {
    localStorage.setItem('creatorweave:onboarding:folder-mount-skipped', 'true')
    setFolderMountSkipped(true)
    setStep('ready')
  }, [])

  const handleSubmit = useCallback(() => {
    const text = inputValue.trim()
    if (!text) return
    // The persistent input also renders on setup steps, but those have no
    // working model yet — sending would start a conversation that fails on
    // every turn. Point the user at the setup card instead; the draft store
    // keeps what they typed so nothing is lost.
    if (step !== 'ready') {
      toast.warning(t('welcome.sendBlockedNotReady'))
      if (step === 'api-key' || step === 'select-model') onOpenSettings?.('llm')
      return
    }
    onStartConversation(text)
    setInputValue('')
    // Sent — the draft is consumed. Clear it so it won't be re-injected
    // if the input remounts later in this session.
    useInputDraftStore.getState().clearDraft(draftKey)
  }, [inputValue, onStartConversation, draftKey, step, t, onOpenSettings])

  // Pull the persisted draft into the editor on remount. initialText is
  // only consumed when the editor is EMPTY (AgentRichInput's draft effect),
  // so a user typing faster than the restore lands can't be overwritten.
  // onDraftRestored clears the pending draft so a manual clear sticks.
  const [draftToRestore, setDraftToRestore] = useState<string | null>(null)
  const restoreDraft = useCallback(() => {
    setDraftToRestore(null)
    useInputDraftStore.getState().clearDraft(draftKey)
  }, [draftKey])
  useEffect(() => {
    // A draft saved under the 'welcome' fallback key (typed before the
    // project id was hydrated) would be orphaned once the real key arrives —
    // carry it over so it is still restored. Runs before the peek below
    // (same effect), so the migrated text is picked up in the same pass.
    if (draftKey !== 'welcome') {
      const store = useInputDraftStore.getState()
      const orphaned = store.peekDraft('welcome')
      if (orphaned?.text && !store.peekDraft(draftKey)) {
        store.saveDraft(draftKey, {
          text: orphaned.text,
          mentionedAgentIds: [],
          selectedFiles: [],
        })
      }
      store.clearDraft('welcome')
    }
    const draft = useInputDraftStore.getState().peekDraft(draftKey)
    setDraftToRestore(draft?.text ?? null)
  }, [draftKey])

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
      // Mirror every edit into the draft store. Store drops empty drafts
      // itself, so clearing the input also clears the persisted draft.
      saveDraft(text)
    },
    [saveDraft],
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
            className="mb-6 flex h-32 items-center justify-center rounded-xl border border-border bg-card px-4"
          >
            <Loader2 className="h-4 w-4 animate-spin text-neutral-400 dark:text-neutral-500" />
            <span className="ml-2 text-sm text-neutral-500 dark:text-neutral-400">
              {t('welcome.checkingConfig')}
            </span>
          </div>
        ) : step === 'welcome' ? (
          /* ── Welcome ──
              Minimal card: plain bordered card container, no decorative
              label/icon — content is just heading + copy + actions.
              Primary action is the inverted button, secondary a text link. */
          <div className="mb-6 rounded-xl border border-border bg-card px-6 py-5 text-center">
            <h2 className="mb-1.5 text-lg font-semibold text-foreground">
              {t('welcome.welcomeHeading')}
            </h2>
            <p className="mb-5 text-sm text-neutral-500 dark:text-neutral-400">
              {t('welcome.welcomeSubtitle')}
            </p>
            <div className="flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
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
                className="inline-flex h-10 items-center justify-center gap-1 rounded-lg px-3 text-sm font-medium text-neutral-500 transition-colors hover:text-foreground"
              >
                {t('welcome.skipButton')}
              </button>
            </div>
          </div>
        ) : step === 'api-key' ? (
          /* ── AI connection setup ──
              Minimal list: one "Connect AI" header, then one row per way to
              connect. Each row's description carries its billing story
              (subscription vs per-provider API) so the paths are directly
              comparable. Global build: the extension row leads and is hidden
              once the extension is detected (codex-oauth then satisfies the
              readiness gate directly). */
          <div className="mb-6 rounded-xl border border-border bg-card px-1.5 py-1.5">
            <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
              <h2 className="text-base font-semibold text-foreground">
                {t('welcome.apiKeyLabel')}
              </h2>
              <SetupGuideLink />
            </div>

            {showExtensionCard && (
              <button
                type="button"
                onClick={handleExtensionSetup}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted/50"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-50 dark:bg-primary-500/10">
                  <Puzzle className="h-[18px] w-[18px] text-primary-600 dark:text-primary-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-foreground">
                      {t('welcome.setupExtensionTitle')}
                    </span>
                    <span className="rounded-full bg-primary-600 px-2 py-0.5 text-[10px] font-semibold text-white">
                      {t('welcome.setupExtensionRecommend')}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
                    {t('welcome.setupExtensionDesc')}
                  </p>
                </div>
                <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" />
              </button>
            )}

            {showExtensionCard && gatewayAvailable && (
              <div className="mx-3 h-px bg-neutral-200/70 dark:bg-neutral-800/70" />
            )}

            {gatewayAvailable && (
              <button
                type="button"
                onClick={async () => {
                  await gatewayLogin()
                }}
                disabled={isGatewayLoginRunning}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted/50 disabled:opacity-60"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-50 dark:bg-primary-500/10">
                  <Shield className="h-[18px] w-[18px] text-primary-600 dark:text-primary-400" />
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

            {(showExtensionCard || gatewayAvailable) && (
              <div className="mx-3 h-px bg-neutral-200/70 dark:bg-neutral-800/70" />
            )}

            <button
              type="button"
              onClick={() => onOpenSettings?.('llm')}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted/50"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-neutral-100 dark:bg-neutral-800">
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
                step 3 have no auto-advance; this is their forward exit.
                Persists (ai-setup-skipped) so a refresh stays skipped. */}
            <div className="flex justify-center pb-2 pt-1">
              <button
                type="button"
                onClick={skipAiSetup}
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
              fail with "model not configured". Same minimal-list language
              as the connect step. */
          <div className="mb-6 rounded-xl border border-border bg-card px-1.5 py-1.5">
            <div className="flex items-center justify-between px-3 pb-1 pt-2.5">
              <h2 className="text-base font-semibold text-foreground">
                {t('welcome.selectModelCardTitle')}
              </h2>
              <SetupGuideLink />
            </div>

            <button
              type="button"
              onClick={() => onOpenSettings?.('llm')}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-muted/50"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-primary-50 dark:bg-primary-500/10">
                <Sparkles className="h-[18px] w-[18px] text-primary-600 dark:text-primary-400" />
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
                top-bar switcher stays available for later. Persists too. */}
            <div className="flex justify-center pb-2 pt-1">
              <button
                type="button"
                onClick={skipAiSetup}
                className="inline-flex h-8 items-center text-xs text-neutral-500 transition-colors hover:text-foreground"
              >
                {t('welcome.skipButton')}
              </button>
            </div>
          </div>
        ) : step === 'mount-folder' ? (
          /* ── Local folder setup ──
              Minimal card, same as welcome: bordered card container, no
              icon decoration; primary action inverted, secondary as text
              link. */
          <div className="mb-6 rounded-xl border border-border bg-card px-6 py-5 text-center">
            <h2 className="mb-1.5 text-lg font-semibold text-foreground">
              {t('welcome.mountFolderTitle')}
            </h2>
            <p className="mx-auto mb-5 max-w-md text-sm text-neutral-500 dark:text-neutral-400">
              {t('welcome.mountFolderDesc')}
            </p>
            <div className="flex flex-col items-center justify-center gap-3 sm:flex-row">
              {nativeHostAvailable && (
                // Primary path: the native-host connection survives reloads and
                // re-authorizes silently, unlike per-session directory handles.
                // Own provider: the screen-level TooltipProvider only wraps the
                // screenshot button, so this one needs its own.
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => void handleAddNativeHostRoot()}
                        disabled={isAddingNativeHost}
                        className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-5 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-wait disabled:opacity-70"
                      >
                        {isAddingNativeHost
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Cable className="h-4 w-4" />}
                        {t('folderSelector.localConnection')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {t('folderSelector.localConnectionDescription')}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <button
                type="button"
                onClick={() => void handleSelectFolder()}
                data-tour="welcome-open-folder"
                className={
                  nativeHostAvailable
                    ? // Secondary peer while the local connection is available
                      "inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-5 text-sm font-medium text-secondary transition-colors hover:bg-muted"
                    : // Only path when the native host is not installed
                      "inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary-600 px-5 text-sm font-medium text-white transition-colors hover:bg-primary-700"
                }
              >
                <FolderOpen className="h-4 w-4" />
                {t('welcome.mountFolderButton')}
              </button>
            </div>
            {/* Already mounted folders */}
            {folderRoots.length > 0 && (
              <div className="mx-auto mt-5 max-w-md border-t border-neutral-200/80 pt-3 dark:border-neutral-800/80">
                {folderRoots.map((root) => (
                  <div key={root.id} className="flex items-center justify-center gap-2 py-0.5 text-xs text-secondary">
                    <Check className="h-3 w-3 text-success" />
                    <span className="truncate">{root.name}</span>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={advanceFromMount}
                  className="mt-3 inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary-600 px-4 text-sm font-medium text-white transition-colors hover:bg-primary-700"
                >
                  {t('welcome.continueButton')}
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {/* Skip + Back */}
            <div className="mt-5 flex justify-center gap-4">
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
        ) : null}

        {/* ── Persistent rich input ──
            Rendered on every step except 'welcome'. Previously the input only
            existed on the 'ready' step, so a transient readiness flip (e.g.
            clearing an API key while replacing it in Settings) unmounted the
            editor and silently discarded unsent text. Drafts additionally
            persist per project via useInputDraftStore as a second safety net
            for full remounts. */}
        {!isLoading && step !== 'welcome' && (
          <>
            {step === 'ready' && (
              /* One-line hint replacing the quick-start buttons */
              <p className="mb-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
                {t('welcome.readyHint')}
              </p>
            )}
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
                sendState={{
                  isProcessing: false,
                  isSendDisabled: !inputValue.trim(),
                  onSend: handleSubmit,
                  onCancel: () => {},
                  sendTitle: t('welcome.send'),
                  cancelTitle: t('welcome.send'),
                }}
                initialText={draftToRestore ?? undefined}
                onDraftRestored={restoreDraft}
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
