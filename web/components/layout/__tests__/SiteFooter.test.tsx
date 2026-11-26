import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'

import { SiteFooter } from '../SiteFooter'
import { resolveSiteFooterConfig, resolveIcpNumber } from '@/lib/site-footer-config'

describe('resolveSiteFooterConfig', () => {
  it('names the domestic operator on the CN build', () => {
    const config = resolveSiteFooterConfig(true, '沪ICP备2026001234号-1')
    expect(config.operator).toBe('上海奕惟网络科技有限公司')
    expect(config.rights).toBe('保留所有权利')
    expect(config.icpNumber).toBe('沪ICP备2026001234号-1')
    expect(config.privacyHref).toBe('/help/privacy')
  })

  it('names the overseas operator on the global build and never shows ICP', () => {
    const config = resolveSiteFooterConfig(false, '沪ICP备2026001234号-1')
    expect(config.operator).toBe('Astronet Technology PTE LTD')
    expect(config.rights).toBe('All rights reserved.')
    expect(config.icpNumber).toBeNull()
  })
})

describe('resolveIcpNumber', () => {
  it('accepts a trimmed filing number', () => {
    expect(resolveIcpNumber(' 沪ICP备2026001234号-1 ')).toBe('沪ICP备2026001234号-1')
  })

  it('rejects empty and injection-looking values', () => {
    expect(resolveIcpNumber(undefined)).toBeNull()
    expect(resolveIcpNumber('   ')).toBeNull()
    expect(resolveIcpNumber('"><script>alert(1)</script>')).toBeNull()
  })
})

describe('SiteFooter', () => {
  it('renders the operator, rights, and privacy link (dev defaults to global build)', () => {
    render(<SiteFooter />)

    const footer = screen.getByRole('contentinfo')
    expect(footer.textContent).toContain('Astronet Technology PTE LTD')
    expect(footer.textContent).toContain('All rights reserved.')

    const privacyLink = screen.getByRole('link', { name: 'Privacy Policy' })
    // Next <Link> normalizes the trailing slash away in the rendered href.
    expect(privacyLink.getAttribute('href')).toBe('/help/privacy')

    // Dev build has no ICP number → no MIIT link.
    expect(screen.queryByRole('link', { name: /beian|ICP|沪/ })).toBeNull()
  })
})
