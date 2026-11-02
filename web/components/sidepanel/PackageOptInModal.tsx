'use client'

/**
 * PackageOptInModal — one-time consent dialog when the side panel opens on a
 * site hosted by a builtin WebMCP package that is still disabled
 * (issue #100).
 *
 * Flow:
 *   1. AppBootstrap (side-panel mode, storage ready) calls
 *      `getPendingPackagePrompt()` after a short delay (let the workspace
 *      render first — the modal must not race the project route).
 *   2. If the bound upstream tab hosts a disabled builtin package AND the
 *      user has not dismissed it within the 1-day cooldown → this modal
 *      renders.
 *   3. 「开启并刷新页面」→ `enablePackageAndReload()` enables the package
 *      extension-side (the same config the packages management page writes)
 *      and reloads the upstream page so the tools register. Success toast
 *      explains what happened.
 *   4. 「暂不开启」→ 1-day local cooldown, no nagging on every panel open.
 *
 * The web app never persists the enabled state itself — extension storage is
 * the single source of truth (revocable in the extension's Supported Sites
 * page). This is purely an accelerator for the consent UX.
 *
 * Visual spec (owner-approved, issue #100): lucide icons only (NO emoji),
 * a collapsible tool list (chevron + Wrench + count) with internal scroll
 * and zebra rows, per-tool read-only / write badges, and a flex modal
 * (max-height 88%) whose header and footer stay fixed while the body
 * scrolls. A backdrop click must NOT close the dialog — an accidental click
 * is not a decision (same rule as ToolAuthModal).
 */

import { useState } from 'react'
import { toast } from 'sonner'
import {
  ChevronDown,
  ChevronRight,
  Clapperboard,
  Globe,
  Mail,
  MessageSquare,
  ShoppingBag,
  Wrench,
  type LucideIcon,
} from 'lucide-react'
import { useT } from '@/i18n'
import {
  dismissPackagePrompt,
  enableLegacyRecipeAndReload,
  enablePackageAndReload,
  type PackageOptInInfo,
  type PackageOptInEnableResult,
} from '@/agent/sidepanel-package-prompt'

/**
 * Package id → lucide icon. The package manifest has no icon field (and the
 * manifest schema stays untouched), so the mapping lives in the front end.
 */
const PACKAGE_ICONS: Record<string, LucideIcon> = {
  'world.jmail.archive': Mail,
  'world.jmail.messages': MessageSquare,
  'com.xiaohongshu.main': ShoppingBag,
  'com.douban.movie': Clapperboard,
  'com.douban.search': Clapperboard,
  'com.discord.main': MessageSquare,
}

export function packageIcon(packageId: string): LucideIcon {
  return PACKAGE_ICONS[packageId] ?? Globe
}

/** Per-tool semantic icon — a per-tool icon map would be guesswork. */
function toolIcon(toolName: string): LucideIcon {
  if (/read|list|search|get|view|check|browse|show|open/i.test(toolName)) return Globe
  if (/publish|post|send|comment|like|reply|write|upload/i.test(toolName)) return Wrench
  return Wrench
}

export interface PackageOptInModalProps {
  packageInfo: PackageOptInInfo
  onClose: () => void
  /**
   * True when the prompt came from the LEGACY (pre-#102) recipe protocol
   * (issue #113): the confirm path then calls `recipeEnable` WITHOUT a
   * consent token — the old protocol has none (its background re-validates
   * the binding + tab itself, the protocol-level analog of grace mode).
   * Toasts, dismissal cooldown and close behavior stay identical.
   */
  legacy?: boolean
}

export function PackageOptInModal({ packageInfo, legacy, onClose }: PackageOptInModalProps) {
  const t = useT()
  const [submitting, setSubmitting] = useState(false)
  const [showTools, setShowTools] = useState(false)
  // Late-arriving enable outcomes and retryable consent failures surface
  // here (not as toasts): the modal stays open until the user closes it, so
  // the correction is actually read (finding: "Late success hides reload
  // failure"). Reset on every confirm attempt — a stale message from a
  // previous attempt must never bleed into the next one.
  const [lateNotice, setLateNotice] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const Icon = packageIcon(packageInfo.id)
  const tools = packageInfo.tools ?? []
  // Tool-count disclosure, per protocol:
  //  - NEW (#102): `tools` = the tools matching THIS tab, `totalTools` = the
  //    package-wide count. An empty matching list means "no tool matches
  //    this site" — the package-wide count must be disclosed as ADDITIONAL
  //    tools on other origins, never as this site's count.
  //  - LEGACY (1.1.7): the payload carries a COUNT only, no per-tool list,
  //    so there is no per-site/package split to disclose — the count is the
  //    only truthful number, and no other-origins note is shown.
  const isLegacy = legacy === true
  const disclosedToolCount =
    tools.length > 0
      ? tools.length
      : isLegacy && typeof packageInfo.totalTools === 'number'
        ? packageInfo.totalTools
        : 0
  const showAdditionalTools =
    !isLegacy &&
    typeof packageInfo.totalTools === 'number' &&
    packageInfo.totalTools > tools.length

  const handleConfirm = async () => {
    setSubmitting(true)
    setLateNotice(null)
    setErrorMessage(null)
    // Legacy prompts (pre-#102 extension, issue #113) enable through the old
    // recipe bridge with NO consent token; the same result shape keeps the
    // timeout / reload-failure / failure handling below shared verbatim.
    const handleLateOutcome = (late: PackageOptInEnableResult) => {
      if (late.ok) {
        // Findings "Late success hides reload failure" / "Enabled package
        // skips page reload": a late ok with reloaded:false means the tools
        // are NOT active — direct the user to reload manually instead of
        // claiming plain success.
        setErrorMessage(null)
        if (late.reloaded === false) {
          setLateNotice(t('sidePanelPackage.enabledReloadFailedToast', { name: packageInfo.id }))
        } else {
          setLateNotice(t('sidePanelPackage.enabledToast', { name: packageInfo.id }))
        }
      }
      // A late FAILURE stays silent: the modal already showed the failure
      // path and the user can retry or close; re-toasting an error after the
      // fact would only nag.
    }
    const runEnable = (): Promise<PackageOptInEnableResult> =>
      legacy
        ? enableLegacyRecipeAndReload(packageInfo.id, handleLateOutcome)
        : enablePackageAndReload(packageInfo.id, packageInfo.consentToken ?? '', handleLateOutcome)
    // The 8s timeout may fire while the bridge call is still in flight; the
    // late-completion callback corrects the picture (success / manual-reload
    // notice) instead of leaving the user with an error while the package
    // enables silently. On TIMEOUT the modal stays OPEN, so this callback can
    // actually reach the user (finding: "Late success appears as failure").
    const result = await runEnable()
    setSubmitting(false)
    if (result.ok) {
      if (result.reloaded === false) {
        // Enabled but the page reload failed — the tools stay inactive until
        // the user reloads. Say so instead of claiming success.
        toast.info(t('sidePanelPackage.enabledReloadFailedToast', { name: packageInfo.id }))
      } else {
        toast.success(t('sidePanelPackage.enabledToast', { name: packageInfo.id }))
      }
      onClose()
    } else if (result.errorCode === 'CONSENT_REQUIRED') {
      // Findings "Expired consent blocks retry" / "Failed opt-ins block
      // retry": a lost/expired token (service-worker restart, slow confirm)
      // is RETRYABLE, not a user decision — no 1-day dismissal, or the
      // prompt could never come back to try with a fresh token. The modal
      // STAYS OPEN with the retry guidance (finding: "Retry guidance
      // disappears"): closing immediately would unmount the message before
      // the user reads it, and the re-probe would re-show a modal with no
      // explanation. The Confirm button retries with the same token first
      // (the background still accepts it within its TTL) and a fresh probe
      // replaces the token when it is truly expired.
      // eslint-disable-next-line no-console
      console.warn('[PackageOptInModal] consent token rejected — retry guidance stays in the modal', {
        packageId: packageInfo.id,
        error: result.error,
      })
      setErrorMessage(t('sidePanelPackage.consentRetryToast'))
      return
    } else if (result.errorCode === 'TIMEOUT') {
      // Finding "Late success appears as failure": a timeout is NOT the final
      // answer — the bridge call keeps running and its real outcome arrives
      // through the late callback. Keep the modal open (no dismissal
      // cooldown, no unmount), show retry guidance, and let the late callback
      // correct the picture when the enable actually lands. A retry clears
      // the message; the Not-now button remains available.
      // eslint-disable-next-line no-console
      console.warn('[PackageOptInModal] enable timed out — waiting for the late outcome; the modal stays open', {
        packageId: packageInfo.id,
      })
      setErrorMessage(t('sidePanelPackage.enableTimeoutToast'))
      return
    } else if (result.errorCode === 'VERIFY_INCOMPLETE' || result.errorCode === 'ENABLE_NOTIFY_FAILED') {
      // Finding "Enabled package reported failed": the background wrote the
      // config AND reloaded the tab, but the post-write verification read
      // kept failing transiently — the enable itself is committed and the
      // outcome is explicitly NOT a failure. Treating it as one (the generic
      // branch below) would record the 1-day cooldown for a done deal and
      // claim "Failed to enable" while the tools are already active. Show
      // honest guidance instead, no dismissal.
      // ENABLE_NOTIFY_FAILED (finding: "Enable reports failure after
      // committing") is the same partial-success shape one step earlier: the
      // config write committed but the catalog-refresh sentinel could not be
      // delivered — the tools register on the next unrelated refresh.
      // eslint-disable-next-line no-console
      console.warn('[PackageOptInModal] enable landed but could not be verified — no cooldown recorded', {
        packageId: packageInfo.id,
        error: result.error,
      })
      toast.warning(
        t('sidePanelPackage.enabledVerificationUnavailableToast', { name: packageInfo.id }),
      )
      onClose()
    } else {
      // Structured failure: log for diagnosis, cool the prompt down so it
      // does not reappear immediately in a broken state, surface the toast.
      // eslint-disable-next-line no-console
      console.error('[PackageOptInModal] enable failed:', {
        packageId: packageInfo.id,
        errorCode: result.errorCode,
        error: result.error,
      })
      dismissPackagePrompt(packageInfo.id)
      toast.error(t('sidePanelPackage.enableFailedToast'))
      onClose()
    }
    // Reached only by the non-timeout paths above (all of which already
    // closed the modal); the CONSENT_REQUIRED and TIMEOUT branches return
    // early to keep the modal open with their retry guidance.
  }

  const handleDismiss = () => {
    dismissPackagePrompt(packageInfo.id)
    onClose()
  }

  return (
    // Backdrop deliberately has no onClick (mirrors ToolAuthModal): an
    // accidental outside click must not be recorded as a consent decision.
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('sidePanelPackage.title')}
    >
      <div
        className="mx-4 flex max-h-[88%] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="shrink-0 border-b border-border px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-100 text-primary-600 dark:bg-primary-50/50 dark:text-primary-500">
              <Icon className="h-5 w-5" aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-semibold text-foreground">
                {t('sidePanelPackage.title')}
              </h2>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {packageInfo.hostname}
              </p>
            </div>
          </div>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p className="text-sm leading-relaxed text-foreground">
            {t('sidePanelPackage.description', { count: disclosedToolCount })}
          </p>

          {/* Package card */}
          <div className="mt-3 flex items-start gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-foreground">
                {packageInfo.id}
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {packageInfo.description}
              </p>
            </div>
          </div>

          {/* Collapsible tool list (same disclosure pattern as PageContextCard) */}
          {tools.length > 0 && (
            <div className="mt-3 overflow-hidden rounded-lg border border-border">
              <button
                type="button"
                className="flex w-full items-center gap-1.5 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                onClick={() => setShowTools(value => !value)}
                aria-expanded={showTools}
                aria-label={showTools ? t('sidePanelPackage.toolsCollapse') : t('sidePanelPackage.toolsExpand')}
              >
                {showTools ? (
                  <ChevronDown className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0" />
                )}
                <Wrench className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {t('sidePanelPackage.toolsTitle', { count: tools.length })}
                </span>
              </button>
              {showTools && (
                <ul className="custom-scrollbar max-h-[140px] overflow-y-auto">
                  {tools.map((tool, index) => {
                    const ToolIcon = toolIcon(tool.name)
                    return (
                      <li
                        key={tool.name}
                        className={`flex items-start gap-2 px-3 py-1.5 text-[11px] leading-relaxed ${
                          index % 2 === 0 ? 'bg-muted/40' : 'bg-transparent'
                        }`}
                      >
                        <ToolIcon
                          className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="font-mono text-foreground">{tool.name}</span>
                          {tool.description ? (
                            <span className="text-muted-foreground"> — {tool.description}</span>
                          ) : null}
                        </span>
                        <span
                          className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${
                            tool.readOnly
                              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                              : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                          }`}
                        >
                          {tool.readOnly
                            ? t('sidePanelPackage.readOnly')
                            : t('sidePanelPackage.write')}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}

          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            {t('sidePanelPackage.privacyNote')}
          </p>

          {errorMessage && (
            <p role="alert" className="mt-2 text-xs leading-relaxed text-red-600 dark:text-red-400">
              {errorMessage}
            </p>
          )}
          {lateNotice && (
            <p role="status" className="mt-2 text-xs leading-relaxed text-emerald-600 dark:text-emerald-400">
              {lateNotice}
            </p>
          )}

          {showAdditionalTools && (
            <p className="mt-2 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
              {t('sidePanelPackage.additionalToolsNote', {
                count: packageInfo.totalTools! - tools.length,
              })}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex shrink-0 justify-end gap-2 border-t border-border px-5 py-3.5">
          <button
            type="button"
            className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
            onClick={handleDismiss}
            disabled={submitting}
          >
            {t('sidePanelPackage.notNow')}
          </button>
          <button
            type="button"
            className="rounded-lg bg-primary-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
            onClick={() => void handleConfirm()}
            disabled={submitting}
          >
            {submitting ? t('sidePanelPackage.enabling') : t('sidePanelPackage.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
