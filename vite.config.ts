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
// it is left out of Vitest, which tests the Worker's logic directly.
export default defineConfig({
  plugins: [react(), appVersion(), ...(process.env.VITEST ? [] : [cloudflare()])],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Several tests play hundreds of robot boards; with every file running at once they can take
    // longer than Vitest's default 5 s on a busy machine
    testTimeout: 15_000,
  },
})
