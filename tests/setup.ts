import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'

// Shared setup for component tests: jest-dom matchers, Chinese UI (the club's default; jsdom
// reports an English browser), the table tour already seen (tests that want it turn it back on)
// and DOM cleanup between cases.
beforeEach(() => {
  try {
    window.localStorage.setItem('tku-bridge-table:prefs', JSON.stringify({ lang: 'zh', tableTourSeen: true }))
  } catch {
    // Storage can be unavailable; tests must not depend on it.
  }
})

afterEach(() => {
  cleanup()
  try {
    window.localStorage.clear()
  } catch {
    // Storage can be unavailable; tests must not depend on it.
  }
})
