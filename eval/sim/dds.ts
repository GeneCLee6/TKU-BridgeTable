import createModule from 'bridge-dds/dist/lib/dds.js'
import type { Vulnerability } from '../../shared/board.ts'
import { RANKS, rankOf, rankValue, SEATS, SUITS, suitOf, type Card, type Hands, type Seat, type Strain, type Suit } from '../../shared/cards.ts'

/**
 * DDS (Bo Haglund and Soren Hein's double-dummy solver, the WASM build in `bridge-dds`) for Node
 * (eval/sim/README.md). The package's own wrapper imports its module without a file extension,
 * which Node cannot resolve, so this is the same thin layer over the emscripten module, only for
 * the two calls the simulations use: a whole DD table and the tricks each card takes from a
 * position. Everything here is a plain function of the cards it is given.
 */

/** The part of the emscripten module the wrapper uses */
interface DdsModule {
  ccall(name: string, returnType: string | null, argTypes: string[], args: unknown[]): number
  _malloc(size: number): number
  _free(pointer: number): void
  getValue(pointer: number, type: 'i32'): number
  setValue(pointer: number, value: number, type: 'i32'): void
  stringToUTF8(text: string, pointer: number, maxBytes: number): void
  UTF8ToString(pointer: number, maxBytes: number): string
}

/** Strains as DDS numbers them: the first index of a DD table and `trump` of a position */
export const DDS_STRAINS: readonly Strain[] = ['S', 'H', 'D', 'C', 'N']

/** Tricks each seat takes as declarer in each strain, `table[strain][seat]` */
export type DdTable = Record<Strain, Record<Seat, number>>

/** A position to solve from: who leads the trick, what was played to it so far, what everyone still holds */
export interface Position {
  trump: Suit | null
  /** The seat that led (or leads) the current trick */
  leader: Seat
  /** Cards already played to the current trick, in order (up to three) */
  trick: readonly Card[]
  /** The cards each seat still holds, not counting those in `trick` */
  hands: Record<Seat, readonly Card[]>
}

/** One of the cards the seat to play may choose, with the tricks its side then takes against best play */
export interface CardTricks {
  card: Card
  /** Lower cards of the same suit that are equivalent (DDS reports them once) */
  equals: Card[]
  /** Tricks the side of the seat to play takes from the rest of the deal, this card played */
  tricks: number
}

// struct dealPBN { int trump; int first; int currentTrickSuit[3]; int currentTrickRank[3]; char remainCards[80]; }
const DEAL_TRUMP = 0
const DEAL_FIRST = 4
const DEAL_TRICK_SUIT = 8
const DEAL_TRICK_RANK = 20
const DEAL_CARDS = 32
const DEAL_SIZE = 112
// struct futureTricks { int nodes; int cards; int suit[13]; int rank[13]; int equals[13]; int score[13]; }
const FUTURE_CARDS = 4
const FUTURE_SUIT = 8
const FUTURE_RANK = 60
const FUTURE_EQUALS = 112
const FUTURE_SCORE = 164
const FUTURE_SIZE = 216
// struct ddTableDealPBN { char cards[80]; }  struct ddTableResults { int resTable[5][4]; }
const TABLE_DEAL_SIZE = 80
const TABLE_RESULT_SIZE = 80
// struct parResultsDealer { int number; int score; char contracts[10][10]; }
const PAR_NUMBER = 0
const PAR_SCORE = 4
const PAR_CONTRACTS = 8
const PAR_SIZE = 108
/** DDS's vulnerability numbers for `DealerPar` */
const DDS_VUL: Record<Vulnerability, number> = { None: 0, Both: 1, NS: 2, EW: 3 }

/** The par result of a deal (DDS `DealerPar`): North–South's score and the par contracts as DDS writes them */
export interface Par {
  /** North–South's par score (negative when East–West make par) */
  ns: number
  contracts: string[]
}

/** A hand in PBN: ♠ ♥ ♦ ♣ high to low, dots between suits ('AKQ.JT9.876.5432') */
export function pbnHand(cards: readonly Card[]): string {
  return SUITS.map((suit) =>
    cards
      .filter((card) => suitOf(card) === suit)
      .map(rankOf)
      .sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b))
      .join(''),
  ).join('.')
}

/** 'N:… … … …': the four hands North first, as DDS reads a deal */
export function pbnOf(hands: Record<Seat, readonly Card[]>): string {
  return 'N:' + SEATS.map((seat) => pbnHand(hands[seat])).join(' ')
}

export class Solver {
  private readonly module: DdsModule

  constructor(module: DdsModule) {
    this.module = module
    // The WASM build has no threads of its own; the pool runs one solver per thread
    module.ccall('SetMaxThreads', null, ['number'], [0])
  }

  /** The DD table of a whole deal: tricks for each declarer in each strain */
  table(hands: Hands): DdTable {
    const m = this.module
    const deal = m._malloc(TABLE_DEAL_SIZE)
    const result = m._malloc(TABLE_RESULT_SIZE)
    try {
      m.stringToUTF8(pbnOf(hands), deal, TABLE_DEAL_SIZE)
      const code = m.ccall('CalcDDtablePBN', 'number', ['number', 'number'], [deal, result])
      if (code !== 1) throw new Error(`DDS CalcDDtablePBN failed: ${code}`)
      const table = {} as DdTable
      DDS_STRAINS.forEach((strain, s) => {
        table[strain] = {} as Record<Seat, number>
        SEATS.forEach((seat, h) => {
          table[strain][seat] = m.getValue(result + (s * 4 + h) * 4, 'i32')
        })
      })
      return table
    } finally {
      m._free(deal)
      m._free(result)
    }
  }

  /**
   * The par of a deal from its DD table (DDS `DealerPar`: both sides bid their best double dummy,
   * the dealer first, so a sacrifice that costs less than the opponents' contract is par).
   */
  par(table: DdTable, dealer: Seat, vul: Vulnerability): Par {
    const m = this.module
    const results = m._malloc(TABLE_RESULT_SIZE)
    const par = m._malloc(PAR_SIZE)
    try {
      DDS_STRAINS.forEach((strain, s) => SEATS.forEach((seat, h) => m.setValue(results + (s * 4 + h) * 4, table[strain][seat], 'i32')))
      const code = m.ccall('DealerPar', 'number', ['number', 'number', 'number', 'number'], [results, par, SEATS.indexOf(dealer), DDS_VUL[vul]])
      if (code !== 1) throw new Error(`DDS DealerPar failed: ${code}`)
      const contracts: string[] = []
      for (let i = 0; i < m.getValue(par + PAR_NUMBER, 'i32'); i++) contracts.push(m.UTF8ToString(par + PAR_CONTRACTS + i * 10, 10))
      // DDS gives North–South's score whoever deals (checked in tests/eval/compete.test.ts)
      return { ns: m.getValue(par + PAR_SCORE, 'i32'), contracts }
    } finally {
      m._free(results)
      m._free(par)
    }
  }

  /**
   * Every card the seat to play may choose, with the tricks its side takes from the rest of the
   * deal when it does (DDS `SolveBoardPBN`, all cards, best play by everyone afterwards). `reuse`
   * keeps DDS's transposition table from the previous call when it was the same deal (DDS checks),
   * which makes solving one position after another of the same deal much faster.
   */
  solve(position: Position, reuse = false): CardTricks[] {
    const m = this.module
    const deal = m._malloc(DEAL_SIZE)
    const future = m._malloc(FUTURE_SIZE)
    try {
      m.setValue(deal + DEAL_TRUMP, position.trump === null ? 4 : SUITS.indexOf(position.trump), 'i32')
      m.setValue(deal + DEAL_FIRST, SEATS.indexOf(position.leader), 'i32')
      for (let i = 0; i < 3; i++) {
        const card = position.trick[i]
        m.setValue(deal + DEAL_TRICK_SUIT + i * 4, card ? SUITS.indexOf(suitOf(card)) : 0, 'i32')
        m.setValue(deal + DEAL_TRICK_RANK + i * 4, card ? rankValue(rankOf(card)) : 0, 'i32')
      }
      m.stringToUTF8(pbnOf(position.hands), deal + DEAL_CARDS, 80)
      // target -1 and solutions 3: the tricks of every legal card; mode 1 reuses the table for the same deal
      const code = m.ccall('SolveBoardPBN', 'number', ['number', 'number', 'number', 'number', 'number', 'number'], [deal, -1, 3, reuse ? 1 : 0, future, 0])
      if (code !== 1) throw new Error(`DDS SolveBoardPBN failed: ${code}`)
      const count = m.getValue(future + FUTURE_CARDS, 'i32')
      const cards: CardTricks[] = []
      for (let i = 0; i < count; i++) {
        const suit = SUITS[m.getValue(future + FUTURE_SUIT + i * 4, 'i32')]
        const rank = m.getValue(future + FUTURE_RANK + i * 4, 'i32')
        const equalsMask = m.getValue(future + FUTURE_EQUALS + i * 4, 'i32')
        const equals: Card[] = []
        for (let r = 14; r >= 2; r--) if (equalsMask & (1 << r)) equals.push(suit + RANKS[14 - r])
        cards.push({ card: suit + RANKS[14 - rank], equals, tricks: m.getValue(future + FUTURE_SCORE + i * 4, 'i32') })
      }
      return cards
    } finally {
      m._free(deal)
      m._free(future)
    }
  }
}

/** Loads the WASM module (about 0.1 s) and wraps it; one solver serves one thread */
export async function loadSolver(): Promise<Solver> {
  const module = (await createModule()) as unknown as DdsModule
  return new Solver(module)
}

/** Spreads DDS's one line per distinct card over its equals too, so every legal card has a value */
export function expandEquals(cards: readonly CardTricks[]): Map<Card, number> {
  const tricks = new Map<Card, number>()
  for (const entry of cards) {
    tricks.set(entry.card, entry.tricks)
    for (const card of entry.equals) tricks.set(card, entry.tricks)
  }
  return tricks
}
