// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_HISTORY_QUERY } from '../../shared/history-query.ts'
import { SUBSTITUTE_MS, type BoardRecord, type ClientMessage } from '../../shared/protocol.ts'
import { openingLead } from '../../shared/traveller.ts'
import { at, teamHarness, tick } from './team-match-harness.ts'

/**
 * The rest of a team match (F5, ARCHITECTURE.md §5.8): robots sitting in for players who drop out
 * or whom the host takes off for a while (e8-t14), the host's rulings on boards over the time limit
 * (e8-t15), pausing, resuming, abandoning and substitutes (e8-t16), what the result page gets
 * (e8-t12), and a whole match end to end (e8-t17)
 */

let t: Awaited<ReturnType<typeof teamHarness>>
beforeEach(async () => {
  t = await teamHarness()
})

const MIN = 60_000

/** A match of four boards: Amy (team A) in the open room's South, Ben (team B) alone in the closed room */
async function started(extra: Record<string, ReturnType<typeof at>> = {}, boardMinutes = 10) {
  const m = await t.match({ boards: 4, seats: { ben: at('closed', 'S'), ...extra }, boardMinutes })
  await t.send(m.amy, { type: 'startMatch', matchId: m.id })
  return { ...m, open: t.tableIdOf(m.id, 'open'), closed: t.tableIdOf(m.id, 'closed') }
}

const matchOf = (id: string, userId: string) => t.club().matches.get(id, userId)!

async function offline(userId: string) {
  t.h.connections.online.delete(userId)
  await t.club().disconnected(userId)
}

async function online(userId: string) {
  t.h.connections.online.add(userId)
  t.club().connected(userId)
  await tick()
  await tick()
}

describe('robots sitting in (代打, e8-t14)', () => {
  it('seats the match’s robot for a player offline three minutes, even alone in the room, and gives the seat back', async () => {
    const { id, amy, people, closed } = await started()
    const { ben } = people
    await offline(ben)
    t.h.time += SUBSTITUTE_MS
    await t.run('substitute')
    // Nobody else in the closed room is online: the room plays on with the match's robot (2/1)
    expect(t.tableState(closed)?.seats.S).toBe('robot:gib:S')
    expect(t.tableState(closed)?.substitutes?.S).toBe(ben)
    expect(matchOf(id, amy).seats.find((s) => s.userId === ben)).toMatchObject({ status: 'seated', substitute: true })
    // Still in the match: no other table, and not the other room either
    expect(t.club().matches.playingOf(ben)?.id).toBe(id)
    await online(ben)
    expect(t.tableState(closed)?.seats.S).toBe(ben)
    expect(matchOf(id, amy).seats.find((s) => s.userId === ben)?.substitute).toBeUndefined()
  })

  it('lets the host have a robot sit in for a player who is still online, who takes the seat back by coming to the table', async () => {
    const { id, amy, people, open, closed } = await started()
    const { ben } = people
    expect(await t.refused(ben, { type: 'matchSitIn', matchId: id, room: 'open', seat: 'S' })).toBe('matchHostOnly')
    expect(await t.refused(amy, { type: 'matchSitIn', matchId: id, room: 'open', seat: 'N' })).toBe('matchNotMember')
    await t.send(amy, { type: 'matchSitIn', matchId: id, room: 'closed', seat: 'S' })
    expect(t.tableState(closed)?.seats.S).toBe('robot:gib:S')
    expect(t.club().lobbyView(ben).myTableId).toBeNull()
    // Coming back is coming to the table: the seat, not a kibitzer's view of all four hands
    expect(await t.refused(ben, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')
    await t.send(ben, { type: 'joinTable', tableId: closed })
    expect(t.tableState(closed)?.seats.S).toBe(ben)
    expect(t.tableState(closed)?.spectators).toEqual([])
    expect(Object.keys(t.view(ben)!.board!.hands)).toEqual(['S'])
  })
})

describe('rulings on boards over the time limit (e8-t15)', () => {
  it('lets only the host rule, only once a room is over the limit, and the slow room goes on to the next board', async () => {
    const { id, amy, people, open, closed } = await started()
    const { ben } = people
    const cat = await t.member('cat')
    // The open room plays board 1; Ben sits on it in the closed room
    await t.playUntil([amy], () => t.played(open) === 1)
    const openRecord = t.tableState(open)!.recent![0].id
    const rule: Extract<ClientMessage, { type: 'matchRule' }> = { type: 'matchRule', matchId: id, seq: 1, ruling: 'avgPlus', team: 'A', reason: '閉室超時' }
    expect(await t.refused(ben, rule)).toBe('matchHostOnly')
    expect(await t.refused(amy, rule)).toBe('matchNotOverTime')
    expect(matchOf(id, amy).rooms?.closed).toMatchObject({ seq: 1, playing: true, endsAt: t.tableState(closed)!.boardStartedAt! + 10 * MIN })
    // Only the host sees where the rooms are
    expect(matchOf(id, ben).rooms).toBeUndefined()

    t.h.time += 10 * MIN
    expect(await t.refused(amy, { ...rule, reason: ' ' } as ClientMessage)).toBe('badRuling')
    expect(await t.refused(amy, { ...rule, ruling: 'avgPlenty' } as unknown as ClientMessage)).toBe('badRuling')
    expect(await t.refused(amy, { ...rule, seq: 9 } as ClientMessage)).toBe('badRuling')
    expect(await t.refused(amy, rule)).toBeUndefined()

    // The closed room put board 1 away unrecorded and plays board 2
    expect(t.tableState(closed)?.board?.boardNo).toBe(2)
    expect(t.view(ben)?.match).toMatchObject({ seq: 2, ruled: [1] })
    const board = matchOf(id, cat).boards[0]
    expect(board).toMatchObject({ seq: 1, ruling: { kind: 'avgPlus', team: 'A', reason: '閉室超時' }, result: { A: 3, B: 0, ruled: true } })
    expect(board.open?.boardId).toBe(openRecord)
    expect(board.closed).toBeUndefined()
    expect(matchOf(id, cat).totals).toEqual({ A: 3, B: 0 })
    // The board is done: the open room's record is shown to everyone
    expect(await t.club().record(openRecord, cat)).not.toBeNull()
    // The host may change the ruling, never on a board nobody is over the limit on
    await t.send(amy, { ...rule, ruling: 'avg', reason: '改判' } as ClientMessage)
    expect(matchOf(id, cat).boards[0].result).toMatchObject({ A: 0, B: 0, ruled: true })
    expect(await t.refused(amy, { ...rule, seq: 2 } as ClientMessage)).toBe('matchNotOverTime')

    // The match ends with the ruled board in it, and the closed room never plays board 1
    await t.playUntil([amy, ben], () => matchOf(id, amy).status === 'finished')
    const done = matchOf(id, cat)
    expect(done.boards.map((b) => b.seq)).toEqual([1, 2, 3, 4])
    expect(done.boards[0].closed).toBeUndefined()
    const team = await t.club().search(cat, { ...DEFAULT_HISTORY_QUERY, scope: 'all', mode: 'team' })
    expect(team.boards).toHaveLength(7)
  })

  it('finishes the match when the last board is ruled on', async () => {
    const { id, amy, open, closed } = await started({}, 3)
    await t.playUntil([amy], () => t.played(open) === 4)
    // The closed room (robots and Ben, who never moves) gets stuck on board 1; rule on the rest one by one
    for (let seq = 1; seq <= 4; seq++) {
      t.h.time += 3 * MIN
      const room = t.tableState(closed)!
      expect(room.board?.boardNo).toBe(seq)
      await t.send(amy, { type: 'matchRule', matchId: id, seq, ruling: 'avg', team: 'A', reason: 'slow' })
    }
    expect(matchOf(id, amy).status).toBe('finished')
    expect(matchOf(id, amy).totals).toEqual({ A: 0, B: 0 })
  })
})

describe('pausing, abandoning and substitutes (e8-t16)', () => {
  it('pauses both rooms: no calls, no robots, the clock stands still; and resumes', async () => {
    const { id, amy, people, open, closed } = await started()
    const { ben } = people
    expect(await t.refused(ben, { type: 'matchPause', matchId: id, paused: true })).toBe('matchHostOnly')
    const startedAt = t.tableState(open)!.boardStartedAt!
    await t.send(amy, { type: 'matchPause', matchId: id, paused: true })
    expect(matchOf(id, ben).pausedAt).toBe(t.h.time)
    for (const userId of [amy, ben]) {
      expect(t.view(userId)?.match?.paused).toBe(true)
      expect(t.view(userId)?.boardEndsAt).toBeNull()
    }
    const board = t.tableState(closed)!.board!
    // Robots wait
    await t.run('robot')
    expect(t.tableState(closed)!.board!.auction).toEqual(board.auction)
    const turn = t.view(ben)!.board!
    if (turn.legalCalls.length) expect(await t.refused(ben, { type: 'call', call: 'P' })).toBe('matchPaused')

    t.h.time += 5 * MIN
    await t.send(amy, { type: 'matchPause', matchId: id, paused: false })
    expect(matchOf(id, ben).pausedAt).toBeUndefined()
    expect(t.view(amy)?.match?.paused).toBeUndefined()
    // The pause does not count against the time limit
    expect(t.tableState(open)!.boardStartedAt).toBe(startedAt + 5 * MIN)
    await t.playUntil([amy, ben], () => t.played(open) >= 1 && t.played(closed) >= 1)
  })

  it('abandons a paused match: the board being played is put away and every board is shown', async () => {
    const { id, amy, people, open, closed } = await started()
    const { ben } = people
    const cat = await t.member('cat')
    await t.playUntil([amy], () => t.played(open) === 1)
    expect(await t.refused(amy, { type: 'matchAbandon', matchId: id })).toBe('matchPauseFirst')
    await t.send(amy, { type: 'matchPause', matchId: id, paused: true })
    expect(await t.refused(ben, { type: 'matchAbandon', matchId: id })).toBe('matchHostOnly')
    await t.send(amy, { type: 'matchAbandon', matchId: id })
    const ended = matchOf(id, cat)
    expect(ended.status).toBe('abandoned')
    expect(ended.endedAt).toBe(t.h.time)
    expect(ended.pausedAt).toBeUndefined()
    expect(ended.boards).toEqual([])
    expect(t.tableState(open)?.board?.phase).not.toBe('auction')
    expect(t.tableState(closed)?.board ?? null).toBeNull()
    expect((await t.club().notifications.view(ben)).items[0]).toMatchObject({ kind: 'matchAbandoned', params: { matchId: id, username: 'amy' } })
    // The one board the open room finished is shown to everyone now
    const team = await t.club().search(cat, { ...DEFAULT_HISTORY_QUERY, scope: 'all', mode: 'team' })
    expect(team.boards).toHaveLength(1)
    expect(t.club().lobbyView(cat).matches).toEqual([])
    // Ben is free again
    await t.send(ben, { type: 'createTable' })
    expect(t.club().lobbyView(ben).myTableId).not.toBe(closed)
  })

  it('puts a substitute in a seat while paused; whoever left may watch neither room, nor may a watcher come in', async () => {
    const { id, amy, people, open, closed } = await started({ bea: at('closed', 'E') })
    const { ben, bea } = people
    const cat = await t.member('cat')
    const dan = await t.member('dan')
    await t.send(cat, { type: 'joinTable', tableId: open })
    const replace: Extract<ClientMessage, { type: 'matchReplace' }> = { type: 'matchReplace', matchId: id, room: 'closed', seat: 'S', userId: dan }
    expect(await t.refused(amy, replace)).toBe('matchPauseFirst')
    await t.send(amy, { type: 'matchPause', matchId: id, paused: true })
    // Ben's team is B: Bea (team A) does not arrange it
    expect(await t.refused(bea, replace)).toBe('matchNotCaptain')
    expect(await t.refused(amy, { ...replace, userId: cat } as ClientMessage)).toBe('matchWatching')
    expect(await t.refused(amy, { ...replace, userId: bea } as ClientMessage)).toBe('matchAlreadyIn')
    expect(await t.refused(amy, { ...replace, room: 'open', seat: 'S' } as ClientMessage)).toBe('matchHostStays')
    expect(await t.refused(amy, replace)).toBeUndefined()

    expect(t.tableState(closed)?.seats.S).toBe(dan)
    expect(t.club().lobbyView(dan).myTableId).toBe(closed)
    expect(t.club().lobbyView(ben).myTableId).toBeNull()
    expect(matchOf(id, dan).seats.find((s) => s.room === 'closed' && s.seat === 'S')).toMatchObject({ userId: dan, status: 'seated' })
    expect((await t.club().notifications.view(dan)).items[0]).toMatchObject({ kind: 'matchSubIn', params: { matchId: id } })
    expect((await t.club().notifications.view(ben)).items[0]).toMatchObject({ kind: 'matchRemoved' })
    // Dan is a player of the closed room now; Ben, out of the match, still may not watch it
    expect(await t.refused(dan, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')
    expect(await t.refused(ben, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')
    expect(await t.refused(ben, { type: 'joinTable', tableId: closed })).toBe('matchNoWatching')

    await t.send(amy, { type: 'matchPause', matchId: id, paused: false })
    await t.playUntil([amy, dan, bea], () => matchOf(id, amy).status === 'finished')
  })

  it('hands the match to another player when the host’s account is deleted while it is played', async () => {
    const { id, amy, people } = await started({ bea: at('closed', 'E') })
    await t.club().adminDeleteUser(t.h.boss, amy)
    const match = matchOf(id, people.bea)
    expect(match.hostId).toBe(people.bea)
    await t.send(people.bea, { type: 'matchPause', matchId: id, paused: true })
    expect(matchOf(id, people.bea).pausedAt).toBeDefined()
  })

  it('works over HTTP too', async () => {
    const { id, amy } = await started()
    const paused = await t.club().matchPlayRequest(amy, { type: 'matchPause', matchId: id, paused: true })
    expect(paused?.pausedAt).toBe(t.h.time)
    await expect(t.club().matchPlayRequest(amy, { type: 'matchPause', matchId: id, paused: 'yes' } as never)).rejects.toMatchObject({
      code: 'badMessage',
    })
    const ended = await t.club().matchPlayRequest(amy, { type: 'matchAbandon', matchId: id })
    expect(ended?.status).toBe('abandoned')
  })
})

describe('the result page (e8-t12)', () => {
  it('gives each room’s contract, tricks and opening lead with the score', async () => {
    const { id, amy, people, open, closed } = await started()
    await t.playUntil([amy, people.ben], () => t.played(open) >= 1 && t.played(closed) >= 1)
    const board = matchOf(id, amy).boards[0]
    for (const room of ['open', 'closed'] as const) {
      const result = board[room]!
      const record = (await t.h.store.get<BoardRecord>(`board:${result.boardId}`))!
      expect(result.contract).toEqual(record.board.contract)
      if (result.contract) expect(result.declarerTricks).toEqual(record.board.result?.declarerTricks)
      expect(result.lead ?? null).toEqual(openingLead(record.board))
      expect(result.scoreNS).toBe(record.board.result?.scoreNS ?? 0)
    }
  })
})

describe('a director’s ruling in the score (e2-t36)', () => {
  it('scores a room’s ruled board by the ruling, pushes the new score, and goes back when it is taken back', async () => {
    const { id, amy, people, open, closed } = await started()
    await t.playUntil([amy, people.ben], () => t.played(open) >= 1 && t.played(closed) >= 1)
    const before = matchOf(id, amy)
    const played = before.boards[0]
    const pushes = () => (t.h.connections.inbox.get(amy) ?? []).filter((m) => m.type === 'match').length
    const sent = pushes()

    // Avg+ for North-South in the open room is Avg+ for team A: +3 IMPs whatever the closed room did
    await t.club().ruleBoard(t.h.boss, played.open!.boardId, { kind: 'avgPlus', side: 'NS', reason: 'Wrong explanation' })
    const ruled = matchOf(id, amy)
    expect(ruled.boards[0].result).toEqual({ A: 3, B: 0, ruled: true })
    expect(ruled.boards[0].open?.ruling).toEqual({ kind: 'avgPlus', side: 'NS' })
    expect(ruled.boards[0].open?.scoreNS).toBe(played.open!.scoreNS)
    expect(ruled.totals.A - ruled.totals.B).toBe(before.totals.A - before.totals.B - (played.result.A - played.result.B) + 3)
    expect(pushes()).toBeGreaterThan(sent)

    // An assigned score in the closed room equal to the open room's: a push
    await t.club().ruleBoard(t.h.boss, played.closed!.boardId, { kind: 'score', scoreNS: played.open!.scoreNS, reason: 'Revoke' })
    await t.club().ruleBoard(t.h.boss, played.open!.boardId, null)
    expect(matchOf(id, amy).boards[0].result).toEqual({ A: 0, B: 0, net: 0, ruled: true })

    await t.club().ruleBoard(t.h.boss, played.closed!.boardId, null)
    const back = matchOf(id, amy)
    expect(back.boards[0].result).toEqual(played.result)
    expect(back.totals).toEqual(before.totals)
  })
})

/** The WBF IMP scale written out again, so the end-to-end test checks the match against its own sums */
function impsByHand(difference: number): number {
  const steps = [20, 50, 90, 130, 170, 220, 270, 320, 370, 430, 500, 600, 750, 900, 1100, 1300, 1500, 1750, 2000, 2250, 2500, 3000, 3500, 4000]
  const won = steps.filter((step) => Math.abs(difference) >= step).length
  return Math.sign(difference) * won
}

describe('a whole match, end to end (e8-t17)', () => {
  it('two people and six robots play four boards: the IMPs add up by hand, and neither room sees the other early', async () => {
    const { id, amy, people, open, closed } = await started()
    const { ben } = people
    const cat = await t.member('cat')
    const all = { ...DEFAULT_HISTORY_QUERY, scope: 'all' as const }
    // Neither player can reach the other room, and boards one room played stay hidden
    expect(await t.refused(amy, { type: 'joinTable', tableId: closed })).toBe('matchOtherRoom')
    expect(await t.refused(ben, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')
    await t.playUntil([amy], () => t.played(open) === 2)
    const heldBack = t.tableState(open)!.recent!.map((r) => r.id)
    for (const boardId of heldBack) {
      expect(await t.club().record(boardId, ben)).toBeNull()
      expect((await t.club().search(cat, all)).boards.map((b) => b.id)).not.toContain(boardId)
    }
    expect(matchOf(id, ben).boards).toEqual([])
    expect(JSON.stringify(t.h.connections.inbox.get(ben))).not.toContain(heldBack[0])

    await t.playUntil([amy, ben], () => matchOf(id, amy).status === 'finished')
    const done = matchOf(id, cat)
    let a = 0
    let b = 0
    for (const board of done.boards) {
      const won = impsByHand(board.open!.scoreNS - board.closed!.scoreNS)
      expect([board.result.A, board.result.B]).toEqual([Math.max(0, won), Math.max(0, -won)])
      a += Math.max(0, won)
      b += Math.max(0, -won)
    }
    expect(done.totals).toEqual({ A: a, B: b })
    expect(done.leader).toBe(a === b ? null : a > b ? 'A' : 'B')
    expect((await t.club().search(cat, { ...all, mode: 'team' })).boards).toHaveLength(8)
  })
})
