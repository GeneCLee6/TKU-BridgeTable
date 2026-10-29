/**
 * How both sites draw suits, calls, an auction and a deal (BridgeHall e7-t07, AC-7.5).
 *
 * This file is the same, byte for byte, in TKU-BridgeHall and TKU-BridgeTable
 * (tests/shared-display/cases.ts). Each site's tests/presentation/shared-display.test.tsx draws its
 * own components from these cases and checks what comes out (BridgeHall: `Suit`, `CallLabel`,
 * `AuctionTable`, `DealDiagram`; BridgeTable: `SuitSymbol`, `CallLabel`, `AuctionBox`, `HandView`),
 * and BridgeHall's `npm run parity` checks that the two copies are still the same. Change both
 * together. Pure data: no imports.
 *
 * Cards and calls are written as the table writes them: a card is suit then rank ('ST' is ♠10), a
 * call '1C' … '7N', 'P', 'X' or 'XX'.
 */

/** Each suit's symbol, and its name as a screen reader says it (Traditional Chinese) */
export const SUITS = [
  { suit: 'S', symbol: '♠', name: '黑桃' },
  { suit: 'H', symbol: '♥', name: '紅心' },
  { suit: 'D', symbol: '♦', name: '方塊' },
  { suit: 'C', symbol: '♣', name: '梅花' },
] as const

const LEVELS = ['1', '2', '3', '4', '5', '6', '7']
const STRAINS = [
  ['C', '♣'],
  ['D', '♦'],
  ['H', '♥'],
  ['S', '♠'],
  ['N', 'NT'],
] as const

/** Every call and the text drawn for it: 1♣ … 7NT, Pass, X, XX */
export const CALLS: readonly (readonly [call: string, text: string])[] = [
  ...LEVELS.flatMap((level) => STRAINS.map(([strain, shown]) => [`${level}${strain}`, `${level}${shown}`] as const)),
  ['P', 'Pass'],
  ['X', 'X'],
  ['XX', 'XX'],
]

/** An auction East dealt, and its rows as drawn: columns West, North, East, South */
export const AUCTION = {
  dealer: 'E',
  calls: ['1C', 'P', '1H', 'X', 'XX', 'P', '1S', 'P', '1N', 'P', 'P', 'P'],
  rows: [
    ['', '', '1♣', 'Pass'],
    ['1♥', 'X', 'XX', 'Pass'],
    ['1♠', 'Pass', '1NT', 'Pass'],
    ['Pass', 'Pass', '', ''],
  ],
} as const

/** A deal with a void, and each hand as drawn: suits ♠ ♥ ♦ ♣, ranks high to low, 'T' as 10 */
export const DEAL = {
  hands: {
    N: ['SA', 'SK', 'ST', 'S2', 'HQ', 'HJ', 'H9', 'DA', 'D8', 'D7', 'D3', 'C6', 'C4'],
    E: ['SQ', 'SJ', 'S9', 'S8', 'S7', 'S6', 'HK', 'H8', 'H7', 'DK', 'DQ', 'DJ', 'DT'],
    S: ['S5', 'S4', 'HA', 'HT', 'H6', 'H5', 'H4', 'D9', 'CA', 'CK', 'CQ', 'CJ', 'CT'],
    W: ['S3', 'H3', 'H2', 'D6', 'D5', 'D4', 'D2', 'C9', 'C8', 'C7', 'C5', 'C3', 'C2'],
  },
  drawn: {
    N: { S: ['A', 'K', '10', '2'], H: ['Q', 'J', '9'], D: ['A', '8', '7', '3'], C: ['6', '4'] },
    E: { S: ['Q', 'J', '9', '8', '7', '6'], H: ['K', '8', '7'], D: ['K', 'Q', 'J', '10'], C: [] },
    S: { S: ['5', '4'], H: ['A', '10', '6', '5', '4'], D: ['9'], C: ['A', 'K', 'Q', 'J', '10'] },
    W: { S: ['3'], H: ['3', '2'], D: ['6', '5', '4', '2'], C: ['9', '8', '7', '5', '3', '2'] },
  },
  /** What a void is drawn as */
  void: '—',
} as const
