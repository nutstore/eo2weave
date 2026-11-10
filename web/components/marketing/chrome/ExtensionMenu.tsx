'use client'

import { useEffect, useId, useRef, useState } from 'react'
import { useExtensionStatus } from './useExtensionStatus'
import { useStoreInstall } from './useStoreInstall'

/** Page-wide "a control menu opened" signal — the static header's closeMenus(). */
const MENU_OPEN_EVENT = 'eo2weave:extension-menu-open'

export const CHROME_STORE = 'https://chromewebstore.google.com/detail/eo2weave/canpcddlognjbengiodekfbbfnjafeml'
export const EDGE_STORE = 'https://microsoftedge.microsoft.com/addons/detail/eo2weave/hnndljbngdmcldojkaedhpehlghkljdm'
export const OFFLINE_ZIP = '/chrome-extension.zip'
/** Where a plain click on the offline option goes: guide screen + auto-download. */
export const OFFLINE_GUIDE = '/experience?from=manual&download=1'

/**
 * The static header's rule, kept verbatim: only an unmodified left click is
 * rerouted to the guide. Ctrl/cmd/shift/alt and middle clicks keep their
 * default action, i.e. they download the archive directly.
 */
export function isPlainClick(event: {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
}

type Variant = 'header' | 'hero' | 'install'

export type ExtensionCopy = {
  install: string
  useNow: string
  checking: string
  offline: string
  offlineHint: string
  store: string
  storeHint: string
}

function browserName(ua: string): 'Edge' | 'Chrome' | '' {
  if (/Edg\//.test(ua)) return 'Edge'
  if (/Chrome\//.test(ua)) return 'Chrome'
  return ''
}

/**
 * Install CTA plus its store/offline menu.
 *
 * Replaces the [data-extension-*] DOM protocol the static pages used: the
 * label, href and menu availability all derive from state instead of being
 * mutated after render.
 */
export function ExtensionMenu({
  variant,
  copy,
  alwaysMenu = false,
}: {
  variant: Variant
  copy: ExtensionCopy
  alwaysMenu?: boolean
}) {
  const status = useExtensionStatus()
  const onStoreInstall = useStoreInstall()
  const [open, setOpen] = useState(false)
  const [browser, setBrowser] = useState<'Edge' | 'Chrome' | ''>('')
  const rootRef = useRef<HTMLDivElement>(null)
  const controlId = useId()

  useEffect(() => {
    setBrowser(browserName(navigator.userAgent))
  }, [])

  // The static header kept at most one menu open across every control on the
  // page (closeMenus(except)); a page can host two (header + hero), so closing
  // siblings cannot be local state alone.
  useEffect(() => {
    if (!open) return
    window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT, { detail: controlId }))
  }, [open, controlId])
  useEffect(() => {
    const onOtherMenuOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== controlId) setOpen(false)
    }
    window.addEventListener(MENU_OPEN_EVENT, onOtherMenuOpen)
    return () => window.removeEventListener(MENU_OPEN_EVENT, onOtherMenuOpen)
  }, [controlId])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const connected = status === 'connected'
  const checking = status === 'checking'
  const isEdge = browser === 'Edge'
  const showsMenu = !isEdge && (browser === 'Chrome' || alwaysMenu)
  // Firefox/Safari cannot install from the Chrome Web Store, but the install
  // variant must never link back to the page it sits on.
  const storeFallback = variant === 'install'
  const href = connected
    ? '/projects'
    : isEdge
      ? EDGE_STORE
      : storeFallback
        ? CHROME_STORE
        : '/download#download-options'
  const opensStore = !connected && (isEdge || storeFallback)
  const label = connected ? copy.useNow : checking ? copy.checking : copy.install
  const classes = [
    'extension-control',
    connected ? 'is-connected' : '',
    isEdge ? 'is-edge' : '',
    browser === 'Chrome' ? 'is-chrome' : '',
    open ? 'is-open' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={classes} data-extension-control="" ref={rootRef}>
      <a
        className={variant === 'header' ? 'header-cta' : variant === 'install' ? 'install-button' : 'button primary'}
        {...(variant === 'install' ? { 'data-browser': 'chrome', 'data-always-menu': '' } : {})}
        href={href}
        data-extension-trigger=""
        {...(showsMenu ? { 'aria-haspopup': true, 'aria-expanded': open } : {})}
        {...(checking ? { 'aria-disabled': true } : {})}
        {...(opensStore ? { target: '_blank', rel: 'noopener noreferrer', ...(isEdge ? { 'data-store-install': '' } : {}) } : {})}
        onClick={(event) => {
          if (checking) { event.preventDefault(); return }
          if (connected) return
          if (showsMenu) {
            event.preventDefault()
            setOpen((value) => !value)
            return
          }
          if (opensStore) onStoreInstall(event)
          // No menu (Firefox/Safari/Edge): let the link navigate to the store.
        }}
      >
        <img
          className="browser-icon"
          src={isEdge ? '/marketing/assets/microsoft-edge.svg' : variant === 'header' ? '/marketing/assets/chrome-color.svg' : '/marketing/assets/chrome-white.svg'}
          alt=""
        />
        <span data-extension-label="">{label}</span>
      </a>

      {showsMenu && (
        <div className="extension-menu" role="menu">
          <a
            className="extension-option"
            href={OFFLINE_ZIP}
            target="_blank"
            rel="noopener noreferrer"
            role="menuitem"
            onClick={(event) => {
              setOpen(false)
              // Modified clicks (ctrl/cmd/middle) keep the archive as their
              // target; bust the cache on the way out, as the static header did.
              if (!isPlainClick(event)) {
                const direct = new URL(OFFLINE_ZIP, window.location.origin)
                direct.searchParams.set('time', String(Date.now()))
                event.currentTarget.href = direct.href
                return
              }
              // Plain click: show the manual install guide and start the
              // download together (the guide screen reads `from=manual`, the
              // page effect reads `download=1`). A client-side push would not
              // re-run that effect, so navigate for real.
              event.preventDefault()
              window.location.assign(OFFLINE_GUIDE)
            }}
          >
            <strong>{copy.offline}</strong>
            <span>{copy.offlineHint}</span>
          </a>
          <a
            className="extension-option"
            href={CHROME_STORE}
            target="_blank"
            rel="noreferrer"
            role="menuitem"
            onClick={(event) => {
              onStoreInstall(event)
              // Keep the link mounted until the browser opens its new tab.
              window.setTimeout(() => setOpen(false), 0)
            }}
          >
            <strong>{copy.store}</strong>
            <span>{copy.storeHint}</span>
          </a>
        </div>
      )}
    </div>
  )
}
