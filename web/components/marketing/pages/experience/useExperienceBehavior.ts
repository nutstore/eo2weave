'use client'

import { useEffect, type RefObject } from 'react'

/**
 * Behaviour that used to live in the experience page's inline script:
 * the manual-install screen (`?from=manual`), the deferred package download
 * (`?download=1`) and the Douban typing loop.
 */
export function useExperienceBehavior(root: RefObject<HTMLElement | null>, region: 'cn' | 'global') {
  useEffect(() => {
    const host = root.current
    if (!host) return
    const cleanups: Array<() => void> = []

    const params = new URLSearchParams(window.location.search)
    const isManual = params.get('from') === 'manual'
    const screen = host.querySelector<HTMLElement>('[data-setup-screen="manual"]')
    if (screen) screen.hidden = !isManual
    document.documentElement.classList.toggle('manual-route', isManual)

    const onPopState = () => {
      const next = new URLSearchParams(window.location.search).get('from') === 'manual'
      if (screen) screen.hidden = !next
      document.documentElement.classList.toggle('manual-route', next)
    }
    window.addEventListener('popstate', onPopState)
    cleanups.push(() => window.removeEventListener('popstate', onPopState))

    if (params.get('download') === '1') {
      const url = new URL(window.location.href)
      url.searchParams.delete('download')
      const zip = new URL('/chrome-extension.zip', window.location.origin)
      zip.searchParams.set('time', String(Date.now()))
      const frame = document.createElement('iframe')
      frame.hidden = true
      frame.setAttribute('aria-hidden', 'true')
      frame.src = zip.href
      document.body.append(frame)
      cleanups.push(() => frame.remove())
      try {
        window.history.replaceState(null, '', url)
      } catch {
        // Local file previews can block history updates.
      }
    }

    // Copying `chrome://extensions/` is the only fallback when the store is
    // unreachable, so the manual screen depends on this handler existing.
    const copyButton = host.querySelector<HTMLButtonElement>('[data-copy-extensions-url]')
    const copyStatus = host.querySelector<HTMLElement>('[data-copy-status]')
    if (copyButton && copyStatus) {
      const address = 'chrome://extensions/'
      const onClick = async () => {
        let copied = false
        try {
          await navigator.clipboard.writeText(address)
          copied = true
        } catch {
          const temporary = document.createElement('textarea')
          temporary.value = address
          temporary.setAttribute('readonly', '')
          temporary.style.position = 'fixed'
          temporary.style.opacity = '0'
          document.body.append(temporary)
          temporary.select()
          copied = document.execCommand('copy')
          temporary.remove()
        }
        copyStatus.textContent = copied
          ? region === 'cn'
            ? '已复制，请粘贴到地址栏并回车'
            : 'Copied. Paste it into the address bar and press Enter.'
          : region === 'cn'
            ? `请在 Chrome 地址栏输入 ${address} 并回车。`
            : `Enter ${address} in Chrome's address bar and press Enter.`
      }
      copyButton.addEventListener('click', onClick)
      cleanups.push(() => copyButton.removeEventListener('click', onClick))
    }

    if (region === 'cn') {
      const typed = host.querySelector<HTMLElement>('.douban-motion-typed')
      const question = host.querySelector<HTMLElement>('.douban-motion-question')?.textContent ?? ''
      if (typed && question && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const characters = Array.from(question)
        const startedAt = performance.now()
        let previous = -1
        let frame = 0
        const tick = (now: number) => {
          const elapsed = (now - startedAt) % 11200
          const count =
            elapsed < 5800 || elapsed >= 8200
              ? 0
              : elapsed >= 7600
                ? characters.length
                : Math.min(characters.length, Math.floor(((elapsed - 5800) / 1800) * characters.length))
          if (count !== previous) {
            typed.textContent = characters.slice(0, count).join('')
            previous = count
          }
          frame = requestAnimationFrame(tick)
        }
        frame = requestAnimationFrame(tick)
        cleanups.push(() => cancelAnimationFrame(frame))
      }
    }

    return () => {
      cleanups.forEach((cleanup) => cleanup())
    }
  }, [root, region])
}
