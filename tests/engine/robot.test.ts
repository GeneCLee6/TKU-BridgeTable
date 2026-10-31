import { describe, expect, it } from 'vitest'
import { contractOf, type AuctionCall } from '../../shared/auction.ts'
import { deal, type Vulnerability } from '../../shared/board.ts'
import { fullDeck, nextSeat, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { robotCall } from '../../shared/robot/robots.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { LIMITS, robotId, robotKindOf } from '../../shared/protocol.ts'
import { patternProblem } from '../../shared/robot/system/context.ts'
import { describe as words } from '../../shared/robot/system/describe.ts'
import { choose, explain } from '../../shared/robot/system/engine.ts'
import type { System } from '../../shared/robot/system/spec.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'
import { minorResponses } from '../../shared/robot/system/tku/minors.ts'
import { openingBook } from '../../shared/robot/system/tku/openings.ts'
import { supportDouble } from '../../shared/robot/system/tku/advancing.ts'
import { HEAVY_MS } from './heavy.ts'

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}

function robotBoard(boardNo: number, hands: Hands): BoardState {
  let state = newBoard(boardNo, hands)
  while (state.phase === 'auction') {
    const seat = turnOf(state)!
    const { call, alert } = robotCall('tku', state.hands[seat], seat, state.auction, state.dealer, state.vul)
    state = makeCall(state, seat, call, alert)
  }
  while (state.phase === 'play') {
    const seat = turnOf(state)!
    state = playCard(state, seat, chooseCard(state, seat))
  }
  return state
}

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

/** The robot's call after the given calls, the first by `dealer` */
function bidOver(cards: Card[], calls: string, dealer: Seat = 'N', vul: 'None' | 'Both' = 'None') {
  const auction: AuctionCall[] = calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
  return robotCall('tku', cards, nextSeat(dealer, auction.length), auction, dealer, vul).call
}

/**
 * The 300 boards, played once for both tests below (each board is bid and played to the end, which
 * is most of this file's time); pure CPU, hence HEAVY_MS (heavy.ts)
 */
let played: BoardState[] | undefined
const boards300 = () => (played ??= Array.from({ length: 300 }, (_, i) => robotBoard(i + 1, deal(seeded(i + 1)))))

describe('robots play 300 random boards', () => {
  it('legally, to the end, reaching sensible contracts', () => {
    const levels = new Map<string, number>()
    for (const state of boards300()) {
      expect(state.phase).toBe('finished')
      expect(state.auction.length).toBeLessThan(40)
      const c = contractOf(state.auction)
      const key = c ? `${c.level}` : 'passed'
      levels.set(key, (levels.get(key) ?? 0) + 1)
    }
    expect(levels.get('passed') ?? 0).toBeLessThan(60)
    expect((levels.get('3') ?? 0) + (levels.get('4') ?? 0)).toBeGreaterThan(50)
  }, HEAVY_MS)

  it('alerting and explaining every call but pass, as GIB does', () => {
    for (const [i, state] of boards300().entries()) {
      for (const entry of state.auction) {
        if (entry.call === 'P') expect(entry.alert).toBeUndefined()
        else {
          expect(entry.alert, `board ${i + 1}: ${entry.call}`).toBeTruthy()
          expect(entry.alert!.length).toBeLessThanOrEqual(LIMITS.alertMax)
        }
      }
    }
  }, HEAVY_MS)
})

describe('openings (淡江制度)', () => {
  it('1NT 15–17 without a five-card major', () => {
    expect(robotCall('tku', hand('AQ2 KJ3 Q54 K432'), 'N', [], 'N', 'None').call).toBe('1N')
    expect(robotCall('tku', hand('AQ2 KJ3 Q54 K432'), 'N', [], 'N', 'None').alert).toContain('15–17')
    // Five clubs is fine, five hearts is not
    expect(bidOver(hand('A2 KJ3 Q54 KQ432'), '')).toBe('1N')
    expect(bidOver(hand('A2 KJ432 Q54 KQ3'), '')).toBe('1H')
  })

  it('five-card majors and the better minor', () => {
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '')).toBe('1S')
    expect(bidOver(hand('A43 K43 Q543 K32'), '')).toBe('1D')
    expect(bidOver(hand('A32 K43 Q54 K432'), '')).toBe('1C')
  })

  it('5542: 1♦ promises four, 1♣ may be two', () => {
    const short = robotCall('tku', hand('AK32 KQ32 432 32'), 'N', [], 'N', 'None')
    expect(short).toMatchObject({ call: '1C', alert: expect.stringContaining('2+ 張♣') })
    expect(bidOver(hand('AK32 KQ32 Q432 2'), '')).toBe('1D')
    expect(robotCall('tku', hand('AKJ32 K43 Q54 32'), 'N', [], 'N', 'None').alert).toBe('5+ 張♠，12–21 大牌點')
  })

  it('2♦ is a weak two in one major (一高弱二)', () => {
    expect(bidOver(hand('32 KQJ943 54 432'), '')).toBe('2D')
    expect(bidOver(hand('KQJ943 32 54 432'), '')).toBe('2D')
    // Not with a good four-card other major; a poor one is fine
    expect(bidOver(hand('KQJ943 KJ32 54 2'), '')).toBe('P')
    expect(bidOver(hand('KQJ943 9832 54 2'), '')).toBe('2D')
  })

  it('2♥ and 2♠ are two-suiters, 5-5 and 5–10 points (社長 2026-10-25)', () => {
    // 2♥: hearts and any other suit; 2♠: spades and a minor
    expect(bidOver(hand('4 KJ974 83 AQ852'), '')).toBe('2H')
    expect(bidOver(hand('QJ932 QJ432 K2 2'), '')).toBe('2H')
    expect(bidOver(hand('QJ985 7 KQ963 42'), '')).toBe('2S')
    expect(robotCall('tku', hand('QJ985 7 KQ963 42'), 'N', [], 'N', 'None').alert).toBe('雙套：和一門低花，5+ 張♠，0–4 張♥，5–10 大牌點')
    expect(robotCall('tku', hand('4 KJ974 83 AQ852'), 'N', [], 'N', 'None').alert).toContain('和另一門 5 張以上的花色')
    // Not 5-4, not in fourth seat; a seven-card suit preempts
    expect(bidOver(hand('QJ985 7 KQ96 432'), '')).toBe('P')
    expect(bidOver(hand('4 KJ974 83 AQ852'), 'P P P', 'W')).toBe('P')
    expect(bidOver(hand('4 KJ97432 - AQ852'), '')).toBe('3H')
  })

  it('answers the two-suiters (技光的答叫)', () => {
    expect(bidOver(hand('8642 Q93 K852 73'), '2H P')).toBe('P')
    expect(bidOver(hand('K843 5 QJ84 T972'), '2H P')).toBe('2S')
    expect(bidOver(hand('KJ7 Q84 AJ63 T82'), '2H P')).toBe('3H')
    expect(bidOver(hand('A84 K93 AQ52 K73'), '2H P')).toBe('4H')
    expect(bidOver(hand('AKQJ75 4 A83 K92'), '2H P')).toBe('2N')
    expect(bidOver(hand('7 K84 Q9632 J852'), '2S P')).toBe('2N')
    expect(bidOver(hand('7 K84 Q9632 J852'), '2S P 2N P 3D P')).toBe('P')
    // Opener: the second suit after 2NT and after the pass-or-correct 2♠
    expect(bidOver(hand('5 QJ974 84 KJ963'), '2H P 2N P')).toBe('3C')
    expect(bidOver(hand('KJ852 AQ974 83 6'), '2H P 2N P')).toBe('3H')
    expect(bidOver(hand('Q9763 KJ852 7 43'), '2H P 2N P')).toBe('3S')
    expect(bidOver(hand('QJ863 KT975 5 82'), '2H P 2S P')).toBe('P')
    expect(bidOver(hand('6 KJ986 94 QT853'), '2H P 2S P')).toBe('3C')
    expect(bidOver(hand('AJ987 5 Q8743 42'), '2S P 2N P')).toBe('3D')
    expect(bidOver(hand('AKQJ75 4 A83 K92'), '2H P 2N P 3H P')).toBe('4S')
  })

  it('reads the two-suiters, not as weak twos', () => {
    const shown = (calls: string) => {
      const auction = calls.split(' ').map((call, i) => ({ seat: nextSeat('N', i), call }))
      return explain(TKU, auction.slice(0, -1), 'N', 'None').get(auction.at(-1)!.call)
    }
    expect(shown('2H')).toMatchObject({ name: 'twoSuiter', hcp: [5, 10], len: { H: [5, 13] } })
    expect(shown('2S')).toMatchObject({ name: 'twoSuiter', len: { S: [5, 13] } })
    expect(shown('2H P 2N P 3D')).toMatchObject({ len: { H: [5, 13], D: [5, 13] } })
  })

  it('4-4 in the minors opens 1♣, 5-5 1♦ (社長 2026-10-25)', () => {
    expect(bidOver(hand('K3 A52 KJ84 Q975'), '')).toBe('1C')
    expect(bidOver(hand('K3 A5 KJ842 Q9752'), '')).toBe('1D')
    expect(bidOver(hand('K3 A52 KJ842 Q97'), '')).toBe('1D')
  })

  it('no 1NT or 2NT with a five-card major unless the switch is on (社長 2026-10-25)', () => {
    expect(bidOver(hand('AKJ93 KQ4 AJ5 Q2'), '')).toBe('1S')
    expect(bidOver(hand('K4 AQ873 KJ5 Q62'), '')).toBe('1H')
    const withFive: System = { ...TKU, books: [openingBook(true), ...TKU.books] }
    expect(choose(withFive, hand('AKJ93 KQ4 AJ5 Q2'), 'N', [], 'N').call).toBe('2N')
    expect(choose(withFive, hand('K4 AQ873 KJ5 Q62'), 'N', [], 'N').call).toBe('1N')  })

  it('opens light in third seat with a good suit and by the Rule of 15 in fourth seat', () => {
    // Third seat: dealer W, W and N pass, E is third
    expect(bidOver(hand('AKJ94 873 Q52 94'), 'P P', 'W')).toBe('1S')
    expect(robotCall('tku', hand('AKJ94 873 Q52 94'), 'E', [{ seat: 'W', call: 'P' }, { seat: 'N', call: 'P' }], 'W', 'None').alert).toContain('10–21')
    expect(bidOver(hand('KJ942 Q73 Q52 Q4'), 'P P', 'W')).toBe('P')
    // Fourth seat: 10 points and five spades make 15; two spades do not
    expect(bidOver(hand('AQJ84 K73 952 95'), 'P P P', 'W')).toBe('1S')
    expect(bidOver(hand('95 K73 AQJ84 952'), 'P P P', 'W')).toBe('P')
    // First seat: 10 points do not open
    expect(bidOver(hand('AKJ94 873 Q52 94'), '')).toBe('P')
  })

  it('preempts by vulnerability, never in fourth seat', () => {
    expect(bidOver(hand('3 KQJ8642 832 T9'), '')).toBe('3H')
    expect(bidOver(hand('3 KQJ8642 832 T9'), 'P P P', 'W')).toBe('P')
    expect(bidOver(hand('KQJ943 32 54 432'), 'P P P', 'W')).toBe('P')
    expect(bidOver(hand('3 KQJ86432 83 T9'), '')).toBe('4H')
    // Vulnerable, the suit needs an honour; never two aces
    expect(bidOver(hand('3 JT98654 AT3 75'), '')).toBe('3H')
    expect(bidOver(hand('3 JT98654 AT3 75'), '', 'N', 'Both')).toBe('P')
    expect(bidOver(hand('A3 JT98654 A3 32'), '')).toBe('P')
  })
})

describe('answers to 1♣ / 1♦ (5542)', () => {
  it('weak jump shifts, new suits up the line, notrump by strength', () => {
    expect(bidOver(hand('KJ9843 32 543 32'), '1C P')).toBe('2S')
    expect(bidOver(hand('KJ98432 32 54 32'), '1C P')).toBe('3S')
    expect(bidOver(hand('KJ98432 32 54 32'), '1D P')).toBe('2S')
    expect(bidOver(hand('KJ32 QT43 54 Q32'), '1D P')).toBe('1H')
    expect(bidOver(hand('K32 Q43 KJ54 Q32'), '1C P')).toBe('1D')
    expect(bidOver(hand('K32 Q43 KJ5 Q432'), '1C P')).toBe('2N')
    expect(bidOver(hand('K32 A43 KJ5 Q432'), '1D P')).toBe('3N')
    expect(bidOver(hand('Q93 Q4 J54 K8432'), '1D P')).toBe('1N')
  })

  it('raises, 1♦–2♣ game forcing and 1♦–4♦', () => {
    expect(bidOver(hand('K3 Q43 A5 KQJ432'), '1D P')).toBe('2C')
    expect(bidOver(hand('K3 Q4 KJ543 Q432'), '1D P')).toBe('3D')
    expect(bidOver(hand('93 Q4 KJ543 8432'), '1D P')).toBe('2D')
    expect(bidOver(hand('3 Q4 KJ6543 8432'), '1D P')).toBe('4D')
    expect(bidOver(hand('93 Q4 J54 KJ8432'), '1C P')).toBe('2C')
    expect(bidOver(hand('93 A4 J54 KQ8432'), '1C P')).toBe('3C')
    // Opener passes a weak jump shift
    expect(bidOver(hand('AK2 KQ3 Q54 5432'), '1C P 2S P')).toBe('P')
  })

  it('has inverted minor raises as an option', () => {
    const inverted: System = { id: 'tku', firstFit: true, books: [minorResponses('C', true)] }
    const auction: AuctionCall[] = [
      { seat: 'N', call: '1C' },
      { seat: 'E', call: 'P' },
    ]
    expect(choose(inverted, hand('93 A4 J54 KQ8432'), 'S', auction, 'N').call).toBe('2C')
    expect(choose(inverted, hand('93 Q4 J54 KJ8432'), 'S', auction, 'N').call).toBe('3C')
  })
})

describe('opener’s rebid (開叫1♣／1♦之後續發展、1NT迫叫之後)', () => {
  it('shows minimum, invitational and game-forcing hands after 1♣ / 1♦', () => {
    expect(bidOver(hand('K5 AJ84 Q3 K9432'), '1C P 1H P')).toBe('2H')
    expect(bidOver(hand('K5 AJ84 Q3 AQ432'), '1C P 1H P')).toBe('3H')
    expect(bidOver(hand('AK54 KJ 5 AKJ432'), '1C P 1S P')).toBe('4D')
    expect(bidOver(hand('A5 K3 AQ54 KJ432'), '1C P 1S P')).toBe('2D')
    expect(bidOver(hand('A5 K3 AQ54 AKJ32'), '1C P 1S P')).toBe('3D')
    expect(bidOver(hand('A54 KQ3 AJ5 KQ43'), '1C P 1S P')).toBe('2N')
    expect(bidOver(hand('A4 AQ32 KQJ54 32'), '1D P 1S P')).toBe('2H')
    expect(bidOver(hand('Q4 K3 AKJ54 Q543'), '1D P 1S P')).toBe('2C')
    expect(bidOver(hand('A54 AQ3 KJ654 43'), '1D P 2C P')).toBe('2N')
    // The reverse is explained as one
    const auction: AuctionCall[] = ['1D', 'P', '1S', 'P'].map((call, i) => ({ seat: nextSeat('N', i), call }))
    expect(robotCall('tku', hand('A4 AQ32 KQJ54 32'), 'N', auction, 'N', 'None').alert).toContain('反序')
  })

  it('after 1NT forcing: 2NT and 3♠ invite, 2♠ is a reverse, 3NT 19–21', () => {
    expect(bidOver(hand('AQ543 K3 AJ5 K43'), '1S P 1N P')).toBe('2N')
    expect(bidOver(hand('AQ5432 K3 AJ5 K4'), '1S P 1N P')).toBe('3S')
    expect(bidOver(hand('AK53 AQ543 A5 43'), '1H P 1N P')).toBe('2S')
    expect(bidOver(hand('K3 AQ543 AJ5 KQ4'), '1H P 1N P')).toBe('3N')
    expect(bidOver(hand('AQ543 K3 Q5 K432'), '1S P 2D P')).toBe('2S')
  })
})

describe('responder’s rebid (新低花迫叫、第四門新花、倒叫之後)', () => {
  it('new minor forcing and the answers', () => {
    expect(bidOver(hand('KQ953 A84 Q52 J3'), '1C P 1S P 1N P')).toBe('2D')
    expect(bidOver(hand('KQ953 A84 Q52 J3'), '1D P 1S P 1N P')).toBe('2C')
    expect(bidOver(hand('KQ953 Q84 J52 43'), '1C P 1S P 1N P')).toBe('2S')
    expect(bidOver(hand('A84 KQ3 KJ5 Q543'), '1C P 1S P 1N P 2D P')).toBe('2S')
    expect(bidOver(hand('A8 KQ43 J54 Q543'), '1C P 1S P 1N P 2D P')).toBe('2H')
    expect(bidOver(hand('KQ953 A84 J52 43'), '1C P 1S P 1N P 2D P 2S P')).toBe('3S')
  })

  it('fourth suit forcing, preference, and the 2NT relay after a reverse', () => {
    expect(bidOver(hand('853 AQ953 KQ5 J3'), '1D P 1H P 1S P')).toBe('2C')
    expect(bidOver(hand('AQ8 KJ5 AK654 3'), '1D P 1S P 2C P 2H P')).toBe('2S')
    expect(bidOver(hand('KQ953 Q84 J52 43'), '1D P 1S P 2C P')).toBe('2D')
    expect(bidOver(hand('KQ53 84 J52 Q432'), '1D P 1S P 2H P')).toBe('2N')
    expect(bidOver(hand('AQ8 KJ5 AK654 3'), '1D P 1S P 2H P 2N P')).toBe('3C')
    expect(bidOver(hand('KQ53 84 J52 Q432'), '1D P 1S P 2H P 2N P 3C P')).toBe('3D')
  })
})

describe('2♣ strong (開叫2♣)', () => {
  it('2♥ is 0–3 points, 2♦ waiting otherwise; opener shows notrump by strength', () => {
    expect(bidOver(hand('8642 973 T852 J4'), '2C P')).toBe('2H')
    expect(bidOver(hand('KQ642 A73 T85 J4'), '2C P')).toBe('2D')
    expect(bidOver(hand('AK5 AQ3 AKJ5 Q43'), '2C P 2D P')).toBe('2N')
    expect(bidOver(hand('AKQ32 KQ5 AK5 A3'), '2C P 2D P')).toBe('3N')
  })

  it('responder after opener’s major: fit with values, sign-off, splinter, own suit, 2NT', () => {
    expect(bidOver(hand('J9432 85 Q32 K43'), '2C P 2D P 2S P')).toBe('3S')
    expect(bidOver(hand('943 85 Q32 Q5432'), '2C P 2D P 2S P')).toBe('4S')
    expect(bidOver(hand('J943 8 Q32 K5432'), '2C P 2D P 2S P')).toBe('4H')
    expect(bidOver(hand('94 QJ853 Q32 J54'), '2C P 2D P 2S P')).toBe('3H')
    expect(bidOver(hand('94 Q853 Q32 J543'), '2C P 2D P 2S P')).toBe('2N')
  })
})

describe('after 1NT', () => {
  it('Stayman, transfers, Texas, minor ask and invitations', () => {
    expect(bidOver(hand('KJ32 Q43 Q54 Q32'), '1N P')).toBe('2C')
    expect(bidOver(hand('32 QJ432 J54 432'), '1N P')).toBe('2D')
    expect(bidOver(hand('QJ432 32 J54 432'), '1N P')).toBe('2H')
    expect(bidOver(hand('KQJ432 32 K54 Q2'), '1N P')).toBe('4H')
    expect(bidOver(hand('2 32 J54 QJ86432'), '1N P')).toBe('2S')
    expect(bidOver(hand('K32 Q43 J54 Q432'), '1N P')).toBe('2N')
    expect(bidOver(hand('K32 Q43 K54 Q432'), '1N P')).toBe('3N')
  })

  it('opener completes transfers, super-accepting with four trumps and 17', () => {
    expect(bidOver(hand('AQ2 KJ3 Q54 K432'), '1N P 2D P')).toBe('2H')
    expect(bidOver(hand('AQ2 KJ32 KQ5 Q32'), '1N P 2D P')).toBe('3H')
    expect(bidOver(hand('AQ2 KJ32 Q54 K43'), '1N P 2C P')).toBe('2H')
    expect(bidOver(hand('AQ2 KJ3 Q54 K432'), '1N P 2C P')).toBe('2D')
    expect(bidOver(hand('AQ2 KJ3 Q54 K432'), '1N P 2S P')).toBe('3C')
  })

  it('responder places the contract after a transfer', () => {
    expect(bidOver(hand('32 QJ432 J54 432'), '1N P 2D P 2H P')).toBe('P')
    expect(bidOver(hand('32 KJ432 K54 Q32'), '1N P 2D P 2H P')).toBe('2N')
    expect(bidOver(hand('32 KJ432 K54 K32'), '1N P 2D P 2H P')).toBe('3N')
  })

  it('uses Lebensohl after an overcall', () => {
    // Weak five-card suit: 2-level, not forcing
    expect(bidOver(hand('KJ432 32 J54 432'), '1N 2D')).toBe('2S')
    // Game values: five-card suit GF at the three level; stopper 2NT relay; no stopper 3NT
    expect(bidOver(hand('K32 Q43 54 KQJ32'), '1N 2D')).toBe('3C')
    expect(bidOver(hand('K32 Q43 KJ5 Q432'), '1N 2D')).toBe('2N')
    expect(bidOver(hand('K32 Q432 54 KQJ2'), '1N 2D')).toBe('3N')
    // Four of their suit and values: penalty double
    expect(bidOver(hand('K32 Q4 KJ54 Q432'), '1N 2D')).toBe('X')
    expect(bidOver(hand('AQ2 KJ3 Q54 K432'), '1N 2D 2N P')).toBe('3C')
  })
})

describe('after 1♥ / 1♠', () => {
  it('Bergen raises with four trumps (松濤版)', () => {
    expect(bidOver(hand('KJ32 Q43 J54 A32'), '1S P')).toBe('3C')
    expect(bidOver(hand('KJ32 Q43 Q54 432'), '1S P')).toBe('3D')
    expect(bidOver(hand('KJ32 J43 54 5432'), '1S P')).toBe('3H')
    expect(bidOver(hand('Q432 J43 54 5432'), '1S P')).toBe('3S')
    expect(bidOver(hand('Q43 KJ32 J54 A32'), '1H P')).toBe('2N')
    expect(bidOver(hand('Q43 KJ32 Q54 432'), '1H P')).toBe('3C')
  })

  it('J2N with game values and splinters with 12–13 and a singleton', () => {
    expect(bidOver(hand('KJ32 AQ3 K54 432'), '1S P')).toBe('2N')
    expect(bidOver(hand('Q43 KJ32 AK4 432'), '1H P')).toBe('2S')
    expect(bidOver(hand('KJ32 AQ43 K543 2'), '1S P')).toBe('4C')
  })

  it('three-card single raise, 1NT forcing and 2/1', () => {
    expect(bidOver(hand('K32 Q43 J54 Q432'), '1S P')).toBe('2S')
    expect(bidOver(hand('32 KQ43 J54 Q432'), '1S P')).toBe('1N')
    expect(bidOver(hand('32 KQ4 AJ543 Q32'), '1S P')).toBe('2D')
    expect(bidOver(hand('KQ43 32 J54 Q432'), '1H P')).toBe('1S')
    // 2/1 is a game force; 4♥ to play with five trumps, a singleton and a weak hand
    expect(robotCall('tku', hand('32 KQ4 AJ543 Q32'), 'S', [{ seat: 'N', call: '1S' }, { seat: 'E', call: 'P' }], 'N', 'None').alert).toContain('迫叫成局')
    expect(bidOver(hand('3 Q8432 K8432 32'), '1H P')).toBe('4H')
  })

  it('opener judges Bergen and the single raise', () => {
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '1S P 3C P')).toBe('3S')
    // Game values ask where responder is short (e5-t37, Bergen加叫（松濤版）: 3♦ 14+)
    expect(bidOver(hand('AKJ32 K43 AQ4 32'), '1S P 3C P')).toBe('3D')
    // 16 points after a single raise: the club's long-suit try
    expect(bidOver(hand('AKJ32 K43 Q54 A2'), '1S P 2S P')).toBe('3D')
    expect(bidOver(hand('AKJ32 K43 Q54 32'), '1S P 2S P')).toBe('P')
  })

  it('defends against Unusual 2NT the club way', () => {
    // 1♥ (2NT): 3♣ shows a heart fit and invitational values; 3♦ five spades and game values
    expect(bidOver(hand('K32 Q43 KJ5 Q432'), '1H 2N')).toBe('3C')
    expect(bidOver(hand('AKJ32 43 KJ5 Q32'), '1H 2N')).toBe('3D')
    // 1♠ (2NT): 3♦ shows a spade fit; 3♣ five hearts and game values
    expect(bidOver(hand('K32 Q43 KJ5 Q432'), '1S 2N')).toBe('3D')
    expect(bidOver(hand('43 AKJ32 KJ5 Q32'), '1S 2N')).toBe('3C')
  })
})

describe('competition', () => {
  it('overcalls, doubles for takeout and uses Unusual 2NT', () => {
    expect(bidOver(hand('AQJ32 K43 54 432'), '1D')).toBe('1S')
    expect(bidOver(hand('AQ32 K432 5 KJ32'), '1D')).toBe('X')
    expect(bidOver(hand('32 K43 Q54 J9432'), '1D')).toBe('P')
    expect(bidOver(hand('2 3 KJ543 QJ5432'), '1S')).toBe('2N')
  })

  it('makes a responsive double after partner’s takeout double is raised', () => {
    // 1♣ (X) 2♣: both majors, 6–11
    expect(bidOver(hand('KJ32 Q432 J54 32'), '1C X 2C')).toBe('X')
    // 1♥ (X) 2♥: both minors
    expect(bidOver(hand('32 43 KJ54 Q5432'), '1H X 2H')).toBe('X')
  })

  it('answers 2♦ pass-or-correct and the 2NT ask', () => {
    expect(bidOver(hand('K32 Q43 J54 Q432'), '2D P')).toBe('2H')
    expect(bidOver(hand('AK2 KQ3 A54 Q432'), '2D P')).toBe('2N')
    expect(bidOver(hand('32 KQJ943 54 432'), '2D P 2N P')).toBe('3C')
    expect(bidOver(hand('KQJ943 32 A4 432'), '2D P 2N P')).toBe('3H')
    expect(bidOver(hand('KQJ943 32 54 432'), '2D P 2H P')).toBe('2S')
  })
})

describe('competitive bidding (競叫篇與技光、賭倍性叫品、CAPP)', () => {
  const at = (cards: Card[], calls: string, dealer: Seat, vul: Vulnerability) => {
    const auction: AuctionCall[] = calls
      .split(' ')
      .filter(Boolean)
      .map((call, i) => ({ seat: nextSeat(dealer, i), call }))
    return robotCall('tku', cards, nextSeat(dealer, auction.length), auction, dealer, vul)
  }
  const meaning = (calls: string, call: string, dealer: Seat = 'N') => {
    const auction: AuctionCall[] = calls
      .split(' ')
      .filter(Boolean)
      .map((c, i) => ({ seat: nextSeat(dealer, i), call: c }))
    return words(explain(TKU, auction, dealer).get(call)!, 'zh')
  }

  it('overcalls by level, jumps weak, cue-bids Michaels and overcalls 1NT (e5-t30)', () => {
    expect(bidOver(hand('KQJ85 A73 84 932'), '1D')).toBe('1S')
    // Two levels need 10 and a good suit
    expect(bidOver(hand('A2 85 KQJ84 A932'), '1H')).toBe('2D')
    expect(bidOver(hand('A2 85 J9842 K932'), '1H')).toBe('P')
    expect(bidOver(hand('KJT854 K3 84 932'), '1D')).toBe('2S')
    expect(bidOver(hand('AQJ85 KQT74 84 9'), '1C')).toBe('2C')
    expect(bidOver(hand('KQJ85 3 84 AJ932'), '1H')).toBe('2H')
    expect(bidOver(hand('KQ8 A73 K84 KJ32'), '1D')).toBe('1N')
    // 16+ doubles first whatever the shape (強力型)
    expect(bidOver(hand('8 AKJ73 KQJ3 Q92'), '1S')).toBe('X')
    expect(meaning('1C', '2C')).toMatch(/^Michaels 扣叫：兩門高花/)
    expect(meaning('1D', '2S')).toMatch(/^弱跳蓋叫/)
  })

  it('balances in the pass-out seat (平衡叫)', () => {
    expect(bidOver(hand('AQ85 73 K843 Q92'), '1H P P')).toBe('X')
    expect(bidOver(hand('KJ94 73 Q843 J92'), '1H P P')).toBe('1S')
    expect(bidOver(hand('KQ8 K73 A84 J932'), '1H P P')).toBe('1N')
    expect(bidOver(hand('AQJ984 84 K3 K32'), '1H P P')).toBe('2S')
    // Long in their suit: no balancing (敵花長，不應平衡)
    expect(bidOver(hand('A2 KJ953 Q84 932'), '1H P P')).toBe('P')
    expect(bidOver(hand('KQ874 42 A82 T76'), '1H P 2H P P')).toBe('2S')
    expect(bidOver(hand('KQ87 42 A82 T765'), '1H P 2H P P')).toBe('X')
  })

  it('advances partner’s overcall and the overcaller answers the cue bid (e5-t31)', () => {
    expect(bidOver(hand('K98 Q73 K843 J92'), '1D 1S P')).toBe('2S')
    expect(bidOver(hand('K985 Q73 K843 A2'), '1D 1S P')).toBe('3D')
    expect(bidOver(hand('AQ8 K73 A843 J92'), '1D 1S P')).toBe('2D')
    expect(bidOver(hand('98 Q73 KJ84 A932'), '1D 1S P')).toBe('1N')
    expect(bidOver(hand('Q9842 73 84 9532'), '1D 1S P')).toBe('4S')
    expect(bidOver(hand('Q984 73 842 9532'), '1D 1S P')).toBe('3S')
    expect(meaning('1D 1S P', '2D')).toMatch(/^扣叫：13\+ 大牌點，迫叫一圈/)
    // The overcaller: minimum rebids the suit, more jumps, six cards and 12+ bid game
    expect(bidOver(hand('KQJ72 J4 83 Q962'), '1D 1S P 2D P')).toBe('2S')
    expect(bidOver(hand('AKQ72 J4 83 K962'), '1D 1S P 2D P')).toBe('3S')
    expect(bidOver(hand('AKQ972 J4 83 K96'), '1D 1S P 2D P')).toBe('4S')
    expect(bidOver(hand('AKQ72 QJ4 83 K96'), '1D 1S P 3D P')).toBe('4S')
    expect(bidOver(hand('KQ972 J4 83 Q96'), '1D 1S P 3D P')).toBe('3S')
  })

  it('answers a takeout double and the doubler bids again (e5-t32)', () => {
    expect(bidOver(hand('T4 9863 9762 753'), '1D X P')).toBe('1H')
    expect(bidOver(hand('QT97 64 764 9763'), '1S X P')).toBe('2C')
    expect(bidOver(hand('94 KJT8 7542 AQ9'), '1D X P')).toBe('2H')
    expect(bidOver(hand('Q2 K832 AT72 A92'), '1D X P')).toBe('2D')
    expect(bidOver(hand('Q32 Q5 KJ74 9742'), '1D X P')).toBe('1N')
    // Leaving the double in: five good trumps (處罰性 Pass)
    expect(bidOver(hand('32 K4 KQJ94 9732'), '1D X P')).toBe('P')
    // A free bid after their bid needs 7 at the one level
    expect(bidOver(hand('T4 Q863 9762 753'), '1D X 1S')).toBe('P')
    expect(bidOver(hand('T4 KQ63 Q762 J53'), '1D X 1S')).toBe('2H')
    // The doubler: 16–18 raises once, 19–21 jumps, a strong double names its suit
    expect(bidOver(hand('AQ8 KJ73 KJ84 Q2'), '1D X P 1H P')).toBe('2H')
    expect(bidOver(hand('AK8 KQ73 KJ84 A2'), '1D X P 1H P')).toBe('3H')
    expect(bidOver(hand('8 AKJ73 KQJ3 Q92'), '1S X P 2C P')).toBe('2H')
    expect(bidOver(hand('AQ8 K73 AJ84 KQ2'), '1D X P 1H P')).toBe('1N')
    expect(bidOver(hand('AQ8 K73 A984 K32'), '1D X P 1H P')).toBe('P')
    // After the cue bid: a four-card major
    expect(bidOver(hand('AQ85 KJ73 4 Q932'), '1D X P 2D P')).toBe('2H')
  })

  it('has the support double as an option (the handbook does not have it)', () => {
    const auction: AuctionCall[] = [
      { seat: 'N', call: '1C' },
      { seat: 'E', call: 'P' },
      { seat: 'S', call: '1H' },
      { seat: 'W', call: '1S' },
    ]
    const withIt: System = { ...TKU, books: [supportDouble(true), ...TKU.books] }
    expect(choose(withIt, hand('K2 Q73 A84 KJ932'), 'N', auction, 'N').call).toBe('X')
    expect(words(explain(withIt, auction, 'N').get('X')!, 'zh')).toMatch(/^支持性賭倍/)
    expect(choose(TKU, hand('K2 Q73 A84 KJ932'), 'N', auction, 'N').call).not.toBe('X')
  })

  it('competes to the level of its trumps, sacrifices by vulnerability and doubles for penalty (e5-t33)', () => {
    expect(bidOver(hand('AQJ984 K2 84 Q32'), '1S P 2S 3H')).toBe('3S')
    expect(bidOver(hand('AQJ98 K32 84 Q32'), '1S P 2S 3H')).toBe('P')
    expect(at(hand('74 QJ842 K8732 5'), '1S 2H 4S', 'E', 'EW').call).toBe('5H')
    expect(at(hand('74 QJ842 K8732 5'), '1S 2H 4S', 'E', 'None').call).toBe('5H')
    expect(at(hand('74 QJ842 K8732 5'), '1S 2H 4S', 'E', 'NS').call).toBe('P')
    expect(at(hand('74 QJ842 K8732 5'), '1S 2H 4S', 'E', 'Both').call).toBe('P')
    expect(bidOver(hand('KJ94 A2 AJ984 82'), '1D 1S 1N 2S')).toBe('X')
    expect(meaning('1D 1S 1N 2S', 'X')).toMatch(/^處罰性賭倍/)
    // Partner's penalty double stands
    expect(bidOver(hand('Q3 KJ8762 Q3 J32'), '1D 1S 1N 2S X P')).toBe('P')
  })

  it('defends against weak twos and preempts, with Lebensohl (e5-t34)', () => {
    expect(bidOver(hand('AQ8 KJ3 KJ84 Q32'), '2H')).toBe('2N')
    expect(bidOver(hand('AKQ874 A3 K84 32'), '2H')).toBe('3S')
    expect(bidOver(hand('AJ85 3 KQ84 K932'), '2H')).toBe('X')
    expect(bidOver(hand('A2 K3 KQJ84 9532'), '2S')).toBe('3D')
    expect(bidOver(hand('AK8 73 Q83 KQJ62'), '3H')).toBe('X')
    expect(bidOver(hand('AK3 AQ84 KJ3 Q92'), '4S')).toBe('X')
    expect(meaning('4S', 'X')).toMatch(/^處罰性賭倍/)
    // Lebensohl: 2NT relays to 3♣, then the suit (pass with clubs)
    expect(bidOver(hand('985 73 Q8432 J32'), '2H X P')).toBe('2N')
    expect(bidOver(hand('AQ85 K2 KQ84 932'), '2H X P 2N P')).toBe('3C')
    expect(bidOver(hand('985 73 Q8432 J32'), '2H X P 2N P 3C P')).toBe('3D')
    expect(bidOver(hand('985 73 J32 Q8432'), '2H X P 2N P 3C P')).toBe('P')
    expect(bidOver(hand('A985 73 Q8432 Q2'), '2H X P')).toBe('2S')
    expect(bidOver(hand('A985 73 K8432 K2'), '2H X P')).toBe('3S')
    expect(bidOver(hand('AK85 73 K8432 K2'), '2H X P')).toBe('4S')
    // 一高弱二: 12–15 balanced doubles
    expect(bidOver(hand('AQ8 K73 Q984 K32'), '2D')).toBe('X')
  })

  it('uses Cappelletti over 1NT (e5-t38)', () => {
    expect(bidOver(hand('T8 K75 AKJ832 74'), '1N')).toBe('2C')
    expect(bidOver(hand('AQJ7 AKQ74 75 Q8'), '1N')).toBe('X')
    expect(bidOver(hand('QJT97 AKQ74 5 82'), '1N')).toBe('2D')
    expect(bidOver(hand('AQJ85 73 84 KQ93'), '1N')).toBe('2S')
    expect(bidOver(hand('K5 3 QJ984 KJ932'), '1N')).toBe('2N')
    expect(meaning('1N', '2C')).toMatch(/^Cappelletti：一門長套/)
    expect(meaning('1N', '2D')).toMatch(/^Cappelletti：兩門高花/)
    // Advancing: relay to 2♦, the better major, pass or correct
    expect(bidOver(hand('T84 Q73 K843 932'), '1N 2C P')).toBe('2D')
    expect(bidOver(hand('9854 Q73 K843 92'), '1N 2D P')).toBe('2S')
    expect(bidOver(hand('KQJ5 Q32 84 9532'), '1N 2H P')).toBe('P')
    expect(bidOver(hand('KQ5 3 Q8432 9543'), '1N 2H P')).toBe('3C')
    // The Cappelletti bidder: names the suit, passes 2♦ with diamonds, corrects 3♣ to 3♦
    expect(bidOver(hand('K8 AQJ984 Q2 974'), '1N 2C P 2D P')).toBe('2H')
    expect(bidOver(hand('T8 K75 AKJ832 74'), '1N 2C P 2D P')).toBe('P')
    expect(bidOver(hand('3 AQJ84 KJ932 K5'), '1N 2H P 3C P')).toBe('3D')
    // Michaels and its 2NT ask
    expect(bidOver(hand('K93 72 QJ84 9532'), '1H 2H P')).toBe('2S')
    expect(bidOver(hand('93 Q72 QJ84 K532'), '1H 2H P')).toBe('2N')
    expect(bidOver(hand('KQJ85 3 AJ932 84'), '1H 2H P 2N P')).toBe('3D')
  })
})

describe('the club’s rules in the system engine', () => {
  /** What the club's robot partner reads from `call` made after these calls */
  const reads = (calls: string, call: string, lang: 'zh' | 'en' = 'zh') => {
    const auction = calls
      .split(' ')
      .filter(Boolean)
      .map((c, i) => ({ seat: nextSeat('N', i), call: c }))
    const spec = explain(TKU, auction, 'N').get(call)
    return spec ? words(spec, lang) : undefined
  }

  it('write every auction pattern with the opponents in the right places', () => {
    for (const book of TKU.books) {
      const after = book.after === undefined ? [] : typeof book.after === 'string' ? [book.after] : book.after
      for (const pattern of after) expect(patternProblem(pattern), pattern).toBeNull()
    }
  })

  it('explain each call for the bidding box hints, in every language', () => {
    expect(reads('1S P', '3C')).toBe('Bergen 加叫：4+ 張♠，10–11 大牌點')
    expect(reads('1S P', '2N')).toBe('J2N：3+ 張♠，12+ 大牌點，迫叫成局')
    expect(reads('1N P', '2D')).toBe('轉換：轉到♥，5+ 張♥')
    expect(reads('1N P', '2C', 'en')).toBe('Stayman: holds a 4+ card major; asks for a 4-card major; 9+ HCP; forcing')
    expect(reads('', '2D')).toBe('一高弱二：6–10 大牌點')
    expect(reads('1H 2N', '3C')).toContain('對抗不尋常 2NT')
    expect(reads('1H X 2H', 'X')).toBe('回答性賭倍：兩門低花，6–11 大牌點')
    expect(reads('1N P', 'P')).toBe('0–7 大牌點')
    // A call no rule makes means nothing in particular to the robot
    expect(reads('1N P', '5C')).toBeUndefined()
  })

  it('keep what each robot call shows, for the alert in each viewer’s language', () => {
    const bid = robotCall('tku', hand('KJ32 Q43 J54 A32'), 'S', [{ seat: 'N', call: '1S' }, { seat: 'E', call: 'P' }], 'N', 'None')
    expect(bid.call).toBe('3C')
    expect(bid.alert).toBe('Bergen 加叫：4+ 張♠，10–11 大牌點')
    expect(words(bid.meaning!, 'en')).toBe('Bergen raise: 4+ ♠; 10–11 HCP')
  })

  it('read partner’s calls with the same rules in the later rounds', () => {
    // 1NT–2♥ (transfer) 2♠ 2NT (five spades, 8–9): opener with 15 and three spades invites in spades
    expect(bidOver(hand('KJ93 Q6 K54 AQ98'), '1N P 2H P 2S P 2N P')).toBe('3S')
  })
})

describe('card play', () => {
  it('follows suit on every trick of an extreme deal', () => {
    const hands: Hands = {
      N: fullDeck().filter((c) => c[0] === 'S'),
      E: fullDeck().filter((c) => c[0] === 'H'),
      S: fullDeck().filter((c) => c[0] === 'D'),
      W: fullDeck().filter((c) => c[0] === 'C'),
    }
    expect(robotBoard(1, hands).phase).toBe('finished')
  })
})

describe('robot ids', () => {
  it('carry the system TKB bids, and read every id saved before', () => {
    expect(robotId('gib', 'E')).toBe('robot:gib:E')
    expect(robotKindOf(robotId('tku', 'S'))).toBe('tku')
    // Before the 2/1 robot: the club's system
    expect(robotKindOf('robot:N')).toBe('tku')
    // When robots had levels: any level is TKB
    expect(robotKindOf('robot:gib:beginner:N')).toBe('gib')
    expect(robotKindOf('robot:tku:open:W')).toBe('tku')
  })
})
