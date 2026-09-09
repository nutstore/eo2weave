import DocsClientBoundary from '@/components/docs/DocsClientBoundary'
import type { Metadata } from 'next'
import {
  DOCS_CATEGORIES,
  DOCS_LANGUAGES,
  getAllDocIndexes,
  getDocPage,
  listAllDocRoutes,
} from '@/lib/docs-server'
import type { DocsCategory, DocsLanguage } from '@/lib/docs-server'

// Markdown rendering is browser-only (OPFS image resolution, KaTeX, mermaid).
// DocsClientBoundary hosts the ssr:false dynamic import (not allowed directly
// in Server Components); the props passed below are resolved server-side.

/**
 * Docs catch-all: /docs, /docs/:language, /docs/:language/:category,
 * /docs/:language/:category/:page — one route replacing the legacy four
 * <Route> entries.
 *
 * Content is resolved SERVER-SIDE at build time from the repository `docs/`
 * tree (the single source of truth) and handed to the client shell as props.
 * This replaces the old pipeline that copied docs/ into web/public/docs/ and
 * had the client fetch raw markdown at runtime.
 */

// All route combinations come from the real docs tree; unknown paths 404.
export const dynamicParams = false

export async function generateStaticParams(): Promise<Array<{ path: string[] }>> {
  return listAllDocRoutes()
}

function isDocsLanguage(value?: string): value is DocsLanguage {
  return (DOCS_LANGUAGES as readonly string[]).includes(value ?? '')
}

function isDocsCategory(value?: string): value is DocsCategory {
  return (DOCS_CATEGORIES as readonly string[]).includes(value ?? '')
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ path?: string[] }>
}): Promise<Metadata> {
  const { path: segments = [] } = await params
  const [language, category, slug] = segments
  if (!isDocsLanguage(language) || !isDocsCategory(category) || !slug) {
    return { title: 'Docs' }
  }
  const page = await getDocPage(language, category, slug)
  return { title: page ? `${page.entry.title} — Docs` : 'Docs' }
}

export default async function DocsRoute({ params }: { params: Promise<{ path?: string[] }> }) {
  const { path: segments = [] } = await params
  const [language, category, slug] = segments

  const lang = isDocsLanguage(language) ? language : undefined
  const cat = isDocsCategory(category) ? category : undefined

  // Resolve everything the client shell needs — no runtime fetching. Invalid
  // prefixes coerce to undefined above, which renders the docs home view.
  // The four indexes travel with every route so the sidebar and the locale
  // switcher work without any client-side index loading.
  const indexes = await getAllDocIndexes()
  const page = cat && slug && lang ? await getDocPage(lang, cat, slug) : null

  return (
    <DocsClientBoundary
      language={lang}
      category={cat}
      slug={slug}
      indexes={indexes}
      pageContent={page}
    />
  )
}
