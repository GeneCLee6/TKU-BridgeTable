import { AppError, type MessageCode, type MessageParams } from '../shared/messages.ts'
import { ClubError } from './errors.ts'
import type { Challenge, ChallengeResult } from './challenges.ts'
import type { Sql } from './store.ts'

/**
 * How the club and the challenges talk (H2b, ARCHITECTURE.md §5.12). Each challenge's state, its
 * job (the reminder and the deadline) and its settlement belong to that challenge
 * (`ChallengeEvent`, `worker/event-service.ts`); in production each runs in its own `EventObject`
 * Durable Object (`worker/event-object.ts`, `idFromName('challenge:<id>')`), switched on with
 * `EVENT_OBJECTS=on`. The club keeps a copy of every challenge in its own SQL tables (the same
 * `challenges`, `challenge_players`, `challenge_results`), written from what the challenge
 * reports: every page, list, visibility rule and table snapshot reads that copy, as before. Both
 * directions are plain async calls with structured-clonable arguments, so they work the same in
 * one process (`LocalEvents`, the switch off and most tests) and as Durable Object RPC.
 */

/** A challenge as it is after a change, with the change's number (`max(last + 1, now)`, so it never goes back) */
export interface EventSnapshot {
  challenge: Challenge
  rev: number
}

/**
 * What the club asks of one challenge. Each answers with the challenge as it is now (the club
 * writes its copy from it); errors are `ClubError` with the codes the pages know
 */
export interface EventApi {
  /**
   * Takes a challenge: a new one (`createChallenge`, the weekly one) or one kept until now in the
   * club (the move out, schema 1 → 2). One that is already there keeps what it has (the call
   * retried, or a move done again after an eviction halfway). Its job is scheduled
   */
  adopt(challenge: Challenge): Promise<EventSnapshot>
  /** An invitee accepts or declines (`answer`); the last answer may end it */
  answer(userId: string, accept: boolean): Promise<EventSnapshot>
  /** The creator calls it off (`cancel`) */
  cancel(userId: string): Promise<EventSnapshot>
  /** A participant's first board is dealt: the creator can no longer cancel once someone else has */
  started(userId: string): Promise<EventSnapshot>
  /** A board's result (once: the same result again changes nothing); the last one may finish it early */
  result(result: ChallengeResult): Promise<EventSnapshot>
  /** An account was deleted: it leaves the challenge if still going (`forgetIn`) */
  forget(userId: string): Promise<EventSnapshot>
}

/** What a challenge tells the club on its own: its job reminded or settled it */
export interface EventLink {
  changed(snapshot: EventSnapshot): Promise<void>
}

/** The club's way to reach a challenge by id */
export interface Events {
  get(challengeId: string): EventApi
}

/**
 * A challenge's answer as it crosses Durable Object RPC: the challenge as it is now (null when the
 * object has none), and the error when the call was refused. RPC keeps an error's message but not
 * its class, so `ClubError` travels as its code (as `Wire` does for the tables). The challenge
 * comes along with an error too, so a club whose copy fell behind (an answer lost on the way)
 * catches up with the refusal
 */
export interface EventWire {
  snapshot: EventSnapshot | null
  error?: { code: MessageCode; params: MessageParams; status: number }
}

/** What one `EventObject` answers over RPC: `EventApi` wrapped, and two calls for the switch back (`EVENT_OBJECTS` off) */
export type EventRpc = {
  [K in keyof EventApi]: (...args: Parameters<EventApi[K]>) => Promise<EventWire>
} & {
  /** The challenge as it is now (null when there is none); from now on the object keeps still until `release` */
  handOver(): Promise<EventWire>
  /** Forgets the challenge for good, once the club took it back */
  release(): Promise<EventWire>
}

/** Runs a call and wraps the `ClubError` it threw, for RPC; any other error is a bug and is thrown */
export async function eventWire(snapshot: () => EventSnapshot | null, run: () => Promise<unknown>): Promise<EventWire> {
  try {
    await run()
    return { snapshot: snapshot() }
  } catch (error) {
    if (error instanceof AppError)
      return { snapshot: snapshot(), error: { code: error.code, params: error.params, status: error.status } }
    throw error
  }
}

export interface RemoteEventsDeps {
  /** The stub of a challenge's object */
  stub: (challengeId: string) => EventRpc
  /** Every snapshot an object answers with, refusals included: the club keeps its copy up to date */
  snapshot: (snapshot: EventSnapshot) => void
  /**
   * The club's copy of a challenge, for an object that answers it has none (its first `adopt`
   * failed, or the club was evicted between writing its copy and the call): it adopts the copy and
   * the call is made again
   */
  copy: (challengeId: string) => Challenge | null
}

/** One challenge in its own Durable Object, as the club sees it: `EventApi` over RPC */
class RemoteEvent implements EventApi {
  private readonly id: string
  private readonly rpc: EventRpc
  private readonly deps: RemoteEventsDeps

  constructor(id: string, rpc: EventRpc, deps: RemoteEventsDeps) {
    this.id = id
    this.rpc = rpc
    this.deps = deps
  }

  private unwrap(wire: EventWire): EventSnapshot | null {
    if (wire.snapshot) this.deps.snapshot(wire.snapshot)
    if (wire.error) throw new ClubError(wire.error.code, wire.error.params, wire.error.status)
    return wire.snapshot
  }

  private async call(run: () => Promise<EventWire>): Promise<EventSnapshot> {
    const found = this.unwrap(await run())
    if (found) return found
    // The object has no challenge: it takes the club's copy, and the call is made once more
    const copy = this.deps.copy(this.id)
    if (!copy) throw new ClubError('challengeGone', {}, 404)
    this.unwrap(await this.rpc.adopt(copy))
    const again = this.unwrap(await run())
    if (!again) throw new ClubError('serverError', {}, 503)
    return again
  }

  async adopt(challenge: Challenge) {
    const found = this.unwrap(await this.rpc.adopt(challenge))
    if (!found) throw new ClubError('serverError', {}, 503)
    return found
  }
  answer(userId: string, accept: boolean) {
    return this.call(() => this.rpc.answer(userId, accept))
  }
  cancel(userId: string) {
    return this.call(() => this.rpc.cancel(userId))
  }
  started(userId: string) {
    return this.call(() => this.rpc.started(userId))
  }
  result(result: ChallengeResult) {
    return this.call(() => this.rpc.result(result))
  }
  forget(userId: string) {
    return this.call(() => this.rpc.forget(userId))
  }
}

/**
 * The challenges in production: each its own `EventObject` (`idFromName('challenge:<id>')`),
 * reached over RPC. The tests give an in-process `EventHost` behind a structured clone instead, so
 * the whole path (wrapping, errors, copies) runs in Node
 */
export class RemoteEvents implements Events {
  private readonly stub: (challengeId: string) => EventRpc
  /** Set by the club: what it does with the snapshots and where its copies are */
  attach: Omit<RemoteEventsDeps, 'stub'> = { snapshot: () => {}, copy: () => null }

  constructor(stub: (challengeId: string) => EventRpc) {
    this.stub = stub
  }

  get(challengeId: string): EventApi {
    return new RemoteEvent(challengeId, this.stub(challengeId), { stub: this.stub, ...this.attach })
  }

  /** Takes a challenge back out of its object, for the switch back into the club; null when it has none */
  async handOver(challengeId: string): Promise<Challenge | null> {
    const wire = await this.stub(challengeId).handOver()
    if (wire.error) throw new ClubError(wire.error.code, wire.error.params, wire.error.status)
    return wire.snapshot?.challenge ?? null
  }

  async release(challengeId: string): Promise<void> {
    const wire = await this.stub(challengeId).release()
    if (wire.error) throw new ClubError(wire.error.code, wire.error.params, wire.error.status)
  }
}

/**
 * The club's own bookkeeping about challenges (never in an `EventObject`):
 * - `event_homes`: the challenges that live in their own object, with the number of the last
 *   snapshot the club wrote into its copy (`rev`, -1 until the object confirmed it adopted it).
 *   A challenge without a row lives in the club (`LocalEvents`).
 * - `challenge_settled`: what the club already did about a challenge's state, so that doing it
 *   follows from the state alone and happens once however often (or late) it is reported: the end
 *   (its tables closed, its boards shown to everyone, the results announced) and the reminder.
 */
export class EventHomes {
  private readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  /**
   * Creates the tables. `challenge_settled` is new with H2b: when it is created, every challenge
   * that already ended (or was already reminded) is marked as done, so nothing is announced again.
   * Run after `ChallengeStore.createTables`
   */
  createTables() {
    this.sql.transaction(() => {
      this.sql.exec(
        'CREATE TABLE IF NOT EXISTS event_homes (event_id TEXT PRIMARY KEY, rev INTEGER NOT NULL) WITHOUT ROWID',
      )
      const exists = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'challenge_settled'").length
      if (exists) return
      this.sql.exec(
        `CREATE TABLE challenge_settled (
          challenge_id TEXT PRIMARY KEY,
          ended INTEGER NOT NULL DEFAULT 0,
          reminded INTEGER NOT NULL DEFAULT 0
        ) WITHOUT ROWID`,
      )
      this.sql.exec(
        `INSERT INTO challenge_settled (challenge_id, ended, reminded)
         SELECT challenge_id, CASE WHEN status IN ('pending', 'active') THEN 0 ELSE 1 END,
                CASE WHEN reminded_at IS NULL THEN 0 ELSE 1 END
         FROM challenges`,
      )
    })
  }

  /** Whether the challenge lives in its own object, and the last snapshot written from it */
  rev(id: string): number | undefined {
    return this.sql.exec<{ rev: number }>('SELECT rev FROM event_homes WHERE event_id = ?', id)[0]?.rev
  }

  setRev(id: string, rev: number) {
    this.sql.exec(
      'INSERT INTO event_homes (event_id, rev) VALUES (?, ?) ON CONFLICT (event_id) DO UPDATE SET rev = excluded.rev',
      id,
      rev,
    )
  }

  drop(id: string) {
    this.sql.exec('DELETE FROM event_homes WHERE event_id = ?', id)
  }

  /** Every challenge in its own object, and those whose object has not confirmed it yet */
  ids(): string[] {
    return this.sql.exec<{ event_id: string }>('SELECT event_id FROM event_homes ORDER BY event_id').map((r) => r.event_id)
  }

  unconfirmed(): string[] {
    return this.sql
      .exec<{ event_id: string }>('SELECT event_id FROM event_homes WHERE rev < 0 ORDER BY event_id')
      .map((r) => r.event_id)
  }

  settled(id: string): { ended: boolean; reminded: boolean } {
    const row = this.sql.exec<{ ended: number; reminded: number }>(
      'SELECT ended, reminded FROM challenge_settled WHERE challenge_id = ?',
      id,
    )[0]
    return { ended: row?.ended === 1, reminded: row?.reminded === 1 }
  }

  /** Notes that the end or the reminder was done, before doing it, so a failure halfway never does it twice */
  settle(id: string, what: 'ended' | 'reminded') {
    this.sql.exec(
      `INSERT INTO challenge_settled (challenge_id, ${what}) VALUES (?, 1)
       ON CONFLICT (challenge_id) DO UPDATE SET ${what} = 1`,
      id,
    )
  }

  /** How many challenges live in objects, and how many of them wait for their object to confirm (`/api/health`) */
  counts(): { objects: number; unconfirmed: number } {
    const row = this.sql.exec<{ n: number; u: number }>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN rev < 0 THEN 1 ELSE 0 END), 0) AS u FROM event_homes',
    )[0]
    return { objects: row.n, unconfirmed: row.u }
  }
}
