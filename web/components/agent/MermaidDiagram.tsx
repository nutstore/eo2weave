/**
 * MermaidDiagram — renders a Mermaid diagram from source text.
 *
 * Lazy-loads the `mermaid` library (~3MB) on first use so it never
 * lands in the main bundle.
 *
 * State machine:
 *
 *   streaming=true                       streaming=false
 *   ┌─────────┐                          ┌─────────┐
 *   │ loading │─────────────────────────►│ loading │
 *   └─────────┘   ←── stream restart     └─────────┘
 *                                          │ parse + render
 *                                          ▼
 *                                      ┌──────────┐
 *                                      │ rendered │ (keeps prior SVG during re-render)
 *                                      └──────────┘
 *                                          │ parse fail OR throw (only after stream ends)
 *                                          ▼
 *                                      ┌──────────┐
 *                                      │ errored  │ (banner strictly inside root <div>)
 *                                      └──────────┘
 *
 * Invariants:
 *   1. While `streaming === true`, the state is locked to `loading`.
 *      Mid-stream partial input is treated as "not ready", never "broken".
 *   2. Errors NEVER bubble out: no console.error, no throw, no escape
 *      of the component root. They appear only as the contained banner.
 *   3. Re-renders of an already-rendered chart keep showing the prior
 *      SVG until the new attempt completes (no flash of spinner on
 *      small edits).
 *
 * Zoom: click the diagram to open a Lightbox for full-size viewing.
 */

import { memo, useEffect, useRef, useState, useId, useCallback } from 'react'
import { Loader2, AlertTriangle, ZoomIn, ZoomOut, Scan, RotateCcw, Copy, Check } from 'lucide-react'
import {
  TransformWrapper,
  TransformComponent,
  useControls,
  useTransformComponent,
} from 'react-zoom-pan-pinch'
import { useTheme } from '@/store/theme.store'
import { useT } from '@/i18n'
import { Lightbox } from './Lightbox'

interface MermaidDiagramProps {
  chart: string
  /**
   * True while the parent is still streaming this chart's source text.
   * Defaults to false. While true the component stays in `loading`
   * and never enters `errored`, so mid-stream partial input never
   * surfaces a misleading "syntax error" banner.
   */
  streaming?: boolean
}

type RenderState =
  | { kind: 'loading' }
  | { kind: 'rendered'; svg: string }
  | { kind: 'errored'; message: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MermaidApi = any

let mermaidPromise: Promise<MermaidApi> | null = null
function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  return mermaidPromise
}

/**
 * Parse the viewBox dimensions {width, height} from a mermaid SVG.
 *
 * IMPORTANT: matches a viewBox starting at ANY origin (minX minY), not just
 * "0 0 W H". Some diagram types — notably `mindmap` — emit non-zero origins
 * like `viewBox="5 5 1130 504"`. A naive "0 0" regex fails to match those,
 * yields a width of 0, and collapses the diagram into an invisible vertical
 * sliver inside the zoom lightbox (a thin white bar that only grows thicker
 * when zoomed to 2000% — exactly the "cannot view after zoom" bug).
 */
function parseViewBox(svg: string): { width: number; height: number } | null {
  const match = /viewBox="[\d.\-+eE]+\s+[\d.\-+eE]+\s+([\d.]+)\s+([\d.]+)"/.exec(svg)
  return match ? { width: Number(match[1]), height: Number(match[2]) } : null
}

/**
 * Parse the intrinsic width (px) from a mermaid SVG's viewBox.
 * Returns null if the viewBox can't be read (fallback: 0 = container-relative).
 */
export function mermaidViewBoxWidth(svg: string): number | null {
  return parseViewBox(svg)?.width ?? null
}

/**
 * Detect mermaid's built-in "error diagram".
 *
 * When parsing fails, mermaid does NOT throw — it renders an inline SVG
 * whose text reads "Syntax error in text mermaid version 11.16.0".
 * Checking only for `res.svg` presence in the render chain would treat
 * that as a successful render and surface the raw error diagram in the
 * chat. This helper lets us route those to our contained error state
 * (banner + source) instead.
 */
export function isMermaidErrorSvg(svg: string): boolean {
  return svg.includes('Syntax error in text') || /class="error-(text|icon)"/.test(svg)
}

/**
 * ZoomableSvg — renders a mermaid SVG with professional zoom/pan/pinch
 * controls, powered by react-zoom-pan-pinch.
 *
 * The library applies a CSS transform (scale + translate) to the content
 * element — the SVG keeps its intrinsic viewBox size, and zooming/panning
 * is handled entirely by the library (wheel, pinch, touchpad, drag, double
 * click). No width-attribute surgery, no CSS dependency cycles.
 *
 * Initial scale fits the diagram WIDTH to the viewport (tall/narrow charts
 * are enlarged to fill the width and panned/zoomed for detail; wide charts
 * are scaled down to fit).
 */
function ZoomableSvg({ svg }: { svg: string }) {
  const intrinsicWidth = mermaidViewBoxWidth(svg) ?? 0

  const vbHeight = () => parseViewBox(svg)?.height ?? null

  // Ref to the outer wrapper div (the actual viewport for the diagram).
  // We measure it directly so "fit to window" uses the REAL container size,
  // not a `window.innerWidth/Height * 0.9` approximation — the container has
  // `max-w-[90vw]` and `h-[85vh]` which don't match the window's 90vh exactly.
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  })

  // Observe the wrapper's size so fitScale responds to viewport / device
  // rotation / window resize — and so the very first "fit" click (before
  // any measurement happens) falls back to a sensible window-based value.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const measure = () => {
      const rect = el.getBoundingClientRect()
      setContainerSize({ w: rect.width, h: rect.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Initial scale: fit the diagram width to the container width.
  // Falls back to a window-based estimate if the wrapper hasn't been
  // measured yet on first render.
  const initialScale = (() => {
    if (intrinsicWidth <= 0) return 1
    const availWidth =
      containerSize.w > 0
        ? containerSize.w
        : window.innerWidth * 0.9 * 0.9 // nested 90% (Lightbox ⊃ wrapper)
    if (availWidth <= 0) return 1
    return availWidth / intrinsicWidth
  })()

  // Fit the ENTIRE diagram into the viewport (both axes).
  // We measure the actual wrapper (not the window) so the inner padding
  // (`p-4` on the SVG div) and the 85vh vs 90vh difference are honored.
  const fitScale = useCallback(() => {
    if (intrinsicWidth <= 0) return 1
    const intrinsicHeight = vbHeight() ?? intrinsicWidth
    const w = containerSize.w > 0 ? containerSize.w : window.innerWidth * 0.9
    const h = containerSize.h > 0 ? containerSize.h : window.innerHeight * 0.85
    if (w <= 0 || h <= 0) return 1
    return Math.min(w / intrinsicWidth, h / intrinsicHeight)
  }, [svg, intrinsicWidth, containerSize.w, containerSize.h])

  return (
    <div ref={wrapperRef} className="relative h-[85vh] w-full">
      <TransformWrapper
        initialScale={initialScale}
        minScale={0.05}
        maxScale={20}
        centerOnInit
        limitToBounds={false}
        wheel={{ step: 0.08 }}
        doubleClick={{ mode: 'zoomIn', step: 0.5 }}
        pinch={{ step: 5 }}
      >
        {/** Controls — rendered via the library's context hook. */}
        <ZoomControls fitScale={fitScale} />

        <TransformComponent
          wrapperStyle={{
            width: '100%',
            height: '100%',
          }}
          contentStyle={{ display: 'flex', justifyContent: 'center', alignItems: 'center' }}
        >
          {/**
           * Original SVG at its intrinsic viewBox size. `width="100%"` on the
           * root svg is overridden so the library's CSS transform scales the
           * true diagram dimensions (initialScale is computed from this width).
           */}
          <div
            className="bg-white p-4"
            style={{ width: intrinsicWidth > 0 ? `${intrinsicWidth}px` : undefined }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </TransformComponent>
      </TransformWrapper>
    </div>
  )
}

/**
 * Floating zoom controls (bottom-right), reading zoom actions from the
 * react-zoom-pan-pinch context. Layout (like common image viewers):
 *
 *   [ − ]  [ 124% ]  [ + ]  |  [⛶ Fit ]  [↺ Reset ]
 *
 * The percentage shows the LIVE scale. We use `useTransformComponent`
 * (not `useTransformContext`) because the former subscribes to library
 * `onChange` and re-renders when scale changes — the context value is a
 * mutable class instance whose `state` mutation does NOT trigger a render.
 *
 * Icons: Scan (four-corner frame) = fit-to-view; RotateCcw = reset.
 * Action buttons with ambiguous icons carry a text label for clarity.
 */
function ZoomControls({ fitScale }: { fitScale: () => number }) {
  const { zoomIn, zoomOut, resetTransform, centerView } = useControls()
  const percent = useTransformComponent(({ state }) => Math.round(state.scale * 100))
  const t = useT()

  return (
    <div className="fixed bottom-4 right-4 z-50 flex items-center gap-0.5 rounded-full border border-neutral-200 bg-white/95 p-1 shadow-lg backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95">
      <button
        type="button"
        onClick={() => zoomOut(0.25)}
        className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        title={t('agent.mermaid.zoom.zoomOut')}
        aria-label={t('agent.mermaid.zoom.zoomOut')}
      >
        <ZoomOut className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => resetTransform(200)}
        className="min-w-[48px] rounded-full px-2 py-1 text-center text-xs font-medium tabular-nums text-neutral-600 transition-colors hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
        title={t('agent.mermaid.zoom.resetPercent')}
      >
        {percent}%
      </button>
      <button
        type="button"
        onClick={() => zoomIn(0.25)}
        className="flex h-8 w-8 items-center justify-center rounded-full text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        title={t('agent.mermaid.zoom.zoomIn')}
        aria-label={t('agent.mermaid.zoom.zoomIn')}
      >
        <ZoomIn className="h-4 w-4" />
      </button>
      <div className="mx-0.5 h-5 w-px bg-neutral-200 dark:bg-neutral-700" />
      <button
        type="button"
        onClick={() => centerView(fitScale(), 200)}
        className="flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        title={t('agent.mermaid.zoom.fitToWindowTitle')}
      >
        <Scan className="h-4 w-4" />
        <span className="hidden sm:inline">{t('agent.mermaid.zoom.fitToWindow')}</span>
      </button>
      <button
        type="button"
        onClick={() => resetTransform(200)}
        className="flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
        title={t('agent.mermaid.zoom.resetTitle')}
      >
        <RotateCcw className="h-4 w-4" />
        <span className="hidden sm:inline">{t('agent.mermaid.zoom.reset')}</span>
      </button>
    </div>
  )
}

/**
 * MermaidDiagramImpl — the actual rendering logic, separated so the
 * memo boundary compares the `chart` string rather than props identity.
 */
const MermaidDiagramImpl = memo(function MermaidDiagramImpl({
  chart,
  streaming = false,
}: MermaidDiagramProps) {
  const { isDark } = useTheme()
  const t = useT()
  const [state, setState] = useState<RenderState>({ kind: 'loading' })
  const [zoomOpen, setZoomOpen] = useState(false)
  // View tab: toggle between the rendered diagram and the raw source.
  const [tab, setTab] = useState<'preview' | 'source'>('preview')
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(chart)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard API may be unavailable in some contexts
    }
  }, [chart])
  // Unique id prefix per instance — mermaid needs a unique render target id.
  const rawId = useId()
  // useId returns something like ":r0:" which is invalid in CSS/HTML id
  // selectors. Sanitize to a safe id.
  const idPrefix = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`
  const renderSeqRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    const seq = ++renderSeqRef.current

    // Parent says "still streaming": lock to loading, do NOT attempt
    // to render. Trying to parse/render partial input would only ever
    // produce failures mid-stream.
    if (streaming) {
      setState({ kind: 'loading' })
      return () => {
        cancelled = true
      }
    }

    // Stream is finalized (or this is a non-stream context). Run a
    // real render. We deliberately do NOT reset to `loading` here —
    // if we already have an SVG, keep showing it until the new
    // attempt completes, avoiding a flash of spinner on small edits.
    loadMermaid()
      .then((mermaid) => {
        if (cancelled) return
        mermaid.initialize({
          startOnLoad: false,
          theme: isDark ? 'dark' : 'default',
          securityLevel: 'strict',
          fontFamily:
            'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
          // Do NOT render mermaid's built-in "Syntax error in text"
          // error diagram. When parsing fails, mermaid would otherwise
          // resolve successfully with that error SVG; this flag makes it
          // throw instead, so our catch below surfaces a contained,
          // friendly error state (banner + source) rather than dumping
          // the error diagram into the message body.
          suppressErrorRendering: true,
        })
        const renderId = `${idPrefix}-${seq}`
        // Render directly: with suppressErrorRendering: true, invalid
        // syntax rejects instead of returning the "Syntax error" error
        // diagram (see mermaidAPI.render). No pre-parse needed.
        return mermaid.render(renderId, chart).then((res: { svg: string }) => {
          // Belt-and-suspenders: if some failure mode still emits the
          // error diagram without rejecting, catch it here too.
          if (isMermaidErrorSvg(res.svg)) {
            throw new Error('Invalid mermaid syntax')
          }
          return res
        })
      })
      .then((res: { svg: string } | undefined) => {
        if (cancelled) return
        if (res?.svg) {
          setState({ kind: 'rendered', svg: res.svg })
        } else {
          setState({ kind: 'errored', message: 'Empty render result' })
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // Errors are CONTAINED: no console.error, no throw, no escape.
        // The banner below is the only surface the user sees.
        const message = err instanceof Error ? err.message : String(err)
        setState({ kind: 'errored', message })
      })

    return () => {
      cancelled = true
    }
  }, [chart, streaming, isDark, idPrefix])

  // ── Loading ─────────────────────────────────────────────────────────
  if (state.kind === 'loading') {
    return (
      <div
        className="my-2 flex items-center justify-center rounded-md border border-neutral-200 bg-neutral-50 py-12 dark:border-neutral-700 dark:bg-bg-tertiary"
        aria-live="polite"
        aria-busy="true"
      >
        <Loader2 className="h-4 w-4 animate-spin text-neutral-400" />
        <span className="ml-2 text-xs text-neutral-400">
          {streaming ? t('agent.mermaid.preparing') : t('agent.mermaid.rendering')}
        </span>
      </div>
    )
  }

  // ── Errored — banner strictly inside this root <div> ───────────────
  if (state.kind === 'errored') {
    return (
      <div className="my-2 overflow-hidden rounded-md border border-amber-200 dark:border-amber-800/50">
        <div className="flex items-center gap-1.5 bg-amber-50 px-3 py-1 text-[11px] text-amber-600 dark:bg-amber-900/20 dark:text-amber-400">
          <AlertTriangle className="h-3 w-3 shrink-0" />
          <span className="font-medium">{t('agent.mermaid.syntaxError')}</span>
        </div>
        <pre className="overflow-x-auto bg-neutral-50 p-3 dark:bg-bg-tertiary">
          <code className="text-[13px] leading-relaxed text-neutral-800 dark:text-white">
            {chart}
          </code>
        </pre>
      </div>
    )
  }

  // ── Rendered ────────────────────────────────────────────────────────
  // (TS narrowing: after the two returns above, state.kind === 'rendered')
  return (
    <>
      <div className="my-2 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
        {/* Header bar: view tabs (left) + language label & copy (right) */}
        <div className="flex items-center justify-between bg-neutral-100 px-2 py-1 dark:bg-neutral-800">
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => setTab('preview')}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                tab === 'preview'
                  ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                  : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-white'
              }`}
            >
              {t('agent.mermaid.preview')}
            </button>
            <button
              type="button"
              onClick={() => setTab('source')}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                tab === 'source'
                  ? 'bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white'
                  : 'text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-white'
              }`}
            >
              {t('agent.mermaid.source')}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-400 dark:text-neutral-500">
              mermaid
            </span>
            <button
              type="button"
              onClick={handleCopy}
              title={copied ? t('agent.mermaid.copied') : t('agent.mermaid.copySource')}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-neutral-200 dark:hover:bg-neutral-700"
            >
              {copied ? (
                <>
                  <Check className="h-3 w-3 text-green-500" />
                  <span className="text-green-600 dark:text-green-400">{t('agent.mermaid.copied')}</span>
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3 text-neutral-500 dark:text-neutral-400" />
                  <span className="text-neutral-500 dark:text-neutral-400">{t('agent.mermaid.copy')}</span>
                </>
              )}
            </button>
          </div>
        </div>
        {/* Content: rendered preview or raw source */}
        {tab === 'preview' ? (
          <div className="overflow-x-auto bg-white p-4 dark:bg-neutral-900">
            <div
              className="cursor-zoom-in [&>svg]:mx-auto [&>svg]:max-w-full"
              // mermaid.render returns sanitized SVG (securityLevel: 'strict' uses DOMPurify internally).
              // We render it via dangerouslySetInnerHTML because the SVG string
              // is already a complete element.
              dangerouslySetInnerHTML={{ __html: state.svg }}
              onClick={() => setZoomOpen(true)}
            />
          </div>
        ) : (
          <pre className="overflow-x-auto bg-neutral-50 p-3 dark:bg-bg-tertiary">
            <code className="text-[13px] leading-relaxed text-neutral-800 dark:text-white">
              {chart}
            </code>
          </pre>
        )}
      </div>
      {zoomOpen && (
        <Lightbox
          onClose={() => setZoomOpen(false)}
          contentClassName="max-h-[90vh] max-w-[90vw] min-w-0 rounded-md bg-white shadow-2xl"
          imgClassName="bg-white"
        >
          {/**
           * Render the SVG into the current DOM (not via an <img> data URI).
           * Loading an SVG that contains <foreignObject> (mermaid node labels)
           * through an <img> enters the browser's "image/static" mode, which
           * does NOT render <foreignObject> — causing broken/blank diagrams on
           * some content. Injecting the same SVG element renders reliably.
           */}
          <ZoomableSvg svg={state.svg} />
        </Lightbox>
      )}
    </>
  )
})

export const MermaidDiagram = MermaidDiagramImpl
