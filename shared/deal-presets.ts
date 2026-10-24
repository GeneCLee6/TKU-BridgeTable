import type { Suit } from './cards.ts'
import type { DealConditions } from './dealer.ts'

/**
 * Ready-made conditions for practice (AC-10.1), all from South's seat: the practice table puts the
 * member there. A preset is a list of alternatives, any of which will do. The club can add more
 * here; the practice table (`e10-t04`) names them from `strings.ts`.
 */

const each = (make: (suit: Suit) => DealConditions, suits: readonly Suit[]) => suits.map(make)

export const DEAL_PRESETS = {
  /** South opens 1NT: 15–17, balanced */
  oneNotrump: [{ seats: { S: { hcp: [15, 17], balanced: true } } }],
  /** South opens one of a major: 12–21 with five or more spades or hearts */
  majorOpening: each((suit) => ({ seats: { S: { hcp: [12, 21], lengths: { [suit]: [5, 13] } } } }), ['S', 'H']),
  /** North and South have a slam between them: 33 or more together, each at least 12 */
  slam: [{ seats: { N: { hcp: [12, 37] }, S: { hcp: [12, 37] } }, sides: { NS: { hcp: [33, 40] } } }],
  /** Both sides have something to say: each side 17–23, South 11–16 */
  competitive: [{ seats: { S: { hcp: [11, 16] } }, sides: { NS: { hcp: [17, 23] }, EW: { hcp: [17, 23] } } }],
  /** South has a preempt: 5–10 with a six- or seven-card suit */
  preempt: each((suit) => ({ seats: { S: { hcp: [5, 10], lengths: { [suit]: [6, 7] } } } }), ['S', 'H', 'D', 'C']),
} as const satisfies Record<string, readonly DealConditions[]>

export type DealPreset = keyof typeof DEAL_PRESETS
export const DEAL_PRESET_IDS = Object.keys(DEAL_PRESETS) as DealPreset[]
