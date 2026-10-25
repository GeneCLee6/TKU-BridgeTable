import { RANKS, SEATS, SUITS, rankOf, suitOf, type Hands, type Seat, type Strain } from '../../shared/cards.ts'
import type { Vulnerability } from '../../shared/board.ts'

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
