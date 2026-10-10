/**
 * Component test for ExtensionOutdatedBanner (PR #36 behavior):
 * an installed extension NEWER than the web build must not render any
 * banner — the store may release ahead of the web deploy, and refreshing
 * cannot make that version available, so the old "refresh to sync"
 * informational banner was removed.
 */
import { render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionOutdatedBanner } from '../ExtensionOutdatedBanner'
import { useExtensionStore } from '@/store/extension.store'

vi.mock('@/i18n', () => ({
  useT: () => (key: string, params?: Record<string, string | number>) => {
    let text = key
    if (params) for (const [k, v] of Object.entries(params)) text += `:${k}=${v}`
    return text
  },
}))

vi.mock('@/lib/extension-distribution', () => ({
  isMobileDeviceForExtension: () => false,
  isEdgeBrowser: () => false,
}))

vi.mock('@/app-build', () => ({
  APP_BUILD_ID: 'test-build',
  EXTENSION_LATEST_VERSION: '1.0.0',
}))

function setStore(overrides: Partial<ReturnType<typeof useExtensionStore.getState>>) {
  useExtensionStore.setState({
    status: 'installed',
    extensionVersion: '1.0.0',
    outdated: false,
    ...overrides,
  } as ReturnType<typeof useExtensionStore.getState>)
}

describe('ExtensionOutdatedBanner', () => {
  beforeEach(() => {
    useExtensionStore.setState({
      status: 'checking',
      extensionVersion: null,
      outdated: false,
      outdatedBannerDismissedAt: null,
    } as ReturnType<typeof useExtensionStore.getState>)
  })

  it('renders the outdated warning for an older manual install', async () => {
    setStore({ extensionVersion: '0.9.0', outdated: true })
    render(<ExtensionOutdatedBanner />)
    await waitFor(() => {
      // The warning banner container carries the warning gradient styling.
      expect(document.querySelector('[class*="from-warning-50"]')).not.toBeNull()
    })
  })

  it('renders nothing when the installed extension is newer than the web build', async () => {
    // newerThanWeb state was removed entirely (PR #36): no banner either way.
    setStore({ extensionVersion: '2.0.0', outdated: false })
    const { container } = render(<ExtensionOutdatedBanner />)
    await waitFor(() => {
      expect(container.querySelector('.bg-warning')).toBeNull()
    })
    expect(container.textContent).toBe('')
  })

  it('renders nothing when versions match', async () => {
    setStore({ extensionVersion: '1.0.0', outdated: false })
    const { container } = render(<ExtensionOutdatedBanner />)
    await waitFor(() => {
      expect(container.textContent).toBe('')
    })
  })
})
