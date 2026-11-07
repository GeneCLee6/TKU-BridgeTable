import { describe, expect, it } from 'vitest'
import type { Call } from '../../shared/auction.ts'
import { deal } from '../../shared/board.ts'
import { nextSeat, RANKS, SEATS, sideOf, type Seat } from '../../shared/cards.ts'
import { claimApprovers, legalCards, makeCall, makeClaim, newBoard, playCard, respondToClaim, tricksWon, turnOf, type BoardState } from '../../shared/game.ts'
import { IMPORT_LIMITS, importedContent, readImportedBoard, readImportedDeal, replayImported, seatNamed, type ImportCode, type ImportedPlay } from '../../shared/imports.ts'
import { parseLin } from '../../shared/lin-import.ts'
import { toLin, toSessionLin } from '../../shared/lin.ts'
import { parsePbn } from '../../shared/pbn-import.ts'
import { formatDeal, parseDeal, toPbnFile } from '../../shared/pbn.ts'
import { parsePracticeSettings } from '../../shared/practice.ts'
import type { BoardRecord } from '../../shared/protocol.ts'

/** Reading LIN (`e4-t39`) and PBN (`e10-t09`) in the browser, and the engine's check of what they give */

const DEAL = 'N:AKQJ.AKQ.AKQ.AKQ T987.JT9.JT9.JT9 6543.876.876.876 2.5432.5432.5432'

/** A board bid and played by the engine: the first legal card each time, stopping after `cards` */
function played(boardNo = 3, calls: Call[] = ['P', 'P', '1N', 'P', 'P', 'P'], cards = 52): BoardState {
  let state = newBoard(boardNo, parseDeal(DEAL)!)
  for (const call of calls) state = makeCall(state, turnOf(state)!, call)
  for (let i = 0; i < cards && state.phase === 'play'; i++) {
    const seat = turnOf(state)!
    state = playCard(state, seat, legalCards(state, seat)[0])
  }
  return state
}

const record = (board: BoardState, id = 'b1', extra: Partial<BoardRecord> = {}): BoardRecord => ({
  id,
  tableNumber: 2,
  finishedAt: Date.UTC(2026, 10, 1),
  players: Object.fromEntries(SEATS.map((seat) => [seat, { id: seat, username: `p${seat}` }])) as BoardRecord['players'],
  board,
  ...extra,
})

describe('parseLin', () => {
  it('reads a board: names, dealer, vulnerability, the fourth hand left out, an alert and a claim', () => {
    const lin = 'pn|amy,ben,cat,dan|st||md|3SAKQJT98765432,HAKQJT98765432,DAKQJT98765432,|rh||ah|Board 3|sv|b|mb|p|mb|p|mb|1N!|an|15-17|mb|p|mb|p|mb|p|mc|7|'
    const { boards, problems } = parseLin(lin)
    expect(problems).toEqual([])
    expect(boards).toHaveLength(1)
    const [board] = boards
    expect(board).toMatchObject({ boardNo: 3, dealer: 'N', vul: 'Both', claim: 7 })
    expect(board.names).toEqual({ S: 'amy', W: 'ben', N: 'cat', E: 'dan' })
    expect(board.hands).toBe('N:..AKQJT98765432. ...AKQJT98765432 AKQJT98765432... .AKQJT98765432..')
    expect(board.calls[2]).toEqual({ call: '1N', alert: '15-17' })
    const state = replayImported(board) as BoardState
    expect(state.result).toEqual({ declarerTricks: 7, scoreNS: expect.any(Number), claimed: true })
  })

  it('reads what lin.ts writes, every card and the score worked out again', () => {
    const board = played()
    const { boards, problems } = parseLin(toLin(record(board)))
    expect(problems).toEqual([])
    const state = replayImported(boards[0]) as BoardState
    expect(state.auction.map((c) => c.call)).toEqual(board.auction.map((c) => c.call))
    expect(state.play).toEqual(board.play)
    expect(state.contract).toEqual(board.contract)
    expect(state.result).toEqual(board.result)
    expect(state.hands).toEqual(board.hands)
    expect(state.dealer).toBe(board.dealer)
    expect(state.vul).toBe(board.vul)
    expect(boards[0].names).toEqual({ N: 'pN', E: 'pE', S: 'pS', W: 'pW' })
  })

  it('reads a passed-out board and a session of several, with their numbers', () => {
    const passed = played(5, ['P', 'P', 'P', 'P'])
    const lin = toSessionLin([record(played(3)), record(passed), record(played(7))], 'Some session')
    const { boards, problems } = parseLin(lin)
    expect(problems).toEqual([])
    expect(boards.map((b) => b.boardNo)).toEqual([3, 5, 7])
    expect((replayImported(boards[1]) as BoardState).result).toEqual({ declarerTricks: 0, scoreNS: 0, claimed: false })
  })

  it('finds a new board at `md` when there is no `qx`, and keeps the names until new ones come', () => {
    const one = toLin(record(played(3)))
    const { boards } = parseLin(`${one}${one.replace(/pn\|[^|]*\|/, '').replace('ah|Board 3', 'ah|Board 4').replace(/sv\|\w/, 'sv|o')}`)
    expect(boards.map((b) => b.boardNo)).toEqual([3, 4])
    expect(boards[1].names).toEqual(boards[0].names)
    expect(boards[1].vul).toBe('None')
  })

  it('takes a match: eight names, the closed room using the last four', () => {
    const body = toLin(record(played(3))).replace(/pn\|[^|]*\|/, '')
    const { boards } = parseLin(`pn|a,b,c,d,e,f,g,h|qx|o3|${body}qx|c3|${body}`)
    expect(boards[0].names).toEqual({ S: 'a', W: 'b', N: 'c', E: 'd' })
    expect(boards[1].names).toEqual({ S: 'e', W: 'f', N: 'g', E: 'h' })
  })

  it('reads a Handviewer link, URL-encoded text, a byte order mark and line breaks', () => {
    const lin = toLin(record(played()))
    const url = `https://www.bridgebase.com/tools/handviewer.html?lin=${encodeURIComponent(lin)}`
    for (const text of [url, encodeURIComponent(lin), `﻿${lin}`, lin.replace(/\|mb\|/g, '|\r\nmb|')]) {
      const { boards, problems } = parseLin(text)
      expect(problems).toEqual([])
      expect(boards).toHaveLength(1)
      expect(boards[0].play).toHaveLength(52)
    }
    expect(parseLin(`a ${url}\nb ${url}`).boards).toHaveLength(2)
  })

  it('takes either case, `10` for a ten, and the other ways to write a call', () => {
    const lin = 'md|3sakqjt98765432,hakqjt98765432,dakq10j98765432,|ah|Board 3|sv|B|mb|PASS|mb|P|mb|1NT|mb|DBL|mb|RDBL|mb|p|mb|p|mb|p|mc|7|'
    const { boards, problems } = parseLin(lin)
    expect(problems).toEqual([])
    expect(boards[0].calls.map((c) => c.call)).toEqual(['P', 'P', '1N', 'X', 'XX', 'P', 'P', 'P'])
    expect(boards[0].names).toEqual({ N: 'N', E: 'E', S: 'S', W: 'W' })
  })

  it('names the board in every kind of malformed input, and keeps the good boards', () => {
    const good = toLin(record(played(3)))
    const withNo = (n: number, text: string) => text.replace('ah|Board 3', `ah|Board ${n}`)
    const cases: [string, string][] = [
      // A card twice
      [withNo(11, good).replace(/md\|\d[^|]*\|/, 'md|3SA,SA,SA,|'), 'importBadDeal'],
      [withNo(11, good).replace(/md\|\d[^|]*\|/, 'md|3SAKZ,HA,DA,|'), 'importBadDeal'],
      [withNo(11, good).replace(/md\|\d/, 'md|3SA,'), 'importBadDeal'],
      // The call goes down, then a word that is no call
      [withNo(11, good).replace('mb|1N|', 'mb|1N|mb|1C|'), 'importBadAuction'],
      [withNo(11, good).replace('mb|1N|', 'mb|9Q|'), 'importBadAuction'],
      // Not finished
      [withNo(11, good).replace(/mb\|p\|pc.*$/, '|'), 'importUnfinished'],
      [withNo(11, good).replace(/pc\|[^|]*\|pg\|\|$/, ''), 'importUnfinished'],
      // A card no one holds there, or a word that is no card
      [withNo(11, good).replace(/pc\|\w\w\|/, 'pc|S1|'), 'importBadPlay'],
      [withNo(11, good).replace(/pc\|\w\w\|/, 'pc|C2|'), 'importBadPlay'],
      // More tricks than there are
      [`${withNo(11, good).replace(/pc\|.*$/, '')}mc|14|`, 'importBadClaim'],
      [`${withNo(11, good).replace(/pc\|.*$/, '')}mc|x|`, 'importBadClaim'],
      [withNo(11, good).replace(/sv\|\w/, 'sv|q'), 'importBadBoard'],
    ]
    for (const [bad, code] of cases) {
      const { boards, problems } = parseLin(`${good}\n${bad}\n${withNo(4, good)}`)
      expect(problems, bad).toEqual([{ board: 11, code }])
      expect(boards.map((b) => b.boardNo)).toEqual([3, 4])
    }
  })

  it('says a claim that does not add up is wrong', () => {
    // Declarer has taken nothing yet with all 52 cards played: the claim must match
    const board = played()
    const lin = `${toLin(record(board))}mc|${(board.result!.declarerTricks + 1) % 14}|`
    expect(parseLin(lin).problems).toEqual([{ board: 3, code: 'importBadClaim' }])
  })

  it('never throws, whatever it is given', () => {
    const lin = toSessionLin([record(played(3)), record(played(5))], 'x')
    const texts = ['', '   ', 'hello world', '|', '||||', 'md|', 'qx|', 'qx|o1|', 'md|md|md|', 'pn|', 'mb|1C|', '%7C', '%E0%A4%A', 'lin=%E0%A4%A', '?lin=%E0%A4%A']
    // Pieces and mixed-up pieces of a real file
    for (let i = 0; i < 400; i += 7) texts.push(lin.slice(i), lin.slice(0, lin.length - i), lin.slice(i, i + 200))
    for (const text of texts) expect(() => parseLin(text)).not.toThrow()
    expect(parseLin('hello world')).toEqual({ boards: [], problems: [] })
    expect(parseLin('qx|o7|').problems).toEqual([{ board: 7, code: 'importBadDeal' }])
    // `null` from a caller that did not check
    expect(() => parseLin(null as unknown as string)).not.toThrow()
  })

  it('keeps names as text: control characters out, cut to length', () => {
    const lin = `pn|${'x'.repeat(60)},a\u0007b,,~~M1|${toLin(record(played())).replace(/pn\|[^|]*\|/, '')}`
    const [board] = parseLin(lin).boards
    expect(board.names.S).toHaveLength(IMPORT_LIMITS.nameMax)
    expect(board.names.W).toBe('a b')
    expect(board.names.N).toBe('N')
    expect(board.names.E).toBe('~~M1')
  })
})

describe('replayImported', () => {
  const base = (over: Partial<ImportedPlay> = {}): ImportedPlay => ({
    boardNo: 3,
    dealer: 'N',
    vul: 'Both',
    hands: DEAL,
    calls: ['1N', 'P', 'P', 'P'].map((call) => ({ call })),
    play: [],
    claim: 7,
    ...over,
  })

  it('works the score out from the engine', () => {
    const state = replayImported(base()) as BoardState
    expect(state.contract).toMatchObject({ level: 1, strain: 'N', declarer: 'N' })
    expect(state.result).toEqual({ declarerTricks: 7, scoreNS: 90, claimed: true })
  })

  it('counts a claim with tricks already won', () => {
    const before = played(3, ['1N', 'P', 'P', 'P'], 8)
    const won = tricksWon(before).NS
    expect(won).toBeGreaterThan(0)
    const play = before.play.map((p) => p.card)
    expect((replayImported(base({ dealer: before.dealer, play, claim: 11 })) as BoardState).result!.declarerTricks).toBe(11)
    // Fewer than won so far, or more than won plus what is left
    expect(replayImported(base({ dealer: before.dealer, play, claim: won - 1 }))).toBe('importBadClaim')
    expect(replayImported(base({ dealer: before.dealer, play, claim: won + 12 }))).toBe('importBadClaim')
  })

  it('refuses what is not a finished legal board', () => {
    expect(replayImported(base({ hands: 'N:AKQJ.AKQ.AKQ.AKQ AKQJ.AKQ.AKQ.AKQ 6543.876.876.876 2.5432.5432.5432' }))).toBe('importBadDeal')
    expect(replayImported(base({ hands: 'x' }))).toBe('importBadDeal')
    expect(replayImported(base({ calls: [{ call: '1N' }, { call: '1C' }] }))).toBe('importBadAuction')
    expect(replayImported(base({ calls: [{ call: 'nonsense' }] }))).toBe('importBadAuction')
    expect(replayImported(base({ calls: Array(IMPORT_LIMITS.callsMax + 1).fill({ call: 'P' }) }))).toBe('importBadAuction')
    expect(replayImported(base({ calls: [{ call: '1N' }] }))).toBe('importUnfinished')
    expect(replayImported(base({ claim: undefined }))).toBe('importUnfinished')
    expect(replayImported(base({ play: ['SA'] }))).toBe('importBadPlay')
    expect(replayImported(base({ claim: 14 }))).toBe('importBadClaim')
    expect(replayImported(base({ claim: 1.5 }))).toBe('importBadClaim')
    expect(replayImported(base({ calls: ['P', 'P', 'P', 'P'].map((call) => ({ call })) }))).toBe('importBadPlay')
    expect(replayImported(base({ calls: ['P', 'P', 'P', 'P'].map((call) => ({ call })), claim: undefined, play: ['SA'] }))).toBe('importBadPlay')
  })
})

describe('replayImported and the engine', () => {
  /** The same board through `makeCall`, `playCard` and the claim, the way a table plays it */
  function byEngine(board: ImportedPlay): BoardState | ImportCode {
    const hands = parseDeal(board.hands)
    if (!hands) return 'importBadDeal'
    let state: BoardState = { boardNo: board.boardNo, dealer: board.dealer, vul: board.vul, hands, auction: [], contract: null, play: [], phase: 'auction' }
    try {
      for (const [i, { call, alert }] of board.calls.entries()) state = makeCall(state, nextSeat(board.dealer, i), call, alert)
    } catch {
      return 'importBadAuction'
    }
    if (state.phase === 'auction') return 'importUnfinished'
    if (state.phase === 'finished') return board.play.length || board.claim !== undefined ? 'importBadPlay' : state
    try {
      for (const card of board.play) state = playCard(state, turnOf(state)!, card)
    } catch {
      return 'importBadPlay'
    }
    if (state.phase === 'finished') return board.claim === undefined || state.result?.declarerTricks === board.claim ? state : 'importBadClaim'
    if (board.claim === undefined) return 'importUnfinished'
    const declarer = state.contract!.declarer
    const share = board.claim - tricksWon(state)[sideOf(declarer)]
    try {
      state = makeClaim(state, declarer, share)
      for (const seat of claimApprovers(state, declarer)) state = respondToClaim(state, seat, true)
    } catch {
      return 'importBadClaim'
    }
    return state
  }

  it('answers as the engine does, on legal boards and broken ones', () => {
    // A small generator of its own, so a failure comes back the same
    let seed = 20261105
    const random = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return Math.floor((seed / 0x1_0000_0000) * n)
    }
    const auctions: Call[][] = [
      ['P', 'P', 'P', 'P'],
      ['1N', 'P', 'P', 'P'],
      ['1C', 'X', 'XX', '2H', 'P', 'P', 'X', 'P', 'P', 'XX', 'P', 'P', 'P'],
      ['P', '1S', 'P', '2S', 'P', '4S', 'P', 'P', 'X', 'P', 'P', 'P'],
      ['1D', '1H', '2D', '2H', '3D', '3H', 'P', 'P', 'P'],
      ['7N', 'X', 'P', 'P', 'XX', 'P', 'P', 'P'],
    ]
    const answers = new Set<string>()
    for (let round = 0; round < 600; round++) {
      const hands = deal(random)
      const boardNo = random(16) + 1
      let state = newBoard(boardNo, hands)
      const calls = auctions[random(auctions.length)]
      for (const call of calls) state = makeCall(state, turnOf(state)!, call)
      const cards = random(3) === 0 ? 52 : random(53)
      while (state.phase === 'play' && state.play.length < cards) {
        const seat = turnOf(state)!
        const legal = legalCards(state, seat)
        state = playCard(state, seat, legal[random(legal.length)])
      }
      const board: ImportedPlay = {
        boardNo,
        dealer: state.dealer,
        vul: state.vul,
        hands: formatDeal(hands),
        calls: calls.map((call, i) => (i === 0 ? { call, alert: 'x' } : { call })),
        play: state.play.map((p) => p.card),
      }
      if (random(2)) board.claim = random(15)
      // Now and then something broken: a call, a card from anywhere, a card missing, the deal
      const breaking = random(5)
      if (breaking === 0 && board.play.length) board.play[random(board.play.length)] = `${'SHDC'[random(4)]}${RANKS[random(13)]}`
      if (breaking === 1) board.calls[random(board.calls.length)] = { call: ['P', 'X', '1C', '7N'][random(4)] }
      if (breaking === 2) board.calls = board.calls.slice(0, random(board.calls.length))
      if (breaking === 3 && board.play.length) board.play.splice(random(board.play.length), 1)
      const fast = replayImported(board)
      const slow = byEngine(board)
      expect(fast, JSON.stringify(board)).toEqual(slow)
      answers.add(typeof fast === 'string' ? fast : fast.result!.claimed ? 'claimed' : fast.contract ? 'played' : 'passed')
    }
    // Every way it can come out was met
    expect([...answers].sort()).toEqual(['claimed', 'importBadAuction', 'importBadClaim', 'importBadPlay', 'importUnfinished', 'passed', 'played'])
  })
})

describe('what a request may carry', () => {
  const board = { boardNo: 3, dealer: 'N', vul: 'Both', hands: DEAL, calls: [{ call: 'P' }], play: ['SA'], names: { N: 'a', E: 'b', S: 'c', W: 'd' }, seat: 'S' }

  it('takes a board, cleaning its names and alerts, and leaves out anything else', () => {
    const read = readImportedBoard({ ...board, calls: [{ call: 'P', alert: `a\u0000b${'x'.repeat(300)}`, robot: true }], result: { scoreNS: 7600 }, names: { ...board.names, N: '' } })!
    expect(read.calls[0].alert).toHaveLength(200)
    expect(read.calls[0].alert!.startsWith('a b')).toBe(true)
    expect(read.calls[0]).not.toHaveProperty('robot')
    expect(read).not.toHaveProperty('result')
    expect(read.names.N).toBe('N')
  })

  it('refuses what is not made of what a board is made of', () => {
    for (const bad of [
      null,
      [],
      'x',
      { ...board, boardNo: 0 },
      { ...board, boardNo: 10_000 },
      { ...board, boardNo: 1.5 },
      { ...board, dealer: 'Q' },
      { ...board, vul: 'x' },
      { ...board, seat: 'Q' },
      { ...board, hands: 7 },
      { ...board, hands: 'x'.repeat(101) },
      { ...board, calls: 'x' },
      { ...board, calls: [{ call: 7 }] },
      { ...board, calls: [{ call: 'P', alert: 7 }] },
      { ...board, calls: [{ call: 'toolong' }] },
      { ...board, calls: Array(IMPORT_LIMITS.callsMax + 1).fill({ call: 'P' }) },
      { ...board, play: ['ZZ'] },
      { ...board, play: Array(53).fill('SA') },
      { ...board, claim: 14 },
      { ...board, claim: -1 },
      { ...board, names: null },
      { ...board, names: { N: 'a' } },
      { ...board, names: { ...board.names, N: 'x'.repeat(201) } },
    ])
      expect(readImportedBoard(bad)).toBeNull()
  })

  it('takes a deal and refuses a bad one', () => {
    expect(readImportedDeal({ boardNo: 1, dealer: 'N', vul: 'None', hands: DEAL, title: ` A${'x'.repeat(60)}` })!.title).toHaveLength(IMPORT_LIMITS.titleMax)
    for (const bad of [null, { boardNo: 0, dealer: 'N', vul: 'None', hands: DEAL }, { boardNo: 1, dealer: 'N', vul: 'None', hands: 7 }, { boardNo: 1, dealer: 'N', vul: 'None', hands: DEAL, title: 7 }])
      expect(readImportedDeal(bad)).toBeNull()
  })

  it('has the same content for the same board whatever the seat, case or alerts', () => {
    const state = played()
    const names = { N: 'Amy', E: 'ben', S: 'cat', W: 'dan' }
    const content = importedContent(state, names)
    expect(importedContent(state, { ...names, N: 'AMY' })).toBe(content)
    expect(importedContent({ ...state, auction: state.auction.map((c) => ({ ...c, alert: 'x' })) }, names)).toBe(content)
    expect(importedContent(state, { ...names, N: 'other' })).not.toBe(content)
    expect(importedContent(played(7), names)).not.toBe(content)
    expect(importedContent(played(3, ['1N', 'P', 'P', 'P']), names)).not.toBe(content)
  })

  it('finds the seat by the name the member gave, in any case', () => {
    const names: Record<Seat, string> = { N: 'amy', E: 'Ben', S: 'cat', W: 'dan' }
    expect(seatNamed(names, ' ben ')).toBe('E')
    expect(seatNamed(names, 'zed')).toBeNull()
    expect(seatNamed(names, '')).toBeNull()
  })
})

describe('parsePbn', () => {
  it('reads back what the exporter writes: deal, number, dealer and vulnerability, one or many', () => {
    const boards = [played(3), played(4, ['P', 'P', 'P', '1N', 'P', 'P', 'P']), played(16, ['P', 'P', 'P', 'P'])]
    const { deals, problems } = parsePbn(toPbnFile(boards.map((b, i) => record(b, `b${i}`))))
    expect(problems).toEqual([])
    expect(deals).toHaveLength(3)
    for (const [i, deal] of deals.entries()) {
      expect(deal.boardNo).toBe(boards[i].boardNo)
      expect(deal.dealer).toBe(boards[i].dealer)
      expect(deal.vul).toBe(boards[i].vul)
      expect(parseDeal(deal.hands)).toEqual(boards[i].hands)
      expect(deal.title).toBe('Overtrick')
    }
    expect(parsePbn(toPbnFile([record(boards[1])])).deals).toHaveLength(1)
  })

  it('reads the file a bridge tool writes: tags without an event, comments, other seats first, other words', () => {
    const file = `% comment [Deal "x"]
[Board "12"]
[Dealer "w"]
[Vulnerable "Love"]
[Deal "E:T987.JT9.JT9.JT9 6543.876.876.876 2.5432.5432.5432 AKQJ.AKQ.AKQ.AKQ"]
{ a comment
[Deal "not this"]
}
[Auction "W"]
Pass Pass

[Board "##"]
[Dealer "#"]
[Vulnerable "Both"]
[Deal "${DEAL}"]
`
    const { deals, problems } = parsePbn(file)
    expect(problems).toEqual([])
    expect(deals).toEqual([
      { boardNo: 12, dealer: 'W', vul: 'None', hands: DEAL },
      { boardNo: 13, dealer: 'W', vul: 'Both', hands: DEAL },
    ])
  })

  it('takes the dealer and vulnerability from the number when a file leaves them out', () => {
    expect(parsePbn(`[Board "2"]\n[Deal "${DEAL}"]`).deals[0]).toMatchObject({ dealer: 'E', vul: 'NS' })
    // No number: its place in the file
    expect(parsePbn(`[Deal "${DEAL}"]\n[Deal "${DEAL}"]`).deals.map((d) => d.boardNo)).toEqual([1, 2])
    expect(parsePbn(`[Board "x"]\n[Dealer "?"]\n[Vulnerable "?"]\n[Deal "${DEAL}"]`).deals[0]).toMatchObject({ boardNo: 1, dealer: 'N', vul: 'None' })
  })

  it('names the board of whatever is wrong and keeps the good ones', () => {
    const good = `[Board "1"]\n[Deal "${DEAL}"]\n`
    for (const [bad, code] of [
      ['[Board "7"]\n[Deal "N:AKQ.. .. .. .."]\n', 'importBadDeal'],
      ['[Board "7"]\n[Deal "N:- - - -"]\n', 'importBadDeal'],
      ['[Board "7"]\n', 'importBadDeal'],
      [`[Board "7"]\n[Deal "N:AKQJ.AKQ.AKQ.AKQ AKQJ.AKQ.AKQ.AKQ 6543.876.876.876 2.5432.5432.5432"]\n`, 'importBadDeal'],
      [`[Board "7"]\n[Dealer "Q"]\n[Deal "${DEAL}"]\n`, 'importBadBoard'],
      [`[Board "7"]\n[Vulnerable "Some"]\n[Deal "${DEAL}"]\n`, 'importBadBoard'],
    ]) {
      const { deals, problems } = parsePbn(`${good}${bad}${good.replace('"1"', '"2"')}`)
      expect(problems, bad).toEqual([{ board: 7, code }])
      expect(deals.map((d) => d.boardNo)).toEqual([1, 2])
    }
  })

  it('never throws', () => {
    const file = toPbnFile([record(played())])
    const texts = ['', 'hello', '[', '[Deal', '[Deal "', '[Deal "x', '{', '}', '%', '[Board "##"]', '[Board "#"]']
    for (let i = 0; i < file.length; i += 11) texts.push(file.slice(i), file.slice(0, i))
    for (const text of texts) expect(() => parsePbn(text)).not.toThrow()
    expect(parsePbn('hello')).toEqual({ deals: [], problems: [] })
    expect(() => parsePbn(null as unknown as string)).not.toThrow()
  })
})

describe('the practice settings', () => {
  it('take the member\'s own deals as a deal set', () => {
    const parsed = parsePracticeSettings({ deal: 'set', set: { source: 'mine', ids: ['abc'] } })
    expect(parsed).toMatchObject({ settings: { deal: 'set', set: { source: 'mine', ids: ['abc'] } } })
    expect(parsePracticeSettings({ deal: 'set', set: { source: 'mine', ids: [] } })).toEqual({ field: 'set' })
  })
})
