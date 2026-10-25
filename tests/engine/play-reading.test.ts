import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { rankOf, rankValue, SEATS, suitOf, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { dummyOf, legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'
import { TableReading } from '../../shared/robot/reading.ts'
import { robotCall } from '../../shared/robot/robots.ts'

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

const LOW = 'low'

/** Board 3 (South deals) after the given calls and cards */
function board(cards: Hands, calls: string, played: string[] = []): BoardState {
  let state = newBoard(3, cards)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of played) {
    const seat = turnOf(state)!
    const lowest = () => [...legalCards(state, seat)].sort((a, b) => rankValue(rankOf(a)) - rankValue(rankOf(b)))[0]
    state = playCard(state, seat, card === LOW ? lowest() : card)
  }
  return state
}

const KINDS: RobotKind[] = ['tku', 'gib']
/** West opens 1♠, North overcalls 2♥ and plays 4♥; East leads */
const WEST_OPENS = 'P 1S 2H P 4H P P P'
/** East opens 1♠ in fourth seat; North plays 4♥ */
const EAST_OPENS = 'P P P 1S P P 2H P 4H P P P'

describe('reading the auction during the play (e6-t39)', () => {
  // North declares 4♥, South is dummy. Dummy wins the club lead and leads towards North.
  const layout = (diamonds: { N: string; W: string; E: string }) =>
    hands({
      N: `432 AKQJ5 ${diamonds.N} K2`,
      S: '65 432 432 A6543',
      W: `AKJ98 76 ${diamonds.W} QJ7`,
      E: `QT7 T98 ${diamonds.E} T98`,
    })
  const opening = ['CT', 'CA', 'C7', 'C2']

  it('places the opener with the high cards', () => {
    const state = board(layout({ N: 'AQ5', W: 'K76', E: 'JT98' }), WEST_OPENS, opening)
    const reading = new TableReading(state, 'S', 'tku')
    expect(reading.unseen).toEqual(['E', 'W'])
    expect(reading.holder('DK')).toBe('W')
    // Cards in view (declarer's) or already played belong to nobody unseen
    expect(reading.holder('DA')).toBeNull()
    expect(reading.holder('CA')).toBeNull()
    expect(reading.hcp('W')[0]).toBeGreaterThan(reading.hcp('E')[1])
    expect(reading.bid('W', 'S')).toBe(true)
    expect(new TableReading(board(layout({ N: 'AQ5', W: 'K76', E: 'JT98' }), EAST_OPENS, opening), 'S', 'tku').holder('DK')).toBe('E')
  })

  it('leads towards the tenace when the opener sits in front of it', () => {
    // North's ♦KJ5 against the ace: only worth leading towards when West, before North, has it
    const cards = layout({ N: 'KJ5', W: 'A76', E: 'QT98' })
    // Trumps first (e6-t41): dummy's low trump towards North's masters
    for (const kind of KINDS) expect(chooseCard(board(cards, WEST_OPENS, opening), 'S', kind)).toBe('H2')
    // East leads a trump; North draws the rest and crosses to dummy's ♣A
    const drawn = [
      ...['HT', 'H2', 'H6', 'HA'],
      ...['HK', 'H9', 'H3', 'H7'],
      ...['HQ', 'H8', 'H4', 'S8'],
      ...['C2', 'C8', 'CA', 'C7'],
    ]
    for (const kind of KINDS) {
      expect(chooseCard(board(cards, WEST_OPENS, drawn), 'S', kind)).toBe('D2')
      // East opened: the ace sits over the king; no finesse, and not the suit East bid
      expect(suitOf(chooseCard(board(cards, EAST_OPENS, drawn), 'S', kind))).not.toBe('S')
    }
  })

  it('takes the finesse through the opener and goes up when the opener sits behind', () => {
    // The same cards, only the auction differs: ♦2 from dummy, West plays low
    const cards = layout({ N: 'AQ5', W: 'K76', E: 'JT98' })
    for (const kind of KINDS) {
      expect(chooseCard(board(cards, WEST_OPENS, [...opening, 'D2', 'D6']), 'N', kind)).toBe('DQ')
      expect(chooseCard(board(cards, EAST_OPENS, [...opening, 'D2', 'D6']), 'N', kind)).toBe('DA')
    }
  })
})

describe('counting the cards (e6-t40)', () => {
  const ruffLayout = (westVoid: boolean) =>
    hands({
      N: '432 KQJ2 A32 K32',
      S: '765 543 654 7654',
      W: westVoid ? 'AKQJT98 A76 KQJ -' : 'AKQJT9 A76 KQJ 8',
      E: westVoid ? '- T98 T987 AQJT98' : '8 T98 T987 AQJT9',
    })
  const auction = 'P P 1H P 4H P P P'

  it('knows who showed out of a suit', () => {
    const state = board(ruffLayout(true), auction, ['CA', LOW, 'S8', 'C2'])
    const reading = new TableReading(state, 'N', 'tku')
    expect(reading.isVoid('W', 'C')).toBe(true)
    expect(reading.len('E', 'C')).toEqual([5, 5])
    expect(reading.mayRuff('W', 'C', 'H')).toBe(true)
    expect(reading.mayRuff('E', 'C', 'H')).toBe(false)
  })

  it('knocks out the trump ace before cashing a side winner (e6-t41)', () => {
    const play = (westVoid: boolean) => ['CA', LOW, westVoid ? 'S8' : 'C8', 'C2', 'DT', 'D4', 'DJ', 'DA']
    for (const kind of KINDS) {
      // West threw a spade on the club ace and still has trumps: ♣K would be ruffed. North
      // knocks out the trump ace first either way (e6-t41)
      expect(chooseCard(board(ruffLayout(true), auction, play(true)), 'N', kind)).toBe('HK')
      expect(chooseCard(board(ruffLayout(false), auction, play(false)), 'N', kind)).toBe('HK')
    }
  })

  it('draws trumps until the opponents have none', () => {
    const cards = hands({
      N: 'AK2 AKQJT 432 32',
      S: '543 98765 765 54',
      W: 'QJT9 3 AKQ8 AKQJ',
      E: '876 42 JT9 T9876',
    })
    const trick1 = ['S8', 'S3', 'S9', 'SA']
    for (const kind of KINDS) {
      expect(chooseCard(board(cards, auction, trick1), 'N', kind)).toBe('HA')
      const after = [...trick1, 'HA', 'H2', 'H5', 'H3']
      expect(chooseCard(board(cards, auction, after), 'N', kind)).toBe('HK')
      // West showed out on the second round and East's last trump fell: stop and cash the spade
      const drawn = board(cards, auction, [...after, 'HK', 'H4', 'H6', 'CJ'])
      expect(new TableReading(drawn, 'N', kind).len('W', 'H')).toEqual([0, 0])
      expect(chooseCard(drawn, 'N', kind)).toBe('SK')
    }
  })
})

describe('the reading uses only what the robot may see', () => {
  function seeded(seed: number) {
    return (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % n
    }
  }

  /** The hands this seat cannot see, their unplayed cards dealt again at random */
  function reshuffled(state: BoardState, seat: Seat, random: (n: number) => number): BoardState {
    const dummy = dummyOf(state)
    const shown = state.play.length > 0
    const hidden = SEATS.filter((s) => s !== seat && !(shown && s === dummy) && !(seat === dummy && s === state.contract!.declarer))
    const played = new Set(state.play.map((p) => p.card))
    const pool = hidden.flatMap((s) => state.hands[s].filter((c) => !played.has(c)))
    for (let i = pool.length - 1; i > 0; i--) {
      const j = random(i + 1)
      ;[pool[i], pool[j]] = [pool[j], pool[i]]
    }
    const handsAgain = { ...state.hands }
    for (const s of hidden) {
      const kept = state.hands[s].filter((c) => played.has(c))
      handsAgain[s] = [...kept, ...pool.splice(0, state.hands[s].length - kept.length)]
    }
    return { ...state, hands: handsAgain }
  }

  it('plays the same card however the hidden hands lie, on 60 random boards', () => {
    for (const kind of KINDS) {
      for (let seed = 1; seed <= 60; seed++) {
        const random = seeded(seed * 31 + 7)
        let state = newBoard(seed, deal(seeded(seed)))
        while (state.phase === 'auction') {
          const seat = turnOf(state)!
          state = makeCall(state, seat, robotCall(kind, state.hands[seat], seat, state.auction, state.dealer, state.vul).call)
        }
        while (state.phase === 'play') {
          const seat = turnOf(state)!
          const card = chooseCard(state, seat, kind)
          expect(chooseCard(reshuffled(state, seat, random), seat, kind), `${kind} board ${seed} card ${state.play.length}`).toBe(card)
          state = playCard(state, seat, card)
        }
      }
    }
  })
})
