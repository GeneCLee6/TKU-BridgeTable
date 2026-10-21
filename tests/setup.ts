import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'

// Shared setup for component tests: jest-dom matchers, Chinese UI (the club's default; jsdom
// reports an English browser) and DOM cleanup between cases.
beforeEach(() => {
  try {
    window.localStorage.setItem('tku-bridge-table:prefs', JSON.stringify({ lang: 'zh' }))
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
