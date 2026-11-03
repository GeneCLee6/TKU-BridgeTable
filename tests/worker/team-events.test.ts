// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { BYE_VP } from '../../shared/team-event.ts'
import { matchVictoryPoints } from '../../shared/vp.ts'
import { teamHarness } from './team-match-harness.ts'

/**
 * Multi-team events (`e9-t14`, AC-9.5, ARCHITECTURE.md §5.26) end to end: a tournament of teams of
 * 4–6, made into the event; captains' line-ups; the director's rounds, each an ordinary team match
 * per pairing with the line-ups seated; the byes; VP standings with the director's penalties; the
 * match's own rules kept for the event; the finish, its points and the results announcement. Runs
 * on both paths of `EVENT_OBJECTS` (the matches in the club, or each in its own object).
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

async function setUp(teams: string[][], over: Record<string, unknown> = {}) {
  const t = await teamHarness()
  const ids: Record<string, string> = {}
  for (const name of teams.flat()) ids[name] = await t.member(name)
  await t.club().adminSetFeature({ flag: 'tournaments', state: 'on', usernames: [] })
  const admin = t.h.boss
  const tour = () => t.club().tournaments
  const { id: tournamentId } = await tour().create(admin, {
    kind: 'teams',
    title: '社慶團體賽',
    startsAt: t.h.time + 3 * 24 * HOUR,
    deadline: t.h.time + 2 * 24 * HOUR,
    teams: { boards: 4, boardMinutes: 10, rounds: 5 },
    ...over,
  })
  for (const [i, team] of teams.entries()) {
    await tour().enter(ids[team[0]], tournamentId, { partners: team.slice(1), teamName: `隊${i + 1}` })
    for (const name of team.slice(1)) await tour().answer(ids[name], tournamentId, true)
  }
  const started = await tour().start(admin, tournamentId)
  const eventId = started.eventId!
  const events = () => t.club().teamEvents
  const view = (userId: string) => events().view(eventId, userId)
  const kinds = async (userId: string) => (await t.club().notifications.view(userId)).items.map((n) => n.kind)
  return { ...t, ids, admin, tournamentId, started, eventId, events, view, kinds }
}

const TEAMS = [
  ['a1', 'a2', 'a3', 'a4', 'a5'],
  ['b1', 'b2', 'b3', 'b4'],
  ['c1', 'c2', 'c3', 'c4'],
]

type Env = Awaited<ReturnType<typeof setUp>>

/** Starts a round's match as its host and plays it out: everyone passes, every board is level */
async function playMatch(t: Env, matchId: string) {
  const match = t.club().matches.store.get(matchId)!
  await t.send(match.hostId, { type: 'startMatch', matchId })
  expect(t.club().matches.store.get(matchId)!.status).toBe('playing')
  const people = match.seats.flatMap((s) => (s.userId ? [s.userId] : []))
  await t.playUntil(people, () => t.club().matches.store.get(matchId)!.status === 'finished')
}

describe('multi-team events (e9-t14)', () => {
  it('is made from a tournament of teams of 4–6, as a round robin when everyone can meet', async () => {
    const t = await setUp(TEAMS)
    expect(t.started).toMatchObject({ status: 'started', eventLink: `/team-events/${t.eventId}` })
    const v = t.view(t.ids.a1)
    expect(v).toMatchObject({ status: 'ready', format: 'roundRobin', rounds: 3, myTeam: 0, canNext: false, canCancel: false, played: [] })
    expect(v.teams.map((x) => [x.name, x.players.length])).toEqual([['隊1', 5], ['隊2', 4], ['隊3', 4]])
    // The standings start level
    expect(v.standings.every((s) => s.vp === 0 && s.rank === 1)).toBe(true)
    expect(t.view(t.admin)).toMatchObject({ canNext: true, canCancel: true })
  })

  it('checks the tournament: teams of 4–6, at least three complete ones', async () => {
    const t = await teamHarness()
    const names = ['p1', 'p2', 'p3', 'q1', 'q2', 'q3', 'q4', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']
    const ids: Record<string, string> = {}
    for (const n of names) ids[n] = await t.member(n)
    await t.club().adminSetFeature({ flag: 'tournaments', state: 'on', usernames: [] })
    const tour = t.club().tournaments
    const { id } = await tour.create(t.h.boss, { kind: 'teams', title: '團體賽', startsAt: t.h.time + 5 * HOUR, deadline: t.h.time + 4 * HOUR })
    expect(tour.view(id, ids.p1)).toMatchObject({ capacity: 16, settings: { teams: { boards: 8, rounds: 5 } } })
    expect(await code(() => tour.enter(ids.p1, id, { partners: ['p2', 'p3'] }))).toBe('tournamentEntrySize')
    expect(await code(() => tour.enter(ids.r1, id, { partners: ['r2', 'r3', 'r4', 'r5', 'r6', 'r7'] }))).toBe('tournamentEntrySize')
    await tour.enter(ids.q1, id, { partners: ['q2', 'q3', 'q4'] })
    await tour.enter(ids.r1, id, { partners: ['r2', 'r3', 'r4', 'r5', 'r6'] })
    for (const n of ['q2', 'q3', 'q4', 'r2', 'r3', 'r4', 'r5', 'r6']) await tour.answer(ids[n], id, true)
    expect(await code(() => tour.start(t.h.boss, id))).toBe('tournamentTooFew')
    expect(await code(() => tour.create(t.h.boss, { kind: 'teams', title: 'x', startsAt: t.h.time + 5 * HOUR, deadline: t.h.time + HOUR, teams: { rounds: 12 } }))).toBe(
      'badTournament',
    )
    expect(await code(() => tour.create(t.h.boss, { kind: 'teams', title: 'x', startsAt: t.h.time + 5 * HOUR, deadline: t.h.time + HOUR, capacity: 2 }))).toBe(
      'badTournament',
    )
  })

  it("lets each captain set the team's line-up, which only the team and the director see", async () => {
    const t = await setUp(TEAMS)
    const { ids, eventId } = t
    const lineup = (userId: string, team: number, players: string[]) => t.events().setLineup(userId, eventId, team, players)
    expect(await code(() => lineup(ids.a2, 0, [ids.a2, ids.a3, ids.a4, ids.a5]))).toBe('teamEventCaptainOnly')
    expect(await code(() => lineup(ids.a1, 0, [ids.a1, ids.a1, ids.a3, ids.a4]))).toBe('teamEventBadLineup')
    expect(await code(() => lineup(ids.a1, 0, [ids.a1, ids.b1, ids.a3, ids.a4]))).toBe('teamEventBadLineup')
    expect(await code(() => lineup(ids.a1, 9, [ids.a1, ids.a2, ids.a3, ids.a4]))).toBe('teamEventBadLineup')
    await lineup(ids.a1, 0, [ids.a5, ids.a1, ids.a2, ids.a3])
    expect(t.view(ids.a4).teams[0].lineup).toEqual([ids.a5, ids.a1, ids.a2, ids.a3])
    expect(t.view(t.admin).teams[0].lineup).toEqual([ids.a5, ids.a1, ids.a2, ids.a3])
    // Another team does not see it before the round is made
    expect(t.view(ids.b1).teams[0].lineup).toEqual([])
    expect(t.view(ids.b1).teams[1]).toMatchObject({ canLineup: true, lineup: [ids.b1, ids.b2, ids.b3, ids.b4] })
    expect(t.view(ids.b1).teams[0].canLineup).toBe(false)
    // The director may set any team's
    await lineup(t.admin, 1, [ids.b4, ids.b3, ids.b2, ids.b1])
    expect(t.view(ids.b2).teams[1].lineup).toEqual([ids.b4, ids.b3, ids.b2, ids.b1])
  })

  it('plays the rounds: each pairing a seated team match, the bye, VP standings with penalties, then points and results', async () => {
    const t = await setUp(TEAMS)
    const { ids, eventId, admin } = t
    expect(await code(() => t.events().nextRound(ids.a1, eventId))).toBe('teamEventDirectorOnly')
    await t.events().setLineup(ids.a1, eventId, 0, [ids.a5, ids.a1, ids.a2, ids.a3])

    // Round 1 of the round robin of three: one match, one bye
    const r1 = await t.events().nextRound(admin, eventId)
    expect(r1).toMatchObject({ status: 'playing', canNext: false, canCancel: false })
    const round1 = r1.played[0]
    expect(round1.matches).toHaveLength(1)
    expect(round1.bye).toBeDefined()
    const m1 = round1.matches[0]
    const match = t.club().matches.store.get(m1.matchId)!
    const teamPlayers = (i: number) => t.view(admin).teams[i].lineup
    const [A, B] = [teamPlayers(m1.a), teamPlayers(m1.b)]
    // Every seat taken by the line-ups, team A's first hosting from the open room's South; no robots, IMPs
    const seat = (room: string, s: string) => match.seats.find((x) => x.room === room && x.seat === s)!
    expect(match).toMatchObject({ hostId: A[0], status: 'setup', captains: { A: A[0], B: B[0] }, settings: { boards: 4, scoring: 'imp', robots: false } })
    expect(match.seats.every((s) => s.status === 'seated' && !s.robot)).toBe(true)
    expect([seat('open', 'S'), seat('open', 'N'), seat('closed', 'E'), seat('closed', 'W')].map((s) => s.userId)).toEqual(A)
    expect([seat('open', 'E'), seat('open', 'W'), seat('closed', 'N'), seat('closed', 'S')].map((s) => s.userId)).toEqual(B)
    // Everyone of the round's teams heard, the bye's too
    const byeTeam = t.view(admin).teams[round1.bye!]
    expect(await t.kinds(byeTeam.players[0].id)).toContain('teamEventRound')
    expect(await t.kinds(A[1])).toContain('teamEventRound')
    expect(t.view(A[1]).myMatch).toBe(m1.matchId)

    // The match is the event's: no cancelling, no new settings, no leaving or inviting; only swapping within a team
    expect(await code(() => t.club().matches.cancel(A[0], m1.matchId))).toBe('teamEventMatch')
    expect(await code(() => t.club().matches.update(A[0], m1.matchId, { boards: 8 }))).toBe('teamEventMatch')
    expect(await code(() => t.club().matches.act(B[1], { type: 'matchLeave', matchId: m1.matchId }))).toBe('teamEventMatch')
    await t.club().matches.act(B[0], { type: 'matchMove', matchId: m1.matchId, from: { room: 'open', seat: 'E' }, to: { room: 'closed', seat: 'N' } })
    expect(t.club().matches.store.get(m1.matchId)!.seats.find((s) => s.room === 'closed' && s.seat === 'N')!.userId).toBe(B[0])
    // The host plays: only admins referee an event's match
    expect(await code(() => t.club().refereeAct(A[0], 'match', m1.matchId, { action: 'penalty', target: 'B', amount: 3, reason: '慢' }))).toBe('refereeOnly')
    expect(t.club().matches.get(m1.matchId, A[0])!.canReferee).toBeUndefined()
    // Not the next round while this one is on
    expect(await code(() => t.events().nextRound(admin, eventId))).toBe('teamEventRoundOn')

    await playMatch(t, m1.matchId)
    // The director takes 5 IMPs off team A: the VP follow
    await t.club().refereeAct(admin, 'match', m1.matchId, { action: 'penalty', target: 'A', amount: 5, reason: '遲到' })
    const after1 = t.view(ids.c1)
    const vp = matchVictoryPoints({ A: -5, B: 0 }, 4)
    expect(after1.played[0]).toMatchObject({ done: true, matches: [{ status: 'finished', imps: { A: -5, B: 0 }, vp }] })
    const vpOf = (team: number) => after1.standings.find((s) => s.team === team)!.vp
    expect(vpOf(m1.a)).toBe(vp.A)
    expect(vpOf(m1.b)).toBe(vp.B)
    expect(vpOf(round1.bye!)).toBe(BYE_VP)
    // A team match of the event gives no points of its own
    expect(t.club().rankings.ledger.ledger(A[0], { from: 0, to: Infinity })).toEqual([])

    // Rounds 2 and 3
    for (let n = 2; n <= 3; n++) {
      const v = await t.events().nextRound(admin, eventId)
      const round = v.played[n - 1]
      expect(round.matches).toHaveLength(1)
      await playMatch(t, round.matches[0].matchId)
    }
    const done = t.view(ids.a1)
    expect(done).toMatchObject({ status: 'finished', canNext: false })
    // Round robin: each pair met once, each team had one bye
    const pairs = done.played.map((r) => [r.matches[0].a, r.matches[0].b].sort().join('-'))
    expect(new Set(pairs).size).toBe(3)
    expect(new Set(done.played.map((r) => r.bye)).size).toBe(3)
    // Totals: two level matches (10 each) and a bye apiece, the first match's penalty on top
    const total = done.standings.reduce((sum, s) => sum + s.vp, 0)
    expect(total).toBeCloseTo(3 * 20 + 3 * BYE_VP, 6)
    expect(done.standings[2].team).toBe(m1.a)
    expect(await code(() => t.events().nextRound(admin, eventId))).toBe('teamEventOver')

    // Points: each team a side by its place, its members who played
    const ledger = (userId: string) => t.club().rankings.ledger.ledger(userId, { from: 0, to: Infinity })
    expect(ledger(ids.a1)).toEqual([expect.objectContaining({ eventId, kind: 'teams' })])
    // a4 never played (the line-up was a5, a1, a2, a3 all along)
    expect(ledger(ids.a4)).toEqual([])
    const last = done.standings[2]
    expect(ledger(done.teams[last.team].players[1].id)[0]).toMatchObject({ rank: 3 })
    // The tournament is finished and everyone in it told
    expect(t.club().tournaments.view(t.tournamentId, ids.b2)).toMatchObject({ status: 'finished', eventLink: `/team-events/${eventId}` })
    expect(await t.kinds(ids.a4)).toContain('tournamentResults')
  })

  it('is Swiss for a larger field: no team meets another twice, and a substitute comes from the team', async () => {
    const teams = Array.from({ length: 4 }, (_, i) => Array.from({ length: 4 }, (_, j) => `s${i}${j}`))
    // Four teams with at most two rounds: Swiss over two
    const t = await setUp(teams, { teams: { boards: 4, boardMinutes: 10, rounds: 3 } })
    expect(t.view(t.admin)).toMatchObject({ format: 'roundRobin', rounds: 3 })
    const t2 = await setUp(
      Array.from({ length: 6 }, (_, i) => Array.from({ length: 4 }, (_, j) => `w${i}${j}`)),
      { teams: { boards: 4, boardMinutes: 10, rounds: 3 } },
    )
    const { admin, eventId } = t2
    expect(t2.view(admin)).toMatchObject({ format: 'swiss', rounds: 3 })
    const met = new Set<string>()
    for (let n = 1; n <= 3; n++) {
      const v = await t2.events().nextRound(admin, eventId)
      const round = v.played[n - 1]
      expect(round.matches).toHaveLength(3)
      expect(round.bye).toBeUndefined()
      for (const m of round.matches) {
        const key = [m.a, m.b].sort().join('-')
        expect(met.has(key)).toBe(false)
        met.add(key)
      }
      if (n === 1) {
        // A substitute must be one of the team's own: the match is paused first
        const m = round.matches[0]
        const match = t2.club().matches.store.get(m.matchId)!
        await t2.send(match.hostId, { type: 'startMatch', matchId: m.matchId })
        await t2.club().matches.pause(match.hostId, m.matchId, true)
        const outsider = t2.view(admin).teams[round.matches[1].a].players[0].id
        expect(
          await code(() => t2.club().matches.replace(match.hostId, { type: 'matchReplace', matchId: m.matchId, room: 'open', seat: 'N', userId: outsider })),
        ).toBe('teamEventRoster')
        await t2.club().matches.pause(match.hostId, m.matchId, false)
      }
      for (const m of round.matches) {
        const match = t2.club().matches.store.get(m.matchId)!
        if (match.status === 'setup') await t2.send(match.hostId, { type: 'startMatch', matchId: m.matchId })
        const people = match.seats.flatMap((s) => (s.userId ? [s.userId] : []))
        await t2.playUntil(people, () => t2.club().matches.store.get(m.matchId)!.status === 'finished')
      }
    }
    expect(t2.view(admin).status).toBe('finished')
  })

  it('may be called off before round 1: the tournament takes entries again', async () => {
    const t = await setUp(TEAMS)
    expect(await code(() => t.events().cancel(t.ids.a1, t.eventId))).toBe('teamEventDirectorOnly')
    await t.events().cancel(t.admin, t.eventId)
    expect(t.club().tournaments.view(t.tournamentId, t.admin)).toMatchObject({ status: 'open' })
    expect(await code(() => t.view(t.ids.a1))).toBe('teamEventGone')
    // Started again from the same entries: a new event
    const again = await t.club().tournaments.start(t.admin, t.tournamentId)
    expect(again.eventId).not.toBe(t.eventId)
  })

  it('is only for members with the flag, its teams and admins', async () => {
    const t = await setUp(TEAMS)
    const outsider = await t.member('zed')
    await t.club().adminSetFeature({ flag: 'tournaments', state: 'off', usernames: [] })
    expect(await code(() => t.view(outsider))).toBe('teamEventGone')
    // Its players reach it without the flag
    expect(t.view(t.ids.b3).myTeam).toBe(1)
    expect(await code(() => t.events().view('nope', t.admin))).toBe('teamEventGone')
  })
})
