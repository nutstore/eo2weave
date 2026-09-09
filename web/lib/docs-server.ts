/**
 * Server-side docs source layer — the App Router replacement for the old
 * `sync-docs.mjs` + `web/public/docs/` static-copy pipeline.
 *
 * SERVER ONLY. This module reads the repository `docs/` tree with node:fs and
 * must never be imported from a client component. Client components may only
 * use `import type { ... }` from here — type imports are erased at compile
 * time, so node:fs never reaches the browser bundle. (The `server-only`
 * package is not installed in this repo; the NODE_ENV guard below is a
 * lightweight equivalent that also fails fast in dev.)
 *
 * Publication policy (enforced structurally): only `docs/<lang>/<category>`
 * for lang ∈ {zh,en} and category ∈ {user,developer} is exposed. Internal
 * material (docs/zh/design/, stray root-level notes, README.md) is NOT
 * reachable — the old pipeline copied it verbatim into web/public/docs/ and
 * shipped it to end users.
 *
 * Everything here runs at BUILD time (generateStaticParams + prerendering).
 * The docs route sets `dynamicParams = false`, so the runtime server never
 * touches the filesystem for docs — deployments that do not carry the
 * `docs/` directory (e.g. slim images) are unaffected.
 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { existsSync } from 'node:fs'

export type DocsLanguage = 'zh' | 'en'
export type DocsCategory = 'user' | 'developer'

/** One sidebar entry — mirrors the shape the old `_index.json` produced. */
export interface DocEntry {
  /** URL slug: file path relative to the category dir, `/` → `-`, no ext. */
  slug: string
  title: string
  /** File path relative to the category dir (with .md). */
  file: string
  /** Subdirectory within the category (developer/guides → 'guides'). */
  category?: string
  /** Sidebar order from frontmatter; missing → sorts last. */
  order: number
}

export interface DocIndex {
  title: string
  pages: DocEntry[]
}

/** Sidebar indexes for every language × category (passed to the client shell). */
export type DocsIndexes = Record<DocsLanguage, Record<DocsCategory, DocIndex>>

/** A resolved document page: sidebar entry + frontmatter-stripped markdown. */
export interface DocPageContent {
  entry: DocEntry
  markdown: string
}

export const DOCS_LANGUAGES: readonly DocsLanguage[] = ['zh', 'en']
export const DOCS_CATEGORIES: readonly DocsCategory[] = ['user', 'developer']

const INDEX_TITLES: Record<DocsLanguage, Record<DocsCategory, string>> = {
  zh: { user: '用户文档', developer: '开发者文档' },
  en: { user: 'User Documentation', developer: 'Developer Documentation' },
}

if (process.env.NODE_ENV === 'production' && typeof window !== 'undefined') {
  // Cheap tripwire: this module must not end up in a browser bundle. Type-only
  // imports are erased, so reaching this means someone imported the value side.
  throw new Error('docs-server is server-only — use import type in client code')
}

/**
 * Locate the repository `docs/` directory. Checked in order:
 * 1. DOCS_ROOT env override (ops / test seam)
 * 2. dev / repo checkout: `next dev|build` runs with cwd = web/ → ../docs
 * 3. standalone image: server.js runs at the monorepo-mirroring root → ./docs
 * The first candidate containing a `<lang>/<category>` subtree wins.
 */
function resolveDocsRoot(): string | null {
  const candidates = [
    process.env.DOCS_ROOT,
    path.resolve(process.cwd(), 'docs'),
    path.resolve(process.cwd(), '..', 'docs'),
  ]
  for (const candidate of candidates) {
    if (candidate && existsSync(path.join(candidate, 'zh', 'user'))) return candidate
  }
  return null
}

let docsRootCache: string | null | undefined

/** Docs root for the current process (cached). Null when docs/ is absent. */
export function getDocsRoot(): string | null {
  if (docsRootCache === undefined) docsRootCache = resolveDocsRoot()
  return docsRootCache
}

/** Test seam — drop the cached root + indexes so a test can point elsewhere. */
export function resetDocsRootForTests(): void {
  docsRootCache = undefined
  indexCache.clear()
}

/** Parse a simple `key: value` YAML frontmatter block (same rules the old sync script used). */
export function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---\n/)
  if (!match) return {}
  return Object.fromEntries(
    match[1].split('\n').flatMap((line) => {
      const separator = line.indexOf(':')
      if (separator < 0) return []
      return [[line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^["']|["']$/g, '')]]
    }),
  )
}

/** Strip the frontmatter block, returning renderable markdown. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith('---\n')) return content
  const end = content.indexOf('\n---\n', 4)
  if (end === -1) return content
  return content.slice(end + 5)
}

function titleFromFilename(fileName: string): string {
  return fileName
    .replace(/\.md$/, '')
    .replace(/^\d+-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function slugFromFile(relative: string): string {
  return relative.replace(/\.md$/, '').replace(/\//g, '-')
}

function localeTag(lang: DocsLanguage): string {
  return lang === 'zh' ? 'zh-CN' : 'en'
}

const indexCache = new Map<string, DocIndex>()

/**
 * Sidebar index for one language+category, sorted by frontmatter `order`
 * (missing → last) then title. Mirrors the old `_index.json` exactly so
 * existing docs URLs keep working.
 *
 * Cached per process — but ONLY outside dev: `next dev` renders per request,
 * so a cached index would hide added/removed/renamed doc files until a dev
 * server restart. The docs tree is ~50 files; a rescan per request in dev is
 * negligible and keeps "edit docs → refresh → see it" true.
 */
export async function getDocIndex(lang: DocsLanguage, category: DocsCategory): Promise<DocIndex> {
  const cacheKey = `${lang}/${category}`
  const cached = process.env.NODE_ENV === 'development' ? undefined : indexCache.get(cacheKey)
  if (cached) return cached

  const root = getDocsRoot()
  const dir = root ? path.join(root, lang, category) : null
  const pages: DocEntry[] = []

  async function scan(directory: string, relative = ''): Promise<void> {
    // Inferred from the call site — do NOT annotate via ReturnType<typeof readdir>:
    // that resolves against the LAST overload (encoding: 'buffer') and turns
    // Dirent.name into Buffer.
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => null)
    if (!entries) return
    for (const entry of entries) {
      const file = path.join(directory, entry.name)
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await scan(file, nextRelative)
      } else if (entry.isFile() && entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'index.md') {
        const metadata = parseFrontmatter(await readFile(file, 'utf8'))
        pages.push({
          slug: slugFromFile(nextRelative),
          title: metadata.title || titleFromFilename(entry.name),
          file: nextRelative,
          category: relative || undefined,
          order: Number.parseInt(metadata.order || '1000000', 10),
        })
      }
    }
  }

  if (dir) await scan(dir)
  pages.sort(
    (left, right) => left.order - right.order || left.title.localeCompare(right.title, localeTag(lang)),
  )

  const index: DocIndex = { title: INDEX_TITLES[lang][category], pages }
  if (process.env.NODE_ENV !== 'development') indexCache.set(cacheKey, index)
  return index
}

/**
 * Resolve one page by slug. Returns null when the slug is not in the index
 * (unknown slug, or docs/ unavailable) — the route then renders the
 * "document not found" state inside the normal docs shell.
 */
export async function getDocPage(
  lang: DocsLanguage,
  category: DocsCategory,
  slug: string,
): Promise<DocPageContent | null> {
  const index = await getDocIndex(lang, category)
  const entry = index.pages.find((p) => p.slug === slug)
  if (!entry) return null

  const root = getDocsRoot()
  if (!root) return null
  try {
    const raw = await readFile(path.join(root, lang, category, entry.file), 'utf8')
    return { entry, markdown: stripFrontmatter(raw) }
  } catch {
    return null
  }
}

/**
 * Every language × category sidebar index in one call (cached underneath).
 * Cheap: everything hits the per-process index cache after first use.
 */
export async function getAllDocIndexes(): Promise<DocsIndexes> {
  const [zhUser, zhDeveloper, enUser, enDeveloper] = await Promise.all([
    getDocIndex('zh', 'user'),
    getDocIndex('zh', 'developer'),
    getDocIndex('en', 'user'),
    getDocIndex('en', 'developer'),
  ])
  return {
    zh: { user: zhUser, developer: zhDeveloper },
    en: { user: enUser, developer: enDeveloper },
  }
}

/**
 * Every prerenderable docs route for generateStaticParams:
 * /docs, /docs/:lang/:category, /docs/:lang/:category/:page.
 * Enumerated from the actual docs tree, so only published pages become URLs.
 */
export async function listAllDocRoutes(): Promise<Array<{ path: string[] }>> {
  const routes: Array<{ path: string[] }> = [{ path: [] }]
  for (const lang of DOCS_LANGUAGES) {
    for (const category of DOCS_CATEGORIES) {
      routes.push({ path: [lang, category] })
      const index = await getDocIndex(lang, category)
      for (const page of index.pages) {
        routes.push({ path: [lang, category, page.slug] })
      }
    }
  }
  return routes
}
