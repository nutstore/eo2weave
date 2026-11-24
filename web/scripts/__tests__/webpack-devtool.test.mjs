import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import nextConfig from '../../next.config.mjs'

const require = createRequire(import.meta.url)
const bundledWebpack = require('next/dist/compiled/webpack/webpack')
bundledWebpack.init()
const { webpack } = bundledWebpack
const { base } = require('next/dist/build/webpack/config/blocks/base')

async function compile({ dev = true, isServer = false, devtool } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'creatorweave-devtool-'))
  const previous = process.env.CW_WEBPACK_DEVTOOL
  const source = 'globalThis.devtoolFixture = "original source";\n'
  try {
    if (devtool === undefined) delete process.env.CW_WEBPACK_DEVTOOL
    else process.env.CW_WEBPACK_DEVTOOL = devtool
    await writeFile(path.join(directory, 'entry.js'), source)
    const initialConfig = base(
      {
        isDevelopment: dev,
        isServer,
        isClient: !isServer,
        targetWeb: !isServer,
      },
      {
        mode: dev ? 'development' : 'production',
        context: directory,
        entry: './entry.js',
        output: { path: path.join(directory, 'out'), filename: 'bundle.js' },
        module: { rules: [] },
        plugins: [],
        resolve: {},
        optimization: { minimize: false },
      }
    )
    const originalDevtool = initialConfig.devtool
    const config = nextConfig.webpack(initialConfig, { dev, isServer, webpack })
    // Next.js restores this field after invoking the webpack callback.
    config.devtool = originalDevtool
    const compiler = webpack(config)
    try {
      await new Promise((resolve, reject) =>
        compiler.run((error, stats) => {
          if (error) reject(error)
          else if (stats.hasErrors()) reject(new Error(stats.toString('errors-only')))
          else resolve()
        })
      )
      const code = await readFile(path.join(directory, 'out/bundle.js'), 'utf8')
      const map = await readFile(path.join(directory, 'out/bundle.js.map'), 'utf8').catch(
        (error) => {
          if (error.code === 'ENOENT') return null
          throw error
        }
      )
      return { code, map: map ? JSON.parse(map) : null, source }
    } finally {
      await new Promise((resolve, reject) =>
        compiler.close((error) => (error ? reject(error) : resolve()))
      )
    }
  } finally {
    if (previous === undefined) delete process.env.CW_WEBPACK_DEVTOOL
    else process.env.CW_WEBPACK_DEVTOOL = previous
    await rm(directory, { recursive: true, force: true })
  }
}

test('client development emits external source maps after Next restores devtool', async () => {
  const { code, map, source } = await compile()
  assert.ok(!code.includes('sourceMappingURL=data:'))
  assert.ok(!code.includes('eval('))
  assert.ok(code.includes('sourceMappingURL=bundle.js.map'))
  assert.ok(map.sourcesContent.includes(source))
  assert.ok(map.mappings.length > 0)
})

test('CW_WEBPACK_DEVTOOL=false disables source maps', async () => {
  const { code, map } = await compile({ devtool: 'false' })
  assert.ok(!code.includes('sourceMappingURL='))
  assert.ok(!code.includes('eval('))
  assert.equal(map, null)
})

test('explicit eval-source-map remains available', async () => {
  const { code, map } = await compile({ devtool: 'eval-source-map' })
  assert.ok(code.includes('sourceMappingURL=data:'))
  assert.equal(map, null)
})

test('server development keeps the original devtool', async () => {
  const { code } = await compile({ isServer: true, devtool: 'false' })
  assert.ok(code.includes('sourceMappingURL=data:'))
})

test('production keeps the original devtool', async () => {
  const { code, map } = await compile({ dev: false, devtool: 'source-map' })
  assert.ok(!code.includes('sourceMappingURL='))
  assert.equal(map, null)
})
