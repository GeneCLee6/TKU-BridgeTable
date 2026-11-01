import type { Suit } from '../../cards.ts'
import type { Hand } from './evaluate.ts'

/**
 * T1 (社長 2026-11-01, both systems): an invitational hand (8–9) over partner's 1NT with no
 * four-card major and a long, good minor jumps to 3NT instead of inviting with 2NT. "Long and good"
 * was chosen by measurement (ROBOT.md §6.13): a six-card or longer minor with two of the ace, king
 * and queen, or a five-card one with two of them and 9 HCP.
 */

const MINORS: readonly Suit[] = ['C', 'D']

/** How many of the ace, king and queen the suit holds */
const topThree = (h: Hand, s: Suit) => [...h.ranks[s]].filter((r) => r === 'A' || r === 'K' || r === 'Q').length

export function jumpsTo3NT(h: Hand): boolean {
  if (h.hcp < 8 || h.hcp > 9 || h.len.H >= 4 || h.len.S >= 4) return false
  return MINORS.some((m) => topThree(h, m) >= 2 && (h.len[m] >= 6 || (h.len[m] === 5 && h.hcp === 9)))
}
