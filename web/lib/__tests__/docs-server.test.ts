import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  getDocIndex,
  getDocPage,
  listAllDocRoutes,
  parseFrontmatter,
  resetDocsRootForTests,
  stripFrontmatter,
} from '@/lib/docs-server'

/**
 * Real-filesystem tests for the server-side docs source layer.
 * Builds a temporary docs/ tree and points DOCS_ROOT at it.
 */
describe('docs-server', () => {
  let root: string

  beforeAll(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'docs-server-test-'))
    process.env.DOCS_ROOT = root

    // zh/user: ordered pages + nested subdir
    await mkdir(path.join(root, 'zh', 'user', 'advanced'), { recursive: true })
    await writeFile(
      path.join(root, 'zh', 'user', 'getting-started.md'),
      '---\ntitle: 快速入门\norder: 1\n---\n\n# 快速入门正文',
    )
    await writeFile(
      path.join(root, 'zh', 'user', 'advanced', 'tips.md'),
      '# 无 frontmatter 的页面',
    )
    // zh/design: internal material that must stay unreachable
    await mkdir(path.join(root, 'zh', 'design'), { recursive: true })
    await writeFile(path.join(root, 'zh', 'design', 'internal.md'), '# internal')

    // en/user
    await mkdir(path.join(root, 'en', 'user'), { recursive: true })
    await writeFile(
      path.join(root, 'en', 'user', 'getting-started.md'),
      '---\ntitle: Getting Started\norder: 1\n---\n\n# Getting started',
    )
  })

  afterAll(async () => {
    delete process.env.DOCS_ROOT
    await rm(root, { recursive: true, force: true })
  })

  beforeEach(() => {
    resetDocsRootForTests()
  })

  it('parses frontmatter key/value pairs and strips quotes', () => {
    expect(parseFrontmatter('---\ntitle: "My Page"\norder: 3\n---\n\nbody')).toEqual({
      title: 'My Page',
      order: '3',
    })
  })

  it('strips the frontmatter block from markdown', () => {
    const md = stripFrontmatter('---\ntitle: x\n---\n\n# Body')
    expect(md).toBe('\n# Body')
    expect(stripFrontmatter('# no frontmatter')).toBe('# no frontmatter')
  })

  it('indexes only the whitelisted language/category dirs, sorted by order', async () => {
    const index = await getDocIndex('zh', 'user')

    expect(index.title).toBe('用户文档')
    expect(index.pages.map((p) => p.slug)).toEqual(['getting-started', 'advanced-tips'])
    expect(index.pages[1]).toMatchObject({ title: 'Tips', category: 'advanced', order: 1000000 })
  })

  it('does not see internal-only directories', async () => {
    const index = await getDocIndex('zh', 'user')
    expect(index.pages.some((p) => p.slug.includes('internal'))).toBe(false)
    await expect(getDocPage('zh', 'user', 'internal')).resolves.toBeNull()
  })

  it('resolves a page by slug with frontmatter stripped', async () => {
    const page = await getDocPage('zh', 'user', 'getting-started')

    expect(page).not.toBeNull()
    expect(page?.entry.title).toBe('快速入门')
    expect(page?.markdown).toBe('\n# 快速入门正文')
  })

  it('returns null for unknown slugs', async () => {
    await expect(getDocPage('zh', 'user', 'nope')).resolves.toBeNull()
  })

  it('enumerates every prerenderable route from the docs tree', async () => {
    const routes = await listAllDocRoutes()
    const paths = routes.map((r) => r.path.join('/'))

    expect(paths).toContain('') // docs home
    expect(paths).toContain('zh/user')
    expect(paths).toContain('zh/user/getting-started')
    expect(paths).toContain('zh/user/advanced-tips')
    expect(paths).toContain('en/user/getting-started')
    // nothing outside user/developer becomes a URL
    expect(paths.some((p) => p.includes('design'))).toBe(false)
  })
})
