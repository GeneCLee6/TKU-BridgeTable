import { expect, test, type Page } from '@playwright/test'
import { playBoard, serve, table } from './fixtures.ts'
import { STRINGS } from '../../src/strings.ts'

/**
 * Against a production build (playwright.config.ts builds and serves one): a thrown error leaves
 * content in `#root`. Development React behaves differently around errors, and the blank page this
 * guards against is what a member would see, so this is not left to the dev server the screenshots
 * use. Nothing here is a screenshot; the failures come from answers the pages cannot read.
 */

test.use({ baseURL: `http://localhost:${process.env.VISUAL_PROD_PORT ?? 4180}` })

const words = STRINGS.zh.errorBoundary
const SIZE = { width: 1280, height: 800 }

/** The reports the page sends to `/api/client-errors` */
function reportsOf(page: Page) {
  const reports: { message: string; source?: string }[] = []
  page.on('request', (request) => {
    if (request.url().includes('/api/client-errors')) reports.push(JSON.parse(request.postData() ?? '{}'))
  })
  return reports
}

test('is a production build', async ({ page }) => {
  await serve(page, {})
  await page.goto('/')
  // Hashed bundles, not Vite's dev modules
  await expect(page.locator('script[type="module"][src^="/assets/"]')).toHaveCount(1)
  await expect(page.locator('script[src*="@vite/client"]')).toHaveCount(0)
})

test('a page that throws leaves the header and a message in #root', async ({ page }) => {
  await page.setViewportSize(SIZE)
  const reports = reportsOf(page)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await serve(page, {})
  // A record with nothing in it: the record page cannot draw it
  await page.route('**/api/history/h1', (route) => route.fulfill({ json: { record: { id: 'h1' } } }))
  await page.goto('/history/h1')

  await expect(page.getByRole('alert')).toContainText(words.title)
  await expect(page.locator('#root')).toContainText(words.retry)
  await expect(page.getByRole('banner')).toBeVisible()
  await expect(page.getByRole('link', { name: STRINGS.zh.navHistory })).toBeVisible()
  await expect.poll(() => reports.map((r) => r.source)).toContain('boundary:route')
  // Caught, so nothing is left uncaught
  expect(errors).toEqual([])

  // And the member can go on from there
  await page.getByRole('link', { name: STRINGS.zh.navHistory }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('banners that throw go alone: the page stays', async ({ page }) => {
  await page.setViewportSize(SIZE)
  const reports = reportsOf(page)
  await serve(page, {})
  await page.route('**/api/notices', (route) => route.fulfill({ json: { platform: [null], club: null } }))
  await page.goto('/')

  await expect(page.getByRole('button', { name: STRINGS.zh.newTable })).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect.poll(() => reports.map((r) => r.source)).toContain('boundary:notice-banners')
})

test('a side panel that throws at the table leaves the play area', async ({ page }) => {
  await page.setViewportSize(SIZE)
  const reports = reportsOf(page)
  // A chat line the panel cannot read
  await serve(page, { table: { ...table(playBoard), chat: [null] } as never })
  await page.goto('/table/t1')

  await expect(page.locator('[data-hand="S"]')).toBeVisible()
  await expect(page.getByRole('tabpanel')).toContainText(words.part)
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect.poll(() => reports.map((r) => r.source)).toContain('boundary:side-panel-chat')
})
