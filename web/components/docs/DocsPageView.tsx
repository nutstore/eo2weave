'use client'

import { useRouter } from 'next/navigation'
import { DocumentationPage } from '@/components/docs/DocsPage'
import { projectsPath } from '@/lib/route-paths'
import type { DocPageContent, DocsCategory, DocsIndexes, DocsLanguage } from '@/lib/docs-server'

/**
 * DocsPageView — client boundary for the docs route.
 *
 * The server component (app/(app)/docs/[[...path]]/page.tsx) resolves the
 * sidebar indexes and the current page markdown from the repository `docs/`
 * tree at build time and passes them in as props. This wrapper only owns the
 * in-app back action and forwards data to the presentational component.
 */
export interface DocsPageViewProps {
  language?: DocsLanguage
  category?: DocsCategory
  slug?: string
  indexes: DocsIndexes
  pageContent: DocPageContent | null
}

export default function DocsPageView({
  language,
  category,
  slug,
  indexes,
  pageContent,
}: DocsPageViewProps) {
  const navigate = useRouter()

  return (
    <DocumentationPage
      language={language}
      category={category}
      page={slug}
      indexes={indexes}
      pageContent={pageContent}
      onBack={() => navigate.push(projectsPath())}
    />
  )
}
