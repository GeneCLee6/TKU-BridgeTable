// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { NotificationKind } from '../../shared/protocol.ts'
import { parseTournamentSettings, TOURNAMENT_LIMITS, type Tournament } from '../../shared/tournament.ts'
import { manualScheduler } from '../../worker/scheduler.ts'
import { memoryStore } from './sqlite.ts'
import { TournamentService, type EventState } from '../../worker/tournaments.ts'
import { teamHarness, tick } from './team-match-harness.ts'

/**
 * Tournament announcements and entries (`e9-t16`, AC-9.7, ARCHITECTURE.md §5.23): an admin
 * announces, members enter alone, with a partner or as a team (partners confirm), withdraw before
 * the deadline; the reminder an hour before the start; the admin makes the pairs event or the team
 * match from the entries; the results announced when it ends.
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

async function setUp(names: string[] = []) {
  const t = await teamHarness()
  const ids: Record<string, string> = {}
  for (const name of names) ids[name] = await t.member(name)
  await t.club().adminSetFeature({ flag: 'tournaments', state: 'on', usernames: [] })
  const admin = t.h.boss
  const now = t.h.time
  const settings = (over: Record<string, unknown> = {}) => ({
    kind: 'pairs',
    title: '社慶盃',
    description: '週六下午兩點，社辦見',
    startsAt: now + 3 * 24 * HOUR,
    deadline: now + 2 * 24 * HOUR,
    capacity: 10,
    pairs: { boardsPerRound: 1, boardMinutes: 8 },
    ...over,
  })
  const kinds = async (userId: string) => (await t.club().notifications.view(userId)).items.map((n) => n.kind)
  return { ...t, ids, admin, settings, kinds }
}

describe('tournaments (e9-t16)', () => {
  it('checks the announcement', () => {
    const now = 1_000
    const ok = { kind: 'pairs', title: '社慶盃', startsAt: now + HOUR * 5, deadline: now + HOUR * 4 }
    expect(parseTournamentSettings(ok, now)).toMatchObject({ settings: { kind: 'pairs', capacity: TOURNAMENT_LIMITS.pairsMax } })
    expect(parseTournamentSettings({ ...ok, kind: 'chess' }, now)).toEqual({ field: 'kind' })
    expect(parseTournamentSettings({ ...ok, title: ' ' }, now)).toEqual({ field: 'title' })
    expect(parseTournamentSettings({ ...ok, startsAt: now - 1 }, now)).toEqual({ field: 'startsAt' })
    expect(parseTournamentSettings({ ...ok, deadline: now + HOUR * 6 }, now)).toEqual({ field: 'deadline' })
    expect(parseTournamentSettings({ ...ok, capacity: 4 }, now)).toEqual({ field: 'capacity' })
    expect(parseTournamentSettings({ ...ok, pairs: { boardsPerRound: 9 } }, now)).toEqual({ field: 'pairs' })
    expect(parseTournamentSettings({ ...ok, kind: 'match', match: { boards: 2 } }, now)).toEqual({ field: 'match' })
    // A team match is always two teams
    expect(parseTournamentSettings({ ...ok, kind: 'match', capacity: 9 }, now)).toMatchObject({ settings: { capacity: 2 } })
    // Kept times may have passed (fixing the text after the deadline); changed ones may not
    const base = (parseTournamentSettings(ok, now) as { settings: Tournament['settings'] }).settings
    expect(parseTournamentSettings({ description: '改地點' }, now + HOUR * 4.5, base)).toMatchObject({ settings: { description: '改地點' } })
    expect(parseTournamentSettings({ deadline: now + HOUR }, now + HOUR * 2, base)).toEqual({ field: 'deadline' })
  })

  it('is behind the flag for members; only admins announce, and members with the flag hear of it', async () => {
    const t = await teamHarness()
    const amy = await t.member('amy')
    const ben = await t.member('ben')
    const admin = t.h.boss
    const settings = { kind: 'pairs', title: '社慶盃', startsAt: t.h.time + 3 * 24 * HOUR, deadline: t.h.time + 24 * HOUR }
    expect(await code(() => t.club().tournaments.list(amy))).toBe('tournamentsOff')
    // Admins reach it with the flag off, to prepare
    expect(t.club().tournaments.list(admin)).toEqual([])
    await t.club().adminSetFeature({ flag: 'tournaments', state: 'off', usernames: ['amy'] })
    expect(await code(() => t.club().tournaments.create(amy, settings))).toBe('tournamentAdminOnly')
    expect(await code(() => t.club().tournaments.create(admin, { ...settings, deadline: 0 }))).toBe('badTournament')
    const view = await t.club().tournaments.create(admin, settings)
    expect(view).toMatchObject({ title: '社慶盃', status: 'open', entriesOpen: true, canManage: true, used: 0 })
    expect((await t.club().notifications.view(amy)).items[0]).toMatchObject({
      kind: 'tournamentAnnounced',
      params: { tournamentId: view.id, title: '社慶盃' },
    })
    expect((await t.club().notifications.view(ben)).items).toEqual([])
    expect(t.club().tournaments.list(amy)).toEqual([expect.objectContaining({ id: view.id, mine: false })])
    expect(t.club().tournaments.view(view.id, amy).canManage).toBe(false)
  })

  it('takes entries alone, with a partner who confirms, and checks them', async () => {
    const t = await setUp(['amy', 'ben', 'cat', 'dan', 'eve'])
    const { club, ids, admin } = t
    const { id } = await club().tournaments.create(admin, t.settings({ capacity: 5 }))
    const tour = () => club().tournaments
    // A partner must be a member, not oneself, and neither may have blocked the other
    expect(await code(() => tour().enter(ids.amy, id, { partners: ['nobody'] }))).toBe('tournamentBadPartner')
    expect(await code(() => tour().enter(ids.amy, id, { partners: ['amy'] }))).toBe('tournamentBadPartner')
    expect(await code(() => tour().enter(ids.amy, id, { partners: ['ben', 'cat'] }))).toBe('tournamentEntrySize')
    await club().handle(ids.eve, { type: 'setBlocked', userId: ids.amy, blocked: true })
    expect(await code(() => tour().enter(ids.amy, id, { partners: ['eve'] }))).toBe('tournamentBadPartner')

    const entered = await tour().enter(ids.amy, id, { partners: ['ben'] })
    expect(entered.entries).toEqual([
      expect.objectContaining({ complete: false, players: [expect.objectContaining({ username: 'amy', confirmed: true }), expect.objectContaining({ username: 'ben', confirmed: false })] }),
    ])
    expect(entered.used).toBe(1)
    expect((await club().notifications.view(ids.ben)).items[0]).toMatchObject({ kind: 'tournamentPartner', params: { tournamentId: id, username: 'amy' } })
    expect(tour().view(id, ids.ben)).toMatchObject({ myPending: true })
    // Nobody is in two entries
    expect(await code(() => tour().enter(ids.cat, id, { partners: ['ben'] }))).toBe('tournamentAlreadyIn')
    // Only an invited partner answers
    expect(await code(() => tour().answer(ids.cat, id, true))).toBe('tournamentNoInvite')
    expect((await tour().answer(ids.ben, id, true)).entries[0].complete).toBe(true)
    // Alone: half a pair
    expect((await tour().enter(ids.cat, id, {})).used).toBe(1.5)
    // Saying no takes the entry off and tells the one who entered
    await tour().enter(ids.dan, id, { partners: ['eve'] })
    await tour().answer(ids.eve, id, false)
    expect(tour().view(id, ids.dan).entries).toHaveLength(2)
    expect((await club().notifications.view(ids.dan)).items[0]).toMatchObject({ kind: 'tournamentWithdrawn', params: { username: 'eve' } })
    // Withdrawing tells the partner
    await tour().withdraw(ids.ben, id)
    expect((await club().notifications.view(ids.amy)).items[0]).toMatchObject({ kind: 'tournamentWithdrawn', params: { username: 'ben' } })
    expect(await code(() => tour().withdraw(ids.ben, id))).toBe('tournamentNotEntered')
    // An admin takes an entry off: its player is told who
    const cat = tour().view(id, ids.cat).myEntry!
    expect(await code(() => tour().remove(ids.amy, id, cat))).toBe('tournamentAdminOnly')
    await tour().remove(admin, id, cat)
    expect((await club().notifications.view(ids.cat)).items[0]).toMatchObject({ kind: 'tournamentRemoved', params: { username: 'boss' } })
    expect(tour().view(id, admin).entries).toEqual([])
  })

  it('stops at the capacity and the deadline', async () => {
    const t = await setUp(Array.from({ length: 12 }, (_, i) => `m${i}`))
    const { club, ids, admin, h } = t
    const { id } = await club().tournaments.create(admin, t.settings({ capacity: 5 }))
    for (let i = 0; i < 10; i += 2) await club().tournaments.enter(ids[`m${i}`], id, { partners: [`m${i + 1}`] })
    expect(await code(() => club().tournaments.enter(ids.m10, id, {}))).toBe('tournamentFull')
    // After the deadline: no entries, no withdrawals, but a partner may still confirm
    await club().tournaments.withdraw(ids.m8, id)
    h.time += 2 * 24 * HOUR
    expect(club().tournaments.view(id, ids.m0).entriesOpen).toBe(false)
    expect(await code(() => club().tournaments.enter(ids.m10, id, {}))).toBe('tournamentClosed')
    expect(await code(() => club().tournaments.withdraw(ids.m0, id))).toBe('tournamentClosed')
    expect(await code(() => club().tournaments.answer(ids.m1, id, false))).toBe('tournamentClosed')
    await club().tournaments.answer(ids.m1, id, true)
    expect(club().tournaments.view(id, ids.m0).entries[0].complete).toBe(true)
  })

  it('reminds everyone entered an hour before the start, once, and again for a new start', async () => {
    const t = await setUp(['amy', 'ben', 'cat'])
    const { club, ids, admin, h } = t
    const view = await club().tournaments.create(admin, t.settings())
    await club().tournaments.enter(ids.amy, view.id, { partners: ['ben'] })
    const jobs = () => h.queue.filter((j) => j.kind === 'tournament')
    expect(jobs().map((j) => j.ms)).toEqual([3 * 24 * HOUR - HOUR])
    // Moved a day later: the old job does nothing, the new one reminds
    const later = view.startsAt + 24 * HOUR
    await club().tournaments.update(admin, view.id, { startsAt: later })
    expect(jobs()).toHaveLength(2)
    const [first, second] = jobs()
    h.queue = h.queue.filter((j) => j.kind !== 'tournament')
    first.run()
    await tick()
    expect(await t.kinds(ids.amy)).not.toContain('tournamentReminder')
    second.run()
    await tick()
    for (const userId of [ids.amy, ids.ben]) {
      const items = (await club().notifications.view(userId)).items
      expect(items[0]).toMatchObject({ kind: 'tournamentReminder', params: { tournamentId: view.id, title: '社慶盃' } })
    }
    expect(await t.kinds(ids.cat)).not.toContain('tournamentReminder')
    // Not twice for the same start, even after an eviction
    second.run()
    await tick()
    expect((await t.kinds(ids.amy)).filter((k) => k === 'tournamentReminder')).toHaveLength(1)
    await club().tournaments.load()
    expect(jobs()).toEqual([])
  })

  it('cancels: everyone entered is told, and only admins still see it', async () => {
    const t = await setUp(['amy', 'ben'])
    const { club, ids, admin } = t
    const { id } = await club().tournaments.create(admin, t.settings())
    await club().tournaments.enter(ids.amy, id, { partners: ['ben'] })
    expect(await code(() => club().tournaments.cancel(ids.amy, id))).toBe('tournamentAdminOnly')
    await club().tournaments.cancel(admin, id)
    expect(await t.kinds(ids.ben)).toContain('tournamentCancelled')
    expect(club().tournaments.list(ids.amy)).toEqual([])
    expect(await code(() => club().tournaments.view(id, ids.amy))).toBe('tournamentGone')
    expect(club().tournaments.list(admin)).toHaveLength(1)
    expect(await code(() => club().tournaments.enter(ids.amy, id, {}))).toBe('tournamentNotOpen')
  })

  it('makes the pairs event from the entries, played without the pairs flag, and announces the results (AC-9.7)', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `p${i + 1}`)
    const t = await setUp(names)
    const { club, ids, admin, playUntil } = t
    const { id } = await club().tournaments.create(admin, t.settings())
    // Four pairs, two alone (paired at the start), one partner who never confirms
    for (let i = 1; i <= 8; i += 2) {
      await club().tournaments.enter(ids[`p${i}`], id, { partners: [`p${i + 1}`] })
      if (i < 7) await club().tournaments.answer(ids[`p${i + 1}`], id, true)
    }
    const extra = await t.member('p11')
    await club().tournaments.enter(ids.p9, id, {})
    await club().tournaments.enter(extra, id, {})
    expect(await code(() => club().tournaments.start(admin, id))).toBe('tournamentTooFew')
    await club().tournaments.answer(ids.p8, id, true)
    expect(await code(() => club().tournaments.start(ids.p1, id))).toBe('tournamentAdminOnly')

    const started = await club().tournaments.start(admin, id)
    expect(started).toMatchObject({ status: 'started', eventLink: `/pairs/${started.eventId}` })
    const eventId = started.eventId!
    // The pairs event: the admin directs it, the pairs entered in order, the two alone together
    const pairs = club().pairs.view(eventId, ids.p1)
    expect(pairs).toMatchObject({ title: '社慶盃', status: 'open', settings: { boardsPerRound: 1, boardMinutes: 8 } })
    expect(pairs.director.id).toBe(admin)
    expect(pairs.pairs.map((p) => p.players.map((u) => u.username).join('+'))).toEqual(['p1+p2', 'p3+p4', 'p5+p6', 'p7+p8', 'p9+p11'])
    // Nobody but its players and director sees it without the pairs flag
    const outsider = await t.member('outsider')
    expect(await code(() => club().pairs.view(eventId, outsider))).toBe('pairsOff')
    expect(await code(() => club().tournaments.enter(outsider, id, {}))).toBe('tournamentNotOpen')

    // The director starts it on its page; everyone plays it through
    await club().pairs.start(admin, eventId)
    club().broadcast()
    await tick()
    const players = [...names.filter((n) => n !== 'p10').map((n) => ids[n]), extra]
    await playUntil(players, () => club().pairs.view(eventId, admin).status === 'finished')
    for (let i = 0; i < 20; i++) await tick()
    const done = club().tournaments.view(id, ids.p1)
    expect(done).toMatchObject({ status: 'finished', eventLink: `/pairs/${eventId}` })
    for (const userId of players)
      expect((await club().notifications.view(userId)).items.find((n) => n.kind === 'tournamentResults')).toMatchObject({
        params: { tournamentId: id, eventKind: 'pairs', eventId },
      })
    // A member who never entered hears nothing
    expect(await t.kinds(ids.p10)).not.toContain('tournamentResults')
  })

  it('is open again when its pairs event is called off before the start', async () => {
    const names = Array.from({ length: 10 }, (_, i) => `p${i + 1}`)
    const t = await setUp(names)
    const { club, ids, admin } = t
    const { id } = await club().tournaments.create(admin, t.settings())
    for (let i = 1; i <= 10; i += 2) {
      await club().tournaments.enter(ids[`p${i}`], id, { partners: [`p${i + 1}`] })
      await club().tournaments.answer(ids[`p${i + 1}`], id, true)
    }
    const { eventId } = await club().tournaments.start(admin, id)
    await club().pairs.cancel(admin, eventId!)
    club().tournaments.view(id, admin)
    await tick()
    const reopened = club().tournaments.view(id, admin)
    expect(reopened.status).toBe('open')
    expect(reopened.eventId).toBeUndefined()
  })

  it('makes the team match from two complete teams: the first player hosts, the others are invited to their seats', async () => {
    const names = ['a1', 'a2', 'a3', 'a4', 'b1', 'b2', 'b3', 'b4']
    const t = await setUp(names)
    const { club, ids, admin } = t
    const { id } = await club().tournaments.create(admin, t.settings({ kind: 'match', match: { boards: 8, scoring: 'imp', boardMinutes: 10 } }))
    expect(await code(() => club().tournaments.enter(ids.a1, id, { partners: ['a2'] }))).toBe('tournamentEntrySize')
    await club().tournaments.enter(ids.a1, id, { partners: ['a2', 'a3', 'a4'], teamName: '甲隊' })
    await club().tournaments.enter(ids.b1, id, { partners: ['b2', 'b3', 'b4'], teamName: '乙隊' })
    for (const n of ['a2', 'a3', 'a4', 'b2', 'b3']) await club().tournaments.answer(ids[n], id, true)
    expect(await code(() => club().tournaments.start(admin, id))).toBe('tournamentTooFew')
    await club().tournaments.answer(ids.b4, id, true)
    const started = await club().tournaments.start(admin, id)
    expect(started.eventLink).toBe(`/matches/${started.eventId}`)
    const match = club().matches.store.get(started.eventId!)!
    expect(match).toMatchObject({ hostId: ids.a1, status: 'setup', settings: { teamNames: ['甲隊', '乙隊'], boards: 8, invite: 'direct' } })
    const seat = (room: string, s: string) => match.seats.find((x) => x.room === room && x.seat === s)
    expect(seat('open', 'S')).toMatchObject({ userId: ids.a1, status: 'seated' })
    expect(seat('open', 'N')).toMatchObject({ userId: ids.a2, status: 'invited' })
    expect(seat('closed', 'E')).toMatchObject({ userId: ids.a3 })
    expect(seat('open', 'E')).toMatchObject({ userId: ids.b1, status: 'invited' })
    expect(seat('closed', 'S')).toMatchObject({ userId: ids.b4 })
    expect(await t.kinds(ids.b1)).toContain('matchInvited')
  })
})

describe('tournament results (e9-t16)', () => {
  it('announces the results once the event finishes, linking to them', async () => {
    let state: EventState = 'on'
    let time = 1_000
    const sent: { to: string; kind: NotificationKind; params: Record<string, string> }[] = []
    const service = new TournamentService({
      store: memoryStore(),
      now: () => time,
      newId: (() => {
        let n = 0
        return () => `id${++n}`
      })(),
      log: () => {},
      scheduler: manualScheduler(() => {}),
      isAdmin: (id) => id === 'boss',
      featureOn: () => true,
      members: () => ['boss', 'amy', 'ben', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jo'],
      userById: (id) => ({ id, username: id }),
      userByName: (name) => name,
      blocked: () => false,
      takeAction: () => true,
      notify: async (to, kind, params) => void sent.push({ to, kind, params }),
      createPairs: async () => 'ev1',
      createMatch: async () => 'm1',
      eventState: () => state,
    })
    const { id } = await service.create('boss', { kind: 'pairs', title: '社慶盃', startsAt: time + 5 * HOUR, deadline: time + 4 * HOUR })
    const people = ['amy', 'ben', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jo']
    for (let i = 0; i < people.length; i += 2) {
      await service.enter(people[i], id, { partners: [people[i + 1]] })
      await service.answer(people[i + 1], id, true)
    }
    await service.start('boss', id)
    sent.length = 0
    await service.eventEnded('pairs', 'other')
    expect(sent).toEqual([])
    state = 'finished'
    time += 6 * HOUR
    await service.eventEnded('pairs', 'ev1')
    await service.eventEnded('pairs', 'ev1')
    expect(sent.map((s) => s.to).sort()).toEqual([...people].sort())
    expect(sent.every((s) => s.kind === 'tournamentResults' && s.params.eventId === 'ev1' && s.params.eventKind === 'pairs')).toBe(true)
    expect(service.view(id, 'amy')).toMatchObject({ status: 'finished', finishedAt: time, eventLink: '/pairs/ev1' })
  })
})
