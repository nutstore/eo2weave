/**
 * ExtensionOutdatedBanner — top banners for installed extensions:
 *
 *   outdated     → installed < latest. Warning banner offering BOTH update
 *                  channels (store first — one click + auto-updates; zip as
 *                  the fallback for networks that can't reach the store).
 *   newerThanWeb → installed > latest known to this web build (the store
 *                  auto-updated ahead of the web deploy). Informational,
 *                  dismissible for 3 days, suggests refreshing the web app.
 *
 * The two are mutually exclusive; outdated wins.
 */

import { useState, useEffect } from 'react'
import { AlertTriangle, Store, Download, Sparkles, RefreshCw, X } from 'lucide-react'
import { useT } from '@/i18n'
import { useExtensionStore } from '@/store/extension.store'
import { APP_BUILD_ID, EXTENSION_LATEST_VERSION } from '@/app-build'
import { CHROME_WEB_STORE_URL } from '@/lib/extension-distribution'

export function ExtensionOutdatedBanner() {
  const t = useT()
  const status = useExtensionStore((s) => s.status)
  const extensionVersion = useExtensionStore((s) => s.extensionVersion)
  const newerThanWeb = useExtensionStore((s) => s.newerThanWeb)
  const latestVersion = EXTENSION_LATEST_VERSION
  const shouldShowOutdatedBanner = useExtensionStore((s) => s.shouldShowOutdatedBanner)
  const shouldShowNewerBanner = useExtensionStore((s) => s.shouldShowNewerBanner)
  const dismissOutdatedBanner = useExtensionStore((s) => s.dismissOutdatedBanner)
  const dismissNewerBanner = useExtensionStore((s) => s.dismissNewerBanner)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (status === 'checking') return
    setVisible(shouldShowOutdatedBanner() || shouldShowNewerBanner())
  }, [status, extensionVersion, newerThanWeb, shouldShowOutdatedBanner, shouldShowNewerBanner])

  if (!visible) return null

  const outdated = shouldShowOutdatedBanner()

  // --- Outdated: warning banner with both update channels ---------------
  if (outdated) {
    return (
      <div className="relative flex items-center justify-between gap-3 border-b border-warning-200 bg-gradient-to-r from-warning-50 to-warning-100 px-4 py-2.5 dark:border-warning-200/30 dark:from-warning-100/15 dark:to-warning-100/5">
        <div className="flex items-center gap-3 min-w-0">
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning" />
          <div className="min-w-0">
            <span className="text-sm font-medium text-warning-900">
              {t('extension.outdatedBannerTitle')}
            </span>
            <span className="ml-2 hidden text-sm text-warning dark:text-warning-200 sm:inline">
              {t('extension.outdatedBannerDescription')
                .replace('{current}', extensionVersion || '?')
                .replace('{latest}', latestVersion)}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {/* Store first — one-click install + auto-updates */}
          <button
            type="button"
            onClick={() => window.open(CHROME_WEB_STORE_URL, '_blank')}
            className="flex items-center gap-1.5 rounded-md bg-warning px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-warning-500 focus:outline-none focus:ring-2 focus:ring-warning focus:ring-offset-2"
          >
            <Store className="h-3.5 w-3.5" />
            {t('extension.outdatedBannerStoreAction')}
          </button>
          {/* Zip fallback for networks that can't reach the store */}
          <button
            type="button"
            onClick={() => window.open(`/chrome-extension.zip?v=${APP_BUILD_ID}`, '_blank')}
            className="flex items-center gap-1.5 rounded-md border border-warning px-3 py-1 text-xs font-medium text-warning transition-colors hover:bg-warning-50 dark:hover:bg-warning-100/10 focus:outline-none focus:ring-2 focus:ring-warning focus:ring-offset-2"
          >
            <Download className="h-3.5 w-3.5" />
            {t('extension.outdatedBannerZipAction')}
          </button>
          <button
            type="button"
            onClick={() => {
              dismissOutdatedBanner()
              setVisible(false)
            }}
            className="rounded p-1 text-warning-200 transition-colors hover:bg-warning-100 hover:text-warning focus:outline-none focus:ring-2 focus:ring-warning focus:ring-offset-2 dark:hover:bg-warning-100/30"
            aria-label={t('extension.bannerDismiss')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    )
  }

  // --- Newer than web: informational banner -----------------------------
  return (
    <div className="relative flex items-center justify-between gap-3 border-b border-primary-200 bg-primary-50 px-4 py-2.5 dark:border-primary-200/20 dark:bg-primary-100/10">
      <div className="flex items-center gap-3 min-w-0">
        <Sparkles className="h-4 w-4 shrink-0 text-primary-600 dark:text-primary-400" />
        <div className="min-w-0">
          <span className="text-sm font-medium text-secondary">
            {t('extension.newerBannerTitle')}
          </span>
          <span className="ml-2 hidden text-sm text-tertiary sm:inline">
            {t('extension.newerBannerDescription')
              .replace('{current}', extensionVersion || '?')
              .replace('{web}', latestVersion)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-600 focus:ring-offset-2 dark:bg-primary-500 dark:hover:bg-primary-600"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t('extension.newerBannerRefreshAction')}
        </button>
        <button
          type="button"
          onClick={() => {
            dismissNewerBanner()
            setVisible(false)
          }}
          className="rounded p-1 text-tertiary transition-colors hover:bg-primary-100 hover:text-secondary dark:hover:bg-primary-100/20"
          aria-label={t('extension.bannerDismiss')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
