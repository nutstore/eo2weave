import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useT } from '@/i18n'
import {
  isWebMCPBridgeAvailable,
  refreshWebMCPCatalog,
  useWebMCPStore,
} from '@/webmcp'
import { useSettingsStore } from '@/store/settings.store'
import { useExtensionStore } from '@/store/extension.store'
import { isMobileDeviceForExtension } from '@/lib/extension-distribution'
import { ExternalTrustCard } from '@/components/external-tools/ExternalTrustCard'
import { WebMCPGlobalToggleCard } from '@/components/webmcp/WebMCPGlobalToggleCard'
import { WebMCPHostList } from '@/components/webmcp/WebMCPHostList'
import { WebMCPPackageRegistrySection } from '@/components/webmcp/WebMCPPackageRegistrySection'

/**
 * WebMCP settings — global switches + read-only tool list.
 *
 * Top of the page, in order:
 * 1. The shared external-trust switch (identical to the MCP page's card).
 * 2. The WebMCP global toggle (discovery/registration control).
 * 3. The discovered hosts list — read-only; per-site authorization lives
 *    exclusively in the extension popup.
 */
export function WebMCPSettings() {
  const t = useT()
  const catalogByHost = useWebMCPStore((state) => state.catalogByHost)
  const lastScanAt = useWebMCPStore((state) => state.lastScanAt)
  const globalEnabled = useSettingsStore((state) => state.enableWebMCP)
  const extensionStatus = useExtensionStore((state) => state.status)
  const extensionInstalled = extensionStatus === 'installed'
  const [refreshing, setRefreshing] = useState(false)

  const bridgeAvailable = isWebMCPBridgeAvailable()

  const hosts = useMemo(
    () =>
      Object.values(catalogByHost).sort((a, b) =>
        a.hostname.localeCompare(b.hostname)
      ),
    [catalogByHost]
  )

  const handleRefresh = async () => {
    if (!bridgeAvailable) {
      toast.error(t('settings.webMCPBridgeUnavailable'))
      return
    }

    setRefreshing(true)
    try {
      const tools = await refreshWebMCPCatalog()
      const count = tools.length
      toast.success(
        t('settings.webMCPRefreshSuccess').replace('{count}', String(count))
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      toast.error(t('settings.webMCPRefreshFailed') + `: ${message}`)
    } finally {
      setRefreshing(false)
    }
  }

  const handleInstallExtension = () => {
    useExtensionStore.getState().openInstallGuide()
  }

  // Mobile browsers cannot install extensions — hide the install prompt;
  // the rest of the WebMCP card (status, refresh, host list) stays unchanged.
  const showInstallPrompt = !bridgeAvailable && !extensionInstalled && !isMobileDeviceForExtension()

  const formatTime = (timestamp: number) =>
    new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })

  return (
    <div className="space-y-4 py-1">
      {/* 1. Shared trust switch — identical card to the MCP page */}
      <ExternalTrustCard t={t} />

      <WebMCPGlobalToggleCard
        t={t}
        globalEnabled={globalEnabled}
        togglingGlobal={false}
        bridgeAvailable={bridgeAvailable}
        extensionInstalled={extensionInstalled}
        lastScanAt={lastScanAt}
        refreshing={refreshing}
        onToggleGlobal={undefined}
        onRefresh={handleRefresh}
        onInstallExtension={handleInstallExtension}
        showInstallPrompt={showInstallPrompt}
        formatTime={formatTime}
      />

      {globalEnabled && <WebMCPHostList t={t} hosts={hosts} />}

      {/* Package registry installer (issue #117) — user-added registries only */}
      <WebMCPPackageRegistrySection t={t} />
    </div>
  )
}
