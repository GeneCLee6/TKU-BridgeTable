// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AuditLog } from '../../worker/audit.ts'
import { at, teamHarness } from './team-match-harness.ts'

/**
 * The director's tools on a team match (`e9-t17`, AC-9.8, ARCHITECTURE.md §5.23): the host or an
 * admin takes IMPs off a team; the score, the leader, the VP and the points ledger follow; a board
 * ruled from the tools is the `e2-t35` ruling on its record. Runs on both paths of `EVENT_OBJECTS`.
 */

const code = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

describe("the director's tools on a team match (e9-t17)", () => {
  it('takes IMPs off a team, re-ranks the match, and keeps the note with the score', async () => {
    const t = await teamHarness()
    const m = await t.match({ boards: 4, seats: { ben: at('closed', 'S') } })
    const { id, amy } = m
    const ben = m.people.ben
    const act = (userId: string, body: unknown) => t.club().refereeAct(userId, 'match', id, body)
    const view = (userId: string) => t.club().matches.get(id, userId)!
    // Not before it is played; only the host and the admins
    expect(await code(() => act(amy, { action: 'penalty', target: 'A', amount: 3, reason: '遲到' }))).toBe('refereeBadTarget')
    expect(await code(() => act(ben, { action: 'penalty', target: 'A', amount: 3, reason: '遲到' }))).toBe('refereeOnly')
    expect(view(amy).canReferee).toBe(true)
    expect(view(ben).canReferee).toBeUndefined()
    // A pairs board's score has no place in a match
    expect(await code(() => act(amy, { action: 'score', table: 1, boardNo: 1, ruling: null }))).toBe('refereeNotHere')
    expect(await code(() => act(amy, { action: 'delay', minutes: 5, reason: '等' }))).toBe('refereeNotHere')

    await t.send(amy, { type: 'startMatch', matchId: id })
    await act(amy, { action: 'penalty', target: 'A', amount: 3, reason: '遲到' })
    expect(view(ben)).toMatchObject({ totals: { A: -3, B: 0 }, leader: 'B', penalties: { A: 3 } })
    expect(view(ben).referee).toEqual([expect.objectContaining({ action: 'penalty', target: 'A', amount: 3, reason: '遲到' })])
    // An admin takes it back, and gives the other team one
    const penaltyId = view(ben).referee![0].id
    await act(t.h.boss, { action: 'withdraw', of: penaltyId, reason: '誤判' })
    await act(t.h.boss, { action: 'penalty', target: 'B', amount: 1, reason: '慢打' })
    expect(view(amy)).toMatchObject({ totals: { A: 0, B: -1 }, leader: 'A', penalties: { B: 1 } })

    // Everyone passes: every board is level, so the penalty decides the match in the points ledger
    await t.playUntil([amy, ben], () => view(amy).status === 'finished')
    const done = view(amy)
    expect(done.totals).toEqual({ A: 0, B: -1 })
    const ledger = (userId: string) => t.club().rankings.ledger.ledger(userId, { from: 0, to: Infinity })
    expect(ledger(amy)).toEqual([expect.objectContaining({ eventId: id, kind: 'match', rank: 1 })])
    expect(ledger(ben)).toEqual([expect.objectContaining({ eventId: id, kind: 'match', rank: 2 })])

    // A ruling on a room's board from the tools: the record's ruling (e2-t35), with its note once the board is shown
    const boardId = t.club().matches.store.get(id)!.boards[0].open!.boardId
    await act(amy, { action: 'score', boardId, ruling: { kind: 'score', scoreNS: 420, reason: '錯誤說明' } })
    expect((await t.club().record(boardId, amy))?.ruling).toMatchObject({ kind: 'score', scoreNS: 420 })
    expect(view(ben).totals.A).toBeGreaterThan(0)
    expect(view(ben).referee!.at(-1)).toMatchObject({ action: 'score', boardId, ruling: { kind: 'score', scoreNS: 420 } })
    const audit = await new AuditLog(t.h.store).list()
    expect(audit.map((a) => a.action)).toEqual(['referee:score', 'referee:penalty', 'referee:withdraw', 'referee:penalty'])
    expect(audit[0]).toMatchObject({ by: 'amy', target: `board:${boardId}` })
  })
})
