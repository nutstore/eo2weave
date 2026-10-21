// @vitest-environment node
import { expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validatePackage } from '@creatorweave/shared/webmcp-adapter'
import { builtinResources } from '../../../browser-extension/entrypoints/webmcp/builtin-resources'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../browser-extension/builtin-webmcp')
const paths = Object.keys(builtinResources)

it('bundles every package file as unchanged raw text', async () => {
  const files = await readdir(root, { recursive: true, withFileTypes: true })
  const sources = files.filter(file => file.isFile() && !file.name.startsWith('.')).map(file =>
    resolve(file.parentPath, file.name).slice(root.length + 1))
  expect(paths.sort()).toEqual(sources.sort())
  for (const path of paths) {
    expect(builtinResources[path]).toBe(await readFile(resolve(root, path), 'utf8'))
  }
})

it('validates all 44 bundled workflow contracts without claiming browser behavior', async () => {
  let count = 0
  for (const path of paths.filter(path => path.endsWith('manifest.json'))) {
    const manifest = JSON.parse(builtinResources[path])
    const sources: Record<string, string> = {}
    for (const tool of manifest.tools) {
      const source = builtinResources[`${manifest.id}/${tool.path}`]
      expect(source).not.toMatch(/tools\.page_/)
      expect(source).not.toContain('location.assign(')
      sources[tool.path] = source
      count++
    }
    expect(() => validatePackage(manifest, sources, manifest.id)).not.toThrow()
  }
  expect(count).toBe(44)
})
