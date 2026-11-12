'use client'

import Link from 'next/link'
import { BrandName } from '@/components/BrandName'
import { useEffect, useRef, useState } from 'react'
import { ExtensionMenu } from './ExtensionMenu'
import type { ExtensionCopy } from './ExtensionMenu'
import { useExtensionStatus } from './useExtensionStatus'

export type MarketingPageKey = 'home' | 'webmcp' | 'download' | 'experience'

export type HeaderCopy = ExtensionCopy & {
  brand: string
  home: string
  webmcp: string
  /** Domestic build only: the overseas site does not offer the Nutstore AI plan. */
  pricing?: string
  help: string
  download: string
  online: string
  openMenu: string
  closeMenu: string
}

const HELP_HREF = { cn: '/docs/zh', global: '/docs' }

/**
 * Shared marketing header.
 *
 * Replaces the `<site-header>` custom element: the collapsed-nav breakpoint,
 * scroll shading and the mobile menu are React state instead of class
 * mutations, and the brand/Home link scrolls to the top without pushing a
 * fragment into the URL.
 */
export function SiteHeader({ page, region, copy }: { page: MarketingPageKey; region: 'cn' | 'global'; copy: HeaderCopy }) {
  const extensionStatus = useExtensionStatus()
  const [scrolled, setScrolled] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const headerRef = useRef<HTMLElement>(null)
  const brandRef = useRef<HTMLAnchorElement>(null)
  const navRef = useRef<HTMLElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const measure = () => {
      const brand = brandRef.current
      const nav = navRef.current
      const inner = innerRef.current
      if (!brand || !nav || !inner) return
      setCollapsed(brand.offsetWidth + 120 + nav.scrollWidth > inner.clientWidth)
      setMenuOpen(false)
    }
    measure()
    window.addEventListener('resize', measure)
    void document.fonts?.ready.then(measure)
    return () => window.removeEventListener('resize', measure)
  }, [extensionStatus])

  useEffect(() => {
    if (!menuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      if (!headerRef.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [menuOpen])

  // On the home page the brand scrolls to top in place; from a subpage it must
  // navigate to "/" without leaving an anchor in the address bar.
  const homeHref = page === 'home' ? '#top' : '/'
  const onCurrentPageClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' })
    history.replaceState(null, '', window.location.pathname + window.location.search)
    setMenuOpen(false)
  }
  const onHomeClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (page === 'home') onCurrentPageClick(event)
  }

  const active = (key: MarketingPageKey) =>
    page === key ? { className: 'active', 'aria-current': 'page' as const } : {}

  return (
    <header
      ref={headerRef}
      className={['site-header', scrolled ? 'is-scrolled' : '', collapsed ? 'is-nav-collapsed' : '', menuOpen ? 'is-menu-open' : '']
        .filter(Boolean)
        .join(' ')}
    >
      <div className="header-inner" ref={innerRef}>
        <Link
          className="brand"
          ref={brandRef}
          href={homeHref}
          aria-label={copy.brand}
          onClick={onHomeClick}
        >
          <img src="/marketing/logo.svg" alt="" />
          <span><BrandName name={copy.brand} /></span>
        </Link>
        <button
          className="nav-toggle"
          type="button"
          aria-label={menuOpen ? copy.closeMenu : copy.openMenu}
          aria-controls="primary-navigation"
          aria-expanded={menuOpen}
          onClick={() => {
            if (!collapsed) return
            setMenuOpen((value) => !value)
          }}
        >
          <span className="nav-toggle-lines" aria-hidden="true" />
        </button>
        <nav
          className="header-nav"
          id="primary-navigation"
          aria-label={copy.home}
          ref={navRef}
          // The static header closed the collapsed menu on any nav link; without
          // this, target=_blank entries (定价/帮助) leave it open behind them.
          onClick={(event) => {
            if ((event.target as HTMLElement).closest('a:not([data-extension-trigger])')) setMenuOpen(false)
          }}
        >
          <Link href={homeHref} onClick={onHomeClick} {...active('home')}>
            {copy.home}
          </Link>
          <Link href="/webmcp" {...active('webmcp')}>
            {copy.webmcp}
          </Link>
          {region === 'cn' && copy.pricing && (
            <a href="https://ai.jianguoyun.com/" target="_blank" rel="noopener noreferrer">
              {copy.pricing}
            </a>
          )}
          <a href={HELP_HREF[region]} target="_blank" rel="noopener noreferrer">
            {copy.help}
          </a>
          <Link href="/download" onClick={page === 'download' ? onCurrentPageClick : undefined} {...active('download')}>
            {copy.download}
          </Link>
          <ExtensionMenu variant="header" copy={copy} />
          {extensionStatus !== 'connected' && (
            <a className="online-link" href="/projects" target="_blank" rel="noopener noreferrer">
              {copy.online}
            </a>
          )}
        </nav>
      </div>
    </header>
  )
}
