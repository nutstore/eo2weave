import type { WebMCPDiscoveryDiagnostics } from '@creatorweave/shared/webmcp-diagnostics'

/** UI-only reasons, frozen with the tool list; never injected into the LLM prompt. */
export type WebmcpAvailabilityState =
  | 'ok'
  | 'host-disabled'
  | 'unavailable'
  | 'no-matching-package'
  | 'package-empty'
  | 'package-rejected'
  | 'catalog-refresh-failed'

export const WEBMCP_AVAILABILITY_MESSAGE_KEYS: Record<WebmcpAvailabilityState, string> = {
  ok: 'conversation.pageContextWebmcpNoTools',
  'host-disabled': 'conversation.pageContextWebmcpHostDisabled',
  unavailable: 'conversation.pageContextWebmcpNoTools',
  'no-matching-package': 'conversation.pageContextWebmcpNoMatchingPackage',
  'package-empty': 'conversation.pageContextWebmcpPackageEmpty',
  'package-rejected': 'conversation.pageContextWebmcpPackageRejected',
  'catalog-refresh-failed': 'conversation.pageContextWebmcpCatalogRefreshFailed',
}

export function deriveWebmcpAvailability(input: {
  globalEnabled: boolean
  hostEnabled: boolean
  toolCount: number
  tabId?: number | null
  url?: string | null
  diagnostics?: WebMCPDiscoveryDiagnostics | null
}): WebmcpAvailabilityState {
  if (!input.globalEnabled || !input.hostEnabled) return 'host-disabled'
  if (input.toolCount > 0) return 'ok'
  const { diagnostics } = input
  const tab = diagnostics?.tabs.find((tab) => tab.tabId === input.tabId && tab.url === input.url)
  if (!tab || !diagnostics || diagnostics.catalogStatus === 'loading') return 'unavailable'
  if (diagnostics.catalogStatus === 'failed') return 'catalog-refresh-failed'
  if (tab.rejectedPackageIds.length > 0) return 'package-rejected'
  return tab.adapterCount > 0 ? 'package-empty' : 'no-matching-package'
}
