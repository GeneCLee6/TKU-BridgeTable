/// <reference types="vitest/config" />
import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

// Stamps the built commit into index.html so a deployment can be traced back to its commit.
// The deploy workflow sets APP_VERSION to the commit it deploys.
const appVersion = (): Plugin => ({
  name: 'app-version',
  transformIndexHtml: () => [
    {
      tag: 'meta',
      attrs: { name: 'app-version', content: process.env.APP_VERSION ?? process.env.GITHUB_SHA ?? 'local' },
      injectTo: 'head',
    },
  ],
})

// https://vite.dev/config/
// The Cloudflare plugin runs the Worker (API, WebSocket, Durable Object) inside `vite dev`;
// it is left out of Vitest, which tests the Worker's logic directly, and of the visual tests
// (playwright.config.ts), which answer the API and WebSocket from fixtures.
export default defineConfig({
  plugins: [react(), appVersion(), ...(process.env.VITEST || process.env.VISUAL_TEST ? [] : [cloudflare()])],
  // The DDS worker (src/lib/dds.worker.ts) is an ES module: its WASM loader uses import.meta
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    // Several tests play hundreds of robot boards; with every file running at once they can take
    // longer than Vitest's default 5 s on a busy machine
    testTimeout: 15_000,
    // bridge-dds ships ES modules with extensionless imports that Node cannot load on its own
    server: { deps: { inline: ['bridge-dds'] } },
    projects: [
      // Each project has its own `include` (a project's list would be added to one given above)
      { extends: true, test: { name: 'default', include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'] } },
      // The challenge and team match tests again, each challenge in its own EventObject (H2b,
      // ARCHITECTURE.md §5.12; tests/worker/event-mode.ts): the switch on as well as off
      {
        extends: true,
        test: {
          name: 'event-objects',
          include: [
            'tests/worker/challenge*.test.ts',
            'tests/worker/weekly-challenge.test.ts',
            'tests/worker/team-match*.test.ts',
            'tests/worker/tku-system.test.ts',
            'tests/worker/visibility/*.test.ts',
          ],
          env: { TBT_EVENT_OBJECTS: 'on' },
        },
      },
    ],
  },
})
