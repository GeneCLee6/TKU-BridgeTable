import { RANKS, SEATS, SUITS, rankOf, rankValue, sideOf, suitOf, type Card, type Hands, type Seat, type Strain, type Suit } from '../../shared/cards.ts'
import type { Vulnerability } from '../../shared/board.ts'
import { legalCards, tricksOf, tricksWon, turnOf, type BoardState, type PlayedCard } from '../../shared/game.ts'

/**
 * Double-dummy analysis of a finished board, worked out in the browser (`e6-t43`). The solver is
 * the WASM build of Bo Haglund and Soren Hein's DDS (`bridge-dds`), run in a Web Worker
 * (`dds.worker.ts`) that is only loaded when a record page asks for it, so neither the Worker on
 * the server nor the first page load ever carries it. These helpers are the plain data side:
 * turning a deal into DDS's input and its output into ours.
 */

/** Strains as DDS numbers them (resTable's first index) */
export const DDS_STRAINS: readonly Strain[] = ['S', 'H', 'D', 'C', 'N']
/** The order the table is shown in: NT first, then the suits from the top */
export const TABLE_STRAINS: readonly Strain[] = ['N', 'S', 'H', 'D', 'C']

/** Tricks each seat takes as declarer in each strain */
export type DdTable = Record<Strain, Record<Seat, number>>

/** One par contract, e.g. 4♠X by EW going one down */
export interface ParContract {
  level: number
  strain: Strain
  doubled: boolean
  /** Who can declare it: a side ('NS'), or one seat when only that seat makes it */
  by: string
  /** Over- or under-tricks: +1, -2; 0 when exactly made */
  overtricks: number
}

export interface DdAnalysis {
  table: DdTable
  par: {
    /** From North-South's point of view, as everywhere else in the records */
    scoreNS: number
    contracts: ParContract[]
  }
}

/** What the page sends the worker */
export interface DdRequest {
  /** The deal in PBN, North first */
  deal: string
  /** 0 = North … 3 = West */
  dealer: number
  /** DDS's numbering: 0 none, 1 both, 2 NS, 3 EW */
  vulnerable: number
}

/** DDS's raw results, before they are turned into a DdAnalysis */
export interface DdRawResult {
  resTable: number[][]
  par: { score: number; contracts: string[] }
}

/** Only a whole, legal deal can be solved: DDS aborts (rather than reporting an error) otherwise */
export function isCompleteDeal(hands: Hands): boolean {
  const seen = new Set<string>()
  for (const seat of SEATS) {
    const cards = hands[seat]
    if (!cards || cards.length !== 13) return false
    for (const card of cards) seen.add(card)
  }
  return seen.size === 52
}

/** 'N:AKQ.JT9.876.5432 …': each hand's suits ♠ ♥ ♦ ♣, high to low, separated by dots */
export function pbnDeal(hands: Hands): string {
  const hand = (cards: readonly string[]) =>
    SUITS.map((suit) =>
      cards
        .filter((card) => suitOf(card) === suit)
        .map(rankOf)
        .sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b))
        .join(''),
    ).join('.')
  return 'N:' + SEATS.map((seat) => hand(hands[seat])).join(' ')
}

const VULNERABLE: Record<Vulnerability, number> = { None: 0, Both: 1, NS: 2, EW: 3 }

export function ddRequest(hands: Hands, dealer: Seat, vul: Vulnerability): DdRequest {
  return { deal: pbnDeal(hands), dealer: SEATS.indexOf(dealer), vulnerable: VULNERABLE[vul] }
}

/** DDS writes par contracts as '4S-NS', '3N-EW+1', '5D*-NS-2' ('*' is doubled) */
export function parseParContract(text: string): ParContract | null {
  const match = /^([1-7])([SHDCN])(\*?)-(NS|EW|N|E|S|W)([+-]\d+)?$/.exec(text.trim())
  if (!match) return null
  return {
    level: Number(match[1]),
    strain: match[2] as Strain,
    doubled: match[3] === '*',
    by: match[4],
    overtricks: match[5] ? Number(match[5]) : 0,
  }
}

export function toAnalysis(raw: DdRawResult): DdAnalysis {
  const table = Object.fromEntries(
    DDS_STRAINS.map((strain, i) => [strain, Object.fromEntries(SEATS.map((seat, j) => [seat, raw.resTable[i][j]]))]),
  ) as DdTable
  const contracts = raw.par.contracts.map(parseParContract).filter((c): c is ParContract => c !== null)
  return { table, par: { scoreNS: raw.par.score, contracts } }
}

/*
 * Double-dummy mode during a replay (BBO's "DD" in the movie): at any point of the play, what each
 * card the hand to play may play is worth. DDS's SolveBoard takes the cards still held, the cards
 * already on the table in the trick being played, and who led it; it answers, for every legal card,
 * how many of the remaining tricks the side to play takes after playing it.
 */

/** DDS's dealPBN: trump and suits numbered ♠ 0 ♥ 1 ♦ 2 ♣ 3 (NT 4), seats N 0 … W 3, ranks 2 … 14 */
export interface DdPositionRequest {
  trump: number
  /** The seat that led the trick being played (or leads the next one) */
  first: number
  /** The cards already played to that trick, in order (unused entries 0) */
  currentTrickSuit: number[]
  currentTrickRank: number[]
  /** The cards still held, in PBN, North first */
  remainCards: string
}

/** DDS's futureTricks: one entry per card (lower equivalent cards folded into `equals`) */
export interface DdPositionRaw {
  suit: number[]
  rank: number[]
  /** Bit r set: the card of rank r in the same suit is worth the same */
  equals: number[]
  /** Remaining tricks (the current one included) the side to play takes */
  score: number[]
}

/** What one card is worth, seen from the declaring side as BBO shows it */
export interface CardOutcome {
  /** Tricks declarer's side ends the board with */
  tricks: number
  /** Against the contract: 0 just made, +1 one overtrick, -1 one down */
  diff: number
  /** One of the best cards for the side to play */
  best: boolean
}

/** A point of the play: who is to play, what they may play, and what DDS needs to know */
export interface DdPosition {
  turn: Seat
  legal: Card[]
  request: DdPositionRequest
  /** Tricks declarer's side has already won (completed tricks only) */
  declarerTricks: number
  /** Tricks still to be played, the current one included */
  tricksLeft: number
  /** The hand to play is declarer or dummy */
  declarerSide: boolean
}

const DDS_SUITS: readonly Suit[] = ['S', 'H', 'D', 'C']
const rankAt = (value: number) => RANKS[14 - value]

/**
 * The point of the play after `play` (the record's cards so far, plus any tried out), or null when
 * there is nothing left to play or no contract
 */
export function ddPosition(board: BoardState, play: readonly PlayedCard[]): DdPosition | null {
  const contract = board.contract
  if (!contract || play.length >= 52) return null
  const state: BoardState = { ...board, phase: 'play', play: [...play], claim: undefined }
  const turn = turnOf(state)
  if (!turn) return null
  const current = tricksOf(state).at(-1)
  const open = current && !current.winner ? current.cards : []
  const first = current && open.length ? current.leader : turn
  const played = new Set(play.map((p) => p.card))
  const remaining = Object.fromEntries(SEATS.map((seat) => [seat, board.hands[seat].filter((c) => !played.has(c))])) as Hands
  const trickSuit = [0, 0, 0]
  const trickRank = [0, 0, 0]
  open.forEach(({ card }, i) => {
    trickSuit[i] = DDS_SUITS.indexOf(suitOf(card))
    trickRank[i] = rankValue(rankOf(card))
  })
  const side = sideOf(contract.declarer)
  return {
    turn,
    legal: legalCards(state, turn),
    request: {
      trump: DDS_STRAINS.indexOf(contract.strain),
      first: SEATS.indexOf(first),
      currentTrickSuit: trickSuit,
      currentTrickRank: trickRank,
      remainCards: pbnDeal(remaining),
    },
    declarerTricks: tricksWon(state)[side],
    tricksLeft: 13 - Math.floor(play.length / 4),
    declarerSide: sideOf(turn) === side,
  }
}

/** The same position always gives the same answer, so each is solved once */
export const positionKey = (request: DdPositionRequest) =>
  [request.trump, request.first, request.currentTrickSuit.join(','), request.currentTrickRank.join(','), request.remainCards].join('|')

/** DDS's answer per card: remaining tricks for the side to play, the equivalent cards spelled out */
export function cardScores(raw: DdPositionRaw): Map<Card, number> {
  const scores = new Map<Card, number>()
  raw.suit.forEach((suitNo, i) => {
    const suit = DDS_SUITS[suitNo]
    scores.set(suit + rankAt(raw.rank[i]), raw.score[i])
    for (let r = 2; r <= 14; r++) if (raw.equals[i] & (1 << r)) scores.set(suit + rankAt(r), raw.score[i])
  })
  return scores
}

/** Each legal card's outcome for declarer's side against a contract of `level`; the best ones for the side to play marked */
export function cardOutcomes(position: DdPosition, scores: Map<Card, number>, level: number): Map<Card, CardOutcome> {
  const outcomes = new Map<Card, CardOutcome>()
  const known = position.legal.filter((card) => scores.has(card))
  const top = Math.max(...known.map((card) => scores.get(card)!))
  for (const card of known) {
    const score = scores.get(card)!
    const tricks = position.declarerTricks + (position.declarerSide ? score : position.tricksLeft - score)
    outcomes.set(card, { tricks, diff: tricks - (level + 6), best: score === top })
  }
  return outcomes
}

/**
 * What goes on the card: '=' just made, otherwise the number of over- or undertricks without a sign,
 * as BBO writes it; the colour (`CardMark.makes`) says which, and `CardMark.label` says it in words
 */
export const outcomeLabel = (diff: number) => (diff === 0 ? '=' : String(Math.abs(diff)))
