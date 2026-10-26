import type { ClientMessage, TableWire } from '../../shared/protocol.ts'

/**
 * How a simulated person plays (docs/LOAD.md): only from what the server sends them, like a
 * browser (`legalCalls`, `legalCards`). Opens at the lowest level now and then so most boards are
 * played out (a load test wants the 52 cards), and plays any legal card
 */

export type Random = () => number

/** How far the board on the table has got: calls made plus cards played */
export function progressOf(table: TableWire | null | undefined): number {
  const board = table?.board
  if (!board) return -1
  const cards = board.tricks.reduce((n, trick) => n + trick.cards.length, 0)
  return board.boardNo * 1000 + board.auction.length + cards
}

export function decide(table: TableWire | null | undefined, random: Random = Math.random): ClientMessage | null {
  const board = table?.board
  if (!board || board.phase === 'finished') return null
  if (board.legalCards.length > 0) return { type: 'play', card: board.legalCards[Math.floor(random() * board.legalCards.length)] }
  const calls = board.legalCalls
  if (calls.length === 0) return null
  const bids = calls.filter((call) => call !== 'P' && call !== 'X' && call !== 'XX')
  const opened = board.auction.some((entry) => entry.call !== 'P' && entry.call !== 'X' && entry.call !== 'XX')
  // Nobody has bid: open (a board passed out plays no cards); otherwise mostly pass
  const bid = bids.length > 0 && (opened ? random() < 0.2 : random() < 0.7)
  return { type: 'call', call: bid ? bids[0] : 'P' }
}
