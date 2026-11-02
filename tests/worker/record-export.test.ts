// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { BoardState } from '../../shared/game.ts'
import { DEFAULT_HISTORY_QUERY } from '../../shared/history-query.ts'
import { toLin, toSessionLin } from '../../shared/lin.ts'
import { parseDeal, toPbn, toPbnFile } from '../../shared/pbn.ts'
import { LIMITS, type BoardRecord } from '../../shared/protocol.ts'
import { SESSION_GAP_MS, SHARE_LOOKUP_BURST, SHARE_MISSES, sessionOf } from '../../worker/board-shares.ts'
import { indexRecord } from '../../worker/history-index.ts'
import { ClubError, ClubService, type Connections } from '../../worker/service.ts'
import type { MemoryStore } from '../../worker/store.ts'
import { sharedBoardView } from '../../worker/views.ts'
import { memoryStore } from './sqlite.ts'

/** J8: PBN export (e4-t36), a session's LIN (e4-t37) and a board's public link (e4-t38) */

const connections: Connections = { onlineUserIds: () => [], send: () => undefined, disconnect: () => undefined }
const MIN = 60_000

// Each seat holds one whole suit, so the deal is easy to read back
const HANDS = parseDeal('N:AKQJT98765432... .AKQJT98765432.. ..AKQJT98765432. ...AKQJT98765432')!

function board(over: Partial<BoardState> = {}): BoardState {
  return {
    boardNo: 3,
    dealer: 'S',
    vul: 'Both',
    hands: HANDS,
    auction: [
      { seat: 'S', call: 'P' },
      { seat: 'W', call: 'P' },
      { seat: 'N', call: '1N', alert: '15-17 "strong"', meaning: { hcp: [15, 17] } as never, inferred: 'tku' },
      { seat: 'E', call: 'X' },
      { seat: 'S', call: 'P', robot: true, book: { text: '淡江橋館的話' } as never },
      { seat: 'W', call: 'P' },
      { seat: 'N', call: 'P' },
    ],
    contract: { level: 1, strain: 'N', doubled: 'X', declarer: 'N' },
    play: [
      { seat: 'E', card: 'HA' },
      { seat: 'S', card: 'DA' },
      { seat: 'W', card: 'CA' },
      { seat: 'N', card: 'S2' },
    ],
    phase: 'finished',
    result: { declarerTricks: 0, scoreNS: -2000, claimed: true },
    ...over,
  }
}

function record(id: string, at: number, ids: [string, string, string, string], extra: Partial<BoardRecord> = {}): BoardRecord {
  const [N, E, S, W] = ids.map((x) => (x.startsWith('robot:') ? { id: x, username: 'Robot', robot: true } : { id: x, username: x }))
  return { id, tableNumber: 2, finishedAt: at, players: { N, E, S, W }, board: board(), ...extra }
}

describe('PBN and LIN', () => {
  it('writes a board as PBN: tags, deal, auction with notes, play from the leader', () => {
    const pbn = toPbn(record('b1', Date.UTC(2026, 10, 1, 20), ['amy', 'ben', 'cat', 'robot:tku:W']))
    expect(pbn).toContain('[Event "TKU BridgeTable"]')
    expect(pbn).toContain('[Site "Table 2"]')
    // Taiwan date: 2026-11-01 20:00 UTC is 2026-11-02 in Taipei
    expect(pbn).toContain('[Date "2026.11.02"]')
    expect(pbn).toContain('[Board "3"]')
    expect(pbn).toContain('[North "amy"]')
    expect(pbn).toContain('[West "Robot"]')
    expect(pbn).toContain('[Vulnerable "All"]')
    expect(pbn).toContain('[Deal "N:AKQJT98765432... .AKQJT98765432.. ..AKQJT98765432. ...AKQJT98765432"]')
    expect(pbn).toContain('[Contract "1NTX"]')
    expect(pbn).toContain('[Declarer "N"]')
    expect(pbn).toContain('[Result "0"]')
    expect(pbn).toContain('[Score "NS -2000"]')
    expect(pbn).toContain('[Auction "S"]\nPass Pass 1NT =1= X\nPass Pass Pass')
    // The explanation's quotes are escaped
    expect(pbn).toContain('[Note "1:15-17 \\"strong\\""]')
    // Columns from the leader (E): E S W N; the rest was claimed
    expect(pbn).toContain('[Play "E"]\nHA DA CA S2\n*')
  })

  it('writes a passed-out board and a file of several', () => {
    const passed = record('b2', 0, ['amy', 'ben', 'cat', 'dan'], {
      mode: 'practice',
      board: board({ auction: ['S', 'W', 'N', 'E'].map((seat) => ({ seat, call: 'P' })) as BoardState['auction'], contract: null, play: [], result: { declarerTricks: 0, scoreNS: 0, claimed: false } }),
    })
    const pbn = toPbn(passed)
    expect(pbn).toContain('[Site "Practice"]')
    expect(pbn).toContain('[Contract "Pass"]')
    expect(pbn).toContain('[Declarer ""]')
    expect(pbn).not.toContain('[Play')
    const file = toPbnFile([passed, record('b1', 0, ['amy', 'ben', 'cat', 'dan'])])
    expect(file.startsWith('% PBN 2.1\n% EXPORT\n')).toBe(true)
    expect(file.match(/\[Event /g)).toHaveLength(2)
    expect(file).toContain('\n\n[Event ')
  })

  it('writes a session as one LIN, one line per board', () => {
    const a = record('a', 0, ['amy', 'ben', 'cat', 'dan'])
    const b = record('b', 1, ['amy', 'ben', 'cat', 'eve'])
    const lin = toSessionLin([a, b], 'TKU BridgeTable Table 2')
    const lines = lin.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('vg|TKU BridgeTable Table 2,,P,1,2,,0,,0|')
    expect(lines[1]).toBe(`qx|o1|${toLin(a)}`)
    expect(lines[2]).toContain('pn|cat,eve,amy,ben')
  })
})

describe('sessionOf', () => {
  const ids: [string, string, string, string] = ['amy', 'ben', 'cat', 'dan']
  it('keeps the boards of the same table, one after another', () => {
    const t = (id: string, at: number, tableId = 'T1') => record(id, at, ids, { tableId })
    const target = t('c', 20 * MIN)
    const boards = [t('a', 0), t('b', 10 * MIN), t('d', 30 * MIN), t('x', 25 * MIN, 'T2'), t('late', 30 * MIN + SESSION_GAP_MS + 1)]
    expect(sessionOf(target, boards).map((r) => r.id)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('takes a record from before tableId by its members', () => {
    const target = record('c', 20 * MIN, ids)
    const boards = [record('a', 0, ids), record('other', 10 * MIN, ['eve', 'fay', 'gus', 'hal']), record('new', 30 * MIN, ids, { tableId: 'T1' })]
    expect(sessionOf(target, boards).map((r) => r.id)).toEqual(['a', 'c'])
  })

  it('keeps at most LIMITS.sessionBoardsMax boards around the one asked for', () => {
    const boards = Array.from({ length: LIMITS.sessionBoardsMax + 20 }, (_, i) => record(`b${i}`, i * MIN, ids, { tableId: 'T' }))
    const session = sessionOf(boards[LIMITS.sessionBoardsMax + 10], boards)
    expect(session).toHaveLength(LIMITS.sessionBoardsMax)
    expect(session.map((r) => r.id)).toContain(`b${LIMITS.sessionBoardsMax + 10}`)
  })
})

describe('sharedBoardView', () => {
  it('shows the deal, the auction and the play, nothing else of the record', () => {
    const r = record('b1', 5, ['amy', 'ben', 'cat', 'robot:tku:W'], {
      tableId: 'T1',
      eventId: 'e1',
      hostId: 'amy',
      events: [{ type: 'call', at: 1, seat: 'S', call: 'P' }] as never,
      ruling: { kind: 'score', reason: 'secret' } as never,
      substitutes: { E: { id: 'ben', username: 'ben' } },
    })
    const view = sharedBoardView(r, 'ben', () => false, 10)!
    const text = JSON.stringify(view)
    for (const leak of ['T1', 'e1', 'secret', 'robot:tku', '"id"', 'meaning', 'inferred', '淡江橋館', 'amy', 'cat', 'events'])
      expect(text).not.toContain(leak)
    // Only the member who made the link is named; the others are 「社員」, robots keep their name
    expect(view.players).toEqual({ N: { name: null }, E: { name: 'ben' }, S: { name: null }, W: { name: 'Robot', robot: true } })
    expect(view.board.hands).toEqual(HANDS)
    expect(view.board.auction[2]).toEqual({ seat: 'N', call: '1N', alert: '15-17 "strong"' })
    expect(view.board.play).toHaveLength(4)
  })

  it('names nobody when the maker keeps their boards private or did not play', () => {
    const r = record('b1', 5, ['amy', 'ben', 'cat', 'robot:tku:W'])
    const names = (sharedBy: string, hides: (id: string) => boolean) => Object.values(sharedBoardView(r, sharedBy, hides, 10)!.players).map((p) => p.name)
    expect(names('ben', (id) => id === 'ben')).toEqual([null, null, null, 'Robot'])
    expect(names('admin', () => false)).toEqual([null, null, null, 'Robot'])
  })

  it('is null for a board kept back or not finished', () => {
    expect(sharedBoardView(record('b', 0, ['amy', 'ben', 'cat', 'dan'], { revealAt: 100 }), 'amy', () => false, 50)).toBeNull()
    expect(sharedBoardView(record('b', 0, ['amy', 'ben', 'cat', 'dan'], { revealAt: 100 }), 'amy', () => false, 100)).not.toBeNull()
    expect(sharedBoardView(record('b', 0, ['amy', 'ben', 'cat', 'dan'], { board: board({ result: undefined }) }), 'amy', () => false, 0)).toBeNull()
  })
})

describe('the club', () => {
  let store: MemoryStore
  let club: ClubService
  let time: number
  let admin: string
  let amy: string
  let ben: string
  let cat: string
  let dan: string
  let eve: string

  async function member(name: string) {
    const result = await club.register(name, 'club-secret-1', '')
    if ('user' in result) return result.user.id
    return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
  }

  /** Names the members by their usernames, as the tables do */
  async function save(r: BoardRecord) {
    for (const seat of ['N', 'E', 'S', 'W'] as const) {
      const user = (await club.adminUsers()).find((u) => u.id === r.players[seat].id)
      if (user) r.players[seat] = { id: user.id, username: user.username }
    }
    await store.put(`board:${r.id}`, r)
    indexRecord(store.sql, r)
  }

  async function codeOf(promise: Promise<unknown>) {
    try {
      await promise
    } catch (e) {
      if (e instanceof ClubError) return e.code
      throw e
    }
    return 'ok'
  }

  beforeEach(async () => {
    store = memoryStore()
    time = 10_000_000
    club = new ClubService(store, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
    await club.load()
    const founder = await club.register('admin', 'club-secret-1', '')
    if (!('user' in founder)) throw new Error('the first account should sign in at once')
    admin = founder.user.id
    ;[amy, ben, cat, dan, eve] = [await member('amy'), await member('ben'), await member('cat'), await member('dan'), await member('eve')]
  })

  describe('PBN export of a search (e4-t36)', () => {
    it('exports what the search finds, without boards kept back or hidden players', async () => {
      await save(record('open', 1, [amy, ben, cat, dan]))
      await save(record('held', 2, [amy, ben, cat, dan], { revealAt: time + 1000 }))
      await save(record('passed', 3, [amy, ben, cat, dan], { board: board({ contract: null, result: { declarerTricks: 0, scoreNS: 0, claimed: false } }) }))
      const mine = await club.exportBoards(amy, { ...DEFAULT_HISTORY_QUERY, scope: 'mine' })
      expect(mine.records.map((r) => r.id)).toEqual(['passed', 'held', 'open'])
      // Someone else does not get the board kept back
      const all = await club.exportBoards(eve, { ...DEFAULT_HISTORY_QUERY, scope: 'all' })
      expect(all.records.map((r) => r.id)).toEqual(['passed', 'open'])
      // The filters apply, and page and size do not limit the file
      const doubled = await club.exportBoards(eve, { ...DEFAULT_HISTORY_QUERY, scope: 'all', doubled: 'X', page: 5, size: 10 })
      expect(doubled).toMatchObject({ total: 1, records: [{ id: 'open' }] })
      // A member who keeps their boards private cannot be searched for by others
      await club.setAccountPreferences(amy, { profileBoards: false })
      expect((await club.exportBoards(eve, { ...DEFAULT_HISTORY_QUERY, scope: 'all', player: amy })).records).toEqual([])
      expect((await club.exportBoards(admin, { ...DEFAULT_HISTORY_QUERY, scope: 'all', player: amy })).records).toHaveLength(2)
    })
  })

  describe('a session (e4-t37)', () => {
    it('gives the boards of the table one after another that the member may see', async () => {
      const at = (id: string, minutes: number, extra: Partial<BoardRecord> = {}) =>
        save(record(id, time - 200 * MIN + minutes * MIN, [amy, ben, cat, dan], { tableId: 'T1', ...extra }))
      await at('s1', 0)
      await at('s2', 10)
      await at('s3', 20, { revealAt: time + 1000 })
      await at('s4', 30)
      await at('other', 15, { tableId: 'T2' })
      await at('later', 30 + SESSION_GAP_MS / MIN + 1)
      expect((await club.session('s2', amy))!.map((r) => r.id)).toEqual(['s1', 's2', 's3', 's4'])
      // Eve did not play the board kept back
      expect((await club.session('s2', eve))!.map((r) => r.id)).toEqual(['s1', 's2', 's4'])
      expect(await club.session('s3', eve)).toBeNull()
      expect(await club.session('nope', amy)).toBeNull()
    })
  })

  describe('public links (e4-t38)', () => {
    beforeEach(async () => {
      await save(record('b1', 1, [amy, ben, cat, 'robot:tku:W']))
      await save(record('held', 2, [amy, ben, cat, dan], { revealAt: time + 1000 }))
    })

    it('lets the players and the admins make one link per board', async () => {
      expect(await club.shares.get(amy, 'b1')).toBeNull()
      const share = await club.shares.create(amy, 'b1')
      expect(share.token).toMatch(/^[0-9a-f]{32}$/)
      expect(share.createdBy).toMatchObject({ id: amy })
      // The same link for everyone who asks again
      expect((await club.shares.create(ben, 'b1')).token).toBe(share.token)
      expect((await club.shares.get(admin, 'b1'))?.token).toBe(share.token)
      // A member who did not play it may see it but not manage its link
      expect(await codeOf(club.shares.get(eve, 'b1'))).toBe('shareNotPlayer')
      expect(await codeOf(club.shares.create(eve, 'b1'))).toBe('shareNotPlayer')
      expect(await codeOf(club.shares.revoke(eve, 'b1'))).toBe('shareNotPlayer')
      expect(await codeOf(club.shares.create(amy, 'missing'))).toBe('boardGone')
    })

    it('does not share a board kept back, and tells others nothing about it', async () => {
      expect(await codeOf(club.shares.create(amy, 'held'))).toBe('shareHeldBack')
      expect(await codeOf(club.shares.create(eve, 'held'))).toBe('boardGone')
      time += 1000
      expect(await codeOf(club.shares.create(amy, 'held'))).toBe('ok')
    })

    it('shows the board to anyone with the token, until it is revoked', async () => {
      const { token } = await club.shares.create(ben, 'b1')
      const shared = await club.shares.open(token, '1.2.3.4')
      // Ben made it: only he is named (社長 2026-11-02), even after Amy asks for the same link
      expect(shared.players).toEqual({ N: { name: null }, E: { name: 'ben' }, S: { name: null }, W: { name: 'Robot', robot: true } })
      expect(JSON.stringify(shared)).not.toContain(ben)
      expect((await club.shares.create(amy, 'b1')).token).toBe(token)
      expect((await club.shares.open(token, '1.2.3.4')).players.N).toEqual({ name: null })
      // Not even he, once he keeps his boards private
      await club.setAccountPreferences(ben, { profileBoards: false })
      expect((await club.shares.open(token, '1.2.3.4')).players.E).toEqual({ name: null })
      await club.shares.revoke(cat, 'b1')
      expect(await codeOf(club.shares.open(token, '1.2.3.4'))).toBe('shareGone')
      expect(await club.shares.get(amy, 'b1')).toBeNull()
      // A new link is a new token
      expect((await club.shares.create(amy, 'b1')).token).not.toBe(token)
    })

    it('rate-limits lookups per address, wrong tokens more strictly', async () => {
      const { token } = await club.shares.create(amy, 'b1')
      for (let i = 0; i < SHARE_MISSES; i++) expect(await codeOf(club.shares.open('0'.repeat(32), '5.5.5.5'))).toBe('shareGone')
      // That address now waits, even with the right token; others do not
      expect(await codeOf(club.shares.open(token, '5.5.5.5'))).toBe('slowDown')
      expect(await codeOf(club.shares.open(token, '6.6.6.6'))).toBe('ok')
      for (let i = 0; i < SHARE_LOOKUP_BURST; i++) await club.shares.open(token, '7.7.7.7')
      expect(await codeOf(club.shares.open(token, '7.7.7.7'))).toBe('slowDown')
      time += 2000
      expect(await codeOf(club.shares.open(token, '7.7.7.7'))).toBe('ok')
    })

    it('goes with the account that made it, and is in its data export', async () => {
      await club.shares.create(dan, 'held').catch(() => undefined)
      const { token } = await club.shares.create(ben, 'b1')
      expect((await club.exportAccount(ben, null)).boardShares).toEqual([{ boardId: 'b1', createdAt: time }])
      await club.deleteOwnAccount(ben, 'club-secret-1')
      expect(await codeOf(club.shares.open(token, '1.2.3.4'))).toBe('shareGone')
    })
  })
})
