import { expect, test, type Page } from '@playwright/test'
import type { Hands } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { STRINGS } from '../../src/strings.ts'
import { playBoard, resultBoard, serve, table } from './fixtures.ts'

/**
 * Does the app start on WebKit at all? The `webkit` project (playwright.config.ts) runs this file
 * against the production build under the site's real headers (Content-Security-Policy included,
 * vite.config.ts), the API and WebSocket answered by fixtures. No screenshots, no baselines.
 *
 * Playwright's WebKit is close to Safari but is not Safari, and this is not a phone: ARCHITECTURE.md
 * §5.1.1 says what is left for a real iPhone.
 *
 * The service worker is blocked here except where a test says otherwise: once one controls a page,
 * WebKit's requests no longer reach `page.route`, so the fixtures would not answer them (Chromium's
 * still do). They go to `vite preview`, which has no API and answers with index.html.
 */

test.use({ baseURL: `http://localhost:${process.env.VISUAL_PROD_PORT ?? 4180}`, serviceWorkers: 'block' })

// Generous: a page's first paint of the whole bundle with several WebKits starting at once
test.describe.configure({ timeout: 90_000 })
const UP = { timeout: 20_000 }

const words = STRINGS.zh

/** What must stay empty: anything uncaught, and anything the CSP refused */
function problemsOf(page: Page) {
  const problems: string[] = []
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (/content security policy|refused to|not allowed/i.test(message.text())) problems.push(`console: ${message.text()}`)
  })
  return problems
}

test('the pages come with the production CSP', async ({ page }) => {
  await serve(page, { me: null })
  const response = await page.goto('/')
  expect(response?.headers()['content-security-policy']).toContain("connect-src 'self'")
})

test('sign-in page', async ({ page }) => {
  const problems = problemsOf(page)
  await serve(page, { me: null })
  await page.goto('/')
  await expect(page.getByRole('button', { name: '登入' })).toBeVisible(UP)
  expect(problems).toEqual([])
})

test('signed in: the lobby', async ({ page }) => {
  const problems = problemsOf(page)
  await serve(page, {})
  await page.goto('/')
  await expect(page.getByRole('button', { name: words.newTable })).toBeVisible(UP)
  expect(problems).toEqual([])
})

test('a table', async ({ page }) => {
  const problems = problemsOf(page)
  await serve(page, { table: table(playBoard) })
  await page.goto('/table/t1')
  await expect(page.locator('[data-hand="S"]')).toBeVisible(UP)
  expect(problems).toEqual([])
})

test.describe('with the service worker', () => {
  test.use({ serviceWorkers: 'allow' })

  test('it takes the page, and the next visit still starts', async ({ page }) => {
    // No check for uncaught errors here: the reload cuts off requests still under way, and WebKit
    // reports those as rejected fetches
    await serve(page, {})
    await page.goto('/')
    await expect(page.locator('main')).toBeVisible(UP)
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined))
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), UP).toBe(true)

    await page.reload()
    await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), UP).toBe(true)
    // Whichever page it is (see the top of this file for why it may be either): it got past loading
    await expect(page.getByRole('button', { name: words.newTable }).or(page.getByRole('button', { name: '登入' }))).toBeVisible(UP)
  })
})

/** A whole board, each hand playing its first legal card: enough to put the solver to work */
function playedOut(): BoardState {
  let board = newBoard(1, resultBoard.hands as Hands)
  for (const call of ['1N', 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  for (let seat = turnOf(board); seat; seat = turnOf(board)) board = playCard(board, seat, legalCards(board, seat)[0])
  return board
}

test('post-game analysis: the WASM double dummy solver under the CSP', async ({ page }) => {
  const problems = problemsOf(page)
  await serve(page, {})
  const player = { id: 'amy', username: 'Amy' }
  const record = { id: 'h1', tableNumber: 3, finishedAt: 0, players: { N: player, E: player, S: player, W: player }, board: playedOut() }
  await page.route('**/api/history/h1/session', (route) => route.fulfill({ json: { records: [record] } }))
  await page.goto('/history/h1/analysis')

  await expect(page.getByRole('status').filter({ hasText: words.postGame.finished })).toBeVisible({ timeout: 60_000 })
  await expect(page.getByRole('alert')).toHaveCount(0)
  // Each hand played its first legal card, so the solver has losses to report
  await expect(page.getByLabel(words.boardNo(1))).toContainText('Declarer')
  await expect(page.getByLabel(words.postGame.moves).getByRole('listitem').first()).toBeVisible()
  expect(problems).toEqual([])
})
