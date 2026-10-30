import { describe, expect, it } from 'vitest'
import type { AuctionCall } from '../../shared/auction.ts'
import { nextSeat, type Card, type Seat } from '../../shared/cards.ts'
import { robotCall } from '../../shared/robot/robots.ts'
import type { RobotKind } from '../../shared/protocol.ts'

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  const cards = text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
  if (cards.length !== 13) throw new Error(`${text} has ${cards.length} cards`)
  return cards
}

const auctionOf = (calls: string, dealer: Seat = 'N'): AuctionCall[] =>
  calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))

/** The robot's call and what it showed after the given calls, the first by North */
function bidOver(kind: RobotKind, cards: string, calls: string) {
  const auction = auctionOf(calls)
  return robotCall(kind, hand(cards), nextSeat('N', auction.length), auction, 'N', 'None')
}

describe('the slam check: a natural game bid with a slam between us (V4d)', () => {
  it('淡江: RKCB instead of the jump to game in an agreed major', () => {
    // 1♣–1♠–2♠ (12–15) with 20: the responder book's 4♠ (13+) would stop in game
    const ask = bidOver('tku', 'A964 AJ AQJ7 A52', '1C P 1S P 2S P')
    expect(ask.call).toBe('4N')
    expect(ask.meaning?.name).toBe('rkcb1430')
    // A game hand still bids game
    expect(bidOver('tku', 'A964 J2 AQ7 Q852', '1C P 1S P 2S P').call).toBe('4S')
  })

  it('淡江: the small slam itself when 4NT does not ask for the suit, on partner’s fewest points', () => {
    // 1♦–1♠–2♥ (reverse, 16+) with 18 and four hearts: 6♥, not 3NT; with 15 (31 on partner's fewest) 3NT
    expect(bidOver('tku', 'AQ642 K862 A KQ3', '1D P 1S P 2H P').call).toBe('6H')
    expect(bidOver('tku', 'AQ642 K862 J KQ3', '1D P 1S P 2H P').call).toBe('3N')
    // 1♣–1♠–2♣ (12–15) with 22 and no fit: 6NT, not 4♠
    expect(bidOver('tku', 'AKQJT7 AQT4 Q2 A', '1C P 1S P 2C P').call).toBe('6N')
  })

  it('淡江: never after the opponents bid, and not past our 4NT', () => {
    expect(bidOver('tku', 'A964 AJ AQJ7 A52', '1C 2H 2S P').call).not.toBe('4N')
  })

  it('淡江: six of the trump suit answering the king ask is the small slam (pass, not seven)', () => {
    expect(bidOver('tku', 'A9 AJ72 K94 AKJ6', '1D P 1H P 2H P 4N P 5S P 5N P 6H P').call).toBe('P')
  })

  it('2/1: RKCB instead of game after a Soloway jump shift and a raise (§10)', () => {
    const ask = bidOver('gib', 'AQ AQ976 KQ8 QJ8', '1C P 2H P 3H P')
    expect(ask.call).toBe('4N')
    expect(ask.meaning?.name).toBe('rkcb')
  })
})
