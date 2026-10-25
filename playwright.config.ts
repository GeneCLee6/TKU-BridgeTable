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
 * - Locally without Docker, `PW_CHANNEL=msedge npm run test:visual -- --update-snapshots` draws
 *   the screens with the installed Edge, to look at; do not commit those.
 */
const PORT = 4179

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
    browserName: 'chromium',
    // Locally, `PW_CHANNEL=msedge` uses the installed Edge instead of downloading Chromium
    channel: process.env.PW_CHANNEL || undefined,
    locale: 'zh-TW',
    timezoneId: 'Asia/Taipei',
    reducedMotion: 'reduce',
    deviceScaleFactor: 1,
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    env: { VISUAL_TEST: '1' },
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
