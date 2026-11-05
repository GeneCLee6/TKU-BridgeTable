// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { SEATS, type Seat } from '../../shared/cards.ts'
import { makeCall, newBoard, type BoardState } from '../../shared/game.ts'
import { DEFAULT_HISTORY_QUERY } from '../../shared/history-query.ts'
import { IMPORT_LIMITS, type ImportedBoard } from '../../shared/imports.ts'
import { parseLin } from '../../shared/lin-import.ts'
import { toLin } from '../../shared/lin.ts'
import { parsePbn } from '../../shared/pbn-import.ts'
import { parseDeal, toPbnFile } from '../../shared/pbn.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { indexRecord } from '../../worker/history-index.ts'
import { ownDealsKey } from '../../worker/imported-boards.ts'
import { IMPORT_BURST } from '../../worker/rate-limit.ts'
import type { ClubService } from '../../worker/service.ts'
import { clubService } from './event-mode.ts'
import { teamHarness } from './team-match-harness.ts'

/**
 * Bringing in boards and deals from files (`e4-t39`, `e10-t09`): the server checks what the browser
 * read, an imported board is only its importer's, and it never counts for anything of the club's.
 * What other members can get of one is also in `tests/worker/visibility/visibility.test.ts`
 */

const DEAL = 'N:AKQJ.AKQ.AKQ.AKQ T987.JT9.JT9.JT9 6543.876.876.876 2.5432.5432.5432'

let t: Awaited<ReturnType<typeof teamHarness>>
beforeEach(async () => {
  t = await teamHarness()
})

function imported(over: Partial<ImportedBoard> = {}): ImportedBoard {
  return {
    boardNo: 3,
    dealer: 'N',
    vul: 'Both',
    hands: DEAL,
    calls: ['1N', 'P', 'P', 'P'].map((call) => ({ call })),
    play: [],
    claim: 7,
    names: { N: 'west_coast', E: 'ben', S: 'carol', W: 'dan' },
    seat: 'S',
    ...over,
  }
}

const later = () => {
  t.h.time += 60_000
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Runs the deleting of imported boards to its end */
async function purge() {
  for (let i = 0; i < 200 && t.h.queue.some((job) => job.kind === 'importPurge'); i++) {
    await t.run('importPurge')
    await settle()
  }
}

/** `count` different boards imported by the member, a batch at a time; their ids */
async function addBoards(userId: string, count: number): Promise<string[]> {
  const ids: string[] = []
  for (let at = 0; at < count; at += IMPORT_LIMITS.batchBoards) {
    t.h.time += 3_600_000
    const boards = Array.from({ length: Math.min(IMPORT_LIMITS.batchBoards, count - at) }, (_, i) => imported({ boardNo: at + i + 1 }))
    ids.push(...(await t.club().importBoards(userId, { boards })).ids)
  }
  return ids
}

const failure = (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (error: { code: string; params?: unknown }) => ({ code: error.code, params: error.params }),
  )

describe('importBoards', () => {
  it('keeps a board as a record of mode imported, with the result worked out by the server', async () => {
    const amy = await t.member('amy')
    const { added, duplicates, ids } = await t.club().importBoards(amy, { boards: [imported()] })
    expect({ added, duplicates }).toEqual({ added: 1, duplicates: 0 })
    const record = (await t.club().record(ids[0], amy))!
    expect(record.mode).toBe('imported')
    expect(record.board.contract).toMatchObject({ level: 1, strain: 'N', declarer: 'N' })
    expect(record.board.result).toEqual({ declarerTricks: 7, scoreNS: 90, claimed: true })
    expect(record.board.vul).toBe('Both')
    // Found with the other boards and by the same filters
    expect((await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY, mode: 'imported' })).boards.map((b) => b.id)).toEqual(ids)
    expect((await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY })).boards.map((b) => b.id)).toEqual(ids)
    expect((await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY, level: 1, strain: 'N' })).total).toBe(1)
    expect((await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY, level: 2 })).total).toBe(0)
  })

  it('ignores a result, a mode or an id the browser made up', async () => {
    const amy = await t.member('amy')
    const forged = { ...imported(), result: { declarerTricks: 13, scoreNS: 7600, claimed: false }, mode: 'team', id: 'forged', revealAt: 0, players: {} }
    const { ids } = await t.club().importBoards(amy, { boards: [forged] })
    const record = (await t.club().record(ids[0], amy))!
    expect(ids[0]).toMatch(/^imp-[0-9a-f]{32}$/)
    expect(record.board.result!.scoreNS).toBe(90)
    expect(record.mode).toBe('imported')
    expect(record.revealAt).toBeGreaterThan(t.h.time)
  })

  it('never makes two of the same board, in one request or another; each member has their own', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    const first = await t.club().importBoards(amy, { boards: [imported(), imported()] })
    expect(first).toMatchObject({ added: 1, duplicates: 1 })
    later()
    // The same board, whichever seat they say and however the names and alerts are written
    const again = await t.club().importBoards(amy, { boards: [imported({ seat: 'N', names: { N: 'WEST_COAST', E: 'BEN', S: 'CAROL', W: 'DAN' }, calls: [{ call: '1N', alert: 'x' }, { call: 'P' }, { call: 'P' }, { call: 'P' }] })] })
    expect(again).toMatchObject({ added: 0, duplicates: 1, ids: [first.ids[0]] })
    expect((await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY, mode: 'imported' })).total).toBe(1)
    // The record stays as it was first imported
    expect((await t.club().record(first.ids[0], amy))!.players.S.id).toBe(amy)
    const theirs = await t.club().importBoards(ben, { boards: [imported()] })
    expect(theirs.added).toBe(1)
    expect(theirs.ids[0]).not.toBe(first.ids[0])
    // The same deal played by others is another board
    later()
    expect((await t.club().importBoards(amy, { boards: [imported({ names: { N: 'x', E: 'y', S: 'z', W: 'q' } })] })).added).toBe(1)
  })

  it('leaves no count of the club or the member changed', async () => {
    const amy = await t.member('amy')
    const before = await t.club().adminUsers()
    await t.club().importBoards(amy, { boards: [imported()] })
    expect(await t.club().adminUsers()).toEqual(before)
  })

  it('reads a real LIN all the way: from the exporter, through the parser, to the same result', async () => {
    const amy = await t.member('amy')
    let board: BoardState = newBoard(3, parseDeal(DEAL)!)
    for (const seat of ['S', 'W', 'N', 'E'] as Seat[]) board = makeCall(board, seat, 'P')
    const record = { id: 'x', tableNumber: 1, finishedAt: 0, board, players: Object.fromEntries(SEATS.map((s) => [s, { id: s, username: `p${s}` }])) } as BoardRecord
    const [read] = parseLin(toLin(record)).boards
    const { ids } = await t.club().importBoards(amy, { boards: [{ ...read, seat: 'E' }] })
    const kept = (await t.club().record(ids[0], amy))!
    expect(kept.board.result).toEqual(board.result)
    expect(kept.players.E.id).toBe(amy)
    expect(kept.players.E.username).toBe('pE')
  })

  it('refuses a whole request for one bad board, naming it, and keeps nothing', async () => {
    const amy = await t.member('amy')
    for (const [bad, code] of [
      [imported({ boardNo: 8, hands: DEAL.replace('AKQJ.', 'AAQJ.') }), 'importBadDeal'],
      [imported({ boardNo: 8, calls: [{ call: '1N' }, { call: '1C' }] }), 'importBadAuction'],
      [imported({ boardNo: 8, play: ['S2'] }), 'importBadPlay'],
      [imported({ boardNo: 8, claim: 14 }), 'importBadBoard'],
      [imported({ boardNo: 8, claim: undefined }), 'importUnfinished'],
    ] as const) {
      later()
      expect(await failure(t.club().importBoards(amy, { boards: [imported(), bad] })), code).toMatchObject({ code, params: { board: 8 } })
    }
    later()
    expect(await failure(t.club().importBoards(amy, { boards: [imported(), 'x'] }))).toMatchObject({ code: 'importBadBoard', params: { board: 2 } })
    expect((await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY, mode: 'imported' })).total).toBe(0)
  })

  it('enforces its limits: a batch, the rate and the member\'s total', async () => {
    const amy = await t.member('amy')
    for (const body of [null, {}, { boards: [] }, { boards: 'x' }]) {
      later()
      expect(await failure(t.club().importBoards(amy, body))).toMatchObject({ code: 'importNoBoards' })
    }
    later()
    expect(await failure(t.club().importBoards(amy, { boards: Array(IMPORT_LIMITS.batchBoards + 1).fill(imported()) }))).toMatchObject({
      code: 'importTooManyBoards',
      params: { max: IMPORT_LIMITS.batchBoards },
    })
    // The bucket refills only with time
    t.h.time += 3_600_000
    for (let i = 0; i < IMPORT_BURST; i++) await t.club().importBoards(amy, { boards: [imported()] })
    expect(await failure(t.club().importBoards(amy, { boards: [imported()] }))).toMatchObject({ code: 'slowDown' })
    later()
    expect(await t.club().importBoards(amy, { boards: [imported()] })).toMatchObject({ duplicates: 1 })

    // At the total: a board already there still counts as a duplicate, a new one is refused
    const base = (await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY, mode: 'imported' })).boards[0]
    const record = (await t.club().record(base.id, amy))!
    for (let i = 1; i < IMPORT_LIMITS.linTotal; i++) indexRecord(t.club()['store'].sql, { ...record, id: `imp-fake-${i}` })
    t.h.time += 3_600_000
    expect(await t.club().importBoards(amy, { boards: [imported()] })).toMatchObject({ added: 0, duplicates: 1 })
    expect(await failure(t.club().importBoards(amy, { boards: [imported({ boardNo: 4 })] }))).toMatchObject({
      code: 'importsFull',
      params: { max: IMPORT_LIMITS.linTotal },
    })
  })

  it('counts for nothing of the club: no summaries, no points, and names never tie to members', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    const { ids } = await t.club().importBoards(amy, { boards: [imported({ names: { N: 'ben', E: 'amy', S: 'carol', W: 'dan' }, seat: 'S' })] })
    const record = (await t.club().record(ids[0], amy))!
    // `ben` in the file is text: no id, so nothing finds him there
    expect(record.players.N).toEqual({ id: '', username: 'ben' })
    expect(record.players.E).toEqual({ id: '', username: 'amy' })
    expect(record.players.S).toEqual({ id: amy, username: 'carol' })
    expect((await t.club().search(ben, { ...DEFAULT_HISTORY_QUERY, player: ben })).total).toBe(0)
    expect((await t.club().search(ben, { ...DEFAULT_HISTORY_QUERY, mode: 'imported' })).total).toBe(0)
    expect((await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY, player: ben })).total).toBe(0)
    expect((await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY, partner: ben })).total).toBe(0)
    const keys = [...(t.club()['store'] as unknown as { data: Map<string, unknown> }).data.keys()]
    expect(keys.some((key) => key.startsWith('hist:') && key.includes(ids[0]))).toBe(false)
    expect(keys.some((key) => key.startsWith('uhist:') && key.includes(ids[0]))).toBe(false)
    expect(t.club().rankings.exportOf(amy).points).toEqual([])
  })
})

describe('removing an imported board', () => {
  it('lets only its importer remove it, and only an imported board', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    const { ids } = await t.club().importBoards(amy, { boards: [imported()] })
    await t.club().saveFavorite(amy, ids[0], {})
    expect(await failure(t.club().removeImported(ben, ids[0]))).toMatchObject({ code: 'boardGone' })
    expect(await failure(t.club().removeImported(t.h.boss, ids[0]))).toMatchObject({ code: 'boardGone' })
    expect(await failure(t.club().removeImported(amy, 'no such board'))).toMatchObject({ code: 'boardGone' })
    await t.club().removeImported(amy, ids[0])
    expect(await t.club().record(ids[0], amy)).toBeNull()
    expect(t.club().favoriteIds(amy)).toEqual([])
    expect((await t.club().search(amy, { ...DEFAULT_HISTORY_QUERY, mode: 'imported' })).total).toBe(0)
    // Gone from the copy too (§5.12), and it can be imported again
    await t.copyToD1()
    const rows = await t.d1.batch([{ sql: "SELECT COUNT(*) AS n FROM boards_index WHERE mode = 'imported'", params: [] }])
    expect(rows[0][0].n).toBe(0)
    later()
    expect((await t.club().importBoards(amy, { boards: [imported()] })).added).toBe(1)
  })

  it('refuses a director\'s ruling on one: it was not played here', async () => {
    const amy = await t.member('amy')
    const { ids } = await t.club().importBoards(amy, { boards: [imported()] })
    expect(await failure(t.club().ruleBoard(t.h.boss, ids[0], null))).toMatchObject({ code: 'boardGone' })
  })
})

describe('the member\'s own data', () => {
  it('exports what they imported, whole', async () => {
    const amy = await t.member('amy')
    const { ids } = await t.club().importBoards(amy, { boards: [imported()] })
    await t.club().importOwnDeals(amy, { deals: [{ boardNo: 3, dealer: 'N', vul: 'Both', hands: DEAL, title: 'mine' }] })
    const data = await t.club().exportAccount(amy, null)
    expect(data.importedBoardCount).toBe(1)
    expect(data.boards.map((b) => b.id)).not.toContain(ids[0])
    expect(data.ownDeals).toMatchObject([{ boardNo: 3, hands: DEAL, title: 'mine' }])
    const page = await t.club().exportImported(amy, null)
    expect(page.next).toBeNull()
    expect(page.boards.map((b) => b.id)).toEqual(ids)
    expect(parseLin(page.boards[0].lin).boards[0].claim).toBe(7)
    expect((await t.club().exportImported(t.h.boss, null)).boards).toEqual([])
  })

  it('exports them a page at a time, every board once, and the boards played at tables are still summarized', async () => {
    const amy = await t.member('amy')
    const total = IMPORT_LIMITS.exportPage * 2 + 3
    await addBoards(amy, total)
    const seen: string[] = []
    let after: string | null = null
    let pages = 0
    do {
      const page: Awaited<ReturnType<ClubService['exportImported']>> = await t.club().exportImported(amy, after)
      expect(page.boards.length).toBeLessThanOrEqual(IMPORT_LIMITS.exportPage)
      seen.push(...page.boards.map((b) => b.id))
      after = page.next
      pages++
    } while (after)
    expect(pages).toBe(3)
    expect(new Set(seen).size).toBe(total)
    // Whatever `after` says, it is only ever their own boards
    expect((await t.club().exportImported(amy, "x' OR 1=1")).boards).toHaveLength(IMPORT_LIMITS.exportPage)
  })

  it('deletes it with the account, leaving another member\'s copy', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    const mine = await t.club().importBoards(amy, { boards: [imported()] })
    const theirs = await t.club().importBoards(ben, { boards: [imported()] })
    await t.club().saveFavorite(amy, mine.ids[0], {})
    await t.club().importOwnDeals(amy, { deals: [{ boardNo: 3, dealer: 'N', vul: 'Both', hands: DEAL }] })
    await t.club().deleteOwnAccount(amy, 'club-secret-1')
    await purge()
    const store = t.club()['store']
    expect(await store.get(`board:${mine.ids[0]}`)).toBeUndefined()
    expect(store.sql.exec('SELECT board_id FROM boards_index WHERE board_id = ?', mine.ids[0])).toEqual([])
    expect(store.sql.exec('SELECT board_id FROM board_players WHERE board_id = ?', mine.ids[0])).toEqual([])
    expect(await store.get(ownDealsKey(amy))).toBeUndefined()
    expect(await t.club().record(theirs.ids[0], ben)).not.toBeNull()
    await t.copyToD1()
    const rows = await t.d1.batch([{ sql: 'SELECT board_id FROM boards_index', params: [] }])
    expect(rows[0].map((r) => r.board_id)).toEqual(theirs.ids)
  })
})

describe('deleting an account at the limit', () => {
  it('deletes its boards in small scheduled steps, nobody seeing them meanwhile', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    const total = IMPORT_LIMITS.purgeStep * 2 + 5
    const ids = await addBoards(amy, total)
    await t.club().importBoards(ben, { boards: [imported()] })
    await t.club().deleteOwnAccount(amy, 'club-secret-1')
    const store = t.club()['store']
    const left = async () => (await Promise.all(ids.map((id) => store.get(`board:${id}`)))).filter(Boolean).length

    // Nothing was deleted in the request itself, and no job does more than one step
    expect(await left()).toBe(total)
    expect(t.h.queue.filter((job) => job.kind === 'importPurge')).toHaveLength(1)
    await t.run('importPurge')
    await settle()
    expect(await left()).toBe(total - IMPORT_LIMITS.purgeStep)
    expect(await t.club().record(ids[0], ben)).toBeNull()
    expect(await t.club().record(ids[0], t.h.boss)).toBeNull()

    await purge()
    expect(await left()).toBe(0)
    expect(await store.get(`importPurge:${amy}`)).toBeUndefined()
    expect(store.sql.exec("SELECT COUNT(*) AS n FROM boards_index WHERE mode = 'imported'")[0].n).toBe(1)
    expect(t.h.queue.filter((job) => job.kind === 'importPurge')).toHaveLength(0)
  })

  it('carries on after the object is evicted', async () => {
    const amy = await t.member('amy')
    await addBoards(amy, 3)
    await t.club().deleteOwnAccount(amy, 'club-secret-1')
    t.h.queue.length = 0
    const queue: { run: () => void; kind: string }[] = []
    const again = clubService(t.h.store, t.h.connections, { maxUsers: 40, now: () => t.h.time, schedule: (run: () => void, _ms: number, kind: string) => queue.push({ run, kind }) })
    await again.load()
    const job = queue.find((j) => j.kind === 'importPurge')
    expect(job).toBeDefined()
    job!.run()
    await settle()
    expect(t.h.store.sql.exec("SELECT COUNT(*) AS n FROM boards_index WHERE mode = 'imported'")[0].n).toBe(0)
  })

  it('schedules nothing for a member who imported nothing', async () => {
    const amy = await t.member('amy')
    await t.club().deleteOwnAccount(amy, 'club-secret-1')
    expect(t.h.queue.filter((job) => job.kind === 'importPurge')).toHaveLength(0)
  })
})

describe('own deals', () => {
  const deal = (boardNo = 3) => ({ boardNo, dealer: 'S', vul: 'EW', hands: DEAL, title: 'Set A' })

  it('keeps them for the member only, never sending the hands back', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    const { added, duplicates, deals } = await t.club().importOwnDeals(amy, { deals: [deal(), { ...deal(), vul: 'NS' }] })
    expect({ added, duplicates }).toEqual({ added: 2, duplicates: 0 })
    expect(JSON.stringify(deals)).not.toContain('AKQJ')
    expect(JSON.stringify(await t.club().ownDealList(amy))).not.toContain('AKQJ')
    expect(await t.club().ownDealList(ben)).toEqual([])
  })

  it('does not add a deal twice, and takes what the PBN exporter wrote', async () => {
    const amy = await t.member('amy')
    await t.club().importOwnDeals(amy, { deals: [deal()] })
    later()
    expect(await t.club().importOwnDeals(amy, { deals: [deal(9)] })).toMatchObject({ added: 0, duplicates: 1 })
    let board: BoardState = newBoard(5, parseDeal(DEAL)!)
    for (const seat of ['N', 'E', 'S', 'W'] as Seat[]) board = makeCall(board, seat, 'P')
    const record = { id: 'x', tableNumber: 1, finishedAt: 0, board, players: Object.fromEntries(SEATS.map((s) => [s, { id: s, username: s }])) } as BoardRecord
    const { deals } = parsePbn(toPbnFile([record]))
    later()
    expect(await t.club().importOwnDeals(amy, { deals })).toMatchObject({ added: 1, duplicates: 0 })
  })

  it('names the board that is wrong and keeps none of the request', async () => {
    const amy = await t.member('amy')
    expect(await failure(t.club().importOwnDeals(amy, { deals: [deal(), { ...deal(8), hands: 'x' }] }))).toMatchObject({ code: 'importBadDeal', params: { board: 8 } })
    later()
    expect(await failure(t.club().importOwnDeals(amy, { deals: [{ ...deal(), dealer: 'Q' }] }))).toMatchObject({ code: 'importBadBoard', params: { board: 3 } })
    later()
    expect(await failure(t.club().importOwnDeals(amy, { deals: 'x' }))).toMatchObject({ code: 'importNoBoards' })
    later()
    expect(await failure(t.club().importOwnDeals(amy, { deals: Array(IMPORT_LIMITS.batchDeals + 1).fill(deal()) }))).toMatchObject({ code: 'importTooManyBoards' })
    expect(await t.club().ownDealList(amy)).toEqual([])
  })

  it('stops at its limit, and the rate limit is shared with the boards', async () => {
    const amy = await t.member('amy')
    const store = t.club()['store']
    await store.put(ownDealsKey(amy), Array.from({ length: IMPORT_LIMITS.ownDeals }, (_, i) => ({ id: `d${i}`, boardNo: 1, dealer: 'N', vul: 'None', hands: DEAL, addedAt: 0 })))
    expect(await failure(t.club().importOwnDeals(amy, { deals: [deal()] }))).toMatchObject({ code: 'ownDealsFull', params: { max: IMPORT_LIMITS.ownDeals } })
    for (let i = 1; i < IMPORT_BURST; i++) await failure(t.club().importBoards(amy, {}))
    expect(await failure(t.club().importOwnDeals(amy, { deals: [deal()] }))).toMatchObject({ code: 'slowDown' })
  })

  it('removes the ones asked for, and only the member\'s', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    const { deals } = await t.club().importOwnDeals(amy, { deals: [deal(), { ...deal(), vul: 'NS' }] })
    expect(await t.club().removeOwnDeals(ben, [deals[0].id])).toEqual([])
    expect(await t.club().ownDealList(amy)).toHaveLength(2)
    expect(await t.club().removeOwnDeals(amy, [deals[0].id])).toHaveLength(1)
    await t.club().removeOwnDeals(amy, [deals[1].id])
    expect(await t.club()['store'].get(ownDealsKey(amy))).toBeUndefined()
    await expect(t.club().removeOwnDeals(amy, 'x')).rejects.toMatchObject({ code: 'importNoBoards' })
  })

  it('deals them at a practice table, in order, with their dealer and vulnerability; a member cannot use another\'s', async () => {
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    const { deals } = await t.club().importOwnDeals(amy, { deals: [deal(21), { ...deal(22), dealer: 'E', vul: 'Both' }] })
    // In the list the newest comes first; the table deals them in the order chosen
    const ids = [...deals].reverse().map((d) => d.id)
    const settings = { deal: 'set', set: { source: 'mine', ids }, biddingOnly: true }
    expect(await t.refused(ben, { type: 'createPractice', settings } as never)).toBe('boardGone')
    expect(await t.refused(amy, { type: 'createPractice', settings: { ...settings, set: { source: 'mine', ids: ['nothing'] } } } as never)).toBe('boardGone')
    expect(await t.refused(amy, { type: 'createPractice', settings } as never)).toBeUndefined()
    const view = t.view(amy)!
    expect(view.board).toMatchObject({ dealer: 'S', vul: 'EW' })
    // Only South's hand, as at any practice table
    expect(Object.keys(view.board!.hands)).toEqual(['S'])
    expect(view.practice?.problem).toMatchObject({ seq: 1, count: 2, title: 'Set A' })
  })
})
