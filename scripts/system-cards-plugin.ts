import type { Plugin } from 'vite'
import { deriveCard } from '../shared/robot/system/card.ts'
import { GIB } from '../shared/robot/system/gib/index.ts'
import { TKU } from '../shared/robot/system/tku/index.ts'

const PUBLIC_ID = 'virtual:system-card-gib'
const CLUB_ID = 'virtual:system-card-tku'
const resolved = (id: string) => `\0${id}`

/**
 * The system cards as modules (e5-t52): worked out from the system files when the site is built, so
 * they cannot drift from what TKB bids, nothing is committed to go stale, and no request ever runs
 * the derivation (10 ms CPU).
 *
 * - `virtual:system-card-gib`: the 2/1 card, public rules, a small chunk of its own in the browser.
 * - `virtual:system-card-tku`: the club's card, members only (ARCHITECTURE.md §4), as one JSON
 *   string for the Worker to send as it is (`worker/system-card.ts`). It must never reach a public
 *   asset, so the browser's build fails outright if anything there imports it;
 *   `scripts/check-public-assets.ts` then checks what was actually built.
 */
export const systemCards = (): Plugin => ({
  name: 'system-cards',
  resolveId: (id) => (id === PUBLIC_ID || id === CLUB_ID ? resolved(id) : undefined),
  load(id) {
    if (id === resolved(PUBLIC_ID)) return `export default ${JSON.stringify(deriveCard(GIB))}`
    if (id !== resolved(CLUB_ID)) return undefined
    // Vitest loads the Worker's code in its own `client` environment; that is not a browser build
    if (this.environment.name === 'client' && !process.env.VITEST) throw new Error(`${CLUB_ID} is for the Worker only: it must not reach the browser`)
    return `export default ${JSON.stringify(JSON.stringify(deriveCard(TKU)))}`
  },
})
