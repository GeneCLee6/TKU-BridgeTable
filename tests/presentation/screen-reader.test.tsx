import { act, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Seat } from '../../shared/cards.ts'
import type { BoardView } from '../../shared/protocol.ts'
import { TableAnnouncer } from '../../src/components/TableAnnouncer.tsx'
import { announcements } from '../../src/lib/announce.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'
import { STRINGS } from '../../src/strings.ts'

// e3-t33 (AC-3.9): the table's live region says whose turn it is, each call and card, the
// contract, who won each trick and the result

const t = STRINGS.zh
const names: Record<Seat, string> = { N: 'Amy', E: 'Ben', S: 'Cat', W: 'Dan' }
const who = (seat: Seat) => `${t.seatNames[seat]} ${names[seat]}`
const ctx = { t, me: 'S' as Seat, who }

function board(change: Partial<BoardView> = {}): BoardView {
  return {
    boardNo: 1,
    dealer: 'N',
    vul: 'None',
    phase: 'auction',
    hands: {},
    handCounts: { N: 13, E: 13, S: 13, W: 13 },
    auction: [],
    contract: null,
    dummy: null,
    turn: 'N',
    tricks: [],
    tricksWon: { NS: 0, EW: 0 },
    legalCards: [],
    legalCalls: [],
    canUndo: false,
    canClaim: false,
    ...change,
  }
}

describe('announcements', () => {
  it('says the new board and whose turn it is on arrival, without reading out what is already on screen', () => {
    const said = announcements(null, board({ auction: [{ seat: 'N', call: '1H' }], turn: 'E' }), ctx)
    expect(said).toEqual(['第 1 副，北家發牌，雙方無身價', '輪到 東 Ben 叫牌'])
  })

  it('says each new call and that it is your call', () => {
    const before = board({ auction: [{ seat: 'N', call: '1H' }], turn: 'E' })
    const after = board({
      auction: [
        { seat: 'N', call: '1H' },
        { seat: 'E', call: 'X' },
      ],
      turn: 'S',
      legalCalls: ['P', '1S'],
    })
    expect(announcements(before, after, ctx)).toEqual(['東 Ben 叫 Double', '輪到你叫牌'])
  })

  it('says the contract when the auction ends, then each card and who won the trick', () => {
    const contract = { level: 4, strain: 'S' as const, doubled: '' as const, declarer: 'N' as Seat }
    const auction = board({ auction: [{ seat: 'N', call: '4S' }, { seat: 'E', call: 'P' }, { seat: 'S', call: 'P' }], turn: 'W' })
    const play = board({
      phase: 'play',
      contract,
      dummy: 'S',
      auction: [...auction.auction, { seat: 'W', call: 'P' }],
      turn: 'E',
    })
    expect(announcements(auction, play, ctx)).toEqual(['西 Dan 叫 Pass', '叫牌結束：合約 4 黑桃，莊家 北 Amy', '輪到 東 Ben 出牌'])

    const trick = board({
      ...play,
      tricks: [
        {
          leader: 'E',
          cards: [
            { seat: 'E', card: 'HK' },
            { seat: 'S', card: 'H2' },
            { seat: 'W', card: 'H5' },
            { seat: 'N', card: 'HA' },
          ],
          winner: 'N',
        },
      ],
      tricksWon: { NS: 1, EW: 0 },
      turn: 'N',
    })
    expect(announcements(play, trick, ctx)).toEqual([
      '東 Ben 出 紅心K',
      '南 Cat 出 紅心2',
      '西 Dan 出 紅心5',
      '北 Amy 出 紅心A',
      '北 Amy 贏這一墩；南北 1 墩、東西 0 墩',
      '輪到 北 Amy 出牌',
    ])
  })

  it('tells declarer to play from dummy', () => {
    const contract = { level: 1, strain: 'N' as const, doubled: '' as const, declarer: 'S' as Seat }
    const before = board({ phase: 'play', contract, dummy: 'N', turn: 'W' })
    const after = board({ ...before, tricks: [{ leader: 'W', cards: [{ seat: 'W', card: 'C5' }] }], turn: 'N', legalCards: ['C2'] })
    expect(announcements(before, after, ctx)).toEqual(['西 Dan 出 梅花5', '輪到你出夢家的牌'])
  })

  it('says the result, and nothing about calls taken back', () => {
    const contract = { level: 3, strain: 'N' as const, doubled: 'X' as const, declarer: 'S' as Seat }
    const before = board({ phase: 'play', contract, dummy: 'N', turn: 'W' })
    const after = board({ ...before, phase: 'finished', turn: null, result: { declarerTricks: 7, scoreNS: -200, claimed: true } })
    expect(announcements(before, after, ctx)).toEqual(['結果：倒 2 墩，南北 -200 分'])

    const undone = board({ auction: [{ seat: 'N', call: '1H' }], turn: 'E' })
    const back = board({ auction: [], turn: 'N' })
    expect(announcements(undone, back, ctx)).toEqual(['輪到 北 Amy 叫牌'])
  })

  it('says a passed-out board', () => {
    const before = board({ auction: ['N', 'E', 'S'].map((seat) => ({ seat: seat as Seat, call: 'P' })), turn: 'W' })
    const after = board({ auction: [...before.auction, { seat: 'W', call: 'P' }], phase: 'finished', turn: null })
    expect(announcements(before, after, ctx)).toEqual(['西 Dan 叫 Pass', 'All pass'])
  })

  it('speaks every language', () => {
    const en = announcements(null, board({ turn: 'E' }), { t: STRINGS.en, me: 'S', who: (s) => STRINGS.en.seatNames[s] })
    expect(en).toEqual(['Board 1, North deals, None vulnerable', 'East to call'])
  })
})

describe('TableAnnouncer', () => {
  it('adds what happened to a polite live region', () => {
    const first = board({ turn: 'E' })
    const { rerender } = render(
      <PreferencesProvider>
        <TableAnnouncer board={first} me="S" who={who} />
      </PreferencesProvider>,
    )
    const log = screen.getByRole('log', { name: '牌桌動態' })
    expect(log).toHaveAttribute('aria-live', 'polite')
    expect(log).toHaveTextContent('輪到 東 Ben 叫牌')

    act(() =>
      rerender(
        <PreferencesProvider>
          <TableAnnouncer board={board({ auction: [{ seat: 'E', call: '1N' }], turn: 'S', legalCalls: ['P'] })} me="S" who={who} />
        </PreferencesProvider>,
      ),
    )
    expect(log).toHaveTextContent('東 Ben 叫 1 無王')
    expect(log).toHaveTextContent('輪到你叫牌')
  })
})
