// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { ServerMessage } from '../../shared/protocol.ts'
import { defaultTeamMatchSettings, type MatchSeat, type TeamMatchSettings, type TeamMatchView } from '../../shared/team-match.ts'
import { ClubError, ClubService, type Connections } from '../../worker/service.ts'
import {
  answerSeat,
  changeSettings,
  clearSeat,
  inviteToSeat,
  leaveSeat,
  moveSeat,
  newTeamMatch,
  parseMatchSeat,
  robotSeat,
  type SeatChange,
} from '../../worker/team-match-flow.ts'
import type { TeamMatch } from '../../worker/team-matches.ts'
import { memoryStore } from './sqlite.ts'
import { clubService } from './event-mode.ts'

/** Team match seats before the start: invitations, answers, moving, leaving, robots and captains (e8-t04, e8-t05) */

const T0 = 1_000_000
const at = (room: 'open' | 'closed', seat: 'N' | 'E' | 'S' | 'W'): MatchSeat => ({ room, seat })

const match = (settings: Partial<TeamMatchSettings> = {}): TeamMatch =>
  newTeamMatch({ id: 'm1', hostId: 'amy', now: T0, settings: { ...defaultTeamMatchSettings(), ...settings }, seat: at('open', 'S') })

/** Applies a step the way the service writes it */
function apply(m: TeamMatch, step: ReturnType<typeof inviteToSeat>): TeamMatch {
  if ('error' in step) throw new Error(step.error)
  const change = step as SeatChange
  const seats = m.seats.map((s) => change.seats.find((c) => c.room === s.room && c.seat === s.seat) ?? s)
  const captains =
    change.captainB === undefined
      ? m.captains
      : change.captainB === null
        ? { A: m.captains.A }
        : { A: m.captains.A, B: change.captainB }
  return { ...m, seats, captains }
}

const seat = (m: TeamMatch, s: MatchSeat) => m.seats.find((x) => x.room === s.room && x.seat === s.seat)!

describe('team match seat steps', () => {
  it('reads a seat from a message', () => {
    expect(parseMatchSeat({ room: 'closed', seat: 'E' })).toEqual(at('closed', 'E'))
    expect(parseMatchSeat({ room: 'lobby', seat: 'E' })).toBeNull()
    expect(parseMatchSeat('S')).toBeNull()
  })

  it('lets the host invite anyone to any empty seat when inviting directly, and the invited answer', () => {
    let m = match()
    expect(inviteToSeat(m, 'ben', at('open', 'N'), 'cat', T0)).toEqual({ error: 'matchNotCaptain' })
    expect(inviteToSeat(m, 'amy', at('open', 'S'), 'cat', T0)).toEqual({ error: 'matchSeatTaken' })
    expect(inviteToSeat(m, 'amy', at('open', 'N'), 'amy', T0)).toEqual({ error: 'notSelf' })
    m = apply(m, inviteToSeat(m, 'amy', at('closed', 'N'), 'ben', T0 + 1))
    expect(seat(m, at('closed', 'N'))).toEqual({ ...at('closed', 'N'), status: 'invited', userId: 'ben', robot: false, invitedAt: T0 + 1 })
    // One seat per member
    expect(inviteToSeat(m, 'amy', at('open', 'N'), 'ben', T0)).toEqual({ error: 'matchAlreadyIn' })
    expect(answerSeat(m, 'cat', true, T0)).toEqual({ error: 'matchNoInvite' })
    const accepted = apply(m, answerSeat(m, 'ben', true, T0 + 2))
    expect(seat(accepted, at('closed', 'N'))).toMatchObject({ status: 'seated', userId: 'ben', answeredAt: T0 + 2 })
    // Inviting directly makes nobody captain of team B
    expect(accepted.captains).toEqual({ A: 'amy' })
    expect(answerSeat(accepted, 'ben', true, T0)).toEqual({ error: 'matchNoInvite' })
    const declined = apply(m, answerSeat(m, 'ben', false, T0 + 2))
    expect(seat(declined, at('closed', 'N'))).toEqual({ ...at('closed', 'N'), status: 'empty', robot: false })
    // Nothing changes once the match started
    expect(inviteToSeat({ ...m, status: 'playing' }, 'amy', at('open', 'N'), 'cat', T0)).toEqual({ error: 'matchStarted' })
    expect(answerSeat({ ...m, status: 'cancelled' }, 'ben', true, T0)).toEqual({ error: 'matchStarted' })
  })

  it('moves a member within their team, and lets the captain swap seats of the team', () => {
    let m = match()
    m = apply(m, inviteToSeat(m, 'amy', at('closed', 'E'), 'ben', T0))
    m = apply(m, answerSeat(m, 'ben', true, T0))
    // Ben is team A (closed room East-West): he moves himself to an empty seat of team A
    expect(moveSeat(m, 'ben', at('closed', 'E'), at('closed', 'N'))).toEqual({ error: 'matchOtherTeam' })
    expect(moveSeat(m, 'ben', at('closed', 'E'), at('open', 'S'))).toEqual({ error: 'matchSeatTaken' })
    const moved = apply(m, moveSeat(m, 'ben', at('closed', 'E'), at('open', 'N')))
    expect(seat(moved, at('open', 'N'))).toMatchObject({ status: 'seated', userId: 'ben' })
    expect(seat(moved, at('closed', 'E'))).toEqual({ ...at('closed', 'E'), status: 'empty', robot: false })
    // The host captains team A and swaps two of its seats, his own too
    const swapped = apply(m, moveSeat(m, 'amy', at('open', 'S'), at('closed', 'E')))
    expect(seat(swapped, at('closed', 'E'))).toMatchObject({ userId: 'amy' })
    expect(seat(swapped, at('open', 'S'))).toMatchObject({ userId: 'ben' })
    // Others cannot move someone else; an empty seat has nobody to move
    expect(moveSeat(m, 'ben', at('open', 'S'), at('open', 'N'))).toEqual({ error: 'matchNotCaptain' })
    expect(moveSeat(m, 'amy', at('open', 'N'), at('closed', 'W'))).toEqual({ error: 'matchSeatEmpty' })
  })

  it('lets anyone but the host leave, and the captain or host clear a seat, never the host’s', () => {
    let m = match()
    m = apply(m, inviteToSeat(m, 'amy', at('open', 'N'), 'ben', T0))
    expect(leaveSeat(m, 'amy')).toEqual({ error: 'matchHostStays' })
    expect(leaveSeat(m, 'cat')).toEqual({ error: 'matchNoInvite' })
    expect(apply(m, leaveSeat(m, 'ben')).seats.every((s) => s.userId !== 'ben')).toBe(true)
    expect(clearSeat(m, 'ben', at('open', 'S'))).toEqual({ error: 'matchNotCaptain' })
    expect(clearSeat(m, 'amy', at('open', 'S'))).toEqual({ error: 'matchHostStays' })
    expect(clearSeat(m, 'amy', at('open', 'E'))).toEqual({ error: 'matchSeatEmpty' })
    expect(seat(apply(m, clearSeat(m, 'amy', at('open', 'N'))), at('open', 'N')).status).toBe('empty')
  })

  it('adds robots only where the captain arranges and only when the settings allow them', () => {
    const m = match()
    const robot = apply(m, robotSeat(m, 'amy', at('closed', 'W'), T0))
    expect(seat(robot, at('closed', 'W'))).toEqual({ ...at('closed', 'W'), status: 'seated', robot: true, answeredAt: T0 })
    expect(robotSeat(robot, 'amy', at('closed', 'W'), T0)).toEqual({ error: 'matchSeatTaken' })
    expect(robotSeat(m, 'ben', at('closed', 'W'), T0)).toEqual({ error: 'matchNotCaptain' })
    expect(robotSeat(match({ robots: false }), 'amy', at('closed', 'W'), T0)).toEqual({ error: 'matchNoRobots' })
    // The host clears a robot like anyone else
    expect(seat(apply(robot, clearSeat(robot, 'amy', at('closed', 'W'))), at('closed', 'W')).robot).toBe(false)
  })

  it('with captains: the host invites only team B’s captain, who then arranges team B', () => {
    let m = match({ invite: 'captains' })
    // Team A is the host's as always
    m = apply(m, inviteToSeat(m, 'amy', at('open', 'N'), 'ann', T0))
    // Team B's captain first; one invitation to team B at a time until they accept
    m = apply(m, inviteToSeat(m, 'amy', at('open', 'E'), 'bob', T0))
    expect(inviteToSeat(m, 'amy', at('closed', 'N'), 'bea', T0)).toEqual({ error: 'matchCaptainPending' })
    m = apply(m, answerSeat(m, 'bob', true, T0))
    expect(m.captains).toEqual({ A: 'amy', B: 'bob' })
    // Now team B is Bob's to arrange, not the host's
    expect(inviteToSeat(m, 'amy', at('closed', 'N'), 'bea', T0)).toEqual({ error: 'matchNotCaptain' })
    expect(robotSeat(m, 'amy', at('closed', 'N'), T0)).toEqual({ error: 'matchNotCaptain' })
    expect(inviteToSeat(m, 'bob', at('closed', 'E'), 'bea', T0)).toEqual({ error: 'matchNotCaptain' })
    m = apply(m, inviteToSeat(m, 'bob', at('closed', 'N'), 'bea', T0))
    m = apply(m, answerSeat(m, 'bea', true, T0))
    // A member who accepts once team B has a captain is not captain
    expect(m.captains.B).toBe('bob')
    m = apply(m, moveSeat(m, 'bob', at('open', 'E'), at('closed', 'S')))
    expect(seat(m, at('closed', 'S')).userId).toBe('bob')
    // The host may still take someone off; when it is the captain, the next member of team B captains it
    const without = apply(m, clearSeat(m, 'amy', at('closed', 'S')))
    expect(without.captains).toEqual({ A: 'amy', B: 'bea' })
    // Leaving with nobody else seated in team B leaves it without a captain: the host invites another
    const alone = apply(without, leaveSeat(without, 'bea'))
    expect(alone.captains).toEqual({ A: 'amy' })
  })

  it('makes the first member seated in team B captain when the host turns to captains', () => {
    let m = match()
    m = apply(m, inviteToSeat(m, 'amy', at('open', 'E'), 'bob', T0))
    m = apply(m, answerSeat(m, 'bob', true, T0))
    const step = changeSettings(m, 'amy', { invite: 'captains' })
    expect(step).toMatchObject({ captainB: 'bob' })
    expect(changeSettings(m, 'amy', { boards: 12 })).not.toHaveProperty('captainB')
  })
})

// ── Through the club ─────────────────────────────────────────────────────────────────────────

class FakeConnections implements Connections {
  online = new Set<string>()
  sent: { userId: string; message: ServerMessage }[] = []
  onlineUserIds() {
    return [...this.online]
  }
  send(userId: string, message: ServerMessage) {
    this.sent.push({ userId, message })
  }
  disconnect() {}
  /** The last team match pushed to a member */
  lastMatch(userId: string): TeamMatchView | null | undefined {
    const found = this.sent.filter((s) => s.userId === userId && s.message.type === 'match').at(-1)?.message
    return found?.type === 'match' ? found.match : undefined
  }
}

let club: ClubService
let connections: FakeConnections

beforeEach(async () => {
  connections = new FakeConnections()
  club = clubService(memoryStore(), connections, { maxUsers: 40, now: () => T0, schedule: () => {} })
  await club.load()
  await club.register('boss', 'secret1', '')
})

async function member(name: string) {
  const result = await club.register(name, 'secret1', '')
  const user =
    'user' in result ? result.user : await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)
  return user.id
}

async function refused(fn: () => Promise<unknown>) {
  try {
    await fn()
  } catch (error) {
    if (error instanceof ClubError) return error.code
    throw error
  }
  throw new Error('it was not turned down')
}

const kinds = async (userId: string) => (await club.notifications.view(userId)).items.map((n) => n.kind)

describe('team match seats through the club', () => {
  it('invites, answers, notifies and pushes the match to everyone in it who is online', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    connections.online = new Set([amy, ben])
    const { id } = club.matches.create(amy, {})
    const invited = await club.matches.request(amy, { type: 'matchInvite', matchId: id, room: 'closed', seat: 'N', userId: ben })
    expect(invited?.seats.find((s) => s.userId === ben)).toMatchObject({ status: 'invited', team: 'B', online: true })
    expect(await kinds(ben)).toEqual(['matchInvited'])
    expect((await club.notifications.view(ben)).items[0].params).toEqual({ matchId: id, username: 'amy' })
    expect(connections.lastMatch(ben)?.seats.find((s) => s.userId === ben)?.status).toBe('invited')

    const answered = await club.matches.request(ben, { type: 'matchAnswer', matchId: id, accept: true })
    expect(answered?.seats.find((s) => s.userId === ben)?.status).toBe('seated')
    expect(await kinds(amy)).toEqual(['matchAccepted'])
    expect(connections.lastMatch(amy)?.seats.find((s) => s.userId === ben)?.status).toBe('seated')
    // The host sees why it cannot start yet
    expect(answered?.ready).toEqual({ ready: false, reason: 'seats' })

    // Leaving: the page hears back null, the host is told and sees the seat empty
    expect(await club.matches.request(ben, { type: 'matchLeave', matchId: id })).toBeNull()
    expect(connections.lastMatch(ben)).toBeNull()
    expect(await kinds(amy)).toEqual(['matchLeft', 'matchAccepted'])
    expect(await refused(() => club.matches.request(ben, { type: 'matchLeave', matchId: id }))).toBe('matchGone')
  })

  it('works out readiness from seats and who is online, and pushes it when someone comes or goes', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    connections.online = new Set([amy])
    const { id } = club.matches.create(amy, {})
    await club.matches.request(amy, { type: 'matchInvite', matchId: id, room: 'open', seat: 'N', userId: ben })
    for (const s of ['E', 'W'] as const) await club.matches.act(amy, { type: 'matchRobot', matchId: id, room: 'open', seat: s })
    for (const s of ['N', 'E', 'S', 'W'] as const) await club.matches.act(amy, { type: 'matchRobot', matchId: id, room: 'closed', seat: s })
    expect(club.matches.get(id, amy)?.ready).toEqual({ ready: false, reason: 'seats' })
    connections.online.add(ben)
    await club.matches.act(ben, { type: 'matchAnswer', matchId: id, accept: true })
    expect(club.matches.get(id, amy)?.ready).toEqual({ ready: true })
    connections.online.delete(ben)
    connections.sent = []
    await club.disconnected(ben)
    expect(connections.lastMatch(amy)?.ready).toEqual({ ready: false, reason: 'offline' })
    expect(connections.lastMatch(amy)?.seats.find((s) => s.userId === ben)?.online).toBe(false)
    // Robots turned off: they leave their seats
    const off = club.matches.update(amy, id, { robots: false })
    expect(off.seats.filter((s) => s.robot)).toEqual([])
    expect(await refused(() => club.matches.act(amy, { type: 'matchRobot', matchId: id, room: 'open', seat: 'E' }))).toBe('matchNoRobots')
  })

  it('never invites across a block, either way, and says only that the member cannot be invited', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const cat = await member('cat')
    const { id } = club.matches.create(amy, {})
    await club.handle(ben, { type: 'setBlocked', userId: amy, blocked: true })
    const invite = (userId: string, seat: 'N' | 'E') => club.matches.request(amy, { type: 'matchInvite', matchId: id, room: 'open', seat, userId })
    expect(await refused(() => invite(ben, 'N'))).toBe('cannotInvite')
    await club.handle(amy, { type: 'setBlocked', userId: cat, blocked: true })
    expect(await refused(() => invite(cat, 'N'))).toBe('cannotInvite')
    expect(await kinds(ben)).toEqual([])
    expect(await refused(() => invite('nobody', 'N'))).toBe('userGone')
    expect(await refused(() => invite('robot:gib:N', 'N'))).toBe('userGone')
  })

  it('checks a team B captain’s invitations against the host’s blocks too', async () => {
    const amy = await member('amy')
    const bob = await member('bob')
    const eve = await member('eve')
    const { id } = club.matches.create(amy, { settings: { invite: 'captains' } })
    await club.matches.act(amy, { type: 'matchInvite', matchId: id, room: 'open', seat: 'E', userId: bob })
    await club.matches.act(bob, { type: 'matchAnswer', matchId: id, accept: true })
    expect(club.matches.get(id, bob)?.captains).toEqual({ A: amy, B: bob })
    await club.handle(eve, { type: 'setBlocked', userId: amy, blocked: true })
    expect(await refused(() => club.matches.act(bob, { type: 'matchInvite', matchId: id, room: 'closed', seat: 'N', userId: eve }))).toBe(
      'cannotInvite',
    )
  })

  it('tells a member taken off a seat, and everyone when the host cancels', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const cat = await member('cat')
    const { id } = club.matches.create(amy, {})
    await club.matches.act(amy, { type: 'matchInvite', matchId: id, room: 'open', seat: 'N', userId: ben })
    await club.matches.act(amy, { type: 'matchInvite', matchId: id, room: 'open', seat: 'E', userId: cat })
    await club.matches.act(amy, { type: 'matchClear', matchId: id, room: 'open', seat: 'N' })
    expect(await kinds(ben)).toEqual(['matchRemoved', 'matchInvited'])
    expect(club.matches.get(id, ben)).toBeNull()
    await club.matches.cancel(amy, id)
    expect(await kinds(cat)).toEqual(['matchCancelled', 'matchInvited'])
    expect(await refused(() => club.matches.act(cat, { type: 'matchAnswer', matchId: id, accept: true }))).toBe('matchStarted')
  })

  it('takes seat actions over the socket, with the shape checked first', async () => {
    const amy = await member('amy')
    const ben = await member('ben')
    const { id } = club.matches.create(amy, {})
    await club.handleRaw(amy, JSON.stringify({ type: 'matchInvite', matchId: id, room: 'open', seat: 'N', userId: ben }))
    expect(club.matches.get(id, ben)?.seats.find((s) => s.userId === ben)?.status).toBe('invited')
    connections.sent = []
    await club.handleRaw(amy, JSON.stringify({ type: 'matchMove', matchId: id, from: 'open S', to: 'open N' }))
    expect(connections.sent.at(-1)?.message).toMatchObject({ type: 'error', code: 'badMessage' })
    await club.handleRaw(ben, JSON.stringify({ type: 'matchClear', matchId: id, room: 'open', seat: 'S' }))
    expect(connections.sent.at(-1)?.message).toMatchObject({ type: 'error', code: 'matchNotCaptain' })
  })
})
