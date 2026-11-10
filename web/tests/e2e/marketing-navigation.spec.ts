import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })

test('returning from WebMCP keeps the home page and its styles intact', async ({ page }) => {
  await page.goto('/')
  const hero = page.locator('.hero').first()
  const padding = await hero.evaluate(element => getComputedStyle(element).padding)
  await page.evaluate(() => { (window as Window & { marketingNavigationMarker?: boolean }).marketingNavigationMarker = true })
  await page.locator('.header-nav a[href="/webmcp"]').click()
  await expect(page).toHaveURL(/\/webmcp$/)
  await page.locator('.header-nav a[href="/"]').click()
  await expect(page).toHaveURL(/\/$/)
  await expect.poll(() => hero.evaluate(element => getComputedStyle(element).padding)).toBe(padding)
  expect(await page.evaluate(() => (window as Window & { marketingNavigationMarker?: boolean }).marketingNavigationMarker)).toBe(true)
})

test('opening the Chrome store also shows the experience guide', async ({ page }) => {
  await page.route('https://chromewebstore.google.com/**', route => route.abort())
  await page.goto('/')
  const control = page.locator('.hero-copy [data-extension-control]')
  await control.locator('[data-extension-trigger]').click()
  const [store] = await Promise.all([
    page.waitForEvent('popup'),
    control.locator('a[href*="chromewebstore.google.com"]').click(),
  ])
  await expect(page).toHaveURL(/\/experience\?from=store$/)
  await store.close()
})

test('the header updates its usage entry when the extension connects or disconnects', async ({ page }) => {
  await page.addInitScript(() => {
    ;(window as Window & { __agentWeb?: { ready: boolean } }).__agentWeb = { ready: true }
  })
  await page.goto('/')
  const header = page.locator('.site-header')
  await expect(header.locator('.online-link')).toHaveCount(0)
  await expect(header.locator('[data-extension-trigger]')).toHaveAttribute('href', '/projects')
  await page.evaluate(() => { (window as Window & { __agentWeb: { ready: boolean } }).__agentWeb.ready = false })
  await expect(header.locator('.online-link')).toBeVisible()
})

test('the Edge install button stays on one line and the active download link returns to the top', async ({ page }) => {
  await page.goto('/download')
  const button = page.locator('a[data-browser="edge"]')
  const layout = await button.evaluate(element => ({
    whiteSpace: getComputedStyle(element).whiteSpace,
    width: element.clientWidth,
    contentWidth: element.scrollWidth,
  }))
  expect(layout.whiteSpace).toBe('nowrap')
  expect(layout.contentWidth).toBeLessThanOrEqual(layout.width)
  await page.evaluate(() => window.scrollTo(0, 900))
  await page.locator('.header-nav a[href="/download"]').click()
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
})
