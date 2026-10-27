/**
 * WelcomeScreen - setup onboarding with local folder mount
 *
 * State machine: welcome → api-key → select-model → ready
 * - welcome: shown only to first-time users (no project created + not seen)
 * - api-key: *** when no API key configured
 * - select-model: shown when a provider key exists but no default
 *   provider/model is selected yet (onboarding completion requires BOTH)
 * - ready: shows the one-line hint above the rich input
 *
 * The former mount-folder step was REMOVED from the machine (#82): mounting
 * a local folder is a recommendation, not a requirement — the topbar
 * FolderSelector and the sidebar's "Choose local folder" empty-state button
 * stay as always-available non-blocking entries. Once the model is
 * configured, sending works immediately.
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
 * Without a usable model the input stays visible but DISABLED (placeholder
 * points at the model chip) — the chip itself is the configuration entry.
 */

import { useState, useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { Sparkles, KeyRound, ChevronRight, Shield, Loader2, ArrowRight, CircleHelp, Puzzle } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useSettingsStore } from '@/store/settings.store'
import { useFolderAccessStore } from '@/store/folder-access.store'
import { useAssetStore } from '@/store/asset.store'
import { useProjectStore } from '@/store/project.store'
import { useInputDraftStore } from '@/store/input-draft.store'
import { useT } from '@/i18n'
import { isPotentiallyDynamicProviderType, getProviderConfig, subscribeToProviderRegistry, getProviderRegistryVersion } from '@/agent/providers/types'
import { useI18nStore } from '@/i18n/store'
import { docsPath } from '@/lib/route-paths'
import { AgentRichInput, type AgentRichInputValue, type AgentInfo } from './agent/AgentRichInput'
import { ModelThinkingControls } from './agent/ModelThinkingControls'
import { ActiveTabIndicator } from './agent/ActiveTabIndicator'
import { AgentDropdown } from './agent/AgentDropdown'
import { AgentModeSelect } from './agent/AgentModeSelect'
import { RunEndPolicySelect } from './agent/RunEndPolicySelect'
import type { FileMentionItem } from './agent/FileMentionExtension'
import { useAgentsStore } from '@/store/agents.store'
import { useWorkspacePreferencesStore } from '@/store/workspace-preferences.store'
import { useProjectAgentsInit } from '@/hooks/useProjectAgentsInit'
import { useGatewayLogin, isLLMGatewayConfigured } from '@/hooks/useGatewayLogin'
import { ENABLE_LLM_GATEWAY } from '@/lib/deploy-region'
import { useExtensionStore } from '@/store/extension.store'
import { isMobileDeviceForExtension } from '@/lib/extension-distribution'
import { DeviceCodeFlowDialog } from './agent/DeviceCodeFlowDialog'
import { PageScreenshotCropDialog } from './agent/PageScreenshotCropDialog'
import type { SettingsTab } from '@/components/settings/SettingsDialog'
import { supportsImageInput } from '@/agent/llm/pi-ai-model-resolver'
import { captureTab, isPageActionAvailable } from '@/agent/tools/page-action-bridge'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@creatorweave/ui'
import { VisionCapabilityIndicator } from '@/components/agent/VisionCapabilityIndicator'

type OnboardingStep = 'welcome' | 'api-key' | 'select-model' | 'ready'

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
  hasCreatedProject: boolean
): OnboardingStep {
  const welcomeSeen = typeof window !== 'undefined'
    && localStorage.getItem('creatorweave:onboarding:welcome-seen') === 'true'
  // "Skip for now" on the AI-setup card persists too — otherwise a refresh
  // recomputes the provider gate and nags the skipped user all over again.
  // The flag is cleared once onboarding completes (readiness turns ready).
  const aiSetupSkipped = typeof window !== 'undefined'
    && localStorage.getItem('creatorweave:onboarding:ai-setup-skipped') === 'true'

  if (!hasCreatedProject && !welcomeSeen) return 'welcome'
  const provider = providerStep(readiness)
  if (provider !== 'ready' && !aiSetupSkipped) return provider
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
  // Reactive count so the send button enables as soon as a file is staged
  const pendingAssetCount = useAssetStore((s) => s.pendingAssets.length)
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null)
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false)
  const hasApiKey = useSettingsStore((s) => s.hasApiKey)
  const hasApiKeyLoaded = useSettingsStore((s) => s.hasApiKeyLoaded)
  const modelCredentialStatus = useSettingsStore((s) => s.modelCredentialStatus)
  const checkHasApiKey = useSettingsStore((s) => s.checkHasApiKey)
  const providerType = useSettingsStore((s) => s.providerType)
  const modelName = useSettingsStore((s) => s.modelName)
  const enableThinking = useSettingsStore((s) => s.enableThinking)
  const thinkingLevel = useSettingsStore((s) => s.thinkingLevel)
  const setEnableThinking = useSettingsStore((s) => s.setEnableThinking)
  const setThinkingLevel = useSettingsStore((s) => s.setThinkingLevel)
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

  // (The mount-folder card's native-host local-connection button went away
  // with the step in #82 — the topbar FolderSelector owns that entry now.)
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

  const hasCreatedProject = typeof window !== 'undefined'
    && localStorage.getItem('creatorweave:auto-default-project-created') === '1'

  // ── Toolbar state (pre-conversation configuration) ──
  // The thinking toggle + level come from the settings store (declared above,
  // next to the input accessory that renders them); they flow into the first
  // message send because useSettingsStore is read at send time, not
  // snapshotted on mount.
  // Workspace preferences: agentMode + auto-apply policy. Both are
  // per-workspace, but with no active workspace yet (bare URL on entry),
  // setAgentMode / setAutoApplyOnRunComplete only update the global mirror;
  // the per-workspace map is populated on the first switchWorkspace, at
  // which point the just-chosen value lands on the new conversation.
  const agentMode = useWorkspacePreferencesStore((s) => s.agentMode)
  const setAgentMode = useWorkspacePreferencesStore((s) => s.setAgentMode)
  const autoApplyOnRunComplete = useWorkspacePreferencesStore((s) => s.autoApplyOnRunComplete)
  const setAutoApplyOnRunComplete = useWorkspacePreferencesStore((s) => s.setAutoApplyOnRunComplete)
  // Agents store: pull the per-project agent list and make sure the store
  // is initialised for the active project. useProjectAgentsInit is shared
  // with ConversationView (so the bare-URL AgentDropdown on WelcomeScreen
  // populates the same way the in-conversation dropdown does). When there
  // is no active project yet (truly bare URL), the init hook is a no-op
  // and the dropdown shows "default" — same fallback AgentRichInput uses.
  const allAgents = useAgentsStore((s) => s.agents)
  const activeAgentId = useAgentsStore((s) => s.activeAgentId)
  const setActiveAgent = useAgentsStore((s) => s.setActiveAgent)
  const deleteAgent = useAgentsStore((s) => s.deleteAgent)
  useProjectAgentsInit()

  // Track whether folder-access hydration has completed for the current
  // project. Until then we don't know whether `folderRoots` is genuinely
  // empty or just hasn't been populated from disk yet — the sidebar tree
  // and FolderSelector read the same store, so we hold the loading gate
  // until hydration settles (kept for the ready-hint gate below).
  const rootsHydrated = useFolderAccessStore((s) => s.rootsHydrated)

  // "Usable model" for the input gate (#82): a provider is configured AND a
  // model selected. No API key at all: the composer stays EDITABLE when a
  // model is selected (#84 review round 2) — the user may need to type/copy
  // while recovering credentials; the send path still blocks (toast). The
  // input only renders after `isLoading` (which includes `hasApiKeyLoaded`),
  // so the hydration flash guard is already satisfied by the render gate.
  //
  // An EXPIRED gateway credential is a send-path concern, not a selection
  // or editability concern (Sourcery round 4): with a selection present
  // `hasUsableModel` is already true, so no expired-specific term is needed
  // here — the composer stays ready/editable and the re-auth toast comes
  // from sendMessage. (The old `|| (expired && selection)` term was a
  // definitional no-op: `expired && selection` is a subset of `selection`.)
  const hasUsableModel = !!providerType && !!modelName
  const hasSelectableModel = hasUsableModel
  // An unregistered dynamic provider (#87 — codex-oauth whose extension
  // disappeared or whose auth was revoked) leaves the persisted selection
  // in place. Same division of responsibility as the expired credential:
  // the input stays editable, but handleSubmit blocks the send below.
  // The registry version is a reactive dependency (Sourcery round 5): a
  // dynamic provider registering/unregistering while this screen stays
  // mounted must recompute the memo — otherwise a restored provider stays
  // blocked forever (or a revoked one stays allowed).
  const providerRegistryVersion = useSyncExternalStore(
    subscribeToProviderRegistry,
    getProviderRegistryVersion,
    getProviderRegistryVersion
  )
  const selectedProviderUnregistered = useMemo(() => {
    void providerRegistryVersion
    if (!hasUsableModel || !isPotentiallyDynamicProviderType(providerType)) return false
    return !getProviderConfig(providerType)
  }, [hasUsableModel, providerType, providerRegistryVersion])

  const readiness: ProviderReadiness = {
    hasApiKey,
    hasUsableModel,
  }

  const [step, setStep] = useState<OnboardingStep>(() =>
    getInitialStep(readiness, hasCreatedProject)
  )
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

  // Auto-advance step when API key / model-selection state changes.
  // The provider gate is two-fold: no key → api-key step; key saved but no
  // default provider/model chosen → select-model step (guides the user to
  // pick one instead of silently failing every send later). This does NOT
  // auto-select a model — the user stays in control of their default.
  // A persisted AI-setup skip downgrades the provider gate: the user said
  // "not now", so they land on ready instead of the setup card (folder
  // mounting is a recommendation, not a step — #82).
  useEffect(() => {
    if (!hasApiKeyLoaded) return
    setStep((prev) => {
      if (prev === 'welcome') return prev
      const provider = providerStep(readiness)
      if (provider !== 'ready' && !aiSetupSkipped) return provider
      return 'ready'
    })
  }, [readiness.hasApiKey, readiness.hasUsableModel, hasApiKeyLoaded, aiSetupSkipped, modelCredentialStatus])

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
    else setStep('ready')
  }, [readiness.hasApiKey, readiness.hasUsableModel, aiSetupSkipped])

  // "Skip for now" on the AI-setup cards (api-key / select-model) persists:
  // a refresh must not resurrect the card the user just dismissed. The flag
  // self-clears once onboarding completes (see the readiness effect above),
  // so a later deliberate unconfigure re-prompts. Sending stays blocked on
  // these steps (see handleSubmit).
  const skipAiSetup = useCallback(() => {
    localStorage.setItem('creatorweave:onboarding:ai-setup-skipped', 'true')
    setAiSetupSkipped(true)
    setStep('ready')
  }, [])

  const handleSubmit = useCallback(() => {
    const text = inputValue.trim()
    // Attachment-only send (plan A): staged assets flow through the global
    // pendingAssets store into the new conversation's first sendMessage.
    const hasStagedAssets = pendingAssetCount > 0
    if (!text && !hasStagedAssets) return
    // The persistent input also renders on setup steps, but those have no
    // working model yet — sending would start a conversation that fails on
    // every turn. Point the user at the setup card instead; the draft store
    // keeps what they typed so nothing is lost. (Only the provider steps
    // gate — folder mounting is optional and never blocks, #82.)
    // EXCEPTION (Sourcery round 5): when the SELECTED dynamic provider is
    // unregistered, its re-login toast must win even on a setup step —
    // the generic not-ready guidance would send the user to gateway
    // re-login / generic setup instead of the provider's own sign-in.
    if (selectedProviderUnregistered) {
      toast.error(t('conversation.toast.providerReauthRequired'))
      return
    }
    if (step !== 'ready') {
      toast.warning(t('welcome.sendBlockedNotReady'))
      if (step === 'api-key' || step === 'select-model') onOpenSettings?.('llm')
      return
    }
    // An unregistered dynamic provider (#87 — e.g. codex-oauth whose
    // extension was removed or whose auth was revoked) leaves a persisted
    // selection that would hit a dead route. The input stays editable (the
    // draft is kept) but the send is blocked with the re-login toast.
    // Checked ABOVE the step gate (see the comment there).
    onStartConversation(text)
    setInputValue('')
    // Sent — the draft is consumed. Clear it so it won't be re-injected
    // if the input remounts later in this session.
    useInputDraftStore.getState().clearDraft(draftKey)
  }, [inputValue, pendingAssetCount, onStartConversation, draftKey, step, t, onOpenSettings, selectedProviderUnregistered])

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
        <div className="mb-6 text-center">
          <img
            src="/favicon.svg"
            alt=""
            className="mb-4 inline-block h-12 w-12"
          />
          <p className="text-base text-foreground">{t('welcome.greeting')}</p>
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
        ) : null}

        {/* ── Persistent rich input ──
            Rendered on every step except 'welcome'. Previously the input only
            existed on the 'ready' step, so a transient readiness flip (e.g.
            clearing an API key while replacing it in Settings) unmounted the
            editor and silently discarded unsent text. Drafts additionally
            persist per project via useInputDraftStore as a second safety net
            for full remounts.
            Without a usable model (no provider/model chosen) the input stays
            visible but disabled — the ModelQuickSwitch chip next to it is the
            configuration entry, and its placeholder points there (#82). */}
        {!isLoading && step !== 'welcome' && (
          <>
            <div className="relative" data-tour="welcome-input">
              {/* Side-panel mode: shows which tab the AI is currently reading.
                  Renders null outside side-panel mode. */}
              <ActiveTabIndicator />
              <AgentRichInput
                placeholder={
                  hasSelectableModel
                    ? t('welcome.placeholder')
                    : t('conversation.input.placeholderNoModel')
                }
                ariaLabel={t('conversation.input.ariaLabel')}
                disabled={!hasSelectableModel}
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
                  // Staged attachments alone are a sendable payload (plan A);
                  // no selectable model (no key, or no provider/model chosen)
                  // also disables sending. The expired-credential case keeps
                  // the input editable; the send path shows the re-auth toast.
                  isSendDisabled: (!inputValue.trim() && pendingAssetCount === 0) || !hasSelectableModel,
                  onSend: handleSubmit,
                  onCancel: () => {},
                  sendTitle: t('welcome.send'),
                  cancelTitle: t('welcome.send'),
                }}
                initialText={draftToRestore ?? undefined}
                onDraftRestored={restoreDraft}
                beforeSendAccessory={(
                  <ModelThinkingControls
                    enableThinking={enableThinking}
                    thinkingLevel={thinkingLevel}
                    setEnableThinking={setEnableThinking}
                    setThinkingLevel={setThinkingLevel}
                  />
                )}
                leadingAccessory={(
                  <VisionCapabilityIndicator
                    modelName={modelName}
                    providerType={providerType}
                    canCapture={canCaptureScreenshot}
                    isCapturing={isCapturingScreenshot}
                    onCapture={() => void handleCaptureScreenshot()}
                  />
                )}
              />
            </div>

            {/* ── Compact toolbar row ──
                Lets users configure agent / mode / completion-apply policy
                BEFORE sending the first message. The settings flow into the
                new conversation on send (the settings store is read at send
                time, not snapshotted on mount; the workspace-preferences maps
                get populated on first switchWorkspace). Rendered on every
                non-welcome step — the setup steps may not be able to send yet,
                but preconfiguring here still applies to the eventual first
                send, and it keeps the visual layout consistent.
                The thinking toggle lives in the input's accessory bar
                (ModelThinkingControls), matching the conversation view — the
                toolbar therefore only carries the remaining knobs. */}
            <div className="mx-auto mb-6 mt-2 flex max-w-2xl items-center justify-between gap-1.5">
              <div className="flex flex-nowrap items-center gap-1.5 overflow-x-auto pt-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:gap-2 sm:overflow-visible">
                <AgentDropdown
                  allAgents={allAgents}
                  activeAgentId={activeAgentId}
                  setActiveAgent={setActiveAgent}
                  deleteAgent={deleteAgent}
                />
                <AgentModeSelect mode={agentMode} onModeChange={setAgentMode} />
                <RunEndPolicySelect
                  runEndPolicy={autoApplyOnRunComplete ? 'auto' : 'manual'}
                  onRunEndPolicyChange={(policy) => setAutoApplyOnRunComplete(policy === 'auto')}
                />
              </div>
            </div>
          </>
        )}

        {/* Local-first privacy hint */}
        {!isLoading && step !== 'welcome' && (
          <p className="mt-7 text-center text-[11px] text-neutral-400 dark:text-neutral-500">
            {t('welcome.setupLocalFirstHint')}
          </p>
        )}

        {screenshotDataUrl && (
          <PageScreenshotCropDialog
            imageDataUrl={screenshotDataUrl}
            onConfirm={handleScreenshotConfirm}
            onCancel={() => setScreenshotDataUrl(null)}
          />
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
