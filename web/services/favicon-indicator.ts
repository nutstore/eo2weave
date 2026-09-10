/**
 * Favicon Indicator — paints a status badge on the browser tab icon.
 *
 * States:
 *   - 'idle'     — no overlay (original favicon)
 *   - 'running'  — blue dot (agent loop in progress)
 *   - 'pending'  — amber dot (loop finished, user hasn't viewed yet)
 *
 * No animation — favicons are static in most browsers. Static dot is
 * enough to attract attention when the user has many tabs open.
 *
 * Sits next to the agent notification feature, but independent — useful
 * even when notifications are disabled.
 */

export type FaviconState = 'idle' | 'running' | 'pending'

const FAVICON_SIZE = 64
const DOT_RADIUS_RATIO = 0.24  // ~15px on a 64px canvas

// Module-level cache of the original favicon
let originalHref: string | null = null
let originalImage: HTMLImageElement | null = null
let originalLoadingPromise: Promise<HTMLImageElement> | null = null
let faviconLinkEl: HTMLLinkElement | null = null

// Color per state — chosen for max contrast against CreatorWeave's
// green logo. Cool blues/yellows disappear on green; orange and red stand out.
const STATE_COLOR: Record<Exclude<FaviconState, 'idle'>, string> = {
  running: '#f97316', // orange-500 (warm, in-progress)
  pending: '#dc2626', // red-600  (attention, please review)
}

function ensureFaviconLinkEl(): HTMLLinkElement {
  if (faviconLinkEl) return faviconLinkEl
  // Try existing <link rel="icon"> first (uses current href from index.html)
  const existing = document.querySelector("link[rel='icon']") as HTMLLinkElement | null
  if (existing && existing.href) {
    faviconLinkEl = existing
    originalHref = existing.href
    return existing
  }
  // Fallback: create a <link> pointing at CreatorWeave's actual favicon.
  // (index.html ships /favicon.svg — see <link rel="icon" type="image/svg+xml" href="/favicon.svg">)
  const el = document.createElement('link')
  el.rel = 'icon'
  el.type = 'image/svg+xml'
  el.href = '/favicon.svg'
  document.head.appendChild(el)
  faviconLinkEl = el
  originalHref = el.href
  return el
}

async function loadOriginalImage(): Promise<HTMLImageElement> {
  if (originalImage) return originalImage
  if (originalLoadingPromise) return originalLoadingPromise

  const href = originalHref ?? '/favicon.svg'
  originalLoadingPromise = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      originalImage = img
      originalLoadingPromise = null
      resolve(img)
    }
    img.onerror = () => {
      originalLoadingPromise = null
      reject(new Error('failed to load favicon image'))
    }
    // no crossOrigin — for same-origin data we don't need it, and SVG-as-image
    // can be flaky with crossOrigin='anonymous' under some browsers.
    img.src = href
  })
  return originalLoadingPromise
}

/**
 * Paint a colored dot in the bottom-right corner of the favicon and
 * update the <link rel="icon"> to point at the new data URL.
 */
async function paintWithDot(color: string): Promise<void> {
  let img: HTMLImageElement
  try {
    img = await loadOriginalImage()
  } catch {
    return
  }

  const canvas = document.createElement('canvas')
  canvas.width = FAVICON_SIZE
  canvas.height = FAVICON_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    return
  }

  // Draw original favicon
  ctx.drawImage(img, 0, 0, FAVICON_SIZE, FAVICON_SIZE)

  // Dot in bottom-right corner with white halo for visibility
  const dotRadius = FAVICON_SIZE * DOT_RADIUS_RATIO
  const cx = FAVICON_SIZE - dotRadius - 3
  const cy = FAVICON_SIZE - dotRadius - 3

  // White outline (so the dot is visible on light OR dark favicons)
  ctx.beginPath()
  ctx.arc(cx, cy, dotRadius + 3, 0, Math.PI * 2)
  ctx.fillStyle = '#ffffff'
  ctx.fill()

  // Colored dot
  ctx.beginPath()
  ctx.arc(cx, cy, dotRadius, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()

  const el = ensureFaviconLinkEl()
  const dataUrl = canvas.toDataURL('image/png')
  el.href = dataUrl
}

function resetToOriginal(): void {
  const el = ensureFaviconLinkEl()
  if (originalHref) {
    el.href = originalHref
  }
}

/**
 * Set the favicon indicator state.
 *
 * - 'idle'     → restore original favicon
 * - 'running'  → paint blue dot (agent loop in progress)
 * - 'pending'  → paint amber dot (loop finished, user hasn't returned)
 *
 * Safe to call repeatedly — non-blocking, swallows canvas/image errors.
 */
export function setFaviconState(state: FaviconState): void {
  if (typeof document === 'undefined') return

  if (state === 'idle') {
    resetToOriginal()
    return
  }

  const color = STATE_COLOR[state]
  // Fire-and-forget: don't block callers on canvas work
  void paintWithDot(color)
}

/** Alias for setFaviconState('idle'). */
export function clearFaviconIndicator(): void {
  setFaviconState('idle')
}
