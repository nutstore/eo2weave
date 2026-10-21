import { defineConfig } from '@playwright/test'

/** Live sites + installed MV3 extension. CreatorWeave is intentionally absent. */
export default defineConfig({
  testDir: './tests/e2e/webmcp',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 100000,
  expect: { timeout: 20000 },
  outputDir: '../output/playwright/webmcp-real/results',
  reporter: [
    ['list'],
    ['json', { outputFile: '../output/playwright/webmcp-real/report.json' }],
    ['html', { outputFolder: '../output/playwright/webmcp-real/html', open: 'never' }],
  ],
})
