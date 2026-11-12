import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { UnsupportedBrowser } from '../UnsupportedBrowser'
import { useI18nStore } from '@/i18n/store'

const chromeUA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'

describe('UnsupportedBrowser recovery guidance', () => {
  beforeEach(() => {
    useI18nStore.setState({ locale: 'en-US' })
    vi.stubGlobal('isSecureContext', true)
    vi.stubGlobal('crossOriginIsolated', true)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(chromeUA)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('recommends HTTPS instead of a browser download on an insecure origin', () => {
    vi.stubGlobal('isSecureContext', false)
    render(<UnsupportedBrowser />)

    expect(
      screen.getByRole('heading', { name: 'A secure connection is required' })
    ).toBeInTheDocument()
    expect(screen.getByText(/Open this site over HTTPS/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument()
  })

  it('identifies Edge before the Chrome token and recommends updating Edge', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`${chromeUA} Edg/120.0.2210.61`)
    render(<UnsupportedBrowser />)

    expect(screen.getByText('Current browser: Microsoft Edge 120.0.2210.61')).toBeInTheDocument()
    expect(screen.getByText(/Update Microsoft Edge to the latest version/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download Microsoft Edge' })).toHaveAttribute(
      'href',
      'https://www.microsoft.com/edge'
    )
  })

  it('does not describe Firefox as unable to use online chats', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(
      'Mozilla/5.0 Gecko/20100101 Firefox/110.0'
    )
    render(<UnsupportedBrowser />)

    expect(screen.getByText('Current browser: Firefox 110.0')).toBeInTheDocument()
    expect(screen.getByText(/Firefox can use browser storage for online chats/)).toBeInTheDocument()
  })

  it('uses the browser version rather than the Chromium engine version for Samsung Internet', () => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(`${chromeUA} SamsungBrowser/23.0.0.47`)
    render(<UnsupportedBrowser />)

    expect(screen.getByText('Current browser: Samsung Internet 23.0.0.47')).toBeInTheDocument()
    expect(screen.getByText(/Update Samsung Internet to the latest version/)).toBeInTheDocument()
  })

  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0.6099.101 Mobile/15E148 Safari/604.1',
      1,
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/15.0 Safari/605.1.15',
      5,
    ],
  ])('gives OS guidance without desktop download links on iOS/iPadOS', (ua, touches) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
    vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(touches)
    render(<UnsupportedBrowser />)

    expect(screen.getByText(/Update iOS or iPadOS/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /Download/ })).not.toBeInTheDocument()
  })

  it('keeps site isolation advice in technical details without blaming the browser', () => {
    vi.stubGlobal('crossOriginIsolated', false)
    render(<UnsupportedBrowser />)

    expect(
      screen.getByRole('heading', { name: 'Browser storage is unavailable' })
    ).toBeInTheDocument()
    const details = screen.getByText('Technical details').closest('details')!
    expect(details).toHaveTextContent('COOP/COEP')
    expect(details).toHaveTextContent('contact the site owner')
    expect(details).not.toHaveAttribute('open')
  })

  it.each([
    ['zh-CN', '浏览器存储不可用'],
    ['ja-JP', 'ブラウザーのストレージを利用できません'],
    ['ko-KR', '브라우저 저장소를 사용할 수 없습니다'],
  ] as const)('renders recovery instructions in %s', (locale, title) => {
    useI18nStore.setState({ locale })
    render(<UnsupportedBrowser />)

    expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('unsupportedBrowser.')
  })
})
