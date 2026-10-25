import { expect, test, type Page } from '@playwright/test'
import { auctionBoard, playBoard, resultBoard, serve, table, type Club } from './fixtures.ts'

/**
 * The main screens, compared with the baselines in __screenshots__ (e3-t37, AC-3.11): the table
 * while bidding, playing and after the board, on a computer, a 390px phone, two tablets (e3-t36)
 * and in dark mode, plus the tour, the lobby and the sign-in page.
 */

const DESKTOP = { width: 1280, height: 800 }
const PHONE = { width: 390, height: 844 }
const TABLET = { width: 1024, height: 768 }
const TABLET_PORTRAIT = { width: 1024, height: 1366 }

async function open(page: Page, path: string, club: Club, size: { width: number; height: number }) {
  await page.setViewportSize(size)
  await serve(page, club)
  await page.goto(path)
  await page.evaluate(() => document.fonts.ready)
}

/** The table, once its cards are drawn */
async function atTable(page: Page, club: Club, size: { width: number; height: number }) {
  await open(page, '/table/t1', club, size)
  await expect(page.locator('[data-hand="S"]')).toBeVisible()
  // A finished trick on the table goes to its winner when the next is led (TrickArea's COLLECT_MS)
  await page.waitForTimeout(1500)
}

const shot = (page: Page, name: string) => expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true })

const screens = [
  { name: 'auction', board: auctionBoard },
  { name: 'play', board: playBoard },
  { name: 'result', board: resultBoard },
]

for (const { name, board } of screens) {
  test(`table ${name} · desktop`, async ({ page }) => {
    await atTable(page, { table: table(board) }, DESKTOP)
    await shot(page, `table-${name}-desktop`)
  })

  test(`table ${name} · phone`, async ({ page }) => {
    await atTable(page, { table: table(board) }, PHONE)
    await shot(page, `table-${name}-phone`)
  })
}

test('table play · dark', async ({ page }) => {
  await atTable(page, { table: table(playBoard), prefs: { mode: 'dark' } }, DESKTOP)
  await shot(page, 'table-play-dark')
})

test('table auction · phone dark', async ({ page }) => {
  await atTable(page, { table: table(auctionBoard), prefs: { mode: 'dark' } }, PHONE)
  await shot(page, 'table-auction-phone-dark')
})

for (const [name, size] of [
  ['tablet', TABLET],
  ['tablet-portrait', TABLET_PORTRAIT],
] as const) {
  test(`table auction · ${name}`, async ({ page }) => {
    await atTable(page, { table: table(auctionBoard) }, size)
    await shot(page, `table-auction-${name}`)
  })

  test(`table play · ${name}`, async ({ page }) => {
    await atTable(page, { table: table(playBoard) }, size)
    await shot(page, `table-play-${name}`)
  })
}

test('table tour, first step', async ({ page }) => {
  await atTable(page, { table: table(auctionBoard), prefs: { tableTourSeen: false } }, DESKTOP)
  await expect(page.getByRole('dialog')).toBeVisible()
  await shot(page, 'table-tour-desktop')
})

test('lobby · desktop', async ({ page }) => {
  await open(page, '/', {}, DESKTOP)
  await expect(page.getByRole('main')).toBeVisible()
  await shot(page, 'lobby-desktop')
})

test('lobby · phone', async ({ page }) => {
  await open(page, '/', {}, PHONE)
  await expect(page.getByRole('main')).toBeVisible()
  await shot(page, 'lobby-phone')
})

test('sign in · desktop', async ({ page }) => {
  await open(page, '/', { me: null }, DESKTOP)
  await expect(page.getByRole('button', { name: '登入' })).toBeVisible()
  await shot(page, 'login-desktop')
})
