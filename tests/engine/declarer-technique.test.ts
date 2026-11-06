import { describe, expect, it } from 'vitest'
import { SEATS, suitOf, type Card, type Hands, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { RobotKind } from '../../shared/protocol.ts'
import { chooseCard } from '../../shared/robot/play.ts'

/**
 * The declarer's techniques in a suit contract (S3, ROBOT.md §3.4): ruffing in the short hand
 * before drawing trumps (making the short hand void, ruffing high when the card reading says the
 * defender behind is out of the suit, keeping the long hand's trumps when partner wins the
 * trick), setting up a long suit by ruffing, and the elimination and throw-in. The same deals as
 * the play quiz (`tests/play-quiz/declarer.technique.json`).
 */

function hand(text: string): Card[] {
  return text.split('.').flatMap((ranks, i) => [...ranks].map((r) => 'SHDC'[i] + r))
}

function hands(given: Record<Seat, string>): Hands {
  const out = {} as Hands
  for (const seat of SEATS) out[seat] = hand(given[seat])
  expect(new Set(SEATS.flatMap((s) => out[s])).size).toBe(52)
  return out
}

function board(no: number, cards: Hands, calls: string, played: string): BoardState {
  let state = newBoard(no, cards)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of played.split(' ').filter(Boolean)) state = playCard(state, turnOf(state)!, card)
  return state
}

const KINDS: RobotKind[] = ['tku', 'gib']
const plays = (state: BoardState, kinds = KINDS) => kinds.map((kind) => chooseCard(state, turnOf(state)!, kind))

describe('ruffing in the short hand', () => {
  it('cashes the ace to make dummy void before drawing trumps', () => {
    // 4♠ by South; dummy's four trumps are all the ruffs there are: drawing three rounds first
    // would leave one. ♥A now, then two heart ruffs
    const cards = hands({ S: 'AKQJ6.A32.K32.A2', N: 'T987.4.A654.8765', W: '54.KQJ9.QJ9.KQJT', E: '32.T8765.T87.943' })
    const state = board(3, cards, '1S P 2S P 4S P P P', 'CK C5 C3 CA')
    expect(plays(state)).toEqual(['HA', 'HA'])
  })

  it('ruffs high when the defender behind has shown it is out of the suit', () => {
    // 6♠ by South; East followed with the ♥7 and ♥Q: dummy ruffs the ♥8 with the 9, not the 3
    const cards = hands({ N: 'KT93.K4.AJ3.KT87', E: '765.Q7.T872.A542', S: 'AQJ84.A983.KQ5.Q', W: '2.JT652.964.J963' })
    const state = board(96, cards, 'P 1C P 1S P 2S P 4N P 5H P 6S P P P', 'HJ HK H7 H3 H4 HQ HA H5 H8 H2')
    for (const card of plays(state)) expect(['S9', 'ST', 'SK']).toContain(card)
  })

  it('keeps the long hand’s trumps when dummy wins the trick with the ace behind', () => {
    // 4♠ by South; East switches to a club, South void: dummy's ♣A takes it, South throws a loser
    const cards = hands({ S: 'AKQJ9.K76.AK432.', N: 'T87.832.75.AQ765', W: '65.QJT9.QJ9.KJT9', E: '432.A54.T86.8432' })
    const state = board(3, cards, '1S P 2S P 4S P P P', 'HQ H2 HA H6 C2')
    for (const card of plays(state)) expect(suitOf(card)).not.toBe('S')
  })
})

describe('setting up a long suit by ruffing', () => {
  it('ruffs dummy’s diamonds good, with an entry back for each ruff, trumps drawn', () => {
    // 4♠ by South; ♦AK cashed, East out: lead a low diamond for South to ruff, West's ♦QJ fall in
    // two rounds, South ruffs twice and dummy's ♥A and ♣A bring the lead back to the long cards
    const cards = hands({ S: 'AKQJT.432.2.5432', N: '543.A65.AK6543.A', W: '98.KQJT.QJT9.KQJ', E: '762.987.87.T9876' })
    const state = board(3, cards, '1S P 2S P 4S P P P', 'S9 S3 S2 ST SA S8 S4 S6 SK HT S5 S7 D2 D9 DA D7 DK D8 C2 DT')
    expect(plays(state)).toEqual(['D3', 'D3'])
  })
})

describe('elimination and throw-in', () => {
  it('exits with the ♦Q to West, who must lead a club into the ♣QJ or give a ruff and discard', () => {
    // 4♠ by North; trumps drawn, hearts gone from both hands, West doubled 4♥ and holds the
    // ♦K: it wins the exit and has only clubs (away from the king) or diamonds left
    const cards = hands({ N: 'AQJ52.AK.J96.985', E: '76.T98643.84.T43', S: '9843.2.AQT5.AQJ7', W: 'KT.QJ75.K732.K62' })
    const state = board(2697, cards, '1S P 4H X 4S P P P', 'HT H2 HJ HK SA S7 S3 ST HA H3 D5 H5 SQ S6 S4 SK D2 D6 D8 DT CA C2 C5 C3 DA D3 D9 D4')
    expect(plays(state, ['tku'])).toEqual(['DQ'])
  })
})
