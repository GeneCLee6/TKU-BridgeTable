import type { MessageCode } from '../shared/messages.ts'
import type { ClientMessage } from '../shared/protocol.ts'
import type { DealSet } from '../shared/deal-set.ts'
import type { MatchSeat, Room } from '../shared/team-match.ts'
import { ClubError } from './errors.ts'
import type { MatchApi, MatchSnapshot, Matches } from './match-events.ts'
import {
  abandonMatch,
  answerSeat,
  cancelMatch,
  changeSettings,
  clearSeat,
  finishedWithRuling,
  inviteToSeat,
  leaveSeat,
  moveSeat,
  nextSegment,
  parseMatchSeat,
  pauseMatch,
  replaceSeat,
  robotSeat,
  roomFinished,
  ruleBoard,
  type FlowError,
  type RoomClock,
  type SeatChange,
} from './team-match-flow.ts'
import type { RoomResult, TeamMatch, TeamMatchStore } from './team-matches.ts'

/**
 * One team match's own writes (H2c, ARCHITECTURE.md §5.12): the half of `TeamMatchService` that
 * changes the match, the `ChallengeEvent` of team matches. Each step runs the pure rules of
 * `team-match-flow.ts` on the match as it is here and writes the outcome in one transaction; the
 * last board (a room's result or the host's ruling) finishes the match in the same transaction.
 * The club checked the same rules on its copy first, with what only it knows (who is online,
 * blocks, members, the other matches); here they are checked again on the match itself. It sends
 * no notification and tells no table: the club does that from what it is answered. It never
 * touches a Cloudflare API: in the club's own object it works on the club's tables
 * (`LocalMatches`), in an `EventObject` on that object's (`EventHost`).
 */

/** The seat actions (`e8-t04`, `e8-t05`) */
export type MatchAction = Extract<
  ClientMessage,
  { type: 'matchInvite' | 'matchAnswer' | 'matchMove' | 'matchLeave' | 'matchClear' | 'matchRobot' }
>

/** The host's ruling as the socket sends it (`e8-t15`) */
export type RuleMessage = Extract<ClientMessage, { type: 'matchRule' }>

/** A change the club asks of a match; structured-clonable, so it crosses Durable Object RPC as it is */
export type MatchStep =
  | { kind: 'settings'; userId: string; settings: unknown }
  | { kind: 'cancel'; userId: string }
  | { kind: 'seat'; userId: string; message: MatchAction }
  | { kind: 'started'; deals: DealSet; tables: Record<Room, string> }
  | { kind: 'result'; seq: number; room: Room; result: RoomResult }
  | { kind: 'rule'; userId: string; message: RuleMessage; rooms: Partial<Record<Room, RoomClock>> }
  | { kind: 'pause'; userId: string; paused: boolean }
  | { kind: 'abandon'; userId: string }
  | { kind: 'replace'; userId: string; at: MatchSeat; newcomer: string }
  | { kind: 'segment'; userId: string }
  | { kind: 'forget'; userId: string }

const STATUS: Partial<Record<MessageCode, number>> = {
  matchHostOnly: 403,
  matchNotCaptain: 403,
  cannotInvite: 403,
  matchGone: 404,
  userGone: 404,
  matchNoWatching: 403,
}

/** The error for a step `team-match-flow.ts` refused, with the status the pages know */
export function flowError(step: FlowError): ClubError {
  return new ClubError(step.error, step.params ?? {}, STATUS[step.error] ?? 400)
}

/** Reads a seat a message names, or `badSeat` */
export function seatOf(value: unknown): MatchSeat {
  const seat = parseMatchSeat(value)
  if (!seat) throw new ClubError('badSeat')
  return seat
}

/**
 * A seat action's rule (`team-match-flow.ts`) for the match as it is: the seats it writes, or why
 * not. A message of the wrong shape throws (`badSeat`, `userGone`, `unknownCommand`)
 */
export function seatChange(match: TeamMatch, userId: string, message: MatchAction, now: number): FlowError | SeatChange {
  switch (message.type) {
    case 'matchInvite': {
      const at = seatOf({ room: message.room, seat: message.seat })
      if (typeof message.userId !== 'string') throw new ClubError('userGone', {}, 404)
      return inviteToSeat(match, userId, at, message.userId, now)
    }
    case 'matchAnswer':
      if (typeof message.accept !== 'boolean') throw new ClubError('unknownCommand')
      return answerSeat(match, userId, message.accept, now)
    case 'matchMove':
      return moveSeat(match, userId, seatOf(message.from), seatOf(message.to))
    case 'matchLeave':
      return leaveSeat(match, userId)
    case 'matchClear':
      return clearSeat(match, userId, seatOf({ room: message.room, seat: message.seat }))
    case 'matchRobot':
      return robotSeat(match, userId, seatOf({ room: message.room, seat: message.seat }), now)
    default:
      throw new ClubError('unknownCommand')
  }
}

export interface MatchEventDeps {
  store: TeamMatchStore
  now: () => number
}

export class MatchEvent {
  readonly id: string
  private readonly deps: MatchEventDeps

  constructor(id: string, deps: MatchEventDeps) {
    this.id = id
    this.deps = deps
  }

  get(): TeamMatch | null {
    return this.deps.store.get(this.id)
  }

  private require(): TeamMatch {
    const match = this.get()
    if (!match) throw new ClubError('matchGone', {}, 404)
    return match
  }

  /** Takes a match: a new one, or one kept until now in the club (the move out). One already here keeps what it has */
  adopt(match: TeamMatch): TeamMatch {
    if (!this.get()) this.deps.store.replace(match)
    return this.require()
  }

  /** Runs one step on the match as it is here; a refusal throws `ClubError` and writes nothing */
  apply(step: MatchStep): TeamMatch {
    const match = this.require()
    const { store, now } = this.deps
    const id = this.id
    const refuse = <T extends object>(result: FlowError | T): T => {
      if ('error' in result) throw flowError(result)
      return result
    }
    const seats = (change: SeatChange) =>
      store.transaction(() => {
        for (const seat of change.seats) store.updateSeat(id, seat)
        if (change.captainB !== undefined) store.setCaptainB(id, change.captainB)
      })
    switch (step.kind) {
      case 'settings': {
        const change = refuse(changeSettings(match, step.userId, step.settings))
        store.transaction(() => {
          store.setSettings(id, change.settings)
          for (const seat of change.freed) store.updateSeat(id, { ...seat, status: 'empty', robot: false })
          if (change.captainB !== undefined) store.setCaptainB(id, change.captainB)
        })
        break
      }
      case 'cancel':
        refuse(cancelMatch(match, step.userId))
        store.setStatus(id, 'cancelled', now())
        break
      case 'seat':
        seats(refuse(seatChange(match, step.userId, step.message, now())))
        break
      case 'started':
        // Once: the same start again (an answer lost on the way) changes nothing
        if (match.status === 'setup') store.setStarted(id, step.deals, step.tables, now())
        break
      case 'result': {
        // A room's result once: the same report again, or one for a match no longer played, changes nothing
        const outcome = roomFinished(match, step.seq, step.room, step.result)
        if (!outcome) break
        store.transaction(() => {
          store.addResult(id, step.seq, step.room, step.result)
          // The segment's last board done in both rooms: the match waits for the next (`e8-t21`)
          if (outcome.segmentDone) store.setBreak(id, now())
          if (outcome.finished) store.setStatus(id, 'finished', now())
        })
        break
      }
      case 'rule': {
        const ruled = refuse(ruleBoard(match, step.userId, step.message, step.rooms, now()))
        const { finished, segmentDone } = finishedWithRuling(match, ruled.seq)
        store.transaction(() => {
          store.setRuling(id, ruled.seq, { ...ruled.ruling, reason: ruled.reason, by: step.userId, at: now() })
          if (segmentDone && match.breakAt === undefined) store.setBreak(id, now())
          if (finished) store.setStatus(id, 'finished', now())
        })
        break
      }
      case 'pause': {
        const change = refuse(pauseMatch(match, step.userId, step.paused))
        if (change.changed) store.setPaused(id, step.paused ? now() : null)
        break
      }
      case 'abandon':
        refuse(abandonMatch(match, step.userId))
        store.transaction(() => {
          store.setPaused(id, null)
          store.setStatus(id, 'abandoned', now())
        })
        break
      case 'replace': {
        const change = refuse(replaceSeat(match, step.userId, step.at, step.newcomer, now()))
        const target = match.seats.find((s) => s.room === step.at.room && s.seat === step.at.seat)
        const before = target && !target.robot ? target.userId : undefined
        store.transaction(() => {
          for (const seat of change.seats) store.updateSeat(id, seat)
          if (before !== undefined && match.captains.B === before) store.setCaptainB(id, step.newcomer)
        })
        break
      }
      case 'segment':
        store.setSegment(id, refuse(nextSegment(match, step.userId)).segment)
        break
      case 'forget':
        store.forgetIn(id, step.userId, now())
        break
    }
    return this.require()
  }
}

/** The match as the club is told it in this same object: there is no change number to compare */
const local = (match: TeamMatch): MatchSnapshot => ({ match, rev: 0 })

/**
 * The matches that live in the club's own object, on its tables: the switch off (`EVENT_OBJECTS`
 * not `on`), the matches not moved out yet, and most tests
 */
export class LocalMatches implements Matches {
  private readonly deps: MatchEventDeps

  constructor(deps: MatchEventDeps) {
    this.deps = deps
  }

  get(id: string): MatchApi {
    const event = new MatchEvent(id, this.deps)
    return {
      adopt: async (match) => local(event.adopt(match)),
      step: async (step) => local(event.apply(step)),
    }
  }
}
