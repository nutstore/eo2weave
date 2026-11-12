import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionMenu, OFFLINE_GUIDE, isPlainClick } from './ExtensionMenu'
import { SiteHeader } from './SiteHeader'
import { chromeCopy } from './copy'
import { DownloadCn } from '../pages/download/DownloadCn'
import { DownloadGlobal } from '../pages/download/DownloadGlobal'

const mocks = vi.hoisted(() => ({ push: vi.fn(), status: 'not_detected' as 'not_detected' | 'connected' | 'checking' }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: mocks.push }) }))
vi.mock('./useExtensionStatus', () => ({ useExtensionStatus: () => mocks.status }))
vi.mock('next/link', async () => {
  const { forwardRef } = await import('react')
  return {
    default: forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }>(
      ({ children, ...props }, ref) => <a {...props} ref={ref} data-client-link="true">{children}</a>,
    ),
  }
})

beforeEach(() => { vi.useFakeTimers(); mocks.push.mockClear(); mocks.status = 'not_detected' })
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks() })

function clickWithoutNavigation(element: HTMLElement, init?: MouseEventInit) {
  element.addEventListener('click', event => event.preventDefault(), { once: true })
  fireEvent.click(element, init)
}

describe('marketing navigation', () => {
  it('opens the experience after choosing Chrome Web Store', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Safari/537.36')
    render(<ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />)
    fireEvent.click(screen.getByText('安装浏览器插件'))
    clickWithoutNavigation(screen.getByText('Chrome 应用商店'))
    expect(screen.getByText('Chrome 应用商店')).toBeTruthy()
    vi.runOnlyPendingTimers()
    expect(mocks.push).toHaveBeenCalledWith('/experience?from=store')
  })

  it('does not change the current page for a modified store click', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0')
    render(<ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />)
    clickWithoutNavigation(screen.getByText('安装浏览器插件'), { ctrlKey: true })
    vi.runOnlyPendingTimers()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('does not open the store while extension detection is still running', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0')
    mocks.status = 'checking'
    render(<ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />)
    clickWithoutNavigation(screen.getByText('正在检测…'))
    vi.runOnlyPendingTimers()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('opens the experience after selecting the Edge store, but not after opening the app', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0')
    const view = render(<ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />)
    clickWithoutNavigation(screen.getByText('安装浏览器插件'))
    vi.runOnlyPendingTimers()
    expect(mocks.push).toHaveBeenCalledWith('/experience?from=store')
    mocks.push.mockClear()
    mocks.status = 'connected'
    view.rerender(<ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />)
    clickWithoutNavigation(screen.getByText('立即使用'))
    vi.runOnlyPendingTimers()
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it('offers the offline package and routes a plain click to the install guide', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Safari/537.36')
    render(<ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />)
    fireEvent.click(screen.getByText('安装浏览器插件'))
    const offline = screen.getByText('离线安装包').closest('a')!
    // Modified clicks must keep downloading the archive directly.
    expect(offline.getAttribute('href')).toBe('/chrome-extension.zip')
    expect(offline.getAttribute('target')).toBe('_blank')
    vi.advanceTimersByTime(2000)
    expect(screen.getByText('Chrome 应用商店')).toBeTruthy()
  })

  it('keeps at most one extension menu open across the page', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Safari/537.36')
    const { container } = render(
      <>
        <ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />
        <ExtensionMenu variant="header" copy={chromeCopy.cn.header} />
      </>
    )
    const openControls = () =>
      [...container.querySelectorAll('[data-extension-control]')].filter((node) =>
        node.classList.contains('is-open')
      )

    const triggers = screen.getAllByText('安装浏览器插件')
    fireEvent.click(triggers[0])
    expect(openControls()).toHaveLength(1)
    fireEvent.click(triggers[1])
    // The static header's closeMenus(): opening the second closes the first.
    expect(openControls()).toHaveLength(1)
  })

  it('reroutes only an unmodified left click to the guide, like the static header', () => {
    const click = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false }
    expect(isPlainClick(click)).toBe(true)
    expect(isPlainClick({ ...click, metaKey: true })).toBe(false)
    expect(isPlainClick({ ...click, ctrlKey: true })).toBe(false)
    expect(isPlainClick({ ...click, shiftKey: true })).toBe(false)
    expect(isPlainClick({ ...click, altKey: true })).toBe(false)
    expect(isPlainClick({ ...click, button: 1 })).toBe(false)
    expect(OFFLINE_GUIDE).toBe('/experience?from=manual&download=1')
  })

  it('links Edge users to the Edge store with the correct icon', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 Chrome/130.0 Safari/537.36 Edg/130.0')
    render(<ExtensionMenu variant="hero" copy={chromeCopy.cn.header} />)
    const link = screen.getByText('安装浏览器插件').closest('a')!
    expect(link.href).toContain('microsoftedge.microsoft.com/addons/')
    expect(link.querySelector('img')?.getAttribute('src')).toBe('/marketing/assets/microsoft-edge.svg')
  })

  it.each([['cn', DownloadCn], ['global', DownloadGlobal]] as const)('opens the experience from the %s download page Edge link', (_region, Page) => {
    const { container } = render(<Page />)
    clickWithoutNavigation(container.querySelector('a[data-browser="edge"]')!)
    vi.runOnlyPendingTimers()
    expect(mocks.push).toHaveBeenCalledWith('/experience?from=store')
  })

  it('uses client navigation for the logo and home link on the WebMCP page', () => {
    render(<SiteHeader page="webmcp" region="cn" copy={chromeCopy.cn.header} />)
    expect(screen.getByRole('link', { name: '怡氧®AI' }).getAttribute('data-client-link')).toBe('true')
    expect(screen.getByRole('link', { name: '首页' }).getAttribute('data-client-link')).toBe('true')
  })

  it.each(['cn', 'global'] as const)('shows only one usage entry when the extension is installed (%s)', (region) => {
    const copy = chromeCopy[region].header
    const view = render(<SiteHeader page="home" region={region} copy={copy} />)
    expect(screen.getByText(copy.online)).toBeTruthy()
    mocks.status = 'connected'
    view.rerender(<SiteHeader page="home" region={region} copy={copy} />)
    expect(screen.queryByText(copy.online)).toBeNull()
    expect(screen.getByText(copy.useNow).closest('a')?.getAttribute('href')).toBe('/projects')
    mocks.status = 'not_detected'
    view.rerender(<SiteHeader page="home" region={region} copy={copy} />)
    expect(screen.getByText(copy.online)).toBeTruthy()
  })

  it('scrolls to the top when the current download page is selected', () => {
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {})
    render(<SiteHeader page="download" region="cn" copy={chromeCopy.cn.header} />)
    fireEvent.click(screen.getByRole('link', { name: '浏览器扩展' }))
    expect(scroll).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }))
  })
})
