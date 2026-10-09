import { createRequire } from 'node:module'
import { mkdir, copyFile } from 'node:fs/promises'
const require = createRequire(import.meta.url)
const runtimeRequire = createRequire(require.resolve('@creatorweave/quickjs-runtime/package.json'))
const target = new URL('../public/assets/quickjs/', import.meta.url)
await mkdir(target, { recursive: true })
await copyFile(runtimeRequire.resolve('quickjs-wasi/quickjs.wasm'), new URL('quickjs.wasm', target))
