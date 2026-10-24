import { deal, dealerOf, secureRandomInt, vulnerabilityOf, type RandomInt, type Vulnerability } from './board.ts'
import { bySuit, isCard, rankOf, SEATS, sortHand, SUITS, type Hands, type Seat } from './cards.ts'
import { DEAL_PRESETS, type DealPreset } from './deal-presets.ts'
import type { DealSource } from './deal-source.ts'
import { dealWith } from './dealer.ts'

/**
 * The fixed boards of a challenge (e7-t02, ARCHITECTURE.md §5.5): made once on the server when
 * the challenge is created, stored with it and never sent whole to a browser. Every participant
 * plays the same boards in the same order; the dealer and vulnerability follow each board's
 * number through the usual 16-board cycle, so a board keeps them wherever it came from.
 */

export interface DealSetBoard {
  /** The board's number: dealer and vulnerability come from it */
  boardNo: number
  hands: Hands
}

export interface DealSet {
  /** In the order they are played; the first is the challenge's board 1 */
  boards: DealSetBoard[]
}

/** How the boards are chosen */
export type DealSetSpec =
  /** `count` boards numbered 1, 2, 3…, shuffled, or dealt to meet a preset (South's seat) */
  | { kind: 'random'; count: number; preset?: DealPreset }
  /** Boards that already exist, such as one from the history (「用這副牌挑戰」) */
  | { kind: 'given'; boards: DealSetBoard[] }

/** A challenge has at most 16 boards (AC-7.1), one full vulnerability cycle */
export const DEAL_SET_MAX = 16

/**
 * The deal set for a spec, or null when it cannot be made: a count out of range, given boards that
 * are not proper deals, or a preset the dealer could not meet. The server deals with the platform
 * CSPRNG; tests pass a seeded `random` to get the same boards every time
 */
export function makeDealSet(spec: DealSetSpec, random: RandomInt = secureRandomInt): DealSet | null {
  if (spec.kind === 'given') {
    const set: DealSet = { boards: spec.boards.map((b) => ({ boardNo: b.boardNo, hands: sortHands(b.hands) })) }
    return dealSetProblem(set) === null ? set : null
  }
  if (!Number.isInteger(spec.count) || spec.count < 1 || spec.count > DEAL_SET_MAX) return null
  const boards: DealSetBoard[] = []
  for (let boardNo = 1; boardNo <= spec.count; boardNo++) {
    if (!spec.preset) {
      boards.push({ boardNo, hands: deal(random) })
      continue
    }
    const result = dealWith(DEAL_PRESETS[spec.preset], random)
    if (!result.ok) return null
    boards.push({ boardNo, hands: result.hands })
  }
  return { boards }
}

const sortHands = (hands: Hands): Hands =>
  Object.fromEntries(SEATS.map((seat) => [seat, sortHand(hands[seat] ?? [])])) as Hands

/** What is wrong with a deal set, or null: each board needs a number and 13 different cards a seat */
export function dealSetProblem(set: DealSet): string | null {
  if (!Array.isArray(set?.boards) || set.boards.length < 1 || set.boards.length > DEAL_SET_MAX) return 'boards'
  for (const [i, board] of set.boards.entries()) {
    if (!Number.isInteger(board?.boardNo) || board.boardNo < 1) return `boards.${i}.boardNo`
    const seen = new Set<string>()
    for (const seat of SEATS) {
      const hand = board.hands?.[seat]
      if (!Array.isArray(hand) || hand.length !== 13 || !hand.every(isCard)) return `boards.${i}.${seat}`
      for (const card of hand) seen.add(card)
    }
    if (seen.size !== 52) return `boards.${i}.cards`
  }
  return null
}

/** Board `seq` (1-based) of the set with its dealer and vulnerability, or null past the end */
export function dealSetBoard(
  set: DealSet,
  seq: number,
): { boardNo: number; dealer: Seat; vul: Vulnerability; hands: Hands } | null {
  const board = set.boards[seq - 1]
  if (!board) return null
  return { boardNo: board.boardNo, dealer: dealerOf(board.boardNo), vul: vulnerabilityOf(board.boardNo), hands: structuredClone(board.hands) }
}

/** The deal source a challenge table plays from: board n of the table is board n of the set */
export function dealSourceOf(set: DealSet): DealSource {
  return { kind: 'fixed', deals: set.boards.map((b) => structuredClone(b.hands)) }
}

// ── Storage ───────────────────────────────────────────────────────────────────────────────────

/**
 * A deal set as one short line per board, `<boardNo> N:<north> <east> <south> <west>`, each hand
 * in PBN order `♠.♥.♦.♣` (`3 N:AK32.T98.765.43 …`): about 75 characters a board, readable in the
 * database and the same notation other bridge tools use
 */
export function encodeDealSet(set: DealSet): string {
  return set.boards
    .map(({ boardNo, hands }) => {
      const pbn = SEATS.map((seat) => {
        const groups = bySuit(hands[seat])
        return SUITS.map((suit) => groups[suit].map(rankOf).join('')).join('.')
      })
      return `${boardNo} N:${pbn.join(' ')}`
    })
    .join('\n')
}

/** Reads what `encodeDealSet` wrote; null if it is not a proper deal set */
export function decodeDealSet(text: string): DealSet | null {
  const boards: DealSetBoard[] = []
  for (const line of String(text ?? '').split('\n')) {
    const match = /^(\d+) N:(\S+) (\S+) (\S+) (\S+)$/.exec(line)
    if (!match) return null
    const hands = {} as Hands
    for (const [i, seat] of SEATS.entries()) {
      const suits = match[i + 2].split('.')
      if (suits.length !== 4) return null
      hands[seat] = sortHand(SUITS.flatMap((suit, s) => [...suits[s]].map((rank) => suit + rank)))
    }
    boards.push({ boardNo: Number(match[1]), hands })
  }
  const set = { boards }
  return dealSetProblem(set) === null ? set : null
}
