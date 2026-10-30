'use client'

import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useRouter } from 'next/navigation'
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  Loader2,
  Package,
  Wallet,
  XCircle,
} from 'lucide-react'
import { useT } from '@/i18n'
import {
  fetchSkillStoreManifest,
  installSkillFromUrl,
  scanInstalledDirNames,
  type InstallProgress,
  type SkillStoreEntry,
} from '@/skills/skill-store'
import { mergePrefillText } from '@/lib/skill-install-flow'
import { getSkillManager } from '@/skills/skill-manager'
import { useProjectStore } from '@/store/project.store'
import { useConversationStore } from '@/store/conversation.store'
import { useConversationContextStore } from '@/store/conversation-context.store'
import { checkAiReadiness, buildPrefillText, pickConversationTarget, waitForCondition } from '@/lib/skill-install-flow'
import { ENABLE_LLM_GATEWAY } from '@/lib/deploy-region'
import { projectWorkspacePath } from '@/lib/route-paths'
import { getNutstoreAIConsoleURL } from '@/lib/jianguoyun-ai-console'
import { useGatewayLogin } from '@/hooks/useGatewayLogin'

/**
 * Skill promotion landing page: /skill-install?skill=<dirName>[&prompt=...]
 *
 * State machine (issue #126):
 *   1. Show skill details + "Install" button — MUST be user-clicked (the
 *      install pipeline's importUserSkillZip writes OPFS entries; the
 *      folder-pick page already proved gesture-restricted APIs do not
 *      survive an auto-flow).
 *   2. Install via installSkillFromUrl('/skills/{dirName}.zip'); idempotent
 *      (already installed → show "already installed" and skip). After a
 *      fresh install, SkillManager.refreshUserSkills() registers the slash
 *      command immediately.
 *   3. AI readiness (auto-skipping): gateway token or any provider key →
 *      skip; otherwise inline device-code login with a "skip for now"
 *      escape — skipping still reaches the conversation (the 401 chain +
 *      re-login error card backstop the first send).
 *   4. Navigate: most recent workspace by lastAccessedAt, else createNew().
 *      No projectId is passed — AppBootstrap's auto-default owns first-visit
 *      project creation; duplicating it would conflict.
 *   5. Prefill the input with /{skill-name} (+ prompt suffix) via the
 *      input-draft store, which ConversationView restores into the editor
 *      through AgentRichInput's initialText pipeline.
 */

type Phase =
  | 'loading'
  | 'error'
  | 'details'
  | 'installing'
  | 'login'
  | 'starting'

type ErrorKind = 'missing-param' | 'not-found' | 'load-failed'

/**
 * Bound for the skill-store manifest fetch: a request that stalls without
 * settling must surface as a retryable load error instead of pinning the
 * page in `loading` forever.
 */
const MANIFEST_TIMEOUT_MS = 15_000

/**
 * Bound for the inline device-code login's FIRST request (device-session
 * creation): `gatewayFetch` has no request timeout, so a gateway that never
 * settles the response would leave the hook in `requesting` forever —
 * spinner only, no escape. On expiry the login attempt is abandoned and the
 * visitor is returned to the error/skip state.
 */
const LOGIN_REQUEST_TIMEOUT_MS = 15_000

interface InstallOutcome {
  alreadyInstalled: boolean
}

function SkillInstallView() {
  const t = useT()
  const router = useRouter()
  const searchParams = useSearchParams()
  const skillParam = searchParams.get('skill')
  const promptParam = searchParams.get('prompt')

  const [phase, setPhase] = useState<Phase>('loading')
  const [errorKind, setErrorKind] = useState<ErrorKind>('load-failed')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [entry, setEntry] = useState<SkillStoreEntry | null>(null)
  const [alreadyInstalled, setAlreadyInstalled] = useState(false)
  const [installProgress, setInstallProgress] = useState<InstallProgress | null>(null)
  const [creditExhausted, setCreditExhausted] = useState(false)
  const installStartedRef = useRef(false)

  // Inline device-code login (same hook as WelcomeScreen).
  const {
    authState,
    isRunning: isLoginRunning,
    login: gatewayLogin,
    reset: resetGatewayLogin,
  } = useGatewayLogin()

  // The deadline applies only while creating the device session. Once a
  // user code is shown, approval can take as long as the server allows.
  const loginGenerationRef = useRef(0)
  const loginAttemptActiveRef = useRef(false)
  const loginTimeoutRef = useRef<number | null>(null)
  const gatewayLoginBounded = useCallback(async () => {
    if (loginTimeoutRef.current !== null) clearTimeout(loginTimeoutRef.current)
    // Invalidate any superseded attempt: its late success/failure must not
    // touch the UI or continue the flow — only the NEWEST attempt acts.
    const generation = ++loginGenerationRef.current
    loginAttemptActiveRef.current = true
    loginTimeoutRef.current = window.setTimeout(() => {
      loginTimeoutRef.current = null
      if (generation !== loginGenerationRef.current) return
      console.error('[SkillInstall] gateway login did not settle in time')
      loginGenerationRef.current++
      loginAttemptActiveRef.current = false
      resetGatewayLogin()
      setErrorMessage(t('skillInstall.loginTimeout'))
      setPhase('login')
    }, LOGIN_REQUEST_TIMEOUT_MS)
    try {
      const success = await gatewayLogin()
      if (generation !== loginGenerationRef.current) return false
      return success
    } finally {
      if (generation === loginGenerationRef.current && loginTimeoutRef.current !== null) {
        clearTimeout(loginTimeoutRef.current)
        loginTimeoutRef.current = null
      }
    }
  }, [gatewayLogin, resetGatewayLogin, t])

  useEffect(
    () => () => {
      if (loginTimeoutRef.current !== null) clearTimeout(loginTimeoutRef.current)
    },
    [],
  )

  // Monotonic request generation: when the `skill` query param changes
  // (or a retry fires) while an earlier lookup/install/continuation is
  // still pending, the stale completion must not overwrite the newer
  // entry/phase state nor navigate for the OLD skill.
  // The generation must key on BOTH query params: a changed `prompt` is as
  // much a new request as a changed `skill` — a pending flow captured the
  // OLD prompt and must not navigate with stale link content.
  const loadGenerationRef = useRef(0)
  const currentGeneration = () => loadGenerationRef.current

  const loadEntry = useCallback(async () => {
    loginGenerationRef.current++
    loginAttemptActiveRef.current = false
    if (loginTimeoutRef.current !== null) {
      clearTimeout(loginTimeoutRef.current)
      loginTimeoutRef.current = null
    }
    resetGatewayLogin()
    const generation = ++loadGenerationRef.current
    const isStale = () => generation !== loadGenerationRef.current
    setPhase('loading')
    setErrorKind('load-failed')
    setErrorMessage(null)
    setEntry(null)
    setAlreadyInstalled(false)
    // Stale UI flags from the PREVIOUS skill: the cached readiness verdict
    // and the zero-credit warning both belong to the old entry. Without
    // this reset, a changed `skill` query would (a) take runAiReadiness's
    // fast path and never re-check current credentials (a visitor who
    // since logged out would skip the required login step), and (b) keep
    // rendering the old skill's credit warning on the new details view
    // before the new readiness check runs.
    readinessDoneRef.current = false
    setCreditExhausted(false)
    if (!skillParam) {
      setErrorKind('missing-param')
      setPhase('error')
      return
    }
    try {
      // Bound the manifest fetch: a stalled request that never settles
      // would otherwise leave the page in `loading` forever, with no
      // error view or retry. 15s covers slow mobile connections; the
      // manifest itself is a small JSON document.
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), MANIFEST_TIMEOUT_MS)
      let manifest: Awaited<ReturnType<typeof fetchSkillStoreManifest>>
      try {
        manifest = await fetchSkillStoreManifest({ signal: controller.signal })
      } finally {
        clearTimeout(timeoutId)
      }
      if (isStale()) return
      const found = manifest.skills.find((s) => s.dirName === skillParam)
      if (!found) {
        setErrorKind('not-found')
        setPhase('error')
        return
      }
      const installed = await scanInstalledDirNames()
      if (isStale()) return
      setEntry(found)
      // The fallback set contains skill IDs (`user:<dirName>`), not bare
      // directory names — normalise before the membership check, or a skill
      // that IS installed looks uninstalled when OPFS scanning failed and
      // the page offers a second install that would overwrite it.
      const installedDirNames = new Set(
        [...installed].map((idOrDir) =>
          idOrDir.startsWith('user:') ? idOrDir.slice('user:'.length) : idOrDir,
        ),
      )
      setAlreadyInstalled(installedDirNames.has(found.dirName))
      setPhase('details')
    } catch (e) {
      if (isStale()) return
      setErrorKind('load-failed')
      setErrorMessage(e instanceof Error ? e.message : String(e))
      setPhase('error')
    }
  }, [skillParam, promptParam, resetGatewayLogin])

  useEffect(() => {
    void loadEntry()
    // Unmount must invalidate the CURRENT generation too: a pending
    // install/readiness continuation (capturing this generation) would
    // otherwise run to completion after the visitor left the page and
    // still call router.replace — redirecting them from wherever they
    // navigated to. Capturing the generation in a local (the ref value at
    // cleanup time is what must be bumped); a remount's loadEntry()
    // re-bumps it for the new visit anyway.
    const generationAtMount = loadGenerationRef.current
    return () => {
      if (loadGenerationRef.current === generationAtMount) {
        loadGenerationRef.current++
      }
      loginAttemptActiveRef.current = false
    }
  }, [loadEntry])

  // ── Steps 3-5: readiness → navigate → prefill ─────────────────────

  const continueToConversation = useCallback(
    async (skillName: string) => {
      // Capture the generation at entry — if the query param changed while
      // this continuation was pending, its navigation must be dropped (it
      // would send the visitor to a conversation pre-filled with the OLD
      // skill's command).
      const generation = currentGeneration()
      const isStale = () => generation !== currentGeneration()
      setPhase('starting')
      setErrorMessage(null)
      // AppBootstrap owns project auto-default; wait for the project store
      // to finish initializing instead of creating a project here (issue
      // #126 decision: duplicate creation conflicts).
      const projectReady = await waitForCondition(() => useProjectStore.getState().initialized)
      if (isStale()) return
      if (!projectReady) {
        setErrorMessage(t('skillInstall.startFailed'))
        setPhase('details')
        return
      }

      // initialize() leaves activeProjectId empty on purpose (it is
      // URL-driven and only syncFromRoute on a project-scoped route sets
      // it). /skill-install is never project-scoped, so a fresh visit
      // would otherwise wait forever — select the first project (the
      // first-visit auto-created default) ourselves.
      let projectState = useProjectStore.getState()
      if (!projectState.activeProjectId) {
        const fallbackProject = projectState.projects[0]
        if (fallbackProject) {
          const switched = await projectState.setActiveProject(fallbackProject.id)
          if (isStale()) return
          if (!switched) {
            setErrorMessage(t('skillInstall.startFailed'))
            setPhase('details')
            return
          }
          projectState = useProjectStore.getState()
        }
      }
      if (!projectState.activeProjectId) {
        setErrorMessage(t('skillInstall.startFailed'))
        setPhase('details')
        return
      }

      // Workspace initialization (SQLite/OPFS load) runs in AppBootstrap
      // too — wait for it so pickConversationTarget sees existing history
      // instead of creating a duplicate conversation. On timeout the
      // workspace list may be incomplete: abort to the details view with
      // an error rather than navigating to a possibly blank conversation.
      const contextReady = await waitForCondition(
        () => useConversationContextStore.getState().initialized,
      )
      if (isStale()) return
      if (!contextReady) {
        setErrorMessage(t('skillInstall.startFailed'))
        setPhase('details')
        return
      }

      // Navigation target: most recent workspace, else a fresh conversation.
      // conversationId === workspaceId in this app, so createNew()'s id is
      // directly usable as the URL's workspaceId.
      const target = pickConversationTarget(
        useConversationContextStore.getState().workspaces,
        () => createConversationForVisitor(),
      )

      // Prefill: write the draft BEFORE navigating so ConversationView's
      // draft-restore effect (peekDraft → initialText → AgentRichInput)
      // picks it up on mount. Merge into any unsent draft instead of
      // clobbering it.
      const { useInputDraftStore } = await import('@/store/input-draft.store')
      const existingDraft = useInputDraftStore.getState().peekDraft(target.id)
      useInputDraftStore.getState().saveDraft(target.id, {
        text: mergePrefillText(existingDraft?.text, buildPrefillText(skillName, promptParam)),
        mentionedAgentIds: existingDraft?.mentionedAgentIds ?? [],
        selectedFiles: existingDraft?.selectedFiles ?? [],
      })

      // Final staleness gate immediately before navigation: a query change
      // during the awaits above must cancel the OLD skill's navigation.
      if (isStale()) return
      router.replace(
        projectWorkspacePath(useProjectStore.getState().activeProjectId, target.id),
      )
    },
    [promptParam, router, t],
  )

  // Set once a readiness check has completed — a follow-up Start click
  // (shown after the zero-credit hint) proceeds straight to navigation.
  const readinessDoneRef = useRef(false)

  // Step 3: AI readiness — automatic, skippable steps are skipped.
  const runAiReadiness = useCallback(async () => {
    // Gate on the CURRENT generation: a query change mid-install/readiness
    // must stop the old skill's flow before it navigates.
    if (readinessDoneRef.current) {
      if (currentGeneration() !== installGenerationRef.current) return
      await continueToConversation(entry?.name ?? entry?.dirName ?? '')
      return
    }
    try {
      const readiness = await checkAiReadiness()
      if (currentGeneration() !== installGenerationRef.current) return
      if (readiness.keyStoreUnavailable) {
        // The api-key store could not be probed, so "not ready" is
        // UNPROVEN — the visitor's key may live in that store. Surface a
        // retryable error instead of the login step, and leave
        // readinessDoneRef false so the retry re-checks credentials.
        console.error('[SkillInstall] api-key store probe failed during readiness check')
        setErrorMessage(t('skillInstall.keyStoreUnavailable'))
        setPhase('details')
        return
      }
      readinessDoneRef.current = true
      if (readiness.ready) {
        setCreditExhausted(readiness.creditExhausted)
        if (readiness.creditExhausted) {
          // 0 credit: surface the "can't use yet" hint in the details view
          // BEFORE navigating — navigating immediately would discard it.
          // The next Start click proceeds (the recharge card on the
          // conversation is the actionable entry).
          setPhase('details')
          return
        }
        await continueToConversation(entry?.name ?? entry?.dirName ?? '')
        return
      }
      resetGatewayLogin()
      setPhase('login')
    } catch (e) {
      if (currentGeneration() !== installGenerationRef.current) return
      // A readiness probe that TIMED OUT (bounded probe discarded its
      // pending result) is NOT evidence of missing credentials: switching
      // to the login step here would show a misleading login prompt to a
      // visitor whose credentials are fine. Surface a retryable readiness
      // error instead (readinessDoneRef stays false so Retry re-checks).
      const timedOut = e instanceof Error && e.message.includes('timed out')
      console.error('[SkillInstall] readiness check failed:', e)
      if (timedOut) {
        setErrorMessage(t('skillInstall.readinessTimeout'))
        setPhase('details')
        return
      }
      resetGatewayLogin()
      setPhase('login')
    }
  }, [continueToConversation, entry, resetGatewayLogin])

  // Generation of the entry runInstall started with — recorded when the
  // install begins so a query change mid-install aborts the stale flow.
  const installGenerationRef = useRef(0)

  // Step 2: install (user-clicked; idempotent).
  const runInstall = useCallback(async () => {
    if (!entry || installStartedRef.current) return
    installStartedRef.current = true
    installGenerationRef.current = currentGeneration()
    const installGeneration = installGenerationRef.current
    const isStale = () => currentGeneration() !== installGeneration
    setPhase('installing')
    try {
      let outcome: InstallOutcome = { alreadyInstalled }
      if (!alreadyInstalled) {
        await installSkillFromUrl(entry.zipUrl, setInstallProgress)
        // The archive IS on disk from this point on — a retry after a
        // failure in the steps below must refresh/verify registration
        // instead of downloading and importing again (a re-import would
        // replace any local changes the visitor made to the skill).
        setAlreadyInstalled(true)
        // A query change during the download abandons the old skill's flow:
        // never verify or navigate for it. The skill IS on disk though, so
        // the manager cache must still be refreshed — otherwise the
        // installed skill stays absent from the slash-command registry
        // until some unrelated refresh happens to rescan OPFS.
        if (isStale()) {
          try {
            await getSkillManager().refreshUserSkills()
          } catch (refreshErr) {
            console.warn('[SkillInstall] post-install refresh failed:', refreshErr)
          }
          return
        }
        // Register the slash command immediately — refreshUserSkills()
        // rescans OPFS and re-syncs the slash-command registry.
        await getSkillManager().refreshUserSkills()
        if (isStale()) return
        // The skill must be REGISTERED and ENABLED after the refresh — a
        // directory alone is not enough: refreshUserSkills() swallows scan
        // failures, and a dir-only check would let the page navigate with
        // a slash command that has nothing behind it. A registered-but-
        // disabled skill (installed, then disabled before this install)
        // must be re-enabled for the promoted flow to work.
        const freshInstallManager = getSkillManager()
        const registeredSkill = freshInstallManager
          .getSkills()
          .find((s) => s.source === 'user' && s.id === `user:${entry.dirName}`)
        if (!registeredSkill) {
          // Throwing here previously left `alreadyInstalled` false, so a
          // retry re-downloaded and re-imported the archive. Now the flag
          // is already set (above), so handleStart's installed-path retry
          // just refreshes/verifies registration instead.
          throw new Error(t('skillInstall.registerFailed'))
        }
        if (!registeredSkill.enabled) {
          freshInstallManager.setUserSkillEnabled(`user:${entry.dirName}`, true)
        }
        outcome = { alreadyInstalled: false }
      }
      setAlreadyInstalled(true)
      setInstallProgress(null)
      await runAiReadiness()
      void outcome
    } catch (e) {
      if (isStale()) return
      console.error('[SkillInstall] install failed:', e)
      setErrorMessage((e as Error).message || t('skillInstall.installFailed'))
      setPhase('details')
    } finally {
      installStartedRef.current = false
    }
  }, [alreadyInstalled, entry, runAiReadiness, t])

  // Guard against overlapping Start attempts: while a readiness check /
  // navigation is in flight, a second click (or double-click) must be a
  // no-op — two concurrent continuations would each see an empty workspace
  // list and create duplicate conversations.
  const startingRef = useRef(false)

  /**
   * The already-installed flow must never navigate with an unregistered
   * slash command: "the dir was seen in the load scan" does NOT imply the
   * skill is registered in THIS tab — the SkillManager cache is populated
   * by an OPFS rescan that may not have run here yet (the install happened
   * in another tab, the scan failed earlier, or this is a fresh session
   * where SkillManager.initialize() has not completed). Verify
   * registration, refresh-on-miss, and abort if the skill still is not
   * registered — the command the visitor is about to send must have
   * something behind it.
   */
  const ensureRegistered = useCallback(
    async (dirName: string, isStale: () => boolean): Promise<boolean | 'disabled'> => {
      const manager = getSkillManager()
      const findRegistered = () =>
        manager
          .getSkills()
          .find((s) => s.source === 'user' && s.id === `user:${dirName}`)
      if (findRegistered()) {
        return findRegistered()!.enabled ? true : 'disabled'
      }
      await manager.refreshUserSkills()
      if (isStale()) return false
      const found = findRegistered()
      if (!found) return false
      return found.enabled ? true : 'disabled'
    },
    [],
  )

  // "Already installed" path skips straight past install + login checks
  // (the acceptance criteria: returning users are done in 2 clicks) — but
  // still runs readiness so a since-logged-out visitor gets the login step.
  const handleStart = useCallback(async () => {
    if (!entry || startingRef.current) return
    startingRef.current = true
    try {
      if (!alreadyInstalled) {
        await runInstall()
        return
      }
      // Already-installed path: this click starts a fresh flow for the
      // CURRENT entry — stamp its generation so the readiness/navigation
      // gates below compare against this click, not an older install.
      installGenerationRef.current = currentGeneration()
      const installGeneration = installGenerationRef.current
      const registration = await ensureRegistered(
        entry.dirName,
        () => currentGeneration() !== installGeneration,
      )
      if (registration === 'disabled') {
        // The skill is installed but the visitor disabled it earlier: the
        // flow must not pre-fill its command and navigate — the conversation
        // could not use the skill. Re-enable it so the promoted flow works,
        // then proceed.
        getSkillManager().setUserSkillEnabled(`user:${entry.dirName}`, true)
      } else if (registration === false) {
        if (currentGeneration() !== installGeneration) return
        setErrorMessage(t('skillInstall.registerFailed'))
        setPhase('details')
        return
      }
      await runAiReadiness()
    } finally {
      startingRef.current = false
    }
  }, [alreadyInstalled, ensureRegistered, entry, runAiReadiness, runInstall, t])

  const handleLoginSuccess = useCallback(async () => {
    setCreditExhausted(false)
    // A visitor who was logged OUT at page load skipped the initial
    // readiness check (the flow went straight to login). Re-check now that
    // credentials exist — otherwise a zero-credit account navigates
    // directly and never sees the early recharge hint on this page.
    try {
      const readiness = await checkAiReadiness()
      if (readiness.creditExhausted) {
        setCreditExhausted(true)
        // Back to the details view where the recharge hint renders; the
        // next Start proceeds (readinessDoneRef is already true).
        setPhase('details')
        return
      }
    } catch (e) {
      // Readiness re-check is best-effort: a failed probe must not trap the
      // visitor mid-flow — proceed (the conversation's recharge card
      // remains the backstop).
      console.warn('[SkillInstall] post-login readiness re-check failed:', e)
    }
    await continueToConversation(entry?.name ?? entry?.dirName ?? '')
  }, [continueToConversation, entry])

  const handleSkipLogin = useCallback(async () => {
    loginGenerationRef.current++
    loginAttemptActiveRef.current = false
    resetGatewayLogin()
    // "later" escape — skipping still proceeds to the conversation; the
    // existing 401 chain + re-login error card backstop the first send.
    await continueToConversation(entry?.name ?? entry?.dirName ?? '')
  }, [continueToConversation, entry, resetGatewayLogin])

  // After a successful inline login, move on automatically. The generation
  // gate ensures a login attempt that was timed out / superseded cannot
  // continue the flow when its underlying `gatewayLogin()` eventually
  // settles AFTER the visitor retried or skipped.
  const authStatus = authState?.status ?? 'idle'
  useEffect(() => {
    if (authStatus !== 'waiting' && authStatus !== 'polling' && authStatus !== 'success' && authStatus !== 'error') return
    if (loginTimeoutRef.current !== null) {
      clearTimeout(loginTimeoutRef.current)
      loginTimeoutRef.current = null
    }
  }, [authStatus])
  const loginGeneration = loginGenerationRef.current
  useEffect(() => {
    if (phase === 'login' && authStatus === 'success') {
      if (loginGeneration !== loginGenerationRef.current) return
      if (!loginAttemptActiveRef.current) return
      loginAttemptActiveRef.current = false
      void handleLoginSuccess()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, authStatus, handleLoginSuccess, loginGeneration])

  // ── Render ─────────────────────────────────────────────────────────

  if (phase === 'loading') {
    return (
      <Centered>
        <Loader2 className="h-6 w-6 animate-spin text-primary-600" />
        <p className="text-sm text-secondary">{t('skillInstall.loading')}</p>
      </Centered>
    )
  }

  if (phase === 'error') {
    return (
      <Centered>
        <AlertCircle className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm font-medium text-secondary">{t('skillInstall.errorTitle')}</p>
        <p className="max-w-md text-xs text-muted-foreground">
          {errorKind === 'missing-param'
            ? t('skillInstall.missingParam')
            : errorKind === 'not-found'
              ? t('skillInstall.notFound')
              : (errorMessage ?? t('skillInstall.loadFailed'))}
        </p>
        <div className="flex items-center gap-3">
          {errorKind === 'load-failed' && (
            <button
              type="button"
              onClick={() => void loadEntry()}
              className="flex h-9 items-center gap-2 rounded-md border border-border bg-white px-4 text-sm text-secondary transition-colors hover:border-primary-100 hover:bg-primary-50 hover:text-primary-600 dark:border-border dark:bg-card"
            >
              {t('skillInstall.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={() => router.replace('/projects')}
            className="flex h-9 items-center gap-2 rounded-md bg-primary-600 px-4 text-sm font-medium text-white transition-colors hover:bg-primary-700"
          >
            {t('skillInstall.openProjectsHome')}
          </button>
        </div>
      </Centered>
    )
  }

  if (!entry) return null

  if (phase === 'details' || phase === 'installing') {
    const busy = phase === 'installing'
    return (
      <Centered>
        <Package className="h-8 w-8 text-primary-600" />
        <div className="text-center">
          <div className="flex items-center justify-center gap-2">
            <h1 className="text-lg font-semibold text-secondary">{entry.name}</h1>
            {alreadyInstalled && (
              <span className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-700 dark:bg-green-900/40 dark:text-green-300">
                {t('skillInstall.installedBadge')}
              </span>
            )}
          </div>
          {entry.description && (
            <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{entry.description}</p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {t('skillInstall.versionLabel')} {entry.version || '—'}
            {typeof entry.fileCount === 'number' &&
              ` · ${t('skillInstall.filesLabel', { count: entry.fileCount })}`}
          </p>
        </div>
        {errorMessage && (
          <div className="flex max-w-md items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <p className="min-w-0 flex-1 break-words">{errorMessage}</p>
          </div>
        )}
        {creditExhausted && (
          <div className="flex max-w-md items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-200">
            <Wallet className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="min-w-0 flex-1">
              <p>{t('skillInstall.creditExhausted')}</p>
              <button
                type="button"
                className="mt-1 font-medium underline underline-offset-2"
                onClick={() => window.open(getNutstoreAIConsoleURL(), '_blank', 'noopener,noreferrer')}
              >
                {t('skillInstall.recharge')}
              </button>
            </div>
          </div>
        )}
        {busy ? (
          <div className="flex flex-col items-center gap-2">
            <div className="flex items-center gap-2 text-sm text-secondary">
              <Loader2 className="h-4 w-4 animate-spin text-primary-600" />
              {installProgress?.phase === 'error'
                ? `${t('skillInstall.installFailed')}: ${installProgress.message}`
                : (installProgress?.message || t('skillInstall.installing'))}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void handleStart()}
            className="flex h-10 items-center gap-2 rounded-md bg-primary-600 px-6 text-sm font-medium text-white transition-colors hover:bg-primary-700"
          >
            <Package className="h-4 w-4" />
            {alreadyInstalled ? t('skillInstall.starting') : t('skillInstall.installButton')}
          </button>
        )}
      </Centered>
    )
  }

  if (phase === 'login') {
    return (
      <Centered>
        <p className="text-sm font-medium text-secondary">
          {ENABLE_LLM_GATEWAY
            ? t('skillInstall.aiNotReady')
            : t('skillInstall.aiGatewayUnavailable')}
        </p>
        {errorMessage && (
          <p className="max-w-sm text-xs text-red-600 dark:text-red-400" role="alert">
            {errorMessage}
          </p>
        )}
        {ENABLE_LLM_GATEWAY ? (
          <InlineGatewayLogin
            authState={authState}
            isRunning={isLoginRunning}
            onLogin={() => void gatewayLoginBounded()}
            onSkip={() => void handleSkipLogin()}
            onCopyCode={() => {
              if (authState?.userCode) void navigator.clipboard.writeText(authState.userCode)
            }}
          />
        ) : (
          // Gateway disabled on this build (e.g. international): the device-
          // code login would always fail (no client id) — offer the app home
          // instead (Settings → provider key is reachable from the top bar
          // there), plus the same "skip" escape.
          <div className="flex w-full max-w-sm flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => router.replace('/projects')}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-md bg-primary-600 px-4 text-sm font-medium text-white transition-colors hover:bg-primary-700"
            >
              <KeyRound className="h-4 w-4" />
              {t('skillInstall.aiOpenSettings')}
            </button>
            <button
              type="button"
              onClick={() => void handleSkipLogin()}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-secondary"
            >
              {t('skillInstall.aiLater')}
            </button>
          </div>
        )}
      </Centered>
    )
  }

  // phase === 'starting'
  return (
    <Centered>
      <CheckCircle2 className="h-6 w-6 text-green-500" />
      <p className="text-sm text-secondary">{t('skillInstall.starting')}</p>
    </Centered>
  )
}

/** Inline device-code login UI — modeled on LLMGatewayCard's inline flow. */
function InlineGatewayLogin(props: {
  authState: ReturnType<typeof useGatewayLogin>['authState']
  isRunning: boolean
  onLogin: () => void
  onSkip: () => void
  onCopyCode: () => void
}) {
  const t = useT()
  const { authState } = props
  const status = authState?.status ?? 'idle'
  return (
    <div className="flex w-full max-w-sm flex-col items-center gap-3">
      {status === 'idle' && (
        <>
          <button
            type="button"
            onClick={props.onLogin}
            className="flex h-9 w-full items-center justify-center rounded-md bg-primary-600 px-4 text-sm font-medium text-white transition-colors hover:bg-primary-700"
          >
            {t('settings.gateway.login')}
          </button>
          <button
            type="button"
            onClick={props.onSkip}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-secondary"
          >
            {t('skillInstall.aiLater')}
          </button>
        </>
      )}
      {status === 'requesting' && (
        <>
          <div className="flex items-center gap-2 text-sm text-secondary">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t('settings.gateway.creatingSession')}
          </div>
          {/* A stalled gateway must never trap the visitor in the spinner:
              the skip escape stays reachable while the request is pending. */}
          <button
            type="button"
            onClick={props.onSkip}
            className="text-xs text-muted-foreground underline underline-offset-2 hover:text-secondary"
          >
            {t('skillInstall.aiLater')}
          </button>
        </>
      )}
      {(status === 'waiting' || status === 'polling') && authState?.userCode && (
        <div className="w-full space-y-3">
          <div className="flex items-center justify-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
            <span className="font-mono text-xl font-bold tracking-[0.15em] text-primary">
              {authState.userCode}
            </span>
            <button
              type="button"
              onClick={props.onCopyCode}
              className="text-muted-foreground hover:text-primary"
              title={t('settings.gateway.copy')}
            >
              <Copy className="h-3.5 w-3.5" />
            </button>
          </div>
          {authState.verificationUri && (
            <a
              href={
                authState.verificationUri.includes('user_code=')
                  ? authState.verificationUri
                  : `${authState.verificationUri}${authState.verificationUri.includes('?') ? '&' : '?'}user_code=${encodeURIComponent(authState.userCode || '')}`
              }
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-9 w-full items-center justify-center gap-1.5 rounded-md bg-primary-600 px-3 text-sm font-medium text-white hover:bg-primary-700"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {t('settings.gateway.openAuthPage')}
            </a>
          )}
          {status === 'polling' && (
            <div className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('settings.gateway.waitingForAuth')}
            </div>
          )}
          <button
            type="button"
            onClick={props.onSkip}
            className="w-full text-xs text-muted-foreground underline underline-offset-2 hover:text-secondary"
          >
            {t('skillInstall.aiLater')}
          </button>
        </div>
      )}
      {status === 'success' && (
        <div className="flex items-center gap-2 text-sm font-medium text-green-500">
          <CheckCircle2 className="h-5 w-5" />
          {t('settings.gateway.loginSuccess')}
        </div>
      )}
      {status === 'error' && (
        <div className="w-full space-y-2">
          <div className="flex items-start gap-2">
            <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
            <div>
              <p className="text-sm font-medium text-secondary">{t('settings.gateway.loginFailed')}</p>
              {authState?.error && <p className="text-xs text-muted-foreground">{authState.error}</p>}
            </div>
          </div>
          <button
            type="button"
            onClick={props.onLogin}
            className="h-9 w-full rounded-md bg-primary-600 px-4 text-sm font-medium text-white hover:bg-primary-700"
          >
            {t('settings.gateway.loginAgain')}
          </button>
          <button
            type="button"
            onClick={props.onSkip}
            className="w-full text-xs text-muted-foreground underline underline-offset-2 hover:text-secondary"
          >
            {t('skillInstall.aiLater')}
          </button>
        </div>
      )}
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      {children}
    </div>
  )
}

/**
 * createNew wrapper — imported lazily to keep this module light; returns the
 * freshly created conversation (persisted immediately by the store).
 */
function createConversationForVisitor(): { id: string } {
  return useConversationStore.getState().createNew('New conversation')
}

/** Standalone promotion landing page: /skill-install?skill=<dirName> */
export default function SkillInstallPage() {
  return (
    <Suspense fallback={null}>
      <SkillInstallView />
    </Suspense>
  )
}
