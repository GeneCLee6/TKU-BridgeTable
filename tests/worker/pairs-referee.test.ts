// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { AuditLog } from '../../worker/audit.ts'
import { teamHarness, tick } from './team-match-harness.ts'

/**
 * The director's tools on a pairs event (`e9-t17`, AC-9.8, ARCHITECTURE.md §5.23): who may use
 * them, the start put off, a board given a score when a table holds the round up, a table
 * re-opened, a ruling on a played board and a penalty, each counted in the standings and the
 * points, each in the event's log and the audit log. Runs on both paths of `EVENT_OBJECTS`.
 */

const code = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

async function setUp(pairs = 5, boardsPerRound = 1) {
  const t = await teamHarness()
  const { club, member } = t
  const names = Array.from({ length: pairs * 2 }, (_, i) => `p${i + 1}`)
  const ids: string[] = []
  for (const name of names) ids.push(await member(name))
  await club().adminSetFeature({ flag: 'pairs', state: 'on', usernames: [] })
  // The director runs the event without playing in it
  const director = await member('td')
  const view = await club().pairs.create(director, { title: '週五雙人賽', boardsPerRound })
  for (let i = 0; i < pairs; i++) await club().pairs.enter(ids[i * 2], view.id, names[i * 2 + 1])
  const viewOf = (userId: string) => club().pairs.view(view.id, userId)
  const act = (userId: string, body: unknown) => club().refereeAct(userId, 'pairs', view.id, body)
  return { ...t, connections: t.h.connections, ids, director, id: view.id, viewOf, act }
}

const reason = '牌桌斷線'

describe("the director's tools on a pairs event (e9-t17)", () => {
  it('is for the director and the admins only, and checks what is asked', async () => {
    const { ids, director, h, act, viewOf } = await setUp()
    expect(await code(() => act(ids[0], { action: 'delay', minutes: 10, reason }))).toBe('refereeOnly')
    expect(viewOf(ids[0]).canReferee).toBeUndefined()
    expect(viewOf(director).canReferee).toBe(true)
    expect(viewOf(h.boss).canReferee).toBe(true)
    // A reason, a known action, a sane amount
    expect(await code(() => act(director, { action: 'delay', minutes: 10 }))).toBe('badReferee')
    expect(await code(() => act(director, { action: 'penalty', target: '0', amount: -1, reason }))).toBe('badReferee')
    expect(await code(() => act(director, { action: 'nothing', reason }))).toBe('badReferee')
    // No penalty before the start; no table to re-open either
    expect(await code(() => act(director, { action: 'penalty', target: '0', amount: 1, reason }))).toBe('refereeBadTarget')
    expect(await code(() => act(director, { action: 'restart', table: 1, reason }))).toBe('pairsNotPlaying')
    expect(await code(() => act(h.boss, { action: 'delay', minutes: 0, reason }))).toBeUndefined()
  })

  it('puts the start off, shows until when, and lifts it', async () => {
    const t = await setUp()
    const { club, director, act, viewOf, h } = t
    await act(director, { action: 'delay', minutes: 30, reason: '等搭檔到場' })
    expect(viewOf(director).delayedUntil).toBe(h.time + 30 * 60_000)
    expect(await code(() => club().pairs.start(director, t.id))).toBe('eventDelayed')
    h.time += 31 * 60_000
    expect((await club().pairs.start(director, t.id)).status).toBe('playing')
    // Only before the start
    expect(await code(() => act(director, { action: 'delay', minutes: 5, reason }))).toBe('pairsNotOpen')
    const notes = viewOf(director).referee!
    expect(notes).toEqual([
      expect.objectContaining({ action: 'delay', until: expect.any(Number), reason: '等搭檔到場', by: expect.objectContaining({ username: 'td' }) }),
    ])
    // In the audit log too
    const audit = await new AuditLog(h.store).list()
    expect(audit[0]).toMatchObject({ action: 'referee:delay', by: 'td', target: `pairs:${t.id}` })
  })

  it('gives a held-up table its board, moves the round on, and scores it as an artificial score', async () => {
    const t = await setUp(5, 1)
    const { club, ids, director, id, playUntil, act, viewOf } = t
    const started = await club().pairs.start(director, id)
    club().broadcast()
    await tick()
    const [first, second] = started.tables
    const at = (table: number) => ids.filter((u) => viewOf(u).myTable?.table === table)
    const firstPlayers = at(first.table)
    // One table plays its board; the other is held up
    await playUntil(firstPlayers, () => viewOf(director).tables.find((x) => x.table === first.table)!.played === 1)
    expect(viewOf(director).round).toBe(1)
    // A board already played there is ruled on its record
    expect(
      await code(() => act(director, { action: 'score', table: first.table, boardNo: first.boards[0], ruling: { kind: 'avg', reason } })),
    ).toBe('refereePlayed')
    await act(director, { action: 'score', table: second.table, boardNo: second.boards[0], ruling: { kind: 'avgPlus', side: 'NS', reason } })
    for (let i = 0; i < 5; i++) await tick()
    const after = viewOf(director)
    expect(after.round).toBe(2)
    // Avg+ to NS is 60% for them and 40% for EW, compared with nobody; the board played (passed out) is alone: 50%
    const ruled = after.travellers.flatMap((tr) => tr.entries).find((e) => e.table === second.table && e.round === 1)!
    expect(ruled).toMatchObject({ ruling: { kind: 'avgPlus', side: 'NS' }, percentNS: 60 })
    expect(ruled.boardId).toBeUndefined()
    const ns = after.standings.find((s) => s.pair === second.ns)!
    expect(ns.percent).toBeCloseTo(60)
    // The note on the board's score goes only to those who may see its traveller
    const outsider = firstPlayers[0]
    expect(viewOf(director).referee).toEqual([expect.objectContaining({ action: 'score', boardNo: second.boards[0], round: 1 })])
    if (first.boards[0] !== second.boards[0]) expect(viewOf(outsider).referee).toBeUndefined()
    // The round is over: the score can be changed, not taken back
    expect(
      await code(() => act(director, { action: 'score', round: 1, table: second.table, boardNo: second.boards[0], ruling: null })),
    ).toBe('refereeRoundOver')
  })

  it('re-opens a table of the round, with a board played there to play again', async () => {
    const t = await setUp(5, 2)
    const { club, ids, director, id, playUntil, act, viewOf, connections } = t
    const started = await club().pairs.start(director, id)
    club().broadcast()
    await tick()
    const table = started.tables[0]
    const players = ids.filter((u) => viewOf(u).myTable?.table === table.table)
    await playUntil(players, () => viewOf(director).tables.find((x) => x.table === table.table)!.played === 1)
    const before = viewOf(director).tables.find((x) => x.table === table.table)!
    // Nothing to replay that is not the table's
    expect(await code(() => act(director, { action: 'restart', table: table.table, replay: [99], reason }))).toBe('refereeNoBoard')
    await act(director, { action: 'restart', table: table.table, replay: [table.boards[0]], reason: '發錯牌' })
    club().broadcast()
    await tick()
    const now = viewOf(director).tables.find((x) => x.table === table.table)!
    expect(now.tableId).not.toBe(before.tableId)
    // The board played there is played again: its result is gone
    expect(now.played).toBe(0)
    for (const userId of players) expect(connections.table(userId)?.id).toBe(now.tableId)
    expect(connections.table(players[0])?.pairs).toMatchObject({ id, round: 1, table: table.table, boards: 2, played: 0 })
    expect(viewOf(ids[0]).referee).toEqual([expect.objectContaining({ action: 'restart', round: 1, table: table.table, replay: [table.boards[0]] })])
    // The round plays on and moves to the next
    await playUntil(ids, () => viewOf(director).round === 2)
  })

  it('counts a ruling on a played board and a penalty, takes the penalty back, and ranks with them', async () => {
    const t = await setUp(5, 1)
    const { club, ids, director, id, playUntil, act, viewOf, h } = t
    await club().pairs.start(director, id)
    club().broadcast()
    await tick()
    await playUntil(ids, () => viewOf(director).round === 2)
    // Every board of round 1 was passed out; the director gives one of them 420 to NS
    const entry = viewOf(director).travellers.flatMap((tr) => tr.entries.map((e) => ({ ...e, boardNo: tr.boardNo })))[0]
    const player = ids.find((u) => viewOf(u).myPair === entry.ns)!
    const boardId = viewOf(player).travellers.flatMap((tr) => tr.entries).find((e) => e.boardId)!.boardId!
    await act(director, { action: 'score', boardId, ruling: { kind: 'score', scoreNS: 420, reason: '錯誤資訊' } })
    const ruled = viewOf(director).travellers.find((tr) => tr.boardNo === entry.boardNo)!.entries.find((e) => e.ns === entry.ns)!
    expect(ruled.ruling).toEqual({ kind: 'score', scoreNS: 420 })
    // Played once so far: alone on the board, it is 50% still (nobody to compare with)
    expect(ruled.percentNS).toBe(50)
    // A board of another event is not this event's
    expect(await code(() => act(director, { action: 'score', boardId: 'nope', ruling: null }))).toBe('refereeNoBoard')

    // A penalty: 1.5 MP off the pair; then taken back
    const pair = entry.ew
    const mpBefore = viewOf(director).standings.find((s) => s.pair === pair)!.mp
    await act(director, { action: 'penalty', target: String(pair), amount: 1.5, reason: '遲到' })
    const penalized = viewOf(director).standings.find((s) => s.pair === pair)!
    expect(penalized).toMatchObject({ penalty: 1.5, mp: mpBefore - 1.5 })
    expect(await code(() => act(director, { action: 'penalty', target: '99', amount: 1, reason }))).toBe('refereeBadTarget')
    const penaltyId = viewOf(ids[0]).referee!.find((n) => n.action === 'penalty')!.id
    await act(h.boss, { action: 'withdraw', of: penaltyId, reason: '查明不是他們' })
    expect(viewOf(director).standings.find((s) => s.pair === pair)!.mp).toBeCloseTo(mpBefore)
    expect(viewOf(ids[0]).referee!.find((n) => n.id === penaltyId)).toMatchObject({ withdrawn: true })
    expect(await code(() => act(director, { action: 'withdraw', of: penaltyId, reason }))).toBe('refereeNoEntry')

    // A penalty that stays: the points ledger ranks with it at the end
    await act(director, { action: 'penalty', target: String(pair), amount: 2, reason: '慢打' })
    await playUntil(ids, () => viewOf(director).status === 'finished')
    for (let i = 0; i < 5; i++) await tick()
    const done = viewOf(director)
    const last = done.standings.find((s) => s.pair === pair)!
    expect(last.penalty).toBe(2)
    expect(last.percent).toBeLessThan(50)
    const players = club().pairs.view(id, director).pairs[pair].players
    const ledger = club().rankings.ledger.ledger(players[0].id, { from: 0, to: Infinity })
    expect(ledger).toEqual([expect.objectContaining({ eventId: id, kind: 'pairs' })])
    // Every other pair is above the penalized one (the boards were all passed out but the ruled one)
    expect(ledger[0].rank).toBeGreaterThan(1)
    // Every step is in the audit log, with who did it
    const audit = await new AuditLog(h.store).list()
    expect(audit.map((a) => a.action)).toEqual(['referee:penalty', 'referee:withdraw', 'referee:penalty', 'referee:score'])
    expect(audit.at(-1)).toMatchObject({ by: 'td', target: `board:${boardId}` })
  })
})
