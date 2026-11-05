import type { Plugin } from 'vite'
import { deriveCards } from '../shared/robot/system/card.ts'

const ID = 'virtual:system-cards'
const RESOLVED = `\0${ID}`

/**
 * The system cards as a module (e5-t52): worked out from the system files when the site is built,
 * so they cannot drift from what TKB bids, nothing is committed to go stale, and neither the browser
 * nor a Worker request ever runs the derivation. `import('virtual:system-cards')` is its own small
 * chunk, loaded only when someone opens a card (`src/lib/systemCards.ts`).
 */
export const systemCards = (): Plugin => ({
  name: 'system-cards',
  resolveId: (id) => (id === ID ? RESOLVED : undefined),
  load: (id) => (id === RESOLVED ? `export default ${JSON.stringify(deriveCards())}` : undefined),
})
