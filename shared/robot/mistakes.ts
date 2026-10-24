import { rankValue, rankOf, suitOf, SUITS, type Card, type Seat, type Suit } from '../cards.ts'
import { legalCards, type BoardState } from '../game.ts'

/**
 * Deliberate, reproducible mistakes (e6-t21, ROBOT.md §8). A robot errs with its level's
 * `errorRate`, decided by a seeded random number from the seed key and the action number, so the
 * same situation always gets the same mistake: replaying a board, an undo, or two players of the
 * same challenge board (whose key is the challenge, the board's place in the set and nothing about
 * who plays it, ARCHITECTURE.md §5.5).
 *
 * Without DDS on the server a mistake is the rule robot's second choice, never an illegal or wild
 * one: in the auction the next rule that fits (`alternative` in `system/engine.ts`), in the play
 * the neighbouring card (`mistakenCard`).
 */

/** The action a robot is asked about: calls and cards made so far on the board */
export const actionNumber = (state: BoardState) => state.auction.length + state.play.length

/** A 32-bit hash of a string (FNV-1a) */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** A number in [0, 1) that depends only on the seed key and the action number (one mulberry32 step) */
export function mistakeRoll(seed: string, action: number): number {
  let t = (hash(`${seed}#${action}`) + 0x6d2b79f5) >>> 0
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
}

/** Whether the robot errs at this action; never without a seed key or at a rate of 0 */
export function errs(errorRate: number, seed: string | undefined, action: number): boolean {
  return seed !== undefined && errorRate > 0 && mistakeRoll(seed, action) < errorRate
}

const byRank = (a: Card, b: Card) => rankValue(rankOf(a)) - rankValue(rankOf(b))

/**
 * The card a robot plays from `seat` when it errs instead of `best`, or null when there is no
 * other sensible card. The mistake is the neighbouring card: in the same suit the next card up,
 * or the next card down when `best` is the highest (second hand plays the 4 instead of the 2,
 * third hand the queen instead of the ace). When `best` is the only card of its suit (a lead or a
 * discard), the lowest card of the first other suit in ♠♥♦♣ order, trumps excluded unless `best`
 * is one, so a mistake
 * never ruffs partner's trick. Every card offered is legal; with one legal card there is no mistake.
 */
export function mistakenCard(state: BoardState, seat: Seat, best: Card): Card | null {
  const legal = legalCards(state, seat)
  if (legal.length < 2 || !legal.includes(best)) return null
  const suit = suitOf(best)
  const same = legal.filter((c) => suitOf(c) === suit).sort(byRank)
  const at = same.indexOf(best)
  const neighbour = same[at + 1] ?? same[at - 1]
  if (neighbour) return neighbour
  const strain = state.contract?.strain
  const trump: Suit | null = strain && strain !== 'N' ? strain : null
  for (const other of SUITS) {
    if (other === suit || (other === trump && suit !== trump)) continue
    const cards = legal.filter((c) => suitOf(c) === other).sort(byRank)
    if (cards.length) return cards[0]
  }
  return null
}
