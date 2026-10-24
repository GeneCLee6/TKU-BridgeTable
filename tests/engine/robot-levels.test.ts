import { describe, expect, it } from 'vitest'
import { contractOf, type AuctionCall } from '../../shared/auction.ts'
import { deal } from '../../shared/board.ts'
import { nextSeat, rankOf, rankValue, SEATS, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { robotId, robotKindOf, robotLevelOf, type RobotKind, type RobotLevel } from '../../shared/protocol.ts'
import { LEVEL_PARAMS, paramsOf, usesRule } from '../../shared/robot/levels.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { TableReading } from '../../shared/robot/reading.ts'
import { robotCall } from '../../shared/robot/robots.ts'
import { GIB } from '../../shared/robot/system/gib/index.ts'
import { TKU } from '../../shared/robot/system/tku/index.ts'

/** Robot levels (e6-t18, e6-t19, ROBOT.md §7) */

const KINDS: RobotKind[] = ['tku', 'gib']

function seeded(seed: number) {
  return (n: number) => {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
    return seed % n
  }
}

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

function hands(given: Record<Seat, string>): Hands {
  const out = {} as Hands
  for (const seat of SEATS) out[seat] = hand(given[seat])
  expect(new Set(SEATS.flatMap((s) => out[s])).size).toBe(52)
  return out
}

/** The robot's call after the given calls, North dealing */
function bidOver(kind: RobotKind, level: RobotLevel, cards: string, calls: string) {
  const auction: AuctionCall[] = calls
    .split(' ')
    .filter(Boolean)
    .map((call, i) => ({ seat: nextSeat('N', i), call }))
  return robotCall(kind, hand(cards), nextSeat('N', auction.length), auction, 'N', 'None', level).call
}

/** Board 3 (South deals) after the given calls and cards ('low' plays the lowest legal card) */
function board(cards: Hands, calls: string, played: string[] = []): BoardState {
  let state = newBoard(3, cards)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of played) {
    const seat = turnOf(state)!
    const lowest = () => [...legalCards(state, seat)].sort((a, b) => rankValue(rankOf(a)) - rankValue(rankOf(b)))[0]
    state = playCard(state, seat, card === 'low' ? lowest() : card)
  }
  return state
}

function robotBoard(boardNo: number, cards: Hands, kind: RobotKind, level: RobotLevel): BoardState {
  let state = newBoard(boardNo, cards)
  while (state.phase === 'auction') {
    const seat = turnOf(state)!
    const { call, alert } = robotCall(kind, state.hands[seat], seat, state.auction, state.dealer, state.vul, level)
    state = makeCall(state, seat, call, alert)
  }
  while (state.phase === 'play') {
    const seat = turnOf(state)!
    state = playCard(state, seat, chooseCard(state, seat, kind, paramsOf(level)))
  }
  return state
}

describe('the robot levels (e6-t18)', () => {
  it('describe each level with the PRD parameters; 大專 is the robot as it was', () => {
    expect(LEVEL_PARAMS.college).toMatchObject({ system: 'college', inference: true, signals: true, play: 'rules', thinkMs: 0 })
    expect(LEVEL_PARAMS.beginner).toMatchObject({ system: 'beginner', inference: false, signals: false })
    expect(LEVEL_PARAMS.open.thinkMs).toBeLessThanOrEqual(1000)
    expect(LEVEL_PARAMS.master).toMatchObject({ play: 'simulation', errorRate: 0, thinkMs: 2000 })
    // Mistakes get rarer level by level (used from e6-t21)
    const rates = (['beginner', 'college', 'open', 'master'] as const).map((l) => LEVEL_PARAMS[l].errorRate)
    expect([...rates].sort((a, b) => b - a)).toEqual(rates)
    // 自訂 starts from 大專 with the teacher's changes
    expect(paramsOf('custom', { signals: false })).toEqual({ ...LEVEL_PARAMS.college, signals: false })
    expect(paramsOf()).toBe(LEVEL_PARAMS.college)
  })

  it('leave out the rules above the level', () => {
    expect(usesRule('beginner', undefined)).toBe(true)
    expect(usesRule('beginner', 'college')).toBe(false)
    expect(usesRule('college', 'college')).toBe(true)
    expect(usesRule('open', 'college')).toBe(true)
    expect(usesRule('college', 'open')).toBe(false)
  })

  it('keep the level in the robot id, which old ids read as 大專', () => {
    expect(robotId('gib', 'N')).toBe('robot:gib:N')
    expect(robotId('gib', 'N', 'college')).toBe('robot:gib:N')
    expect(robotId('tku', 'E', 'beginner')).toBe('robot:tku:beginner:E')
    expect(robotKindOf('robot:tku:beginner:E')).toBe('tku')
    expect(robotLevelOf('robot:tku:beginner:E')).toBe('beginner')
    expect(robotLevelOf('robot:gib:open:W')).toBe('open')
    expect(robotLevelOf('robot:gib:N')).toBe('college')
    expect(robotLevelOf('robot:N')).toBe('college')
    expect(robotKindOf('robot:N')).toBe('tku')
  })

  it('mark the everyday conventions of both systems for 大專 and up', () => {
    const marked = (books: typeof TKU.books) => books.flatMap((b) => b.rules).filter((r) => r.minLevel === 'college').length
    expect(marked(TKU.books)).toBeGreaterThan(10)
    expect(marked(GIB.books)).toBeGreaterThan(10)
    // Nothing is marked above 大專 yet: 公開組 and 橋士組 bid as 大專 does
    expect([...TKU.books, ...GIB.books].flatMap((b) => b.rules).some((r) => r.minLevel === 'open' || r.minLevel === 'master')).toBe(false)
  })
})

describe('the beginner bids naturally (e6-t19)', () => {
  it.each(KINDS)('%s: no Stayman or transfers over 1NT', (kind) => {
    expect(bidOver(kind, 'college', 'KQ32 AJ5 432 Q43', '1N P')).toBe('2C')
    expect(bidOver(kind, 'beginner', 'KQ32 AJ5 432 Q43', '1N P')).toBe('3N')
    expect(bidOver(kind, 'college', '32 KJ832 432 432', '1N P')).toBe('2D')
    expect(bidOver(kind, 'beginner', '32 KJ832 432 432', '1N P')).not.toBe('2D')
  })

  it.each(KINDS)('%s: no negative double', (kind) => {
    expect(bidOver(kind, 'college', '32 KJ83 Q432 K32', '1C 1S')).toBe('X')
    expect(bidOver(kind, 'beginner', '32 KJ83 Q432 K32', '1C 1S')).not.toBe('X')
  })

  it.each(KINDS)('%s: 公開組 bids as 大專 for now', (kind) => {
    expect(bidOver(kind, 'open', 'KQ32 AJ5 432 Q43', '1N P')).toBe('2C')
  })

  it.each(KINDS)('%s: four beginners still play 100 random boards legally to the end', (kind) => {
    let played = 0
    for (let seed = 1; seed <= 100; seed++) {
      const state = robotBoard(seed, deal(seeded(seed)), kind, 'beginner')
      expect(state.phase).toBe('finished')
      expect(state.auction.length).toBeLessThan(40)
      if (contractOf(state.auction)) played++
    }
    expect(played).toBeGreaterThan(60)
  })
})

describe('the beginner plays without reading or signals (e6-t19)', () => {
  // West opens 1♠, North plays 4♥; East leads the ♥10, West follows with two small hearts
  const cards = hands({
    N: '432 AKQJ5 AQ5 K2',
    S: '65 432 432 A6543',
    W: 'AKJ98 76 K76 QJ7',
    E: 'QT7 T98 JT98 T98',
  })
  const calls = 'P 1S 2H P 4H P P P'

  it('gives no attitude signal on partner’s lead (the club’s reverse attitude: high discourages)', () => {
    const state = board(cards, calls, ['HT', 'low'])
    expect(chooseCard(state, 'W', 'tku', LEVEL_PARAMS.college)).toBe('H7')
    expect(chooseCard(state, 'W', 'tku', LEVEL_PARAMS.beginner)).toBe('H6')
  })

  it('reads nothing from the auction or the count', () => {
    const state = board(cards, calls, ['CT', 'CA', 'C7', 'C2'])
    const reading = new TableReading(state, 'S', 'tku')
    const blind = new TableReading(state, 'S', 'tku', false)
    expect(reading.holder('DK')).toBe('W')
    expect(reading.bid('W', 'S')).toBe(true)
    expect(blind.holder('DK')).toBeNull()
    expect(blind.bid('W', 'S')).toBe(false)
  })
})
