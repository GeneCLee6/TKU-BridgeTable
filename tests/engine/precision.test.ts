// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { seatToCall, type AuctionCall } from '../../shared/auction.ts'
import { SEATS, type Card, type Seat, type Suit } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { TableReading } from '../../shared/robot/reading.ts'
import { deriveCard } from '../../shared/robot/system/card.ts'
import { describe as words } from '../../shared/robot/system/describe.ts'
import { choose, explain } from '../../shared/robot/system/engine.ts'
import { evaluate, fits } from '../../shared/robot/system/evaluate.ts'
import { read } from '../../shared/robot/system/infer.ts'
import { GIB } from '../../shared/robot/system/gib/index.ts'
import { PRECISION } from '../../shared/robot/system/precision/index.ts'
import { LANGS } from '../../shared/messages.ts'
import { consistencyCheck } from '../../eval/consistency.ts'
import { evalBoards } from '../../eval/deals.ts'

/** e5-t50: TKB in Precision (docs/systems/precision.md), against the engine itself */

const hand = (text: string): Card[] => {
  const suits = text.split(' ')
  const out: Card[] = []
  ;(['S', 'H', 'D', 'C'] as Suit[]).forEach((s, i) => {
    for (const r of suits[i] === '-' ? '' : suits[i]) out.push(`${s}${r}` as Card)
  })
  return out
}

const auctionOf = (calls: string[], dealer: Seat = 'N'): AuctionCall[] => calls.map((call, i) => ({ seat: seatToCall(dealer, i), call }))

const bid = (text: string, calls: string[] = []) => {
  const auction = auctionOf(calls)
  return choose(PRECISION, hand(text), seatToCall('N', auction.length), auction, 'N', 'None')
}

const LAYOUT = { N: 'AK32 KQ4 J52 Q43', E: 'Q876 AT9 A32 872', S: 'J54 J62 K87 AKJ6', W: 'T9 8753 QT964 T95' } as const
const layout = (hands: Record<Seat, string>) => Object.fromEntries(SEATS.map((s) => [s, hand(hands[s])])) as Record<Seat, Card[]>

function played(hands: Record<Seat, string>, calls: string[], systems?: (seat: Seat) => 'precision' | 'gib'): BoardState {
  let state = newBoard(1, layout(hands))
  for (const call of calls) {
    const seat = turnOf(state)!
    state = makeCall(state, seat, call)
    if (systems) state.auction[state.auction.length - 1].system = systems(seat)
  }
  return state
}

describe('Precision openings', () => {
  it.each([
    ['AKQ2 KQ4 J52 Q43', '1C', '16+ any shape'],
    ['AQ932 K43 Q54 J2', '1S', 'five-card major, 11–15'],
    ['AQ93 K43 Q54 Q32', '1N', 'balanced 13–15'],
    ['AQ93 K43 Q54 J32', '1D', 'balanced 11–12 is not 1NT, and three diamonds is enough'],
    ['AQ93 K432 Q5 J32', '1D', 'a doubleton diamond: short, as published'],
    ['K4 Q32 A5 KJ9432', '2C', 'six clubs, 11–15'],
    ['AQ93 K4 Q5 Q9432', '2C', 'five clubs and a four-card major'],
    ['AQ93 K432 5 KJ32', '2D', '4=4=1=4'],
    ['AQ93 K32 - KJ8432', '2C', 'six clubs goes to 2♣ even with short diamonds'],
    ['AQ93 KJ2 5 KT432', '2D', '4=3=1=5'],
    ['AQ8532 K32 54 32', '2S', 'a weak two'],
    ['AK4 KQ4 AQ52 KQ3', '2N', '22–24'],
    ['43 54 AKQ9632 43', '3N', 'gambling'],
  ])('opens %s with %s (%s)', (cards, call) => {
    expect(bid(cards).call).toBe(call)
  })

  it('never opens 1♦ with fewer than two diamonds, nor more than 15 outside 1♣ and 2NT, over many hands', () => {
    for (const board of evalBoards(800))
      for (const seat of SEATS) {
        const cards = board.hands[seat]
        const { call } = choose(PRECISION, cards, 'N', [], 'N', 'None')
        const h = evaluate(cards)
        if (call === '1D') expect(h.len.D).toBeGreaterThanOrEqual(2)
        if (['1D', '1H', '1S', '1N', '2C', '2D'].includes(call)) expect(h.hcp).toBeLessThanOrEqual(15)
        if (h.hcp >= 16) expect(['1C', '2N']).toContain(call)
      }
  })

  it('makes only calls whose explanation fits the hand', () => {
    for (const board of evalBoards(300))
      for (const seat of SEATS) {
        const { call, shows } = choose(PRECISION, board.hands[seat], 'N', [], 'N', 'None')
        if (call !== 'P') expect(fits(evaluate(board.hands[seat]), { ...shows!, before: undefined })).toBe(true)
      }
  })
})

describe('Responses to 1♣', () => {
  it.each([
    ['432 432 5432 432', '1D', '0–7'],
    ['AJ432 K32 432 32', '1S', 'a positive, 5+'],
    ['A432 K32 432 Q32', '1N', '8–10, no five-card suit'],
    ['A432 K432 A32 32', '2N', '11–13'],
    ['AQ32 K432 A32 Q3', '3N', '14–15'],
    ['AQJ432 32 432 32', '2S', 'a good six-card suit, 4–7'],
    ['K432 Q432 K432 3', '1N', '4441 with 8–10 has no five-card suit to show'],
  ])('answers %s with %s (%s)', (cards, call) => {
    expect(bid(cards, ['1C', 'P']).call).toBe(call)
  })

  it('the positive forces to game, the negative does not', () => {
    const meanings = explain(PRECISION, auctionOf(['1C', 'P']), 'N')
    expect(meanings.get('1S')?.forcing).toBe('game')
    expect(meanings.get('1D')?.forcing).toBeUndefined()
    expect(meanings.get('1D')).toMatchObject({ name: 'clubNegative', hcp: [0, 7], artificial: true })
  })

  it.each([
    ['AK32 KQ4 Q52 Q43', '1N', '16–18 balanced'],
    ['AK32 KQ4 AJ5 KJ3', '2N', '19–21 balanced'],
    ['AQ932 K43 AQ5 Q3', '1S', 'a natural suit'],
    ['AKQJ32 A43 AK5 3', '2S', '20+ jumps'],
  ])('opener after the negative: %s rebids %s (%s)', (cards, call) => {
    expect(bid(cards, ['1C', 'P', '1D', 'P']).call).toBe(call)
  })

  it('reads the notrump rebid into its structure: Stayman at 6+', () => {
    const meaning = explain(PRECISION, auctionOf(['1C', 'P', '1D', 'P', '1N', 'P']), 'N')
    expect(meaning.get('2C')).toMatchObject({ name: 'stayman' })
    expect(meaning.get('2D')).toMatchObject({ name: 'transfer' })
  })

  it('opener can ask a notrump responder for a major', () => {
    expect(bid('AQ32 KQ32 AJ5 Q3', ['1C', 'P', '1N', 'P']).call).toBe('2C')
  })
})

describe('Interference over 1♣', () => {
  it.each([
    ['432 432 5432 432', ['1C', '1S'], 'P', '0–4'],
    ['K32 Q32 5432 Q32', ['1C', '1S'], 'X', '5–7'],
    ['32 AQJ32 K432 32', ['1C', '1S'], '2H', 'a natural positive'],
    ['KJ3 A32 K432 Q32', ['1C', '1S'], '1N', '8+ with a stopper'],
    ['432 A32 K432 K32', ['1C', '1S'], '2S', '8+ without one: the cue bid'],
    ['432 432 5432 432', ['1C', 'X'], 'P', 'double: 0–4 passes'],
    ['K32 Q32 5432 Q32', ['1C', 'X'], '1D', 'double: 5–7'],
    ['KJ3 A32 K432 Q32', ['1C', 'X'], 'XX', 'double: 8+ and no five-card suit'],
  ])('%s after %j bids %s (%s)', (cards, calls, call) => {
    expect(bid(cards, calls).call).toBe(call)
  })

  it('opener bids over a double passed round rather than play 1♣ doubled', () => {
    expect(bid('AQ932 K43 AQ5 Q3', ['1C', 'X', 'P', 'P']).call).toBe('1S')
  })
})

describe('Second rounds that were lost to the fallback (found reading the worst boards)', () => {
  it('accepts the 2NT invitation after the 1NT rebid with the top of 16–18', () => {
    expect(bid('AK2 KQ4 QJ5 Q432', ['1C', 'P', '1D', 'P', '1N', 'P', '2N', 'P']).call).toBe('3N')
    expect(bid('AK2 KQ4 Q52 Q432', ['1C', 'P', '1D', 'P', '1N', 'P', '2N', 'P']).call).toBe('P')
  })

  it('completes a minor transfer after the 1NT rebid', () => {
    expect(bid('AK2 KQ4 Q52 Q432', ['1C', 'P', '1D', 'P', '1N', 'P', '2S', 'P']).call).toBe('3C')
  })

  it('does not sell out to an overcall of the negative with a strong hand', () => {
    expect(bid('KQ2 Q7 Q8 AKQJ43', ['1C', 'P', '1D', '1H']).call).toBe('2C')
    expect(bid('72 AKQ73 AQ2 A63', ['1C', 'P', '1D', '1S']).call).toBe('2H')
    expect(bid('KJT5 AKT AK54 Q9', ['1C', 'P', '1D', '1H']).call).toBe('1N')
    expect(bid('AKJ5 T2 AK54 AQ9', ['1C', 'P', '1D', '1H']).call).toBe('X')
    expect(bid('AK32 43 AQ52 K43', ['1C', 'P', '1D', '1H']).call).toBe('P')
  })

  it('finds a major after the cue bid', () => {
    expect(bid('T63 AKJ32 A7 A54', ['1C', '2D', '3D', 'P']).call).toBe('3H')
    expect(bid('KQJ3 K96 A KQT32', ['1C', '2D', '3D', 'P']).call).toBe('3S')
  })

  it('keeps responder from driving on with 7 at most, opener shows a second suit over 1NT', () => {
    expect(bid('AJ9654 JT7 T3 J3', ['1C', 'P', '1D', 'P', '2C', 'P']).call).toBe('2S')
    expect(bid('975 Q52 QJ95 J96', ['1C', 'P', '1D', 'P', '1S', 'P']).call).not.toBe('2N')
    expect(bid('AKJ65 K87 AJT98 -', ['1C', 'P', '1D', 'P', '1S', 'P', '1N', 'P']).call).toBe('2D')
  })

  it('opener bids his own long suit over a notrump response, so the strong hand declares', () => {
    expect(bid('AKT73 KJ5 KQ5 QJ', ['1C', 'P', '1N', 'P']).call).toBe('2S')
    expect(explain(PRECISION, auctionOf(['1C', 'P', '1N', 'P']), 'N').get('2H')?.name).toBeUndefined()
    expect(bid('AQ32 KQ32 AJ5 Q3', ['1C', 'P', '1N', 'P']).call).toBe('2C')
  })
})

describe('After 1♦, 2♣ and 2♦', () => {
  it.each([
    ['AQ32 432 432 Q32', ['1D', 'P'], '1S', 'a four-card major'],
    ['K32 Q32 Q532 432', ['1D', 'P'], '1N', '6–10'],
    ['AQ3 K32 Q532 Q32', ['1D', 'P'], '3N', '13–15'],
    ['AQ32 K32 Q32 432', ['1D', 'P', '1S', 'P'], '2S', 'a raise with four, shown by the opener of 11–13'],
    ['Q32 K32 AQ32 J32', ['1D', 'P', '1S', 'P'], '1N', '11–12, the balanced 13–15 opened 1NT'],
    ['AQ32 K32 432 Q32', ['2C', 'P'], '2D', 'the ask with a major'],
    ['AQ32 K32 AQ32 32', ['2D', 'P'], '2N', 'the ask with enough for game'],
    ['32 Q432 Q432 432', ['2D', 'P'], '2H', 'to play'],
  ])('%s after %j bids %s (%s)', (cards, calls, call) => {
    expect(bid(cards, calls).call).toBe(call)
  })

  it('answers the 2♣ ask with a major, then by strength', () => {
    expect(bid('AQ93 K4 Q5 Q9432', ['2C', 'P', '2D', 'P']).call).toBe('2S')
    expect(bid('K4 Q32 A5 KJ9432', ['2C', 'P', '2D', 'P']).call).toBe('3C')
    expect(bid('K4 Q32 AQ KJ9432', ['2C', 'P', '2D', 'P']).call).toBe('2N')
  })

  it('answers the 2♦ ask by strength, then shape', () => {
    expect(bid('AQ93 K432 5 QJ32', ['2D', 'P', '2N', 'P']).call).toBe('3C')
    expect(bid('AK93 KQ32 5 QJ32', ['2D', 'P', '2N', 'P']).call).toBe('3D')
  })
})

describe('Alerts', () => {
  it('words every artificial call in each language', () => {
    const artificial = [
      ['1C', auctionOf([])],
      ['2D', auctionOf([])],
      ['3N', auctionOf([])],
      ['1D', auctionOf(['1C', 'P'])],
      ['2D', auctionOf(['2C', 'P'])],
      ['2N', auctionOf(['2D', 'P'])],
    ] as const
    for (const [call, auction] of artificial) {
      const spec = explain(PRECISION, auction, 'N').get(call)!
      expect(spec.artificial || spec.name, call).toBeTruthy()
      for (const lang of LANGS) expect(words(spec, lang).length, `${call} ${lang}`).toBeGreaterThan(0)
    }
  })
})

describe('The opening lead', () => {
  it("does not lead a suit partner's 1♣ did not show", () => {
    // Partner (N) opens a strong 1♣ and defends 4♠ by EW: clubs were never shown
    const calls = ['1C', '1S', 'P', '4S', 'P', 'P', 'P']
    const hands = { N: 'AK32 KQ4 AJ5 Q43', E: 'QJ9876 A9 Q3 872', S: '5 J862 K8742 J65', W: 'T4 T753 T96 AKT9' }
    const state = played(hands, calls)
    const lead = chooseCard(state, turnOf(state)!, 'precision')
    expect(lead.startsWith('C')).toBe(false)
  })

  it('still leads a suit partner opened naturally', () => {
    const calls = ['1H', '1S', 'P', '4S', 'P', 'P', 'P']
    const hands = { N: 'A32 AKJ54 A5 Q43', E: 'QJ9876 Q9 Q3 872', S: '5 862 K8742 J965', W: 'KT4 T73 JT96 AKT' }
    const state = played(hands, calls)
    expect(chooseCard(state, turnOf(state)!, 'precision').startsWith('H')).toBe(true)
  })
})

describe('Reading the auction across systems', () => {
  it('reads each call in the system of the robot that made it', () => {
    // A 2/1 robot opens 1♣ natural, and its 1NT is 15–17
    const systemOf = () => GIB
    const natural = read(PRECISION, auctionOf(['1N']), 'N', 'None', systemOf).shown.N
    expect(natural.hcp).toEqual([15, 17])
    expect(read(PRECISION, auctionOf(['1N']), 'N', 'None').shown.N.hcp).toEqual([13, 15])
    const club = read(GIB, auctionOf(['1C']), 'N', 'None', () => PRECISION).shown.N
    expect(club.hcp).toEqual([16, 40])
    expect(club.len?.C).toBeUndefined()
  })

  it('the play reads a Precision declarer as Precision', () => {
    const state = played(LAYOUT, ['1N', 'P', '3N', 'P', 'P', 'P'], () => 'precision')
    const next = playCard(state, turnOf(state)!, chooseCard(state, turnOf(state)!, 'gib'))
    const reading = new TableReading(next, turnOf(next)!, 'gib')
    expect(reading).toBeDefined()
    // The declarer (N) as the auction said: at most 15, whatever 2/1 says of a 1NT
    const defender: Seat = 'W'
    const seen = new TableReading(next, defender, 'gib')
    expect(seen.hcp('N')[1]).toBeLessThanOrEqual(15)
  })
})

describe('The consistency check', () => {
  it('finds no contradiction, nothing wider and nothing left out, on deals and in the quiz', () => {
    const { conflicts, wide, dropped, calls } = consistencyCheck({ systems: ['precision'], deals: 200 })
    expect(calls['precision deal']).toBeGreaterThan(1000)
    expect(calls['precision quiz']).toBeGreaterThan(10)
    expect(conflicts.map((c) => `${c.pattern} ${c.feature}`)).toEqual([])
    expect(wide.map((c) => `${c.pattern} ${c.feature}`)).toEqual([])
    expect(dropped.map((c) => `${c.pattern} ${c.feature}`)).toEqual([])
  }, 120_000)
})

describe('The system card', () => {
  const card = deriveCard(PRECISION)
  const group = (after: string, seat?: number) => card.sections.flatMap((s) => s.groups).find((g) => g.after === after && g.seat === seat)

  it('comes from the rules', () => {
    const open = group('')!
    const call = (c: string) => open.calls.find((x) => x.call === c)?.shows
    expect(call('1C')).toMatchObject({ name: 'strongClub', hcp: [16, 40] })
    expect(call('1N')).toMatchObject({ hcp: [13, 15], balanced: true })
    expect(call('2C')).toMatchObject({ len: { C: [5, 13] } })
    expect(call('2D')).toMatchObject({ name: 'shortDiamonds' })
    expect(group('1C (P)')!.calls.map((c) => c.call)).toContain('1D')
    expect(group('1C (P) 1D (P)')).toBeDefined()
    expect(group('2C (P) 2D (P)')).toBeDefined()
    expect(group('2D (P) 2N (P)')).toBeDefined()
    expect(group('1C (X)')).toBeDefined()
    expect(card.system).toBe('precision')
  })
})
