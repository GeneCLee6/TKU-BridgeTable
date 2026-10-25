import { describe, expect, it } from 'vitest'
import { contractOf, type AuctionCall } from '../../shared/auction.ts'
import { deal } from '../../shared/board.ts'
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

describe('robots play 300 random boards', () => {
  it('legally, to the end, reaching sensible contracts', () => {
    const levels = new Map<string, number>()
    for (let seed = 1; seed <= 300; seed++) {
      const state = robotBoard(seed, deal(seeded(seed)))
      expect(state.phase).toBe('finished')
      expect(state.auction.length).toBeLessThan(40)
      const c = contractOf(state.auction)
      const key = c ? `${c.level}` : 'passed'
      levels.set(key, (levels.get(key) ?? 0) + 1)
    }
    expect(levels.get('passed') ?? 0).toBeLessThan(60)
    expect((levels.get('3') ?? 0) + (levels.get('4') ?? 0)).toBeGreaterThan(50)
  })

  it('alerting and explaining every call but pass, as GIB does', () => {
    for (let seed = 1; seed <= 300; seed++) {
      for (const entry of robotBoard(seed, deal(seeded(seed))).auction) {
        if (entry.call === 'P') expect(entry.alert).toBeUndefined()
        else {
          expect(entry.alert, `board ${seed}: ${entry.call}`).toBeTruthy()
          expect(entry.alert!.length).toBeLessThanOrEqual(LIMITS.alertMax)
        }
      }
    }
  })
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
    expect(bidOver(hand('AKJ32 K43 AQ4 32'), '1S P 3C P')).toBe('4S')
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
    expect(reads('1N P', '2C', 'en')).toBe('Stayman: asks for a 4-card major; 9+ HCP; forcing')
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
