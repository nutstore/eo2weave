import { afterEach, expect, it } from 'vitest'
import { useWebMCPStore } from '../store'
import type { WebMCPDiscoveryDiagnostics } from '@creatorweave/shared/webmcp-diagnostics'

const diagnostics: WebMCPDiscoveryDiagnostics = {
  catalogStatus: 'ready',
  rejected: [],
  tabs: [
    {
      tabId: 7,
      url: 'https://example.com/',
      adapterCount: 0,
      toolCount: 0,
      rejectedPackageIds: [],
    },
  ],
}
afterEach(() => useWebMCPStore.getState().clearCatalog())

it('publishes the tool list, timestamp and diagnostics in one state update', () => {
  const observed: Array<{ scan: number | null; diagnostics: WebMCPDiscoveryDiagnostics | null }> =
    []
  const unsubscribe = useWebMCPStore.subscribe((state) =>
    observed.push({ scan: state.lastScanAt, diagnostics: state.diagnostics })
  )
  useWebMCPStore.getState().setDiscoveredTools([], 123, diagnostics)
  unsubscribe()
  expect(observed).toEqual([{ scan: 123, diagnostics }])
})
it('drops diagnostics when an old extension omits them or the catalog is cleared', () => {
  const state = useWebMCPStore.getState()
  state.setDiscoveredTools([], 1, diagnostics)
  state.setDiscoveredTools([], 2)
  expect(useWebMCPStore.getState().diagnostics).toBeNull()
  state.setDiscoveredTools([], 3, diagnostics)
  state.clearCatalog()
  expect(useWebMCPStore.getState().diagnostics).toBeNull()
})
