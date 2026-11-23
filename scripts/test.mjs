#!/usr/bin/env node
// Run all tests (web frontend).
// Run from repo root: node scripts/test.mjs
import { $, cd } from 'zx'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')

$.verbose = true

console.log('🧪 Running tests...')
console.log('')

// pnpm only — the repo is a pnpm monorepo (npm test would bypass the workspace setup)
process.chdir(path.join(projectRoot, 'web'))

console.log('⚙️  Running webpack config tests...')
await $`pnpm test:config`

console.log('')
console.log('⚛️  Running frontend tests...')
await $`pnpm test`

console.log('')
console.log('✅ All tests passed!')
