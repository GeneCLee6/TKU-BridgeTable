import { nextSeat, sameSide, type Seat, type Strain } from './cards.ts'

/**
 * A call: a bid such as '1C' '3N' '7S', or 'P' (pass), 'X' (double), 'XX' (redouble).
 * Strains go up ♣ ♦ ♥ ♠ NT; 'N' is notrump.
 */
export type Call = string

export interface AuctionCall {
  seat: Seat
  call: Call
  /** Set when the caller alerted the call; the text is the explanation (may be empty) */
  alert?: string
}

export interface Contract {
  level: number
  strain: Strain
  doubled: '' | 'X' | 'XX'
  declarer: Seat
}

export const STRAINS: readonly Strain[] = ['C', 'D', 'H', 'S', 'N']
export const LEVELS = [1, 2, 3, 4, 5, 6, 7] as const

export const isBid = (call: Call) => /^[1-7][CDHSN]$/.test(call)
export const isCall = (call: unknown): call is Call =>
  typeof call === 'string' && (isBid(call) || call === 'P' || call === 'X' || call === 'XX')

export const levelOf = (bid: Call) => Number(bid[0])
export const strainOf = (bid: Call) => bid[1] as Strain
/** 0 for 1♣ up to 34 for 7NT */
export const bidIndex = (bid: Call) => (levelOf(bid) - 1) * 5 + STRAINS.indexOf(strainOf(bid))

/** The seat whose turn it is after `count` calls */
export function seatToCall(dealer: Seat, count: number): Seat {
  return nextSeat(dealer, count % 4)
}

/** Four passes to start, or three passes after any bid, end the auction */
export function isAuctionComplete(calls: readonly AuctionCall[]): boolean {
  return calls.length >= 4 && calls.slice(-3).every((c) => c.call === 'P')
}

function lastBid(calls: readonly AuctionCall[]): AuctionCall | undefined {
  return calls.findLast((c) => isBid(c.call))
}

/** Every call the next seat may legally make */
export function legalCalls(calls: readonly AuctionCall[], dealer: Seat): Set<Call> {
  const legal = new Set<Call>()
  if (isAuctionComplete(calls)) return legal
  const seat = seatToCall(dealer, calls.length)
  legal.add('P')

  const highest = lastBid(calls)
  const from = highest ? bidIndex(highest.call) + 1 : 0
  for (let i = from; i < 35; i++) legal.add(`${Math.floor(i / 5) + 1}${STRAINS[i % 5]}`)

  const lastAction = calls.findLast((c) => c.call !== 'P')
  if (lastAction && !sameSide(lastAction.seat, seat)) {
    if (isBid(lastAction.call)) legal.add('X')
    if (lastAction.call === 'X') legal.add('XX')
  }
  return legal
}

/** The final contract, or null when the board was passed out or the auction is still running */
export function contractOf(calls: readonly AuctionCall[]): Contract | null {
  if (!isAuctionComplete(calls)) return null
  const final = lastBid(calls)
  if (!final) return null
  const strain = strainOf(final.call)
  const after = calls.slice(calls.lastIndexOf(final) + 1)
  const doubled = after.some((c) => c.call === 'XX') ? 'XX' : after.some((c) => c.call === 'X') ? 'X' : ''
  // The declarer is the first player of the winning side to have named the final strain
  const declarer = calls.find(
    (c) => isBid(c.call) && strainOf(c.call) === strain && sameSide(c.seat, final.seat),
  )!.seat
  return { level: levelOf(final.call), strain, doubled, declarer }
}
