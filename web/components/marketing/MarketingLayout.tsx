'use client'

import { useEffect, type ReactNode } from 'react'
import { SiteFooter, type FooterCopy } from './chrome/SiteFooter'
import { SiteHeader, type HeaderCopy, type MarketingPageKey } from './chrome/SiteHeader'
import { chromeCopy } from './chrome/copy'
import './chrome/site-header.css'

export type MarketingRegion = 'cn' | 'global'

function isMobileUserAgent(ua: string): boolean {
  return /Android|iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1)
}

/**
 * Shared marketing chrome.
 *
 * Every marketing route renders through this so the header/footer exist once
 * in the tree instead of being re-injected per page, and the mobile-mode class
 * is owned by React rather than a script.
 */
export function MarketingLayout({
  page,
  region,
  children,
  headerCopy,
  footerCopy,
}: {
  page: MarketingPageKey
  region: MarketingRegion
  children: ReactNode
  headerCopy?: HeaderCopy
  footerCopy?: FooterCopy
}) {
  useEffect(() => {
    const root = document.documentElement
    root.classList.toggle('marketing-mobile', isMobileUserAgent(navigator.userAgent))
    return () => root.classList.remove('marketing-mobile')
  }, [])

  const copy = chromeCopy[region]

  return (
    <div className={`marketing-page-${page}`}>
      {/* Icon font for the .hgi-stroke glyphs in the ported markup. The static
          pages loaded it in <head>; React pages need it here. */}
      <link rel="stylesheet" href="https://use.hugeicons.com/font/icons.css" crossOrigin="anonymous" />
      <SiteHeader page={page} region={region} copy={headerCopy ?? copy.header} />
      {children}
      <SiteFooter copy={footerCopy ?? copy.footer} />
    </div>
  )
}
