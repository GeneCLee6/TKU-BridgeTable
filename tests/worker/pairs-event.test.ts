// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { PairsView } from '../../shared/pairs.ts'
import { HELD_BACK } from '../../worker/team-mode.ts'
import { EVENT_OBJECTS, eventObjects, pairsKey } from './event-mode.ts'
import { teamHarness, tick } from './team-match-harness.ts'

/**
 * Pairs events (J3, `e9-t10`–`e9-t13`, ARCHITECTURE.md §5.20): entering, the start, every round's
 * tables at once, the change of tables after each round, what nobody may see of a board before
 * playing it, the matchpoints and the end. Runs twice (`vite.config.ts`): with every event in the
 * club's object, and with `EVENT_OBJECTS=on`, each in its own `EventObject` (`pairs:<id>`).
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
  const director = ids[0]
  const view = await club().pairs.create(director, { title: '週五雙人賽', boardsPerRound })
  for (let i = 0; i < pairs; i++) await club().pairs.enter(ids[i * 2], view.id, names[i * 2 + 1])
  return { ...t, connections: t.h.connections, ids, names, director, id: view.id }
}

describe('pairs events', () => {
  it('is behind the feature flag, off by default', async () => {
    const { club, member } = await teamHarness()
    const amy = await member('amy')
    expect(await code(async () => club().pairs.list(amy))).toBe('pairsOff')
    expect(await code(() => club().pairs.create(amy, {}))).toBe('pairsOff')
  })

  it('takes entries until the start, and checks them (e9-t10)', async () => {
    const { club, ids, director, id } = await setUp(4)
    const extra = await club().pairs.view(id, director)
    expect(extra.pairs).toHaveLength(4)
    expect(extra.pairs[0].players.map((p) => p.username)).toEqual(['p1', 'p2'])
    // Nobody enters twice, nor with themselves or a stranger
    expect(await code(() => club().pairs.enter(ids[2], id, 'p1'))).toBe('pairsInPair')
    expect(await code(() => club().pairs.enter(ids[2], id, 'p3'))).toBe('pairsBadPartner')
    expect(await code(() => club().pairs.enter(ids[2], id, 'nobody'))).toBe('pairsBadPartner')
    // 4 pairs are too few for 3 tables; only the director starts
    expect(await code(() => club().pairs.start(director, id))).toBe('pairsTooFew')
    // A pair leaves (one of its players) and enters again
    await club().pairs.withdraw(ids[3], id, undefined)
    expect((await club().pairs.view(id, director)).pairs).toHaveLength(3)
    await club().pairs.enter(ids[3], id, 'p3')
    expect(await code(() => club().pairs.withdraw(ids[4], id, ids[0]))).toBe('pairsDirectorOnly')
    expect(await code(() => club().pairs.start(ids[2], id))).toBe('pairsDirectorOnly')
  })

  it('needs everyone online to start', async () => {
    const { club, connections, ids, director, id, member } = await setUp(4)
    const a = await member('x1')
    await member('x2')
    await club().pairs.enter(a, id, 'x2')
    connections.online.delete(ids[5])
    expect(await code(() => club().pairs.start(director, id))).toBe('pairsOffline')
  })

  it('plays every round at once, changes tables, keeps the boards back and scores them (e9-t11–e9-t13)', async () => {
    const t = await setUp(5, 1)
    const { club, ids, director, id, playUntil, send, connections } = t
    const started = await club().pairs.start(director, id)
    t.club().broadcast()
    await tick()
    // 5 pairs: 3 tables, 3 rounds, one table sits out each round (the phantom pair's)
    expect(started.status).toBe('playing')
    expect(started.movement).toMatchObject({ kind: 'mitchell', tables: 3, rounds: 3, boardsPerRound: 1, boards: 3 })
    expect(started.tables).toHaveLength(2)
    expect(started.pairs.map((p) => `${p.dir}${p.no}`)).toEqual(['NS1', 'NS2', 'NS3', 'EW1', 'EW2'])
    // Each player sees their table; the pair sitting out has none this round
    const viewOf = (userId: string) => club().pairs.view(id, userId)
    const sitting = ids.filter((u) => viewOf(u).myTable === null)
    expect(sitting).toHaveLength(2)
    for (const userId of ids.filter((u) => !sitting.includes(u))) {
      const mine = viewOf(userId).myTable!
      expect(connections.table(userId)?.id).toBe(mine.tableId)
      expect(connections.table(userId)?.pairs).toMatchObject({ id, round: 1, rounds: 3, table: mine.table })
    }
    // A player stays at their round's table: no other table, and no watching another one of the event
    expect(await t.refused(ids[0], { type: 'createTable' })).toBe('inPairs')
    const other = started.tables.find((x) => x.tableId !== viewOf(ids[0]).myTable?.tableId)!
    expect(await t.refused(sitting[0], { type: 'joinTable', tableId: other.tableId })).toBe('inPairs')

    // Round 1 played at both tables; nobody saw how the board went at another table before playing it
    let seen: PairsView[] = []
    await playUntil(ids, () => {
      seen.push(viewOf(ids[2]))
      return viewOf(director).round === 2
    })
    for (const v of seen) {
      const mine = new Set(v.travellers.map((tr) => tr.boardNo))
      const played = new Set(v.travellers.flatMap((tr) => tr.entries.filter((e) => e.ns === v.myPair || e.ew === v.myPair).map(() => tr.boardNo)))
      expect([...mine].every((b) => played.has(b))).toBe(true)
    }
    const after = viewOf(director)
    expect(after.round).toBe(2)
    // Those who sat out have seen no board yet; a player who played sees their board, with only their own record's id
    for (const userId of sitting) expect(viewOf(userId).travellers).toEqual([])
    const player = ids.find((u) => !sitting.includes(u))!
    const travellers = viewOf(player).travellers
    expect(travellers).toHaveLength(1)
    const own = viewOf(player).myPair!
    for (const e of travellers[0].entries) expect(!!e.boardId).toBe(e.ns === own || e.ew === own)
    // The records are kept back until the event ends: only the four who played one see it
    const mine = travellers[0].entries.find((e) => e.boardId)!
    expect((await club().record(mine.boardId!, player))?.revealAt).toBe(HELD_BACK)
    expect(await club().record(mine.boardId!, sitting[0])).toBeNull()
    // Round 2's tables: everyone was moved, each player at their new table
    for (const userId of ids) {
      const table = viewOf(userId).myTable
      if (table) expect(connections.table(userId)?.id).toBe(table.tableId)
    }

    seen = []
    await playUntil(ids, () => viewOf(director).status === 'finished')
    const done = viewOf(ids[3])
    expect(done.status).toBe('finished')
    // Every board played twice (3 rounds, one table sitting out each); each NS pair sat out once, the EW pairs never
    expect(done.travellers).toHaveLength(3)
    expect(done.travellers.every((tr) => tr.entries.length === 2 && tr.entries.every((e) => e.boardId))).toBe(true)
    for (const s of done.standings) expect(s.boards).toBe(s.dir === 'NS' ? 2 : 3)
    // All passed out: every result ties, everyone has 50%
    expect(done.standings.every((s) => s.rank === 1 && s.percent === 50)).toBe(true)
    // Once over, every record is shown to everyone
    const anyRecord = done.travellers[0].entries[0].boardId!
    const outsider = await t.member('outsider')
    expect(await club().record(anyRecord, outsider)).not.toBeNull()
    // The players are free again
    expect(club().pairs.tableOf(ids[0])).toBeNull()
    await send(ids[0], { type: 'leaveTable' })
    expect(await t.refused(ids[0], { type: 'createTable' })).toBeUndefined()

    // Where the event lives: its own object with the switch on, else the club's storage
    const object = eventObjects(club()).get(pairsKey(id))
    if (EVENT_OBJECTS) expect(object?.host.pairsEvent?.status).toBe('finished')
    else expect(object).toBeUndefined()
  })

  it('lists the events, newest first, with who is in them', async () => {
    const { club, ids, director, id } = await setUp(5)
    const list = club().pairs.list(ids[1])
    expect(list).toEqual([expect.objectContaining({ id, title: '週五雙人賽', status: 'open', pairs: 5, mine: true })])
    await club().pairs.cancel(director, id)
    // A cancelled event is only on its director's list
    expect(club().pairs.list(ids[1])).toEqual([])
    expect(club().pairs.list(director)).toHaveLength(1)
  })
})
