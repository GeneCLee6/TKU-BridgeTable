import type { Plugin } from 'vite'
import { deriveCard } from '../shared/robot/system/card.ts'
import { OPEN_SYSTEMS } from '../shared/robot/system/open-systems.ts'
import { TKU } from '../shared/robot/system/tku/index.ts'

const OPEN_CARDS = new Map(Object.values(OPEN_SYSTEMS).map((system) => [`virtual:system-card-${system.id}`, system]))
const CLUB_ID = 'virtual:system-card-tku'
const resolved = (id: string) => `\0${id}`

/**
 * The system cards as modules (e5-t52): worked out from the system files when the site is built, so
 * they cannot drift from what TKB bids, nothing is committed to go stale, and no request ever runs
 * the derivation (10 ms CPU).
 *
 * - `virtual:system-card-<system>`: a public system's card (`OPEN_SYSTEMS`), a small chunk of its own
 *   in the browser.
 * - `virtual:system-card-tku`: the club's card, members only (ARCHITECTURE.md §4), as one JSON
 *   string for the Worker to send as it is (`worker/system-card.ts`). It must never reach a public
 *   asset, so the browser's build fails outright if anything there imports it;
 *   `scripts/check-public-assets.ts` then checks what was actually built.
 */
export const systemCards = (): Plugin => ({
  name: 'system-cards',
  resolveId: (id) => (OPEN_CARDS.has(id) || id === CLUB_ID ? resolved(id) : undefined),
  load(id) {
    const open = id.startsWith('\0') ? OPEN_CARDS.get(id.slice(1)) : undefined
    if (open) return `export default ${JSON.stringify(deriveCard(open))}`
    if (id !== resolved(CLUB_ID)) return undefined
    // Vitest loads the Worker's code in its own `client` environment; that is not a browser build
    if (this.environment.name === 'client' && !process.env.VITEST) throw new Error(`${CLUB_ID} is for the Worker only: it must not reach the browser`)
    return `export default ${JSON.stringify(JSON.stringify(deriveCard(TKU)))}`
  },
})
