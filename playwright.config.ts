import { defineConfig } from '@playwright/test'

/**
 * Visual regression screenshots (e3-t37, AC-3.11): the real app on Vite's dev server, without the
 * Cloudflare plugin, with the API and WebSocket answered by fixtures (tests/visual/fixtures.ts).
 * Baselines are made on Linux in Playwright's container (the CI job `visual`): fonts differ by
 * system, so screenshots taken elsewhere are only for looking at.
 *
 * - `npm run test:visual` compares with the baselines in tests/visual/__screenshots__.
 * - A change meant to look different: the failed CI job uploads a `visual` artifact with the diffs
 *   (test-results/) and new baselines (tests/visual/__screenshots__/); check the diffs, copy the
 *   new baselines in and commit them. Or, with Docker:
 *   docker run --rm -v "$PWD":/work -w /work mcr.microsoft.com/playwright:v1.64.0-noble \
 *     sh -c "npm ci && npx playwright test --update-snapshots"
 * - Locally without Docker, `PW_CHANNEL=msedge npm run test:visual -- --project=chromium --update-snapshots`
 *   draws the screens with the installed Edge, to look at; do not commit those.
 */
const PORT = Number(process.env.VISUAL_PORT ?? 4179)
/** A production build, for what only it can show (tests/visual/production.spec.ts) */
const PROD_PORT = Number(process.env.VISUAL_PROD_PORT ?? 4180)
const PROD_DIR = 'node_modules/.cache/visual-production'

export default defineConfig({
  testDir: 'tests/visual',
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  expect: {
    toHaveScreenshot: { maxDiffPixelRatio: 0.002, animations: 'disabled', caret: 'hide' },
  },
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // Locally, `PW_CHANNEL=msedge` uses the installed Edge instead of downloading Chromium
        channel: process.env.PW_CHANNEL || undefined,
      },
    },
    // Does the app start on WebKit? tests/visual/webkit.smoke.ts, no screenshots. `.smoke.ts` is
    // not a name the chromium project picks up. Locally: npm run test:visual -- --project=webkit
    { name: 'webkit', testMatch: /\.smoke\.ts$/, use: { browserName: 'webkit' } },
  ],
  webServer: [
    {
      command: `npx vite --port ${PORT} --strictPort`,
      env: { VISUAL_TEST: '1' },
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `npx vite build --outDir ${PROD_DIR} --emptyOutDir && npx vite preview --outDir ${PROD_DIR} --port ${PROD_PORT} --strictPort`,
      env: { VISUAL_TEST: '1' },
      url: `http://localhost:${PROD_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
    },
  ],
})
