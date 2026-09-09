'use client'

import dynamic from 'next/dynamic'
import type { DocPageContent, DocsCategory, DocsIndexes, DocsLanguage } from '@/lib/docs-server'

/**
 * Client boundary that hosts the `ssr: false` dynamic import.
 *
 * Next.js forbids `ssr: false` on next/dynamic inside Server Components, so
 * the RSC docs route renders this component and the browser-only view
 * (OPFS image resolution, KaTeX, mermaid) is loaded client-side only —
 * same behaviour as the pre-App-Router version of the docs page.
 */
const DocsPageView = dynamic(() => import('@/components/docs/DocsPageView'), { ssr: false })

export interface DocsRouteData {
  language?: DocsLanguage
  category?: DocsCategory
  slug?: string
  indexes: DocsIndexes
  pageContent: DocPageContent | null
}

export default function DocsClientBoundary(props: DocsRouteData) {
  return <DocsPageView {...props} />
}
