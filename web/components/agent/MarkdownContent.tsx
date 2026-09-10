/**
 * MarkdownContent - renders markdown text with syntax highlighting.
 * Used by both MessageBubble (final messages) and streaming display.
 *
 * Memoized: avoids re-parsing markdown when content hasn't changed.
 * This is critical during streaming — every delta triggers a parent
 * re-render, but already-committed text blocks stay stable.
 *
 * Image support: `![alt](assets/images/...)` references are resolved
 * from OPFS and rendered as inline images with loading states.
 *
 * Math support: LaTeX formulas via remark-math + rehype-katex.
 * Inline: $x_1$  Block: $$\varepsilon_l = x_l - \hat{x}_l$$
 */

import { memo, useContext, createContext, useEffect, useRef, useState, useCallback, useMemo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkBreaks from 'remark-breaks'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeRaw from 'rehype-raw'
import 'katex/dist/katex.min.css'
import { Copy, Check, Loader2 } from 'lucide-react'
import { readAssetBlob, readWorkspaceFileBlob } from './asset-utils'
import { HtmlSandboxPreview } from './HtmlSandboxPreview'
import { Lightbox } from './Lightbox'
import { MermaidDiagram } from './MermaidDiagram'

/** Context for passing the image click callback from MarkdownContent to MarkdownImage/AssetImage */
const ImageClickContext = createContext<(src: string) => void>(() => {})

/** Check if a path looks like an OPFS asset reference */
function isAssetPath(src: string): boolean {
  return src.startsWith('assets/') || src.startsWith('/assets/')
}

/** Strip leading "assets/" to get the relative OPFS path */
function toRelativePath(src: string): string {
  const p = src.startsWith('/') ? src.slice(1) : src
  if (p.startsWith('assets/')) return p.slice('assets/'.length)
  return p
}

/**
 * Check whether a string looks like a local/relative file reference
 * rather than a remote URL or data URI. Bare filenames such as
 * `byd_2026_05_sales.png` or `sub/dir/img.png` qualify; `http(s)://`,
 * `data:`, `blob:` and protocol-relative URLs do not.
 */
function isLocalFilePath(src: string): boolean {
  return (
    !/^[a-z][a-z0-9+.-]*:/i.test(src) && // not a URL scheme (http:, data:, blob: ...)
    !src.startsWith('//') && // not protocol-relative
    !src.startsWith('#') // not an anchor
  )
}

/**
 * MarkdownImage — custom `img` component for react-markdown.
 *
 * Resolution order for local images:
 * 1. `assets/...` paths → conversation assets directory (OPFS)
 * 2. Any other local/relative path →
 *    a. try conversation assets directory (stripped of any rootName prefix)
 *    b. try the workspace OPFS store (rootName/path or bare path)
 *
 * External URLs and data URIs are rendered as-is.
 */
function MarkdownImage({ src, alt, ...props }: React.ComponentPropsWithoutRef<'img'>) {
  const srcStr = src || ''
  const onImageClick = useContext(ImageClickContext)

  // External URL or data URI → render with click-to-enlarge
  if (!isAssetPath(srcStr) && !isLocalFilePath(srcStr)) {
    return (
      <img
        src={srcStr}
        alt={alt || ''}
        loading="lazy"
        className="max-w-full cursor-zoom-in"
        onClick={() => onImageClick(srcStr)}
        {...props}
      />
    )
  }

  return <AssetImage src={srcStr} alt={alt || ''} />
}

/**
 * AssetImage — resolves a local image reference into an inline image.
 *
 * Resolution order:
 * 1. If `src` is an `assets/...` path → read from conversation assets dir.
 * 2. Otherwise (bare/workspace-relative path) →
 *    a. try the conversation assets dir (last segment as filename)
 *    b. fall back to the workspace OPFS store (handles `rootName/path`
 *       and bare paths across all roots)
 *
 * Shows loading spinner while reading, error state on failure.
 */
function AssetImage({ src, alt }: { src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const urlRef = useRef<string | null>(null)
  const onImageClick = useContext(ImageClickContext)
  const assetPath = isAssetPath(src) ? toRelativePath(src) : src.replace(/^\/+/, '')

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current)
    }
  }, [])

  // Load image (assets dir first, then workspace fallback)
  useEffect(() => {
    let cancelled = false

    async function load() {
      // 1. Try the conversation assets directory
      const blob = await readAssetBlob(assetPath)
      if (blob) return blob

      // 2. Fall back to the workspace OPFS store. `readWorkspaceFileBlob`
      //    accepts both `rootName/path` and bare paths; the runtime resolves
      //    bare paths against the configured roots.
      return await readWorkspaceFileBlob(assetPath)
    }

    load().then((blob) => {
      if (cancelled) return
      if (blob) {
        const objectUrl = URL.createObjectURL(blob)
        urlRef.current = objectUrl
        setUrl(objectUrl)
      } else {
        setError(true)
      }
    })
    return () => { cancelled = true }
  }, [assetPath])

  if (error) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-red-50 px-2 py-1 text-xs text-red-500 dark:bg-red-900/20 dark:text-red-400">
        ⚠ Image not found: {assetPath.split('/').pop()}
      </span>
    )
  }

  if (!url) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-neutral-100 px-2 py-1 text-xs text-neutral-400 dark:bg-neutral-800">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading image…
      </span>
    )
  }

  return (
    <img
      src={url}
      alt={alt}
      className="max-w-full cursor-zoom-in rounded-md"
      loading="lazy"
      onClick={() => onImageClick(url)}
    />
  )
}

// Stable module-level references — prevents ReactMarkdown from re-parsing
// when the MarkdownContent parent re-renders with unchanged content.
// Previously these were inline literals, causing new array/object refs on
// every render → 76 unnecessary re-renders on cancel (react-scan profiled).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const REHYPE_PLUGINS: any = [rehypeKatex]

interface MarkdownAstNode {
  type?: string
  meta?: string
  data?: { hProperties?: Record<string, unknown> }
  children?: MarkdownAstNode[]
}

/** Preserve fenced-code metadata so interactive-html blocks can read title/height. */
function preserveCodeFenceMeta() {
  const visit = (node: MarkdownAstNode) => {
    if (node.type === 'code' && node.meta) {
      node.data = { ...node.data, hProperties: { ...node.data?.hProperties, 'data-meta': node.meta } }
    }
    node.children?.forEach(visit)
  }
  return (tree: MarkdownAstNode) => visit(tree)
}

// remark-breaks converts single line breaks (\n) into <br>, so poetry,
// lyrics, and other content that relies on one-line-per-statement renders
// correctly instead of being merged into a single paragraph.
const INTERACTIVE_HTML_REMARK_PLUGINS: any = [remarkGfm, remarkMath, remarkBreaks, preserveCodeFenceMeta]

/**
 * Extract plain text from react-markdown children (may be string, ReactNode[], etc.)
 */
function extractText(children: React.ReactNode): string {
  if (typeof children === 'string') return children
  if (Array.isArray(children)) return children.map(extractText).join('')
  if (children && typeof children === 'object' && 'props' in (children as React.ReactElement)) {
    return extractText((children as React.ReactElement).props.children)
  }
  return String(children)
}

/**
 * CodeBlock — renders a fenced code block with language label and copy button.
 */
function CodeBlock({
  language,
  code,
}: {
  language: string | undefined
  code: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    const text = extractText(code)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // clipboard API may be unavailable in some contexts
    }
  }, [code])

  return (
    <div className="my-2 overflow-hidden rounded-md border border-neutral-200 dark:border-neutral-700">
      <div className="flex items-center justify-between bg-neutral-100 px-3 py-1 dark:bg-neutral-800">
        <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-500 text-neutral-400 text-neutral-400 dark:text-neutral-400">
          {language || 'code'}
        </span>
        <button
          onClick={handleCopy}
          title={copied ? 'Copied!' : 'Copy code'}
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >
          {copied ? (
            <>
              <Check className="h-3 w-3 text-green-500" />
              <span className="text-green-600 dark:text-green-400">Copied!</span>
            </>
          ) : (
            <>
              <Copy className="h-3 w-3 text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500" />
              <span className="text-neutral-400 text-neutral-500 text-neutral-500 dark:text-neutral-500">Copy</span>
            </>
          )}
        </button>
      </div>
      <pre className="overflow-x-auto bg-neutral-50 p-3 dark:bg-bg-tertiary">
        <code className="text-[13px] leading-relaxed text-neutral-800 dark:text-white">
          {code}
        </code>
      </pre>
    </div>
  )
}

interface MarkdownCodeNode {
  properties?: {
    'data-meta'?: string | null
  }
}

export function parseInteractiveHtmlMeta(meta: string | null | undefined): { title: string; height: number } {
  const titleMatch = meta && /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta)
  const heightMatch = meta && /(?:^|\s)height=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(meta)
  const heightValue = heightMatch?.[1] ?? heightMatch?.[2] ?? heightMatch?.[3]
  const parsedHeight = heightValue ? Number.parseInt(heightValue, 10) : NaN
  return {
    title: titleMatch?.[1] ?? titleMatch?.[2] ?? titleMatch?.[3] ?? 'Interactive demo',
    height: Number.isFinite(parsedHeight) ? Math.min(Math.max(parsedHeight, 240), 720) : 420,
  }
}

function buildMarkdownComponents(streaming: boolean) {
  return {
  // Fenced blocks provide their own <pre> in CodeBlock or HtmlSandboxPreview.
  // Removing react-markdown's wrapper avoids invalid block-level elements inside <pre>.
  pre({ children }: React.ComponentPropsWithoutRef<'pre'>) {
    return <>{children}</>
  },
  // Code blocks
  code({ className, children, node, ...props }: React.ComponentPropsWithoutRef<'code'> & { className?: string; node?: MarkdownCodeNode }) {
    const match = /language-([\w-]+)/.exec(className || '')
    const isBlock = match || (typeof children === 'string' && children.includes('\n'))
    if (match?.[1] === 'mermaid') {
      return <MermaidDiagram chart={extractText(children).replace(/^\n+|\n+$/g, '')} streaming={streaming} />
    }
    if (match?.[1] === 'interactive-html') {
      const meta = parseInteractiveHtmlMeta(node?.properties?.['data-meta'])
      return (
        <HtmlSandboxPreview
          html={extractText(children).replace(/^\n+|\n+$/g, '')}
          title={meta.title}
          height={meta.height}
          showReset
          showSource
          allowFullscreen
          downloadFileName="interactive-demo.html"
        />
      )
    }
    if (isBlock) {
      return <CodeBlock language={match?.[1]} code={children} />
    }
    return (
      <code
        className="rounded bg-neutral-100 px-1.5 py-0.5 text-[13px] text-pink-600 dark:bg-neutral-800 dark:text-pink-400"
        {...props}
      >
        {children}
      </code>
    )
  },
  // Paragraphs
  p({ children }: React.ComponentPropsWithoutRef<'p'>) {
    return <p className="mb-2 last:mb-0">{children}</p>
  },
  // Lists
  ul({ children }: React.ComponentPropsWithoutRef<'ul'>) {
    return <ul className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">{children}</ul>
  },
  ol({ children }: React.ComponentPropsWithoutRef<'ol'>) {
    return <ol className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">{children}</ol>
  },
  // Links
  a({ href, children }: React.ComponentPropsWithoutRef<'a'>) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary-600 dark:text-primary-500 underline hover:text-primary-700 dark:hover:text-primary-700"
      >
        {children}
      </a>
    )
  },
  // Headings
  h1({ children }: React.ComponentPropsWithoutRef<'h1'>) {
    return <h1 className="mb-2 text-base font-bold text-neutral-900 dark:text-white">{children}</h1>
  },
  h2({ children }: React.ComponentPropsWithoutRef<'h2'>) {
    return <h2 className="mb-1.5 text-sm font-bold text-neutral-900 dark:text-white">{children}</h2>
  },
  h3({ children }: React.ComponentPropsWithoutRef<'h3'>) {
    return <h3 className="mb-1 text-sm font-semibold text-neutral-900 dark:text-white">{children}</h3>
  },
  // Blockquote
  blockquote({ children }: React.ComponentPropsWithoutRef<'blockquote'>) {
    return (
      <blockquote className="mb-2 border-l-2 border-neutral-300 dark:border-neutral-600 pl-3 text-neutral-600 dark:text-white last:mb-0">
        {children}
      </blockquote>
    )
  },
  // Table
  table({ children }: React.ComponentPropsWithoutRef<'table'>) {
    return (
      <div className="my-2 overflow-x-auto">
        <table className="w-full border-collapse text-sm">{children}</table>
      </div>
    )
  },
  th({ children }: React.ComponentPropsWithoutRef<'th'>) {
    return (
      <th className="border border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 px-3 py-1.5 text-left font-medium dark:text-white">
        {children}
      </th>
    )
  },
  td({ children }: React.ComponentPropsWithoutRef<'td'>) {
    return <td className="border border-neutral-200 dark:border-neutral-700 px-3 py-1.5 dark:text-white">{children}</td>
  },
  // Horizontal rule
  hr() {
    return <hr className="my-3 border-neutral-200 dark:border-neutral-700" />
  },
  // Images — resolve OPFS asset paths (e.g. assets/images/...)
  img(props: React.ComponentPropsWithoutRef<'img'>) {
    return <MarkdownImage {...props} />
  },
  }
}

/**
 * Convert LaTeX-style delimiters to remark-math compatible syntax.
 * \[...\] → $$...$$ (display math)
 * \(...\) → $...$ (inline math)
 *
 * LLMs often output \[\] and \(\) which remark-math doesn't recognize
 * by default (it only handles $$ and $).
 */
function normalizeMathDelimiters(content: string): string {
  // Display math: \[ ... \] → $$ ... $$
  let result = content.replace(/\\\[([\s\S]*?)\\\]/g, (_match, body) => `$$${body}$$`)
  // Inline math: \( ... \) → $ ... $
  result = result.replace(/\\\(([\s\S]*?)\\\)/g, (_match, body) => `$${body}$`)
  return result
}

interface MarkdownContentProps {
  content: string
  /**
   * Whether the markdown content is still being streamed in by the
   * parent (typically an LLM token stream). Defaults to false.
   *
   * Forwarded to `MermaidDiagram` so a partially-emitted mermaid
   * block shows a "Preparing diagram…" spinner instead of flashing a
   * misleading "syntax error" banner mid-stream.
   */
  streaming?: boolean
  /**
   * Whether to render raw HTML embedded in the markdown.
   *
   * react-markdown escapes HTML by default for safety. Set this to true
   * ONLY for trusted content (e.g. local .md file previews) where the
   * user explicitly authored or trusts the HTML. When enabled, mounts
   * the `rehype-raw` plugin so tags like `<div align="center">…</div>`
   * render as real elements instead of visible tag text.
   *
   * Defaults to false (AI message stream stays XSS-safe).
   */
  allowHtml?: boolean
}

export const MarkdownContent = memo(function MarkdownContent({ content, streaming = false, allowHtml = false }: MarkdownContentProps) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const normalized = normalizeMathDelimiters(content)
  const components = useMemo(() => buildMarkdownComponents(streaming), [streaming])
  // rehype-raw must run BEFORE rehype-katex: it reparses raw HTML strings
  // into hast nodes so that subsequent plugins (katex) see a real tree.
  // Without it, embedded HTML like `<div align="center">…</div>` shows up
  // as literal tag text instead of rendered elements.
  const rehypePlugins = useMemo(
    () => (allowHtml ? [rehypeRaw, ...REHYPE_PLUGINS] : REHYPE_PLUGINS),
    [allowHtml],
  )
  return (
    <ImageClickContext.Provider value={setLightboxSrc}>
      <ReactMarkdown
        remarkPlugins={INTERACTIVE_HTML_REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {normalized}
      </ReactMarkdown>
      {lightboxSrc && (
        <Lightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />
      )}
    </ImageClickContext.Provider>
  )
})
