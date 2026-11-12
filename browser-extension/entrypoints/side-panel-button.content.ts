// ============================================================
// Side Panel Button Content Script (ISOLATED world)
//
// Generic entry point for CreatorWeave's side panel feature — runs on
// ALL URLs (matches <all_urls>) so users can invoke the side panel
// from any page they're browsing. Injects a compact floating button
// labeled "怡氧®AI" that toggles the side panel on click.
// The button is draggable: release snaps to the nearest screen edge.
//
// What this script needs from the page:
//   - Just `window.location.href`. Everything else (URL/title/selected
//     text) is fetched fresh by background via `__cwUpstreamPage` (a
//     separate MAIN-world content script). This keeps the click handler
//     light and avoids shipping stale or wrong-shaped context.
//
// Why ISOLATED world (not MAIN):
//   - `chrome.runtime.sendMessage` is only available in ISOLATED.
//   - `chrome.sidePanel.open()` needs the user gesture in the SAME sync
//     call stack. MAIN→ISOLATED postMessage loses the gesture, so the
//     click handler must run in ISOLATED and send synchronously.
//
// Per-site provider opt-in is independent:
//   - Sites that want richer context (e.g. ticket data) can expose
//     `window.__sidePanelContextProvider.getContext()` and background
//     will pick it up automatically. No code change in this script.
// ============================================================

import { isCwWebappOrigin } from '../lib/webapp-origins'

const POS_KEY = 'cw_side_panel_btn_pos'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  // 默认 ISOLATED world — 不需要 world: 'MAIN'

  main() {
    const BUTTON_ID = 'cw-side-panel-btn'

    // Don't inject the button on CreatorWeave's own pages — the side
    // panel *is* CreatorWeave, so having a "唤起怡氧®AI" button there
    // is confusing and recursive.
    //
    // Detection: CreatorWeave sets `document.documentElement.dataset.creatorweave`
    // at app load (main.tsx). We check the DOM (not window vars) because
    // this content script runs in the ISOLATED world and can't read
    // MAIN-world window properties. Falls back to origin check in case
    // the data attribute hasn't been set yet (e.g. page still loading).
    if (
      document.documentElement.dataset.creatorweave === 'true' ||
      isCwWebappOrigin(window.location.origin)
    ) {
      // eslint-disable-next-line no-console
      console.log('[CreatorWeave Side Panel] skipped: this is a CreatorWeave page')
      return
    }

    function removeButton() {
      const existing = document.getElementById(BUTTON_ID)
      if (existing) existing.remove()
    }

    function injectButton() {
      if (document.getElementById(BUTTON_ID)) return

      const container = document.createElement('div')
      container.id = BUTTON_ID
      container.style.cssText = [
        'position: fixed',
        'z-index: 2147483647',
        'background: linear-gradient(135deg, #14B8A6, #0D7377)',
        'color: #fff',
        'border: 1px solid rgba(255,255,255,0.2)',
        'border-radius: 10px',
        'padding: 8px',
        'width: 32px',
        'height: 32px',
        // box-sizing: border-box keeps width/height inclusive of padding + border,
        // so the rendered size stays 32x32 even on pages without a global reset
        // (e.g. YouTube — its scoped reset doesn't reach injected <div> elements,
        // so without this the button becomes 50x50 = 32 + 8*2 + 1*2).
        'box-sizing: border-box',
        'cursor: pointer',
        'box-shadow: 0 2px 10px rgba(0,0,0,0.2)',
        'display: inline-flex',
        'align-items: center',
        'justify-content: center',
        'transition: background 0.2s, opacity 0.3s',
        'user-select: none',
        'touch-action: none',
        'opacity: 0',
      ].join(';')
      // Brand mark: the official eo2weave logo (icon.svg) embedded inline so
      // the button needs no extra HTTP request. The white-tipped weave reads
      // clearly at 16×16 against the teal button background. The SVG uses
      // currentColor so the lane-flip transform below can recolor it on
      // hover without re-rendering the path.
      container.title = chrome.i18n.getMessage('sidePanelButtonTitle') || 'Open eo2weave in the side panel'

      container.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 128 128" fill="currentColor" aria-hidden="true">
          <path d="M85.22 21.5C82.19 25.26 76.62 27.15 80.04 33.5C78.19 34.93 73.81 34.11 71.5 34.11C65.76 34.11 60.05 34.17 55.18 37.34C52.36 39.18 49.2 42.78 48.17 45.99C46.01 52.69 48.29 60.04 43.93 66.12C37.35 75.31 21.27 74.04 17.14 63.1C15.27 58.17 15.83 52.75 15.82 47.5C15.82 42.49 14.88 36.37 16.09 31.5C20.73 12.77 38.87 15.83 54.17 15.82C62.61 15.82 79.9 13.51 85.22 21.5ZM97.5 42.99C96.68 42.49 95.87 42 95.05 41.5C93.4 33.97 86.39 34.77 84.93 30.5C85.62 27.08 90.45 26.49 92.71 24.21C94.39 22.52 94.33 19.78 96.1 18.26C96.94 17.54 98.77 17.51 99.66 18.19C101.5 19.58 101.71 22.69 103.38 24.42C105.13 26.24 108.03 26.39 109.66 28.18C110.35 28.94 110.36 30.54 109.89 31.42C108.69 33.71 104.24 34.45 102.39 36.56C100.46 38.76 100.78 42.04 97.5 42.99ZM88.83 42.01C92.64 50.68 97.62 49.41 104.5 45.74C114.19 51.39 112.18 64.92 112.18 74.5C112.18 89.53 115 107.5 96.5 111.92C92.59 112.85 87.84 112.17 83.83 112.18C80.17 112.18 74.17 113.31 70.83 111.83C70.91 109.21 77.03 105.44 77.83 101.68C78.82 96.96 78.25 91.63 78.24 86.83C78.22 76.7 80.6 62.57 70.59 56.25C68.55 54.95 65.63 53.26 63.17 53.07C60.82 52.88 57.93 53.56 55.84 52.5C55.51 50.62 56.06 49.23 56.82 47.67C60.85 39.37 72.48 41.77 80.17 41.77C82.87 41.77 86.25 41.25 88.83 42.01ZM16.5 71.87C20.68 74.1 22.96 78.83 27.92 79.86C37.9 81.95 50.27 78.09 59.83 81.07C69.15 83.99 73.48 95.56 68.77 103.93C63.94 112.51 54.86 112.18 46.17 112.18C32.45 112.18 19.97 112.46 16.08 96.5C15.35 93.5 15.82 89.91 15.82 86.83C15.82 84.11 15.05 73.39 16.5 71.87Z" fill="currentColor" stroke="currentColor" stroke-width="0.25" stroke-linejoin="round" fill-rule="evenodd"/>
        </svg>
      `

      // ── Position logic ──
      // We remember which EDGE (left/right) and the Y coordinate.
      // On every reposition we clamp to the current viewport, so window
      // resize / side-panel-open both trigger a reposition.
      let edge: 'left' | 'right'
      let posY: number

      const savedPos = (() => {
        try {
          const raw = localStorage.getItem(POS_KEY)
          if (!raw) return null
          const pos = JSON.parse(raw) as { edge: string; y: number }
          if (pos.edge !== 'left' && pos.edge !== 'right') return null
          if (typeof pos.y !== 'number') return null
          return pos as { edge: 'left' | 'right'; y: number }
        } catch {
          return null
        }
      })()
      if (savedPos) {
        edge = savedPos.edge
        posY = savedPos.y
      } else {
        edge = 'right'
        posY = window.innerHeight / 2
      }

      // Recalculate and apply position based on current viewport.
      // Called on load, after drag, on window resize, and after toggle.
      const EDGE_OFFSET = 8 // px gap from screen edge — avoids scrollbar overlap
      function reposition() {
        const w = window.innerWidth
        const h = window.innerHeight
        const clampedY = Math.max(40, Math.min(posY, h - 40))
        const x = edge === 'left' ? EDGE_OFFSET : w - EDGE_OFFSET
        container.style.left = `${x}px`
        container.style.top = `${clampedY}px`
        container.style.transform = edge === 'left' ? 'translate(0, -50%)' : 'translate(-100%, -50%)'

        // The brand mark is intentionally not flipped on the left edge:
        // a mirrored logo hides the sparkle (top-right corner) and reads
        // as a different wordmark on the other side. The translate(-100%)
        // on the right edge already keeps the button flush to the edge.
      }
      reposition()

      // Reposition on viewport changes (window resize, side panel open/close,
      // devtools toggle, zoom level change). rAF-debounced for smoothness.
      let resizeRaf = 0
      window.addEventListener('resize', () => {
        cancelAnimationFrame(resizeRaf)
        resizeRaf = requestAnimationFrame(reposition)
      })

      // ── Toggle click (fire-and-forget) ──
      container.addEventListener('click', (e) => {
        // If this click ended a drag, suppress the toggle
        if (wasDragging) {
          e.preventDefault()
          e.stopPropagation()
          return
        }
        chrome.runtime.sendMessage({
          type: 'cw_side_panel_toggle',
          url: window.location.href,
        })
        // Side panel open/close changes available viewport width.
        // Reposition after Chrome has finished the panel animation.
        // 300ms covers Chrome's default side panel open animation.
        setTimeout(reposition, 300)
      })

      // ── Hover ──
      container.addEventListener('mouseenter', () => {
        container.style.background = '#14b8a6'
      })
      container.addEventListener('mouseleave', () => {
        container.style.background = '#0d9488'
      })

      // ── Drag: mousedown → move → mouseup snaps to nearest edge ──
      let isDragging = false
      let wasDragging = false
      let startX = 0
      let startY = 0
      let offsetX = 0
      let offsetY = 0
      const DRAG_THRESHOLD = 5 // px movement before it counts as a drag

      container.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 && e.pointerType === 'mouse') return // left button only for mouse
        isDragging = true
        wasDragging = false
        startX = e.clientX
        startY = e.clientY
        const rect = container.getBoundingClientRect()
        offsetX = e.clientX - rect.left - rect.width / 2
        offsetY = e.clientY - rect.top - rect.height / 2
        container.setPointerCapture(e.pointerId)
        // Disable transition during drag for 1:1 tracking
        container.style.transition = 'none'
        e.preventDefault()
      })

      container.addEventListener('pointermove', (e) => {
        if (!isDragging) return
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        if (!wasDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
          wasDragging = true
        }
        if (!wasDragging) return

        // Follow cursor, centered on pointer
        let cx = e.clientX - offsetX
        let cy = e.clientY - offsetY
        // Clamp to viewport
        cx = Math.max(20, Math.min(cx, window.innerWidth - 20))
        cy = Math.max(20, Math.min(cy, window.innerHeight - 20))
        container.style.left = `${cx}px`
        container.style.top = `${cy}px`
        container.style.transform = 'translate(-50%, -50%)'
      })

      container.addEventListener('pointerup', (e) => {
        if (!isDragging) return
        isDragging = false
        container.releasePointerCapture(e.pointerId)
        container.style.transition = 'background 0.2s'

        if (!wasDragging) return // it was a click, not a drag

        // ── Snap to nearest edge ──
        const w = window.innerWidth
        const h = window.innerHeight
        const rect = container.getBoundingClientRect()
        const centerX = rect.left + rect.width / 2

        edge = centerX < w / 2 ? 'left' : 'right'
        posY = Math.max(40, Math.min(rect.top + rect.height / 2, h - 40))
        reposition()

        // Persist
        try {
          localStorage.setItem(POS_KEY, JSON.stringify({ edge, y: posY }))
        } catch {}
      })

      document.body.appendChild(container)
      // Trigger slide-in animation (opacity transition from 0→1).
      // requestAnimationFrame ensures the browser registers opacity:0
      // before we switch to 1, otherwise the transition is skipped.
      requestAnimationFrame(() => {
        container.style.opacity = '1'
      })
    }

    function tryInject() {
      if (document.body) {
        injectButton()
      } else {
        setTimeout(tryInject, 200)
      }
    }
    tryInject()

    // SPA 路由变化时重新注入按钮
    let lastUrl = window.location.href
    const urlObserver = new MutationObserver(() => {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href
        removeButton()
        setTimeout(tryInject, 500)
      }
    })
    urlObserver.observe(document.documentElement, { childList: true, subtree: true })

    // eslint-disable-next-line no-console
    console.log('[CreatorWeave Side Panel] ✅ Button injected on', window.location.hostname)
  },
})
