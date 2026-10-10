/**
 * ExtensionOutdatedBanner — top banners for installed extensions:
 *
 *   outdated     → a manual/self-hosted install is older than the bundled ZIP.
 *                  Store-managed installs are intentionally excluded until
 *                  channel-specific published version metadata exists.
 *
 * An installed version newer than this web build is intentionally ignored:
 * the extension store may still be reviewing that version, so the web build
 * must not ask users to refresh or install an unavailable release.
 */

import { useState, useEffect } from 'react'
import { AlertTriangle, Download, X } from 'lucide-react'
import { useT } from '@/i18n'
import { useExtensionStore } from '@/store/extension.store'
import { APP_BUILD_ID, EXTENSION_LATEST_VERSION } from '@/app-build'
import { isMobileDeviceForExtension } from '@/lib/extension-distribution'

export function ExtensionOutdatedBanner() {
  const t = useT()
  const status = useExtensionStore((s) => s.status)
  const extensionVersion = useExtensionStore((s) => s.extensionVersion)
  const latestVersion = EXTENSION_LATEST_VERSION
  const shouldShowOutdatedBanner = useExtensionStore((s) => s.shouldShowOutdatedBanner)
  const dismissOutdatedBanner = useExtensionStore((s) => s.dismissOutdatedBanner)
  // Only meaningful when the extension is installed, which mobile devices can
  // never have — gate here so both banners are structurally mobile-free.
  const isMobile = isMobileDeviceForExtension()
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (isMobile) return
    if (status === 'checking') return
    setVisible(shouldShowOutdatedBanner())
  }, [isMobile, status, extensionVersion, shouldShowOutdatedBanner])

  if (!visible || isMobile) return null

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
}
