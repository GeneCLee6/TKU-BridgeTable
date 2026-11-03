// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { PairsView } from '../../shared/pairs.ts'
import { HELD_BACK } from '../../worker/team-mode.ts'
import { EVENT_OBJECTS, eventObjects, pairsKey } from './event-mode.ts'
import { teamHarness, tick } from './team-match-harness.ts'

/**
 * Individual events (個人賽, `e9-t15`, AC-9.6, ARCHITECTURE.md §5.25): a pairs event of the
 * individual format — members enter alone, every round each player is at the table and seat the
 * whist movement gives them (a new partner every round), each board is matchpointed as in a pairs
 * event and each player takes their side's MP, one ranking by percentage, points on the finish;
 * the director's tools on players; a tournament of the individual kind. Runs on both paths of
 * `EVENT_OBJECTS` (`vite.config.ts`, `pairs*.test.ts`).
 */

const code = async (run: () => Promise<unknown>) => {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

async function setUp(players = 8, boardsPerRound = 1) {
  const t = await teamHarness()
  const { club, member } = t
  const names = Array.from({ length: players }, (_, i) => `p${i + 1}`)
  const ids: string[] = []
  for (const name of names) ids.push(await member(name))
  await club().adminSetFeature({ flag: 'pairs', state: 'on', usernames: [] })
  // The director runs the event without playing in it
  const director = await member('td')
  const view = await club().pairs.create(director, { title: '個人賽之夜', boardsPerRound }, 'individual')
  for (const id of ids) await club().pairs.enter(id, view.id, undefined)
  const viewOf = (userId: string) => club().pairs.view(view.id, userId)
  return { ...t, connections: t.h.connections, ids, names, director, id: view.id, viewOf }
}

describe('individual events (e9-t15)', () => {
  it('takes members alone, checks the format, blocks and sizes', async () => {
    const t = await setUp(9)
    const { club, ids, director, id, viewOf, member } = t
    const view = viewOf(director)
    expect(view).toMatchObject({ format: 'individual', status: 'open' })
    expect(view.pairs).toHaveLength(9)
    expect(view.pairs.every((p) => p.players.length === 1)).toBe(true)
    expect(club().pairs.list(ids[0])).toEqual([expect.objectContaining({ id, format: 'individual', pairs: 9, mine: true })])
    // A bad format is refused
    expect(await code(() => club().pairs.create(director, {}, 'teams'))).toBe('badPairsSettings')
    // Nobody enters twice
    expect(await code(() => club().pairs.enter(ids[0], id, undefined))).toBe('pairsInPair')
    // Somebody blocked by a player already in would partner them once: refused
    const late = await member('late')
    await club().handle(ids[3], { type: 'setBlocked', userId: late, blocked: true })
    expect(await code(() => club().pairs.enter(late, id, undefined))).toBe('individualBlocked')
    // 9 players do not make full tables: 8, 12, 16 or 20
    expect(await code(() => club().pairs.start(director, id))).toBe('individualSize')
    await club().pairs.withdraw(ids[8], id, undefined)
    expect(viewOf(director).pairs).toHaveLength(8)
    // A player withdraws only themselves; the director anyone
    expect(await code(() => club().pairs.withdraw(ids[1], id, ids[0]))).toBe('pairsDirectorOnly')
  })

  it('seats everyone every round with a new partner, keeps boards back, scores each player and ranks them (AC-9.6)', async () => {
    const t = await setUp(8, 1)
    const { club, ids, director, id, playUntil, connections, viewOf } = t
    const started = await club().pairs.start(director, id)
    club().broadcast()
    await tick()
    // 8 players: 2 tables, 7 rounds, one board a round played at both tables
    expect(started.movement).toMatchObject({ kind: 'individual', tables: 2, rounds: 7, boardsPerRound: 1, boards: 7 })
    expect(started.tables).toHaveLength(2)
    // A player's entry has no Mitchell place: they move every round
    expect(started.pairs.every((p) => p.dir === undefined)).toBe(true)

    const partners = new Map<string, Set<string>>()
    const seatOf = (view: PairsView) => {
      const me = view.myPair!
      const table = view.myTable!
      return { table, seat: table.seats!.indexOf(me) }
    }
    let seen: PairsView[] = []
    for (let round = 1; round <= 7; round++) {
      // Every player is at a table this round, at the table the server put them, on the seat of the movement
      const tables = viewOf(director).tables
      const seated = tables.flatMap((tb) => tb.seats!)
      expect([...seated].sort((a, b) => a - b)).toEqual([...Array(8).keys()])
      for (const userId of ids) {
        const view = viewOf(userId)
        expect(view.round).toBe(round)
        const { table, seat } = seatOf(view)
        expect(seat).toBeGreaterThanOrEqual(0)
        const state = connections.table(userId)
        expect(state?.id).toBe(table.tableId)
        expect(state?.pairs).toMatchObject({ id, round, rounds: 7, table: table.table, individual: true })
        // The seat at the table is the movement's: North, South, East, West
        const at = (['N', 'S', 'E', 'W'] as const)[seat]
        expect(state!.seats[at]?.id).toBe(userId)
        const partnerSeat = seat ^ 1
        const partner = view.pairs[table.seats![partnerSeat]].players[0].id
        partners.set(userId, (partners.get(userId) ?? new Set()).add(partner))
      }
      seen = []
      await playUntil(ids, () => {
        seen.push(viewOf(ids[0]))
        const v = viewOf(director)
        return round < 7 ? v.round === round + 1 : v.status === 'finished'
      })
      // Nobody saw a board's traveller before playing it
      for (const v of seen) {
        const shown = v.travellers.map((tr) => tr.boardNo)
        const played = v.travellers.flatMap((tr) => tr.entries.filter((e) => e.seats!.includes(v.myPair!)).map(() => tr.boardNo))
        expect(shown.every((b) => played.includes(b))).toBe(true)
      }
      if (round === 1) {
        // A record is kept back until the end: the four who played it see it, not the others
        const mine = viewOf(ids[0]).travellers[0].entries.find((e) => e.boardId)!
        expect((await club().record(mine.boardId!, ids[0]))?.revealAt).toBe(HELD_BACK)
        const other = viewOf(ids[0]).travellers[0].entries.find((e) => !e.seats!.includes(viewOf(ids[0]).myPair!))!
        expect(other.boardId).toBeUndefined()
      }
    }
    // Everyone partnered all seven others once
    for (const userId of ids) {
      const set = partners.get(userId)!
      expect(set.size).toBe(7)
      expect(set.has(userId)).toBe(false)
    }

    const done = viewOf(ids[3])
    expect(done.status).toBe('finished')
    // Every board at both tables; every player played all 7 boards; one field, all passed out: 50% each
    expect(done.travellers).toHaveLength(7)
    expect(done.travellers.every((tr) => tr.entries.length === 2 && tr.entries.every((e) => e.boardId && e.seats))).toBe(true)
    expect(done.standings).toHaveLength(8)
    expect(done.standings.every((s) => s.dir === undefined && s.boards === 7 && s.rank === 1 && s.percent === 50)).toBe(true)
    // Once over, every record is shown to everyone
    const outsider = await t.member('outsider')
    expect(await club().record(done.travellers[0].entries[0].boardId!, outsider)).not.toBeNull()
    // The points ledger took the event once, every player one side (`kind: 'individual'`)
    expect(club().rankings.ledger.recorded(id)).toBe(true)
    for (const userId of ids)
      expect(club().rankings.ledger.ledger(userId, { from: 0, to: Infinity })).toEqual([
        expect.objectContaining({ eventId: id, kind: 'individual', rank: 1, field: 8 }),
      ])
    // The players are free again
    expect(club().pairs.tableOf(ids[0])).toBeNull()

    const object = eventObjects(club()).get(pairsKey(id))
    if (EVENT_OBJECTS) expect(object?.host.pairsEvent).toMatchObject({ format: 'individual', status: 'finished' })
    else expect(object).toBeUndefined()
  })

  it("gives the director's tools on players: a penalty, a held-up table's board, a table re-opened (e9-t17)", async () => {
    const t = await setUp(8, 2)
    const { club, director, id, playUntil, connections, viewOf } = t
    const act = (userId: string, body: unknown) => club().refereeAct(userId, 'pairs', id, body)
    const reason = '牌桌斷線'
    await club().pairs.start(director, id)
    club().broadcast()
    await tick()
    // A penalty is on a player (their entry); not on an entry that is not there
    await act(director, { action: 'penalty', target: '5', amount: 1, reason: '遲到' })
    expect(await code(() => act(director, { action: 'penalty', target: '8', amount: 1, reason }))).toBe('refereeBadTarget')
    expect(viewOf(director).standings.find((s) => s.pair === 5)).toMatchObject({ penalty: 1 })

    // Re-opening table 1: its four players are taken to the new table
    const [first, second] = viewOf(director).tables
    await act(director, { action: 'restart', table: first.table, replay: [], reason })
    club().broadcast()
    await tick()
    const reopened = viewOf(director).tables.find((x) => x.table === first.table)!
    expect(reopened.tableId).not.toBe(first.tableId)
    for (const entry of reopened.seats!) {
      const userId = viewOf(director).pairs[entry].players[0].id
      expect(connections.table(userId)?.id).toBe(reopened.tableId)
    }

    // Table 1 plays its boards; table 2 is held up and the director scores its boards
    const at = (table: number) =>
      viewOf(director)
        .tables.find((x) => x.table === table)!
        .seats!.map((entry) => viewOf(director).pairs[entry].players[0].id)
    await playUntil(at(first.table), () => viewOf(director).tables.find((x) => x.table === first.table)!.played === 2)
    for (const boardNo of second.boards)
      await act(director, { action: 'score', table: second.table, boardNo, ruling: { kind: 'avgPlus', side: 'EW', reason } })
    for (let i = 0; i < 5; i++) await tick()
    const after = viewOf(director)
    expect(after.round).toBe(2)
    // Avg+ to EW: 60% to both East–West players of table 2 on those boards
    const ruled = after.travellers.flatMap((tr) => tr.entries).filter((e) => e.round === 1 && e.table === second.table)
    expect(ruled).toHaveLength(2)
    expect(ruled.every((e) => e.percentNS === 40 && e.ruling?.kind === 'avgPlus')).toBe(true)
    for (const entry of second.seats!.slice(2)) {
      const s = after.standings.find((x) => x.pair === entry)!
      // The player fined 1 MP loses its share of the two boards' tops (2 × 2)
      expect(s.percent).toBeCloseTo(60 - ((s.penalty ?? 0) / 4) * 100)
    }
  })

  it('runs as a tournament of the individual kind: alone only, the first 8 of 9, results linked', async () => {
    const t = await teamHarness()
    const { club, member, h } = t
    const names = Array.from({ length: 9 }, (_, i) => `p${i + 1}`)
    const ids: string[] = []
    for (const name of names) ids.push(await member(name))
    await club().adminSetFeature({ flag: 'tournaments', state: 'on', usernames: [] })
    const admin = h.boss
    const HOUR = 3_600_000
    const { id, capacity, kind } = await club().tournaments.create(admin, {
      kind: 'individual',
      title: '個人賽盃',
      startsAt: h.time + 3 * 24 * HOUR,
      deadline: h.time + 2 * 24 * HOUR,
      pairs: { boardsPerRound: 1, boardMinutes: 8 },
    })
    expect({ capacity, kind }).toEqual({ capacity: 20, kind: 'individual' })
    // Every member enters alone: a partner is refused
    expect(await code(() => club().tournaments.enter(ids[0], id, { partners: ['p2'] }))).toBe('tournamentEntrySize')
    for (const userId of ids.slice(0, 7)) await club().tournaments.enter(userId, id, {})
    // Each one counts as a whole place
    expect(club().tournaments.view(id, admin).used).toBe(7)
    expect(await code(() => club().tournaments.start(admin, id))).toBe('tournamentTooFew')
    for (const userId of ids.slice(7)) await club().tournaments.enter(userId, id, {})

    const started = await club().tournaments.start(admin, id)
    expect(started).toMatchObject({ status: 'started', eventLink: `/pairs/${started.eventId}` })
    const eventId = started.eventId!
    // The first eight in the order they entered (the ninth is left over), directed by the admin, played without the pairs flag
    const event = club().pairs.view(eventId, ids[0])
    expect(event).toMatchObject({ format: 'individual', title: '個人賽盃', status: 'open' })
    expect(event.director.id).toBe(admin)
    expect(event.pairs.map((p) => p.players[0].username)).toEqual(names.slice(0, 8))
    expect(await code(async () => club().pairs.view(eventId, ids[8]))).toBe('pairsOff')

    await club().pairs.start(admin, eventId)
    club().broadcast()
    await tick()
    const players = ids.slice(0, 8)
    await t.playUntil(players, () => club().pairs.view(eventId, admin).status === 'finished')
    for (let i = 0; i < 20; i++) await tick()
    expect(club().tournaments.view(id, ids[0])).toMatchObject({ status: 'finished', eventLink: `/pairs/${eventId}` })
    for (const userId of players)
      expect((await club().notifications.view(userId)).items.find((n) => n.kind === 'tournamentResults')).toMatchObject({
        params: { tournamentId: id, eventKind: 'individual', eventId },
      })
  })
})
