import { defineConfig } from '@playwright/test'

/** Live sites + installed MV3 extension + the real Web tool host. No intercepted responses. */
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
  use: { baseURL: process.env.WEBMCP_E2E_BASE_URL || 'http://localhost:5173' },
  webServer: {
    command: 'pnpm dev',
    url: process.env.WEBMCP_E2E_BASE_URL || 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 180000,
  },
})
