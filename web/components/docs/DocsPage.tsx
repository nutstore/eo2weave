/**
 * DocumentationPage - Documentation viewer component
 *
 * Redesigned with editorial/magazine aesthetic:
 * - Strong typographic hierarchy
 * - Clean content-focused layout
 * - Generous whitespace and visual rhythm
 * - Smooth transitions and interactions
 */

import { useEffect, useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { docsPath } from '@/lib/route-paths'
import { ChevronLeft, ChevronRight, Menu, X, FileText, BookOpen, Code2, Github } from 'lucide-react'
import { MarkdownContent } from '@/components/agent/MarkdownContent'
import { BrandButton } from '@creatorweave/ui'
import { cn } from '@/lib/utils'
import { useLocale } from '@/i18n'
import type { Locale } from '@/i18n'
import type { DocPageContent, DocsIndexes } from '@/lib/docs-server'

type DocsLanguage = 'zh' | 'en'
type DocsCategory = 'user' | 'developer'

interface DocumentationPageProps {
  language?: DocsLanguage
  category?: DocsCategory
  page?: string
  /** Sidebar indexes for every language × category, resolved server-side. */
  indexes: DocsIndexes
  /** Markdown for the current page (null on index/home views or unknown slug). */
  pageContent: DocPageContent | null
  onBack?: () => void
}

const CATEGORY_ICONS = {
  user: BookOpen,
  developer: Code2,
} as const

const CATEGORY_LABELS: Record<DocsLanguage, Record<'user' | 'developer', string>> = {
  zh: {
    user: '用户文档',
    developer: '开发者文档',
  },
  en: {
    user: 'User Docs',
    developer: 'Developer Docs',
  },
}

const UI_TEXT: Record<
  DocsLanguage,
  {
    homeTitle: string
    homeSubtitle: string
    categoryDescriptions: Record<'user' | 'developer', string>
    openSourceLabel: string
    githubSource: string
    tocLabel: string
    backToDocsHome: string
    chooseDocToRead: string
    docsRootLabel: string
    backToDirectory: string
    docNotFound: string
  }
> = {
  zh: {
    homeTitle: '文档中心',
    homeSubtitle: '选择文档类别开始探索',
    categoryDescriptions: {
      user: '产品功能使用指南，快速上手',
      developer: 'API 参考和技术架构文档',
    },
    openSourceLabel: '开源项目',
    githubSource: 'GitHub 源码',
    tocLabel: '目录',
    backToDocsHome: '回到文档首页',
    chooseDocToRead: '选择一个文档开始阅读',
    docsRootLabel: '文档',
    backToDirectory: '返回目录',
    docNotFound: '文档未找到',
  },
  en: {
    homeTitle: 'Documentation',
    homeSubtitle: 'Choose a section to start reading',
    categoryDescriptions: {
      user: 'Product usage guides and quick starts',
      developer: 'API references and architecture notes',
    },
    openSourceLabel: 'Open Source',
    githubSource: 'GitHub Repository',
    tocLabel: 'Contents',
    backToDocsHome: 'Back to docs home',
    chooseDocToRead: 'Choose a document to start reading',
    docsRootLabel: 'Docs',
    backToDirectory: 'Back to directory',
    docNotFound: 'Document not found',
  },
}

function localeToDocsLanguage(locale: Locale): DocsLanguage {
  return locale === 'zh-CN' ? 'zh' : 'en'
}

export function DocumentationPage({
  language,
  category,
  page,
  indexes,
  pageContent,
  onBack,
}: DocumentationPageProps) {
  const navigate = useRouter()
  const [locale, setLocale] = useLocale()
  const docsLang = language ?? localeToDocsLanguage(locale)
  const copy = UI_TEXT[docsLang]
  const index = category ? indexes[docsLang][category] : null
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)

  // Close mobile sidebar when navigating to a page
  useEffect(() => {
    if (page) {
      setMobileSidebarOpen(false)
    }
  }, [page])

  const navigateTo = useCallback((cat: 'user' | 'developer', slug?: string, lang?: DocsLanguage) => {
    navigate.push(docsPath(lang ?? docsLang, cat, slug))
  }, [docsLang, navigate])

  const navigateToHome = useCallback((lang?: DocsLanguage) => {
    navigate.push(docsPath(lang ?? docsLang))
  }, [docsLang, navigate])

  const switchLocale = useCallback((nextLocale: Locale) => {
    if (locale === nextLocale) return
    const nextLang = localeToDocsLanguage(nextLocale)

    // Keep current page when target locale has same slug; otherwise fallback to category home.
    if (category && page) {
      const hasSameSlug = indexes[nextLang][category].pages.some((p) => p.slug === page)
      setLocale(nextLocale)
      navigateTo(category, hasSameSlug ? page : undefined, nextLang)
      return
    }

    setLocale(nextLocale)
    if (category) {
      navigateTo(category, undefined, nextLang)
      return
    }
    navigateToHome(nextLang)
  }, [category, page, indexes, locale, setLocale, navigateTo, navigateToHome])

  const pages = index?.pages ?? []

  // Get current page info
  const currentPage = index?.pages.find((p) => p.slug === page)
  const CategoryIcon = category ? CATEGORY_ICONS[category] : null
  const LanguageSwitch = ({ compact = false }: { compact?: boolean }) => (
    <div
      className={cn(
        'inline-flex items-center gap-1 rounded-lg border border-[oklch(88%_0.01_60)] bg-white p-1 dark:border-[oklch(25%_0.01_60)] dark:bg-[oklch(18%_0.01_250)]',
        compact && 'scale-95'
      )}
    >
      <button
        type="button"
        onClick={() => switchLocale('zh-CN')}
        className={cn(
          'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
          docsLang === 'zh'
            ? 'bg-[oklch(94%_0.04_175)] text-[oklch(40%_0.08_175)] dark:bg-[oklch(25%_0.03_175)] dark:text-[oklch(80%_0.05_175)]'
            : 'text-[oklch(45%_0.015_60)] hover:bg-[oklch(94%_0.01_60)] dark:text-[oklch(60%_0.01_60)] dark:hover:bg-[oklch(22%_0.01_60)]'
        )}
      >
        中文
      </button>
      <button
        type="button"
        onClick={() => switchLocale('en-US')}
        className={cn(
          'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
          docsLang === 'en'
            ? 'bg-[oklch(94%_0.04_175)] text-[oklch(40%_0.08_175)] dark:bg-[oklch(25%_0.03_175)] dark:text-[oklch(80%_0.05_175)]'
            : 'text-[oklch(45%_0.015_60)] hover:bg-[oklch(94%_0.01_60)] dark:text-[oklch(60%_0.01_60)] dark:hover:bg-[oklch(22%_0.01_60)]'
        )}
      >
        English
      </button>
    </div>
  )

  // ====== HOME PAGE ======
  if (!category) {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-[oklch(98%_0.005_60)] p-8 dark:bg-[oklch(12%_0.01_250)]">
        <div className="w-full max-w-3xl">
          <div className="mb-6 flex justify-end">
            <LanguageSwitch />
          </div>
          {/* Header */}
          <header className="mb-16 text-center">
            <h1 className="mb-4 text-5xl font-bold tracking-tight text-[oklch(20%_0.03_60)] dark:text-[oklch(95%_0.01_60)]">
              {copy.homeTitle}
            </h1>
            <p className="text-lg text-[oklch(45%_0.02_60)] dark:text-[oklch(65%_0.01_60)]">
              {copy.homeSubtitle}
            </p>
          </header>

          {/* Category Cards */}
          <div className="grid gap-6 sm:grid-cols-2">
            {(['user', 'developer'] as const).map((cat) => {
              const Icon = CATEGORY_ICONS[cat]
              return (
                <button
                  key={cat}
                  onClick={() => navigateTo(cat)}
                  className={cn(
                    'group relative overflow-hidden rounded-2xl p-8 text-left transition-all',
                    'border border-[oklch(88%_0.01_60)] bg-white shadow-sm',
                    'hover:border-[oklch(75%_0.05_60)] hover:shadow-md',
                    'dark:border-[oklch(25%_0.01_60)] dark:bg-[oklch(18%_0.01_250)]',
                    'dark:hover:border-[oklch(40%_0.02_250)]'
                  )}
                >
                  {/* Decorative accent */}
                  <div className="absolute left-0 top-0 h-1 w-full bg-[oklch(60%_0.12_175)] opacity-0 transition-opacity group-hover:opacity-100" />

                  <Icon className="mb-6 h-10 w-10 text-[oklch(60%_0.12_175)]" strokeWidth={1.5} />

                  <h2 className="mb-2 text-xl font-semibold text-[oklch(25%_0.02_60)] dark:text-[oklch(95%_0.01_60)]">
                    {CATEGORY_LABELS[docsLang][cat]}
                  </h2>

                  <p className="text-sm text-[oklch(50%_0.015_60)] dark:text-[oklch(60%_0.01_60)]">
                    {copy.categoryDescriptions[cat]}
                  </p>

                  <ChevronRight className="absolute bottom-6 right-6 h-5 w-5 text-[oklch(70%_0.02_60)] transition-transform group-hover:translate-x-1" />
                </button>
              )
            })}
          </div>

          {/* GitHub Project Link */}
          <a
            href="https://github.com/nutstore/eo2weave"
            target="_blank"
            rel="noopener noreferrer"
            className={cn(
              'group relative mt-6 flex items-center gap-4 overflow-hidden rounded-2xl p-6 transition-all',
              'border border-[oklch(88%_0.01_60)] bg-white shadow-sm',
              'hover:border-[oklch(75%_0.05_60)] hover:shadow-md',
              'dark:border-[oklch(25%_0.01_60)] dark:bg-[oklch(18%_0.01_250)]',
              'dark:hover:border-[oklch(40%_0.02_250)]'
            )}
          >
            <Github className="h-8 w-8 text-[oklch(50%_0.02_60)]" strokeWidth={1.5} />
            <div className="flex-1">
              <p className="text-xs font-medium uppercase tracking-wider text-[oklch(50%_0.02_60)] dark:text-[oklch(55%_0.01_60)]">
                {copy.openSourceLabel}
              </p>
              <p className="font-semibold text-[oklch(25%_0.02_60)] dark:text-[oklch(95%_0.01_60)]">
                {copy.githubSource}
              </p>
            </div>
            <ChevronRight className="h-5 w-5 text-[oklch(70%_0.02_60)] transition-transform group-hover:translate-x-1" />
          </a>
        </div>
      </div>
    )
  }

  // ====== SIDEBAR ======
  const SidebarContent = () => (
    <div className="flex h-full flex-col">
      {/* Sidebar Header */}
      <div className="shrink-0 border-b border-[oklch(88%_0.01_60)] px-6 py-5 dark:border-[oklch(25%_0.01_60)]">
        <button
          onClick={() => navigateToHome()}
          className="flex items-center gap-3 text-left"
        >
          {CategoryIcon && (
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[oklch(92%_0.03_175)] text-[oklch(60%_0.12_175)] dark:bg-[oklch(25%_0.02_175)]">
              <CategoryIcon className="h-5 w-5" strokeWidth={1.5} />
            </div>
          )}
          <div>
            <div className="text-xs font-medium uppercase tracking-wider text-[oklch(50%_0.02_60)] dark:text-[oklch(55%_0.01_60)]">
              {CATEGORY_LABELS[docsLang][category]}
            </div>
            <div className="font-semibold text-[oklch(25%_0.02_60)] dark:text-[oklch(95%_0.01_60)]">
              {index?.title}
            </div>
          </div>
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-4 py-6">
        {pages.length > 0 && (
          <div className="mb-6">
            <h3 className="mb-3 px-3 text-xs font-semibold uppercase tracking-wider text-[oklch(50%_0.02_60)] dark:text-[oklch(55%_0.01_60)]">
              {copy.tocLabel}
            </h3>
            <div className="space-y-1">
              {pages.map((p) => (
                <button
                  key={p.slug}
                  onClick={() => navigateTo(category, p.slug)}
                  className={cn(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-all',
                    page === p.slug
                      ? 'bg-[oklch(94%_0.04_175)] font-medium text-[oklch(40%_0.08_175)] dark:bg-[oklch(25%_0.03_175)] dark:text-[oklch(80%_0.05_175)]'
                      : 'text-[oklch(45%_0.015_60)] hover:bg-[oklch(94%_0.01_60)] hover:text-[oklch(25%_0.02_60)] dark:text-[oklch(60%_0.01_60)] dark:hover:bg-[oklch(22%_0.01_60)] dark:hover:text-[oklch(90%_0.01_60)]'
                  )}
                >
                  <FileText className="h-4 w-4 shrink-0 opacity-60" />
                  <span className="truncate">{p.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </nav>

      {/* Back to Home */}
      <div className="shrink-0 border-t border-[oklch(88%_0.01_60)] px-4 py-4 dark:border-[oklch(25%_0.01_60)]">
        <button
          onClick={() => navigateToHome()}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-[oklch(50%_0.015_60)] transition-colors hover:bg-[oklch(94%_0.01_60)] hover:text-[oklch(40%_0.02_60)] dark:text-[oklch(55%_0.01_60)] dark:hover:bg-[oklch(22%_0.01_60)] dark:hover:text-[oklch(90%_0.01_60)]"
        >
          <ChevronLeft className="h-4 w-4" />
          {copy.backToDocsHome}
        </button>
      </div>
    </div>
  )

  // ====== CATEGORY INDEX PAGE ======
  if (!page && index) {
    return (
      <div className="flex h-[100dvh] overflow-hidden">
        {/* Desktop Sidebar */}
        <aside className={cn(
          'h-full w-72 shrink-0 border-r border-[oklch(88%_0.01_60)] bg-white dark:border-[oklch(25%_0.01_60)] dark:bg-[oklch(15%_0.01_250)]',
          'hidden lg:block'
        )}>
          <SidebarContent />
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto bg-[oklch(98%_0.005_60)] p-8 dark:bg-[oklch(12%_0.01_250)]">
          <div className="mx-auto max-w-2xl">
            {/* Mobile header */}
            <div className="mb-8 flex items-center gap-4 lg:hidden">
              <BrandButton
                variant="ghost"
                iconButton
                onClick={() => setMobileSidebarOpen(true)}
                className="h-10 w-10"
              >
                <Menu className="h-5 w-5" />
              </BrandButton>
              <h1 className="text-2xl font-bold text-[oklch(25%_0.02_60)] dark:text-[oklch(95%_0.01_60)]">
                {index.title}
              </h1>
              <div className="ml-auto">
                <LanguageSwitch compact />
              </div>
            </div>

            {/* Desktop header */}
            <header className="mb-12 hidden lg:block">
              <div className="mb-3 flex items-start justify-between gap-4">
                <h1 className="text-4xl font-bold tracking-tight text-[oklch(20%_0.03_60)] dark:text-[oklch(95%_0.01_60)]">
                  {index.title}
                </h1>
                <LanguageSwitch />
              </div>
              <p className="text-lg text-[oklch(45%_0.02_60)] dark:text-[oklch(65%_0.01_60)]">
                {copy.chooseDocToRead}
              </p>
            </header>

            {/* Page List */}
            <div className="space-y-3">
              {pages.map((p) => (
                <button
                  key={p.slug}
                  onClick={() => navigateTo(category, p.slug)}
                  className={cn(
                    'group flex w-full items-center justify-between rounded-xl border p-5 text-left transition-all',
                    'border-[oklch(88%_0.01_60)] bg-white',
                    'hover:border-[oklch(75%_0.05_60)] hover:shadow-sm',
                    'dark:border-[oklch(25%_0.01_60)] dark:bg-[oklch(18%_0.01_250)]',
                    'dark:hover:border-[oklch(40%_0.02_250)]'
                  )}
                >
                  <div className="flex items-center gap-4">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[oklch(94%_0.03_175)] text-[oklch(50%_0.08_175)] dark:bg-[oklch(25%_0.03_175)] dark:text-[oklch(70%_0.05_175)]">
                      <FileText className="h-5 w-5" strokeWidth={1.5} />
                    </div>
                    <span className="font-medium text-[oklch(25%_0.02_60)] dark:text-[oklch(95%_0.01_60)]">
                      {p.title}
                    </span>
                  </div>
                  <ChevronRight className="h-5 w-5 text-[oklch(70%_0.02_60)] transition-transform group-hover:translate-x-1" />
                </button>
              ))}
            </div>
          </div>
        </main>

        {/* Mobile Sidebar Overlay */}
        {mobileSidebarOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/50 lg:hidden"
              onClick={() => setMobileSidebarOpen(false)}
            />
            <aside className="fixed bottom-0 left-0 top-0 z-50 w-72 bg-white shadow-xl dark:bg-[oklch(15%_0.01_250)] lg:hidden">
              <div className="flex justify-end p-4">
                <BrandButton
                  variant="ghost"
                  iconButton
                  onClick={() => setMobileSidebarOpen(false)}
                  className="h-8 w-8"
                >
                  <X className="h-5 w-5" />
                </BrandButton>
              </div>
              <SidebarContent />
            </aside>
          </>
        )}
      </div>
    )
  }

  // ====== DOCUMENT CONTENT PAGE ======
  return (
    <div className="flex h-[100dvh] overflow-hidden">
      {/* Desktop Sidebar */}
      <aside className={cn(
        'h-full w-72 shrink-0 border-r border-[oklch(88%_0.01_60)] bg-white dark:border-[oklch(25%_0.01_60)] dark:bg-[oklch(15%_0.01_250)]',
        sidebarOpen ? 'hidden lg:block' : 'hidden'
      )}>
        <SidebarContent />
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-auto">
        {/* Top Bar */}
        <header className="sticky top-0 z-10 border-b border-[oklch(88%_0.01_60)] bg-[oklch(98%_0.005_60)]/95 px-6 py-4 backdrop-blur-sm dark:border-[oklch(25%_0.01_60)] dark:bg-[oklch(12%_0.01_250)]/95">
          <div className="flex items-center gap-4">
            {/* Mobile menu */}
            <BrandButton
              variant="ghost"
              iconButton
              onClick={() => setMobileSidebarOpen(true)}
              className="h-9 w-9 lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </BrandButton>

            {/* Desktop toggle */}
            <BrandButton
              variant="ghost"
              iconButton
              onClick={() => setSidebarOpen(!sidebarOpen)}
              className="hidden h-9 w-9 lg:flex"
            >
              {sidebarOpen ? (
                <ChevronLeft className="h-5 w-5" />
              ) : (
                <ChevronRight className="h-5 w-5" />
              )}
            </BrandButton>

            {/* Back button */}
            <BrandButton
              variant="ghost"
              iconButton
              onClick={onBack}
              className="h-9 w-9"
            >
              <ChevronLeft className="h-5 w-5" />
            </BrandButton>

            {/* Breadcrumb */}
            <div className="flex items-center gap-2 text-sm">
              <span className="text-[oklch(50%_0.015_60)] dark:text-[oklch(55%_0.01_60)]">
                {copy.docsRootLabel}
              </span>
              <ChevronRight className="h-4 w-4 text-[oklch(80%_0.01_60)]" />
              <span className="text-[oklch(50%_0.015_60)] dark:text-[oklch(55%_0.01_60)]">
                {CATEGORY_LABELS[docsLang][category]}
              </span>
              {currentPage && (
                <>
                  <ChevronRight className="h-4 w-4 text-[oklch(80%_0.01_60)]" />
                  <span className="font-medium text-[oklch(25%_0.02_60)] dark:text-[oklch(95%_0.01_60)]">
                    {currentPage.title}
                  </span>
                </>
              )}
            </div>
            <div className="ml-auto hidden sm:block">
              <LanguageSwitch compact />
            </div>
          </div>
        </header>

        {/* Content */}
        <div className="bg-[oklch(98%_0.005_60)] px-8 py-12 dark:bg-[oklch(12%_0.01_250)]">
          {pageContent ? (
            <article className="docs-content mx-auto max-w-3xl">
              <MarkdownContent content={pageContent.markdown} />
            </article>
          ) : (
            <div className="mx-auto max-w-3xl text-center">
              <p className="mb-4 text-[oklch(50%_0.05_25)] dark:text-[oklch(65%_0.05_25)]">
                {copy.docNotFound}
              </p>
              <button
                onClick={() => navigateTo(category)}
                className="text-sm font-medium text-[oklch(60%_0.12_175)] hover:underline"
              >
                {copy.backToDirectory}
              </button>
            </div>
          )}
        </div>
      </main>

      {/* Mobile Sidebar */}
      {mobileSidebarOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/50 lg:hidden"
            onClick={() => setMobileSidebarOpen(false)}
          />
          <aside className="fixed bottom-0 left-0 top-0 z-50 w-72 bg-white shadow-xl dark:bg-[oklch(15%_0.01_250)] lg:hidden">
            <div className="flex justify-end p-4">
              <BrandButton
                variant="ghost"
                iconButton
                onClick={() => setMobileSidebarOpen(false)}
                className="h-8 w-8"
              >
                <X className="h-5 w-5" />
              </BrandButton>
            </div>
            <SidebarContent />
          </aside>
        </>
      )}
    </div>
  )
}
