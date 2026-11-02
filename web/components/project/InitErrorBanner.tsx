'use client'

import { useState } from 'react'
import { BrandButton, BrandDialog, BrandDialogBody, BrandDialogFooter } from '@creatorweave/ui'
import { useT } from '@/i18n'
import { useProjectStore } from '@/store/project.store'
import { runDiagnostics, copyMarkdownToClipboard } from '@/storage/diagnostics'

/**
 * Shared initialization-failure banner (issue #131).
 *
 * Rendered by BOTH ProjectHomeView and WorkspaceRouteView so a direct
 * workspace URL (/projects/:id/...) also surfaces the error with a Retry —
 * previously only the projects list page handled it and a refreshed
 * workspace route stayed unusable with no error and no action (Sourcery:
 * "Workspace route stays unusable").
 *
 * Diagnostics stay reachable (Sourcery round 2: "Diagnostics become
 * inaccessible"): the banner carries its own Run Diagnostics action — run
 * + copy-report dialog — so users can collect and attach the requested
 * report even when the init failure hides the normal ProjectHome (and with
 * it the HomeSettingsDrawer entry point).
 *
 * Copy tone follows initErrorKind: known transient contention failures
 * reassure ("projects are safe, retrying usually fixes it"); corruption and
 * UNCLASSIFIED failures get neutral, non-reassuring copy — the code has no
 * basis to promise the data is safe (Sourcery: "Storage damage gets
 * reassurance").
 *
 * Retry semantics (Sourcery "Retry shows a misleading empty state" +
 * "Retry can become a no-op"):
 *  - The banner stays rendered while a retry is in flight — the store keeps
 *    `initError`/`initializingRetry` until the attempt resolves, so the empty
 *    project list never flashes as "No projects yet".
 *  - The store's initialize() de-duplicates concurrent attempts and a failed
 *    attempt invalidates `initialized`, so the button always triggers a real
 *    re-run instead of returning at the initialized guard.
 */
export function InitErrorBanner() {
  const t = useT()
  const initError = useProjectStore((s) => s.initError)
  const initErrorKind = useProjectStore((s) => s.initErrorKind)
  const initializingRetry = useProjectStore((s) => s.initializingRetry)
  const isLoading = useProjectStore((s) => s.isLoading)
  const initializeProjects = useProjectStore((s) => s.initialize)

  const [isRetrying, setIsRetrying] = useState(false)
  const [diagOpen, setDiagOpen] = useState(false)
  const [diagRunning, setDiagRunning] = useState(false)
  const [diagReport, setDiagReport] = useState('')
  const [diagCopied, setDiagCopied] = useState(false)

  if (!initError) return null

  const busy = isRetrying || initializingRetry || isLoading

  const handleRetry = async () => {
    setIsRetrying(true)
    try {
      await initializeProjects()
    } finally {
      setIsRetrying(false)
    }
  }

  const handleRunDiagnostics = async () => {
    setDiagOpen(true)
    setDiagRunning(true)
    setDiagReport('')
    setDiagCopied(false)
    try {
      const report = await runDiagnostics()
      setDiagReport(report.markdown)
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      setDiagReport(`${t('projectHome.dialogs.diagnosticsFailed')}\n\n${detail}`)
    } finally {
      setDiagRunning(false)
    }
  }

  const handleCopyReport = async () => {
    if (!diagReport) return
    const ok = await copyMarkdownToClipboard(diagReport)
    if (ok) {
      setDiagCopied(true)
      window.setTimeout(() => setDiagCopied(false), 2000)
    }
  }

  const hintKey =
    initErrorKind === 'corruption'
      ? 'app.projectsInitCorruptionHint'
      : initErrorKind === 'transient'
        ? 'app.projectsInitErrorHint'
        : 'app.projectsInitUnknownHint'

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background px-6">
      <div
        role="alert"
        className="w-full max-w-md rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-center"
      >
        <h1 className="mb-2 text-base font-semibold text-foreground">
          {t('app.initFailed')}
        </h1>
        <p className="mb-1 break-words text-sm text-muted-foreground">
          {initError}
        </p>
        <p className="mb-5 text-sm text-muted-foreground">{t(hintKey)}</p>
        <div className="flex flex-col items-center gap-2">
          <BrandButton
            variant="primary"
            onClick={() => void handleRetry()}
            // Disable while diagnostics runs (Sourcery: "Retry discards
            // running diagnostic report") — a successful retry unmounts this
            // banner, which would throw away the pending report before the
            // user can copy it.
            disabled={busy || diagRunning}
          >
            {busy ? t('app.projectsInitRetrying') : t('app.retry')}
          </BrandButton>
          <BrandButton
            variant="outline"
            onClick={() => void handleRunDiagnostics()}
            disabled={diagRunning}
          >
            {diagRunning
              ? t('projectHome.dialogs.diagnosticsInProgress')
              : t('projectHome.sidebar.runDiagnostics')}
          </BrandButton>
        </div>
      </div>

      {/* Run-diagnostics report dialog (Sourcery: keep Diagnostics reachable
          even when the init failure hides the settings drawer). */}
      <BrandDialog open={diagOpen} onOpenChange={setDiagOpen}>
        <BrandDialogBody>
          {diagRunning ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('projectHome.dialogs.diagnosticsRunning')}
            </p>
          ) : (
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-secondary">
              {diagReport}
            </pre>
          )}
        </BrandDialogBody>
        <BrandDialogFooter>
          <BrandButton variant="ghost" onClick={() => setDiagOpen(false)} disabled={diagRunning}>
            {t('common.close')}
          </BrandButton>
          <BrandButton
            variant="primary"
            onClick={() => void handleCopyReport()}
            disabled={diagRunning || !diagReport}
          >
            {diagCopied ? t('projectHome.dialogs.copied') : t('projectHome.dialogs.copyReport')}
          </BrandButton>
        </BrandDialogFooter>
      </BrandDialog>
    </div>
  )
}
