import { describe, expect, it } from 'vitest'
import { dealerOf, deal, vulnerabilityOf } from '../../shared/board.ts'
import { hcp, SEATS, type Hands } from '../../shared/cards.ts'
import {
  bestHand,
  bestHandSeat,
  boardAsSouth,
  boardNoFor,
  challengeDeals,
  robotAuction,
  rotateHands,
} from '../../shared/challenge-deals.ts'
import { decodeDealSet, dealSetProblem, encodeDealSet } from '../../shared/deal-set.ts'

/** Best Hand, Just Declare and boards turned for 「用這副牌挑戰」 (C8, e7-t10, e7-t11, e7-t22) */

/** A small seeded generator, so every run deals the same boards */
function seeded(seed: number) {
  let s = seed
  return (n: number) => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s % n
  }
}

const hands = deal(seeded(7))

describe('rotateHands', () => {
  it('turns the table: the hand at `from` lands at `to`, the rest keep their order', () => {
    const turned = rotateHands(hands, 'E', 'S')
    expect(turned.S).toEqual(hands.E)
    expect(turned.W).toEqual(hands.S)
    expect(turned.N).toEqual(hands.W)
    expect(turned.E).toEqual(hands.N)
  })
})

describe('Best Hand (e7-t10)', () => {
  it('gives South the hand with the most points', () => {
    for (let i = 0; i < 50; i++) {
      const dealt = deal(seeded(i + 1))
      const turned = bestHand(dealt)
      expect(hcp(turned.S)).toBe(Math.max(...SEATS.map((s) => hcp(dealt[s]))))
    }
  })

  it('breaks ties by a fixed order: South, North, West, East', () => {
    const tie = (points: Record<string, number>) => {
      const fake = { N: [], E: [], S: [], W: [] } as Hands
      // A hand with n aces has 4n points
      const aces = ['SA', 'HA', 'DA', 'CA']
      let next = 0
      for (const seat of SEATS) for (let k = 0; k < points[seat]; k++) fake[seat].push(aces[next++])
      return bestHandSeat(fake)
    }
    expect(tie({ N: 1, E: 1, S: 0, W: 1 })).toBe('N')
    expect(tie({ N: 0, E: 1, S: 0, W: 1 })).toBe('W')
    expect(tie({ N: 1, E: 1, S: 1, W: 1 })).toBe('S')
    expect(tie({ N: 0, E: 2, S: 1, W: 1 })).toBe('E')
  })

  it('is the same for everyone: the deal set is made once', () => {
    const a = challengeDeals({ count: 4, bestHand: true, justDeclare: false, robotKind: 'gib' }, seeded(3))!
    const b = challengeDeals({ count: 4, bestHand: true, justDeclare: false, robotKind: 'gib' }, seeded(3))!
    expect(a).toEqual(b)
    for (const board of a.boards)
      expect(hcp(board.hands.S)).toBe(Math.max(...SEATS.map((s) => hcp(board.hands[s]))))
  })
})

describe('Just Declare (e7-t11)', () => {
  it('keeps only boards North-South declare, with the robots’ auction', () => {
    for (const robotKind of ['gib', 'tku'] as const) {
      const set = challengeDeals({ count: 8, bestHand: false, justDeclare: true, robotKind }, seeded(11))!
      expect(set.boards.map((b) => b.boardNo)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
      for (const board of set.boards) {
        const bid = robotAuction(robotKind, board.boardNo, board.hands, board.auction)
        expect(bid.phase).toBe('play')
        expect(['N', 'S']).toContain(bid.contract!.declarer)
        expect(bid.auction.map((c) => c.call)).toEqual(board.auction)
        expect(bid.auction.every((c) => c.robot)).toBe(true)
        // The robots bid it again the same way: TKB has no randomness
        expect(robotAuction(robotKind, board.boardNo, board.hands).auction).toEqual(bid.auction)
      }
      // Kept with the deal set, and read back
      expect(decodeDealSet(encodeDealSet(set))).toEqual(set)
    }
  })

  it('works with Best Hand too', () => {
    const set = challengeDeals({ count: 4, bestHand: true, justDeclare: true, robotKind: 'gib' }, seeded(5))!
    for (const board of set.boards) {
      expect(hcp(board.hands.S)).toBe(Math.max(...SEATS.map((s) => hcp(board.hands[s]))))
      expect(['N', 'S']).toContain(robotAuction('gib', board.boardNo, board.hands, board.auction).contract!.declarer)
    }
  })

  it('turns down a kept auction that is not legal or does not end in a contract', () => {
    const set = { boards: [{ boardNo: 1, hands, auction: ['P', 'P', 'P', 'P'] }] }
    expect(dealSetProblem(set)).toBe('boards.0.auction')
    expect(dealSetProblem({ boards: [{ boardNo: 1, hands, auction: ['1C', '1C'] }] })).toBe('boards.0.auction')
    expect(dealSetProblem({ boards: [{ boardNo: 1, hands, auction: ['1C', 'P', 'P', 'P'] }] })).toBeNull()
  })
})

describe('boards from the history turned to South (e7-t22)', () => {
  it('finds the board number of every dealer and vulnerability', () => {
    for (let n = 1; n <= 16; n++) expect(boardNoFor(dealerOf(n), vulnerabilityOf(n))).toBe(n)
  })

  it('keeps a South player’s board as it was', () => {
    expect(boardAsSouth({ boardNo: 5, hands, scoreNS: 420 }, 'S')).toEqual({ boardNo: 5, hands, scoreNS: 420 })
  })

  it('turns an East player’s board: dealer, vulnerability and score turn with them', () => {
    // Board 2: East deals, North-South vulnerable. East to South is a quarter turn clockwise
    const turned = boardAsSouth({ boardNo: 2, hands, scoreNS: -620 }, 'E')
    expect(turned.hands.S).toEqual(hands.E)
    expect(dealerOf(turned.boardNo)).toBe('S')
    expect(vulnerabilityOf(turned.boardNo)).toBe('EW')
    // East-West made 620: from South's side now, +620
    expect(turned.scoreNS).toBe(620)
  })

  it('turns a North player’s board half way: vulnerability stays, score stays', () => {
    // Board 1: North deals, nobody vulnerable
    const turned = boardAsSouth({ boardNo: 1, hands, scoreNS: 100 }, 'N')
    expect(turned.hands.S).toEqual(hands.N)
    expect(dealerOf(turned.boardNo)).toBe('S')
    expect(vulnerabilityOf(turned.boardNo)).toBe('None')
    expect(turned.scoreNS).toBe(100)
  })
})
