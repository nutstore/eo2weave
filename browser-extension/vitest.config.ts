import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The extension has no test runner of its own until now: the pure logic
// (registry URL derivation, mirror fallback, locale parity) lived in the web
// app and was tested there. Now that the registry client lives in the
// extension, its unit tests must run here too — otherwise the ported logic
// would ship untested.
//
// The extension sources import workspace packages by their published names
// (`@creatorweave/fs-provider`, `@creatorweave/shared`), which pnpm links
// into browser-extension/node_modules — the same resolution the build uses.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '..'),
      '@/*': path.resolve(__dirname, '../*'),
    },
  },
  test: {
    environment: 'node',
    include: ['entrypoints/**/__tests__/**/*.test.ts', 'entrypoints/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**', '.wxt/**'],
  },
})
