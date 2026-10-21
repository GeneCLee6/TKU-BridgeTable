import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Shared setup for component tests: jest-dom matchers and DOM cleanup between cases.
afterEach(() => {
  cleanup()
  try {
    window.localStorage.clear()
  } catch {
    // Storage can be unavailable; tests must not depend on it.
  }
})
