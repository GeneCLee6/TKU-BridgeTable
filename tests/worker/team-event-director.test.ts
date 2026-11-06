// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { teamHarness } from './team-match-harness.ts'

/**
 * Multi-team events, the president's follow-ups (社長 2026-11-03, ARCHITECTURE.md §5.26): the
 * admin chooses round robin or Swiss on the announcement; in the event's matches its director (or
 * an admin) rules, pauses, abandons and may start for the host, who only arranges their own team;
 * every match of a round plays the same deals, compared board by board on the event's page once
 * every match has played the board, and kept from the round's other players until then. Runs on
 * both paths of `EVENT_OBJECTS`.
 */

const HOUR = 3_600_000

const code = async (run: () => unknown) => {
  try {
    await run()
  } catch (error) {
    return (error as { code?: string }).code
  }
  return undefined
}

async function setUp(teamCount: number, teams: Record<string, unknown> = { boards: 4, boardMinutes: 10, rounds: 5 }, capacity?: number) {
  const t = await teamHarness()
  const names = Array.from({ length: teamCount }, (_, i) => Array.from({ length: 4 }, (_, j) => `t${i}p${j}`))
  const ids: Record<string, string> = {}
  for (const name of names.flat()) ids[name] = await t.member(name)
  await t.club().adminSetFeature({ flag: 'tournaments', state: 'on', usernames: [] })
  const admin = t.h.boss
  const tour = () => t.club().tournaments
  const { id: tournamentId } = await tour().create(admin, {
    kind: 'teams',
    title: '團體賽',
    startsAt: t.h.time + 3 * 24 * HOUR,
    deadline: t.h.time + 2 * 24 * HOUR,
    teams,
    ...(capacity !== undefined && { capacity }),
  })
  for (const [i, team] of names.entries()) {
    await tour().enter(ids[team[0]], tournamentId, { partners: team.slice(1), teamName: `隊${i + 1}` })
    for (const name of team.slice(1)) await tour().answer(ids[name], tournamentId, true)
  }
  const started = await tour().start(admin, tournamentId)
  const eventId = started.eventId!
  const events = () => t.club().teamEvents
  const view = (userId: string) => events().view(eventId, userId)
  const store = () => t.club().matches.store
  const people = (matchId: string) => store().get(matchId)!.seats.flatMap((s) => (s.userId && !s.robot ? [s.userId] : []))
  return { ...t, ids, admin, tournamentId, eventId, events, view, store, people }
}

describe('multi-team events: the format the admin chooses', () => {
  it('checks the rounds against the format: a round robin every team meeting every other, Swiss fewer than the places', async () => {
    const t = await teamHarness()
    const tour = t.club().tournaments
    const base = { kind: 'teams', title: '團體賽', startsAt: t.h.time + 5 * HOUR, deadline: t.h.time + 4 * HOUR }
    const create = (capacity: number, teams: Record<string, unknown>) => code(() => tour.create(t.h.boss, { ...base, capacity, teams }))
    // A round robin of up to 8 teams plays 7 rounds; of up to 7, 7 too (each one bye)
    expect(await create(8, { rounds: 5, format: 'roundRobin' })).toBe('badTournament')
    expect(await create(8, { rounds: 7, format: 'roundRobin' })).toBeUndefined()
    expect(await create(7, { rounds: 7, format: 'roundRobin' })).toBeUndefined()
    // More than ten teams do not fit the nine rounds allowed
    expect(await create(12, { rounds: 9, format: 'roundRobin' })).toBe('badTournament')
    // Swiss: fewer rounds than the places
    expect(await create(4, { rounds: 4, format: 'swiss' })).toBe('badTournament')
    expect(await create(4, { rounds: 3, format: 'swiss' })).toBeUndefined()
    expect(await create(16, { rounds: 9, format: 'nope' })).toBe('badTournament')
    // Automatic, as before
    expect(await create(16, { rounds: 5, format: 'auto' })).toBeUndefined()
  })

  it('plays the format chosen: Swiss for four teams that could have met in a round robin, a round robin of the teams that came', async () => {
    const swiss = await setUp(4, { boards: 4, boardMinutes: 10, rounds: 3, format: 'swiss' })
    expect(swiss.view(swiss.admin)).toMatchObject({ format: 'swiss', rounds: 3, settings: { format: 'swiss' } })
    // Places for 6 (5 rounds), 3 came: a round robin of three
    const rr = await setUp(3, { boards: 4, boardMinutes: 10, rounds: 5, format: 'roundRobin' }, 6)
    expect(rr.club().tournaments.view(rr.tournamentId, rr.admin)).toMatchObject({ settings: { teams: { format: 'roundRobin' } } })
    expect(rr.view(rr.admin)).toMatchObject({ format: 'roundRobin', rounds: 3 })
  })
})

describe("multi-team events: the director runs the matches (the host only plays)", () => {
  it('lets the director start, pause, rule and abandon; the host may not, and arranges only their own team', async () => {
    const t = await setUp(3)
    const { admin, eventId } = t
    const round = (await t.events().nextRound(admin, eventId)).played[0]
    const matchId = round.matches[0].matchId
    const match = t.store().get(matchId)!
    const host = match.hostId
    const captainB = match.captains.B!
    // The director sees the prep room, may start it and runs it; the host is told so
    const directorView = t.club().matches.get(matchId, admin)!
    expect(directorView).toMatchObject({ status: 'setup', canReferee: true, event: { id: eventId, directs: true }, ready: { ready: true } })
    expect(t.club().matches.get(matchId, host)).toMatchObject({ event: { id: eventId, directs: false } })
    expect(t.club().matches.get(matchId, host)!.canReferee).toBeUndefined()
    await t.club().startMatchRequest(admin, matchId)
    expect(t.store().get(matchId)!.status).toBe('playing')
    const kinds = async (userId: string) => (await t.club().notifications.view(userId)).items.map((n) => n.kind)
    // The host did not start it: they hear it started too
    expect(await kinds(host)).toContain('matchStarted')
    // Only the director sees where the rooms are
    expect(t.club().matches.get(matchId, admin)!.rooms).toBeDefined()
    expect(t.club().matches.get(matchId, host)!.rooms).toBeUndefined()

    // The host may not pause, rule, have a robot sit in or abandon
    expect(await code(() => t.club().matches.pause(host, matchId, true))).toBe('matchEventDirector')
    expect(await code(() => t.club().matches.sitIn(host, { type: 'matchSitIn', matchId, room: 'open', seat: 'N' }))).toBe('matchEventDirector')
    expect(
      await code(() => t.club().matches.rule(host, { type: 'matchRule', matchId, seq: 1, ruling: 'avg', team: 'A', reason: '慢' })),
    ).toBe('matchEventDirector')
    expect(await t.refused(host, { type: 'matchPause', matchId, paused: true })).toBe('matchEventDirector')
    // The director (or an admin) rules on a board over the time limit
    expect(
      await code(() => t.club().matches.rule(admin, { type: 'matchRule', matchId, seq: 1, ruling: 'avg', team: 'A', reason: '慢' })),
    ).toBe('matchNotOverTime')
    t.h.time += 11 * 60_000
    await t.send(admin, { type: 'matchRule', matchId, seq: 1, ruling: 'avgPlus', team: 'B', reason: '超時' })
    expect(t.store().get(matchId)!.boards.find((b) => b.seq === 1)!.ruling).toMatchObject({ kind: 'avgPlus', team: 'B', by: admin })
    // The director pauses
    await t.send(admin, { type: 'matchPause', matchId, paused: true })
    expect(t.store().get(matchId)!.pausedAt).toBeDefined()
    expect(await code(() => t.club().matches.abandon(host, matchId))).toBe('matchEventDirector')
    // Paused: the host brings in a substitute only for team A (their own); team B's captain for team B
    const teamB = t.view(admin).teams[round.matches[0].b]
    const teamA = t.view(admin).teams[round.matches[0].a]
    expect(teamB.players.length).toBe(4)
    expect(teamA.players.length).toBe(4)
    expect(
      await code(() => t.club().matches.replace(host, { type: 'matchReplace', matchId, room: 'open', seat: 'E', userId: teamB.players[0].id })),
    ).toBe('matchNotCaptain')
    expect(captainB).toBe(teamB.players[0].id)
    // The director abandons the paused match
    await t.send(admin, { type: 'matchAbandon', matchId })
    expect(t.store().get(matchId)!.status).toBe('abandoned')
    // The director's referee tools too (the host's are not)
    await t.club().refereeAct(admin, 'match', matchId, { action: 'penalty', target: 'A', amount: 1, reason: '遲到' })
    expect(await code(() => t.club().refereeAct(host, 'match', matchId, { action: 'penalty', target: 'B', amount: 1, reason: 'x' }))).toBe('refereeOnly')
  })

  it('still lets the host start it, and swap seats within team A only', async () => {
    const t = await setUp(3)
    const round = (await t.events().nextRound(t.admin, t.eventId)).played[0]
    const matchId = round.matches[0].matchId
    const host = t.store().get(matchId)!.hostId
    const move = (from: string, to: string) => ({
      type: 'matchMove' as const,
      matchId,
      from: { room: 'open' as const, seat: from as 'N' },
      to: { room: from === 'E' || from === 'W' ? ('open' as const) : ('closed' as const), seat: to as 'N' },
    })
    expect(await code(() => t.club().matches.act(host, move('E', 'W')))).toBe('matchNotCaptain')
    await t.club().matches.act(host, move('N', 'E'))
    // Nobody else in the event (another team's player) may start it
    const other = t.view(t.admin).teams[round.bye!].players[0].id
    expect(await code(() => t.club().startMatchRequest(other, matchId))).toBe('matchGone')
    await t.club().startMatchRequest(host, matchId)
    expect(t.store().get(matchId)!.status).toBe('playing')
  })
})

describe('multi-team events: the same deals in every match of a round', () => {
  it('deals the round once, compares each board once every match played it, and keeps it from the other players until then', async () => {
    const t = await setUp(4)
    const { admin, eventId } = t
    const round = (await t.events().nextRound(admin, eventId)).played[0]
    expect(round.matches).toHaveLength(2)
    expect(round.sameDeals).toBe(true)
    const [m1, m2] = round.matches.map((m) => m.matchId)
    // The matches need not start together: match 1 first
    await t.club().startMatchRequest(t.store().get(m1)!.hostId, m1)
    const open1 = t.tableIdOf(m1, 'open')

    // Match 1 plays board 1 in both rooms
    const done = (id: string, seq: number) => {
      const b = t.store().get(id)!.boards.find((x) => x.seq === seq)
      return !!(b?.open && b.closed)
    }
    await t.playUntil(t.people(m1), () => done(m1, 1))
    const board1 = t.store().get(m1)!.boards.find((b) => b.seq === 1)!
    const player2 = t.people(m2)[1]
    const player1 = t.people(m1)[1]
    // Match 2 has not played it: nothing of it shows outside match 1
    expect(t.view(player2).played[0].boards).toEqual([])
    expect(t.view(admin).played[0].boards).toEqual([])
    expect(t.club().matches.get(m1, player2)!.boards).toEqual([])
    expect(t.club().matches.get(m1, player2)!.totals).toEqual({ A: 0, B: 0 })
    // Match 1's own players see their board, as in any team match; so does the director
    expect(t.club().matches.get(m1, player1)!.boards.map((b) => b.seq)).toEqual([1])
    expect(t.club().matches.get(m1, admin)!.boards.map((b) => b.seq)).toEqual([1])
    // Its records stay kept back from the round's other players
    expect(await t.club().record(board1.open!.boardId, player2)).toBeNull()
    // Nor may they watch match 1 (its tables, its Vugraph page) while their own match is on
    expect(await code(() => t.club().matchVugraph(player2, m1))).toBe('teamEventNoWatching')
    expect(await t.refused(player2, { type: 'joinTable', tableId: open1 })).toBe('teamEventNoWatching')
    const bystander = await t.member('zed')
    await t.club().matchVugraph(bystander, m1)

    // Match 2 starts later on the same boards, dealer and vulnerability with them (each board keeps its number)
    await t.club().startMatchRequest(t.store().get(m2)!.hostId, m2)
    const deals1 = t.store().get(m1)!.deals!
    const deals2 = t.store().get(m2)!.deals!
    expect(deals1.boards).toHaveLength(4)
    expect(deals2).toEqual(deals1)
    expect(deals1.boards.map((b) => b.boardNo)).toEqual([1, 2, 3, 4])
    expect(t.tableState(t.tableIdOf(m2, 'open'))!.board!.hands).toEqual(deals1.boards[0].hands)

    // Match 2 plays board 1 too: now the board is compared, for everyone who sees the event
    await t.playUntil(t.people(m2), () => done(m2, 1))
    const compared = t.view(player2).played[0].boards
    expect(compared.map((b) => b.seq)).toEqual([1])
    expect(compared[0].rows.map((r) => r.matchId)).toEqual([m1, m2])
    // Everyone passed: every room scored 0, so does the datum
    expect(compared[0]).toMatchObject({ datum: 0, rows: [{ result: { A: 0, B: 0 }, vsDatum: { open: 0, closed: 0 } }, { result: { A: 0, B: 0 } }] })
    expect(t.club().matches.get(m1, player2)!.boards.map((b) => b.seq)).toEqual([1])
    expect(await t.club().record(board1.open!.boardId, player2)).not.toBeNull()
    expect(t.view(t.ids.t0p0).played[0].boards).toHaveLength(1)

    // Both finish: every board compared, every record shown, watching allowed again
    await t.playUntil(t.people(m1), () => t.store().get(m1)!.status === 'finished')
    expect(t.view(player2).played[0].boards.map((b) => b.seq)).toEqual([1])
    await t.playUntil(t.people(m2), () => t.store().get(m2)!.status === 'finished')
    expect(t.view(player2).played[0].boards.map((b) => b.seq)).toEqual([1, 2, 3, 4])
    const last = t.store().get(m1)!.boards.find((b) => b.seq === 4)!
    expect(await t.club().record(last.closed!.boardId, player2)).not.toBeNull()
    await t.club().matchVugraph(player2, m1)

    // The next round deals anew
    const r2 = (await t.events().nextRound(admin, eventId)).played[1]
    for (const m of r2.matches) await t.club().startMatchRequest(t.store().get(m.matchId)!.hostId, m.matchId)
    const next = r2.matches.map((m) => t.store().get(m.matchId)!.deals!)
    expect(next[1]).toEqual(next[0])
    expect(next[0]).not.toEqual(deals1)
  })
})
