/**
 * Storage Initialization Loading Screen
 *
 * A polished loading state shown while the application initializes.
 * Uses brand components for consistent styling.
 */

import {
  BrandCard,
  BrandCardHeader,
  BrandCardTitle,
  BrandCardDescription,
  BrandProgress,
} from '@creatorweave/ui'
import { AlertTriangle, Database, Download, RefreshCw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n'
import { BrandName } from '@/components/BrandName'

export interface StorageLoadingProps {
  /** Optional progress percentage (0-100) */
  progress?: number
  /** Whether to show indeterminate loading animation */
  isLoading?: boolean
  /** Error message to display */
  error?: string | null
  /** Whether the error can be fixed by resetting the database */
  canReset?: boolean
  /** Callback when user clicks the reset button */
  onReset?: () => void
  /** Callback when user clicks the export button. Renders the button only when set. */
  onExport?: () => void
}

/**
 * Loading screen shown during application initialization
 */
export function StorageLoading({
  progress,
  isLoading = true,
  error,
  canReset = false,
  onReset,
  onExport,
}: StorageLoadingProps) {
  const t = useT()

  // Two-step confirmation for the destructive "Reset Database" action.
  // First click arms the button; a second click within the timeout window
  // actually performs the reset. This prevents accidental data loss.
  const [resetArmed, setResetArmed] = useState(false)
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const RESET_ARM_TIMEOUT_MS = 5000

  const disarmReset = () => {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current)
      resetTimerRef.current = null
    }
    setResetArmed(false)
  }

  // Clean up the timer if the component unmounts or the dialog state changes.
  useEffect(() => {
    return disarmReset
  }, [])

  const handleResetClick = () => {
    if (!resetArmed) {
      // First click: arm the confirmation. Auto-disarm after a short window.
      setResetArmed(true)
      resetTimerRef.current = setTimeout(disarmReset, RESET_ARM_TIMEOUT_MS)
      return
    }
    // Second click within the window: perform the destructive action.
    disarmReset()
    onReset?.()
  }

  // Error state
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-900">
        <div className="w-full max-w-md">
          <BrandCard
            variant="info"
            className="border-danger-500 bg-red-50 text-center dark:bg-red-950/20"
          >
            <BrandCardHeader className="items-center justify-center pb-6">
              {/* Error Icon */}
              <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-red-100 dark:bg-red-900/30">
                <AlertTriangle className="h-6 w-6 text-red-600 dark:text-red-400" />
              </div>

              <BrandCardTitle className="text-xl text-red-900 dark:text-red-100">
                {t('app.databaseInitFailed')}
              </BrandCardTitle>
              <BrandCardDescription className="mt-2 text-sm text-red-700 dark:text-red-300">
                {error}
              </BrandCardDescription>
            </BrandCardHeader>

            <div className="space-y-4 px-6 pb-6">
              {canReset && (
                <>
                  <p className="text-sm text-neutral-600 text-neutral-400 text-neutral-400 dark:text-neutral-400">
                    {t('app.databaseResetExplanation')}
                  </p>
                  {/* Hint about the most common cause (cleaner tools wiping OPFS).
                      Kept short so the page doesn't feel like a wall of text. */}
                  <p className="text-xs text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
                    {t('app.databaseCorruptedHint')}
                  </p>
                  {onExport && (
                    <button
                      className="border-primary-100 text-primary-700 hover:bg-primary-50 flex w-full items-center justify-center gap-2 rounded-md border bg-white px-4 py-2 text-sm font-medium transition-colors dark:border-primary-700 dark:text-primary-700 dark:hover:bg-primary-50/30"
                      onClick={onExport}
                    >
                      <Download className="h-4 w-4" />
                      {t('app.exportDatabase')}
                    </button>
                  )}
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    {t('app.exportBeforeResetWarning')}
                  </p>
                  <button
                    aria-live="polite"
                    className={
                      resetArmed
                        ? 'animate-pulse flex w-full items-center justify-center gap-2 rounded-md bg-danger-600 px-4 py-2 text-sm font-bold text-white ring-2 ring-danger-300 transition-colors'
                        : 'bg-danger-600 hover:bg-danger-700 flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white transition-colors'
                    }
                    onClick={handleResetClick}
                    onBlur={disarmReset}
                  >
                    <Database className="h-4 w-4" />
                    {resetArmed
                      ? t('app.resetDatabaseConfirm')
                      : t('app.resetDatabase')}
                  </button>
                  {resetArmed && (
                    <p className="text-center text-xs text-danger-600 dark:text-danger-400">
                      {t('app.resetDatabaseArmedHint')}
                    </p>
                  )}
                </>
              )}

              <div className="pt-2">
                <button
                  className="hover:bg-hover flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-secondary transition-colors"
                  onClick={() => window.location.reload()}
                >
                  <RefreshCw className="h-4 w-4" />
                  {t('app.reloadPage')}
                </button>
              </div>
            </div>
          </BrandCard>

          <p className="mt-4 text-center text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500"><BrandName name={t('app.productName')} /></p>
        </div>
      </div>
    )
  }

  // Normal loading state
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-50 p-4 dark:bg-neutral-900">
      <div className="w-full max-w-md">
        <BrandCard variant="info" className="text-center">
          <BrandCardHeader className="items-center justify-center pb-6">
            {/* Logo */}
            <img src="/favicon.svg" alt="" className="mb-4 h-12 w-12" />

            <BrandCardTitle className="text-xl"><BrandName name={t('app.productName')} /></BrandCardTitle>
            <BrandCardDescription className="mt-1">{t('app.initializing')}</BrandCardDescription>
          </BrandCardHeader>

          <div className="space-y-4 px-6 pb-6">
            {/* Progress bar */}
            {progress !== undefined ? (
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-secondary">{t('app.loadProgress')}</span>
                  <span className="font-medium">{progress}%</span>
                </div>
                <BrandProgress value={progress} size="md" rounded="md" />
              </div>
            ) : isLoading ? (
              <div className="space-y-2">
                <div className="h-6 text-sm text-secondary">{t('app.preparing')}</div>
                <BrandProgress size="md" rounded="md" />
              </div>
            ) : null}
          </div>
        </BrandCard>

        <p className="mt-4 text-center text-xs text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500"><BrandName name={t('app.productName')} /></p>
      </div>
    </div>
  )
}

/**
 * Compact inline loading indicator
 */
export function StorageLoadingInline({ message }: { message?: string }) {
  const t = useT()
  return (
    <div className="flex items-center gap-3 text-secondary">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary-600 border-t-transparent" />
      <span className="text-sm">{message || t('common.loading')}</span>
    </div>
  )
}
