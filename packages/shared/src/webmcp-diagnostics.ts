export interface WebMCPRejectedPackage {
  id: string
  reason: string
}

export interface WebMCPCatalogDiagnostics {
  catalogStatus: 'loading' | 'ready' | 'failed'
  rejected: WebMCPRejectedPackage[]
}

/** Ephemeral results from the same scan as the discovered tool list. */
export interface WebMCPDiscoveryDiagnostics extends WebMCPCatalogDiagnostics {
  tabs: Array<{
    tabId: number
    url: string
    adapterCount: number
    toolCount: number
    rejectedPackageIds: string[]
  }>
}
