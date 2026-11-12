import { expect, it } from 'vitest'
import { filterDiagnosticsByHostAuthorization } from '../../../browser-extension/entrypoints/webmcp/authorization'

it('does not expose disabled-site URLs or package matches through diagnostics', () => {
  const diagnostics = {
    catalogStatus: 'ready' as const,
    rejected: [],
    tabs: [
      {
        tabId: 1,
        url: 'https://private.test/account',
        adapterCount: 1,
        toolCount: 1,
        rejectedPackageIds: ['com.private'],
      },
      {
        tabId: 2,
        url: 'https://public.test/',
        adapterCount: 0,
        toolCount: 0,
        rejectedPackageIds: [],
      },
    ],
  }
  const filtered = filterDiagnosticsByHostAuthorization(diagnostics, { 'private.test': false })
  expect(filtered.tabs.map((tab) => tab.tabId)).toEqual([2])
  expect(diagnostics.tabs).toHaveLength(2)
})
