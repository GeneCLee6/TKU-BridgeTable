import { SEATS, SUITS, sortHand, type Card, type Hands } from '../shared/cards.ts'
import { dealWith, type DealConditions } from '../shared/dealer.ts'

/**
 * The fixed deal sets of the evaluation platform (e6-t16, eval/README.md). A set is not stored as a
 * file: it is the seed plus this generator, so 5,000 boards cost nothing in the repo and any board
 * can be dealt on its own. Board `n` of a set is shuffled by its own generator, seeded from the
 * set's seed and `n`, so the quick set is simply the first 200 boards of the full set and a run of
 * boards 4,001–4,100 needs no other boards. The generator lives here, not in `shared/board.ts`, so
 * a change to the club's dealing never changes the sets; the fingerprints in
 * `tests/eval/deals.test.ts` fail if anything here does.
 */

/** The seed of the platform's set; a new seed is a new set, so results are only comparable within one */
export const EVAL_SEED = 'tku-eval-v1'
/** The full set: enough for calibration (e6-t22) and two-standard-error proofs (AC-6.14) */
export const FULL_SET_SIZE = 5000
/** The CI quick set (e6-t17): boards 1–200 of the full set */
export const QUICK_SET_SIZE = 200

export interface EvalBoard {
  /** The board's number: dealer and vulnerability follow the usual 16-board cycle */
  boardNo: number
  hands: Hands
}

/** A 32-bit hash of a string (FNV-1a) */
export function hashText(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** mulberry32: a random integer in [0, n) from a 32-bit state */
function mulberry32(seed: number) {
  let state = seed >>> 0
  return (n: number) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4_294_967_296) * n)
  }
}

/** The deck in a fixed order, independent of `shared/cards.ts` */
const DECK: readonly Card[] = [...'SHDC'].flatMap((suit) => [...'AKQJT98765432'].map((rank) => suit + rank))

/**
 * A seed that starts with `slam:` (`--deck slam`) is a slam-zone set (eval/sim/README.md §9): North–
 * South hold 30–36 points between them, or 26–29 with a nine-card fit (five and four). Every deal
 * meeting that is equally likely (`shared/dealer.ts`); dealer and vulnerability follow the board
 * number as usual, so each seat deals and each vulnerability comes round.
 */
export const SLAM_PREFIX = 'slam:'

export const SLAM_CONDITIONS: readonly DealConditions[] = [
  { sides: { NS: { hcp: [30, 36] } } },
  ...SUITS.flatMap((suit): DealConditions[] => [
    { seats: { N: { lengths: { [suit]: [5, 13] } }, S: { lengths: { [suit]: [4, 13] } } }, sides: { NS: { hcp: [26, 29] } } },
    { seats: { N: { lengths: { [suit]: [4, 13] } }, S: { lengths: { [suit]: [5, 13] } } }, sides: { NS: { hcp: [26, 29] } } },
  ]),
]

/** Board `boardNo` of the set with `seed`: a Fisher-Yates shuffle, 13 cards a seat, each hand sorted */
export function evalBoard(boardNo: number, seed: string = EVAL_SEED): EvalBoard {
  if (seed.startsWith(SLAM_PREFIX)) {
    const dealt = dealWith(SLAM_CONDITIONS, mulberry32(hashText(`${seed}:${boardNo}`)), 1_000_000)
    if (!dealt.ok) throw new Error(`no slam-zone deal for board ${boardNo} of ${seed}`)
    return { boardNo, hands: dealt.hands }
  }
  const random = mulberry32(hashText(`${seed}:${boardNo}`))
  const deck = [...DECK]
  for (let i = deck.length - 1; i > 0; i--) {
    const j = random(i + 1)
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  const hands = Object.fromEntries(SEATS.map((seat, i) => [seat, sortHand(deck.slice(i * 13, i * 13 + 13))])) as Hands
  return { boardNo, hands }
}

/** Boards `from` to `from + count - 1` of the set with `seed` */
export function evalBoards(count: number, seed: string = EVAL_SEED, from = 1): EvalBoard[] {
  return Array.from({ length: count }, (_, i) => evalBoard(from + i, seed))
}

/** A short fingerprint of boards (their numbers and cards), to notice a set that changed */
export function fingerprint(boards: readonly EvalBoard[]): string {
  let h = 0x811c9dc5
  for (const board of boards) {
    const text = `${board.boardNo}|${SEATS.map((seat) => [...board.hands[seat]].sort().join('')).join('|')};`
    h = Math.imul(h ^ hashText(text), 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
