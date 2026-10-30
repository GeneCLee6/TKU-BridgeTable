import { describe, expect, it } from 'vitest'
import { SEATS, suitOf, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * The declaring side against single dummy by sampling (V4c, ROBOT.md §3.10): positions from
 * `npm run sim -- compare --points declarer` where TKB's card lost most, each from the
 * evaluation deal it was found on (board numbers of tku-eval-v1).
 */

function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

function hands(given: Record<Seat, string>): Hands {
  const out = {} as Hands
  for (const seat of SEATS) out[seat] = hand(given[seat])
  expect(new Set(SEATS.flatMap((s) => out[s])).size).toBe(52)
  return out
}

function board(no: number, cards: Hands, calls: string, played: string[] = []): BoardState {
  let state = newBoard(no, cards)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of played) state = playCard(state, turnOf(state)!, card)
  return state
}

const KINDS: RobotKind[] = ['tku', 'gib']
const plays = (state: BoardState) => KINDS.map((kind) => chooseCard(state, turnOf(state)!, kind))

describe('the declaring side (single-dummy comparison)', () => {
  it('counts a suit that runs as all its tricks, and cashes instead of finessing', () => {
    // Board 84, 3NT by West: ♣A763 opposite dummy's ♣KQJ982 with three clubs out gives six
    // tricks, enough with the ♦AK. Not the ♥8 towards dummy's ♥Q
    const cards = hands({ N: 'AQJ98 KT93 QT T5', E: 'T7 Q2 974 KQJ982', S: 'K2 J7654 J6532 4', W: '6543 A8 AK8 A763' })
    const state = board(84, cards, '1N 2D 2N 3H P P 3N P P P', ['HT', 'H2', 'HJ', 'HA'])
    for (const card of plays(state)) expect(['D', 'C']).toContain(suitOf(card))
  })

  it("overtakes partner's last card of the suit when this hand has no other way in", () => {
    // Board 250, 3NT by North: North leads the ♥T to dummy's ♥AKQJ842. North has winners outside,
    // but dummy has none: dummy overtakes with the jack and runs the hearts
    const cards = hands({ N: 'A62 T A74 AKJ942', E: '984 - QJT832 Q763', S: 'Q53 AKQJ842 - T85', W: 'KJT7 97653 K965 -' })
    const played = ['DQ', 'H2', 'D5', 'D4', 'DJ', 'S3', 'D6', 'D7', 'DT', 'C5', 'DK', 'DA', 'SA', 'S9', 'S5', 'S7', 'HT', 'D2']
    expect(plays(board(250, cards, 'P 1H P 2C P 2H P 3N P P P', played))).toEqual(['HJ', 'HJ'])
  })

  it('cashes the winners dummy cannot get back to', () => {
    // Board 115, 6♥ by South: dummy ruffed a spade and is on lead with ♣AQJ6542; South has no
    // club and dummy no other entry: the ♣A now (a spade goes), not dummy's last trump
    const cards = hands({ N: 'Q 85 QJT AQJ6542', E: 'K982 T 8765 KT87', S: 'A743 AKQJ763 A4 -', W: 'JT65 942 K932 93' })
    const state = board(115, cards, '1H P 2C P 3H P 4H P 4N P 5C P 6H P P P', ['SJ', 'SQ', 'SK', 'SA', 'S3', 'S5', 'H5', 'S2'])
    expect(plays(state)).toEqual(['CA', 'CA'])
  })

  it("rises with dummy's master at trick one in a suit contract", () => {
    // Board 59, 6♥ by South: West leads the ♦9 and South has ♦J7, nothing to beat third hand's
    // queen: dummy's ♦AKT5 wins it (the king), not the five
    const cards = hands({ N: 'A9 Q95 AKT5 9632', E: 'J32 - Q8632 KQJ84', S: 'KT65 AKJT32 J7 7', W: 'Q874 8764 94 AT5' })
    const state = board(59, cards, '1H P 2S P 3C P 3D P 3N P 4S P 5D P 6H P P P', ['D9'])
    expect(plays(state)).toEqual(['DK', 'DK'])
  })

  it('leaves the last trump out when it is the master', () => {
    // 4♠ by South: trumps were drawn down to East's ♠A. South's ♠JT9 do not lead it out
    const cards = hands({ S: 'KQJT98 AK AK2 32', N: '763 QJ3 QJ3 7654', W: '2 T9876 T987 AKQ', E: 'A54 542 654 JT98' })
    const played = ['CA', 'C4', 'C8', 'C2', 'CK', 'C5', 'C9', 'C3', 'CQ', 'C6', 'CT', 'S8', 'SK', 'S2', 'S3', 'S4', 'SQ', 'H6', 'S6', 'S5']
    for (const card of plays(board(3, cards, '1S P 2S P 4S P P P', played))) expect(suitOf(card)).not.toBe('S')
  })
})
