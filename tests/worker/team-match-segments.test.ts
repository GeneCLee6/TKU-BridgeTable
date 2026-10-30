// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClientMessage } from '../../shared/protocol.ts'
import { at, teamHarness } from './team-match-harness.ts'

/**
 * A team match played in segments (e8-t21, AC-8.9, ARCHITECTURE.md §5.8): both rooms stop at the
 * end of a segment, the captains change seats (a pair changes rooms) and bring in substitutes
 * between segments, the host starts the next, and the score runs on. A match without segments
 * plays as before (the other team match suites)
 */

let t: Awaited<ReturnType<typeof teamHarness>>
beforeEach(async () => {
  t = await teamHarness()
})

const matchOf = (id: string, userId: string) => t.club().matches.get(id, userId)!

/** Six boards in segments of two (three segments): Amy (team A) open South, Bea (team A) closed East, Ben (team B) closed South */
async function started() {
  const m = await t.match({ boards: 6, segmentBoards: 2, seats: { bea: at('closed', 'E'), ben: at('closed', 'S') } })
  await t.send(m.amy, { type: 'startMatch', matchId: m.id })
  return { ...m, open: t.tableIdOf(m.id, 'open'), closed: t.tableIdOf(m.id, 'closed') }
}

describe('segments and changing seats between them (e8-t21)', () => {
  it('stops each room at the end of a segment until both finished it, then waits for the host', async () => {
    const { id, amy, people, open, closed } = await started()
    const { bea, ben } = people
    const next: ClientMessage = { type: 'matchNextSegment', matchId: id }
    expect(matchOf(id, amy)).toMatchObject({ segment: 1 })
    expect(matchOf(id, amy).breakAt).toBeUndefined()
    expect(t.view(amy)?.match).toMatchObject({ segment: { n: 1, of: 3 } })

    // The open room plays its two boards and waits: nothing more is dealt there
    await t.playUntil([amy], () => t.played(open) === 2)
    expect(t.view(amy)?.match).toMatchObject({ seq: 2, played: 2, over: true })
    expect(t.view(amy)?.dealAt).toBeNull()
    expect(matchOf(id, amy).breakAt).toBeUndefined()
    expect(await t.refused(amy, next)).toBe('matchNotBreak')
    // Seats change only between segments
    expect(await t.refused(amy, { type: 'matchMove', matchId: id, from: at('open', 'S'), to: at('closed', 'E') })).toBe('matchStarted')

    // The closed room finishes the segment too: the match waits between segments, the score so far kept
    await t.playUntil([bea, ben], () => t.played(closed) === 2)
    const between = matchOf(id, amy)
    expect(between.breakAt).toBe(t.h.time)
    expect(between.status).toBe('playing')
    expect(between.boards.map((b) => b.seq)).toEqual([1, 2])
    expect(t.tableState(closed)?.board?.boardNo).toBe(2)
    expect(await t.refused(bea, next)).toBe('matchHostOnly')
    expect(t.club().lobbyView(t.h.boss).matches).toHaveLength(1)
  })

  it('lets a pair change rooms and a substitute come in, then plays on in the new seats with the score carried over', async () => {
    const { id, amy, people, open, closed } = await started()
    const { bea, ben } = people
    await t.playUntil([amy, bea, ben], () => matchOf(id, amy).breakAt !== undefined)
    const before = matchOf(id, amy).totals

    // Team A's captain swaps Amy (open South) and Bea (closed East): they change rooms. Seats never change teams
    expect(await t.refused(amy, { type: 'matchMove', matchId: id, from: at('open', 'S'), to: at('closed', 'S') })).toBe('matchOtherTeam')
    expect(await t.refused(amy, { type: 'matchMove', matchId: id, from: at('open', 'S'), to: at('closed', 'E') })).toBeUndefined()
    // The tables take the new seats only when the next segment starts
    expect(t.club().lobbyView(amy).myTableId).toBe(open)
    // A substitute comes in for Ben without pausing
    const dan = await t.member('dan')
    expect(await t.refused(amy, { type: 'matchReplace', matchId: id, room: 'closed', seat: 'S', userId: dan })).toBeUndefined()
    expect(t.tableState(closed)?.seats.S).toBe(dan)

    expect(await t.refused(amy, { type: 'matchNextSegment', matchId: id })).toBeUndefined()
    const now = matchOf(id, amy)
    expect(now).toMatchObject({ segment: 2, totals: before })
    expect(now.breakAt).toBeUndefined()
    // A person who declared from a robot partner's seat is back in their own
    expect(t.tableState(open)?.seats.S).toBe(bea)
    expect(t.tableState(closed)?.seats.E).toBe(amy)
    expect(t.tableState(closed)?.seats.S).toBe(dan)
    expect(t.club().lobbyView(amy).myTableId).toBe(closed)
    expect(t.club().lobbyView(bea).myTableId).toBe(open)
    expect(t.club().lobbyView(ben).myTableId).toBeNull()
    // Each plays in their new room only; Ben, out of the match, may not watch it
    expect(await t.refused(amy, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')
    expect(await t.refused(bea, { type: 'joinTable', tableId: closed })).toBe('matchOtherRoom')
    expect(await t.refused(ben, { type: 'joinTable', tableId: open })).toBe('matchOtherRoom')

    // Board 3 is dealt in both rooms after the countdown
    await t.playUntil([amy, bea, dan], () => t.tableState(open)?.board?.boardNo === 3 && t.tableState(closed)?.board?.boardNo === 3)
    expect(t.view(bea)?.match).toMatchObject({ seq: 3, segment: { n: 2, of: 3 } })

    // Segment two, the third segment, and the end: the score runs on over all six boards
    await t.playUntil([amy, bea, dan], () => matchOf(id, amy).breakAt !== undefined)
    expect(matchOf(id, amy).boards.map((b) => b.seq)).toEqual([1, 2, 3, 4])
    expect(await t.refused(amy, { type: 'matchNextSegment', matchId: id })).toBeUndefined()
    await t.playUntil([amy, bea, dan], () => matchOf(id, amy).status === 'finished')
    const done = matchOf(id, amy)
    expect(done.boards.map((b) => b.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(done.totals.A + done.totals.B).toBe(done.boards.reduce((sum, b) => sum + b.result.A + b.result.B, 0))
    expect(done.segment).toBeUndefined()
  })

  it('lets the host abandon between segments without pausing, and works over HTTP', async () => {
    const { id, amy, people } = await started()
    await t.playUntil([amy, people.bea, people.ben], () => matchOf(id, amy).breakAt !== undefined)
    await expect(t.club().matchPlayRequest(people.bea, { type: 'matchNextSegment', matchId: id })).rejects.toMatchObject({ code: 'matchHostOnly' })
    const next = await t.club().matchPlayRequest(amy, { type: 'matchNextSegment', matchId: id })
    expect(next).toMatchObject({ segment: 2 })
    await t.playUntil([amy, people.bea, people.ben], () => matchOf(id, amy).breakAt !== undefined)
    const ended = await t.club().matchPlayRequest(amy, { type: 'matchAbandon', matchId: id })
    expect(ended?.status).toBe('abandoned')
    expect(ended?.boards.map((b) => b.seq)).toEqual([1, 2, 3, 4])
  })

  it('reaches the break by a ruling on the segment’s last board', async () => {
    const m = await t.match({ boards: 4, segmentBoards: 2, seats: { ben: at('closed', 'S') }, boardMinutes: 3 })
    await t.send(m.amy, { type: 'startMatch', matchId: m.id })
    const open = t.tableIdOf(m.id, 'open')
    const closed = t.tableIdOf(m.id, 'closed')
    await t.playUntil([m.amy], () => t.played(open) === 2)
    await t.playUntil([m.people.ben], () => t.played(closed) === 1 && t.tableState(closed)?.board?.boardNo === 2)
    t.h.time += 3 * 60_000
    const rule: ClientMessage = { type: 'matchRule', matchId: m.id, seq: 2, ruling: 'avg', team: 'A', reason: '太慢' }
    expect(await t.refused(m.amy, rule)).toBeUndefined()
    expect(matchOf(m.id, m.amy).breakAt).toBeDefined()
    expect(t.tableState(closed)?.board).toBeNull()
  })
})
