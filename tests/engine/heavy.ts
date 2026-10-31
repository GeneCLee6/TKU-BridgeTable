/**
 * The timeout of a test that bids or plays hundreds of boards (X3). Such a test is pure CPU: about
 * 1–2 s alone, but with every test file running at once on a busy machine it took 15–28 s, past the
 * 15 s every other test gets (vite.config.ts). A test that waits on something should not need this
 */
export const HEAVY_MS = 60_000
