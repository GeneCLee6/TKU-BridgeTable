import { ClubError } from './errors.ts'
import type { EventWire } from './events.ts'
import type { MatchStep } from './match-event.ts'
import type { Sql } from './store.ts'
import type { TeamMatch } from './team-matches.ts'

/**
 * How the club and the team matches talk (H2c, ARCHITECTURE.md §5.12), the same way as the
 * challenges (`events.ts`, H2b). Each match's state and its settlement (a room's result, the last
 * board finishing it) belong to that match (`MatchEvent`, `worker/match-event.ts`); with
 * `EVENT_OBJECTS=on` each open match runs in its own `EventObject` (`idFromName('match:<id>')`).
 * The club keeps a copy of every match in its own SQL tables (the same `matches`, `match_seats`,
 * `match_boards`), written from what the match answers or reports: every page, list, view, push
 * and check across matches reads that copy, as before. The Vugraph chat and who watched stay with
 * the club only (they are not the match's state).
 */

/** A match as it is after a change, with the change's number (`max(last + 1, now)`, so it never goes back) */
export interface MatchSnapshot {
  match: TeamMatch
  rev: number
}

/** What the club asks of one match. Each answers with the match as it is now; errors are `ClubError` */
export interface MatchApi {
  /** Takes a match: a new one, or one kept until now in the club (the move out). One already there keeps what it has */
  adopt(match: TeamMatch): Promise<MatchSnapshot>
  /** One change (`MatchStep`), checked again on the match itself */
  step(step: MatchStep): Promise<MatchSnapshot>
}

/** The club's way to reach a match by id */
export interface Matches {
  get(matchId: string): MatchApi
}

/** A match's answer as it crosses Durable Object RPC (as `EventWire` for a challenge) */
export interface MatchWire {
  snapshot: MatchSnapshot | null
  error?: EventWire['error']
}

/** What one `EventObject` answers for a match over RPC; `release` is the challenges' (it forgets whatever it holds) */
export interface MatchRpc {
  adoptMatch(match: TeamMatch): Promise<MatchWire>
  stepMatch(step: MatchStep): Promise<MatchWire>
  /** The match as it is now (null when there is none); from now on the object keeps still until `release` */
  handOverMatch(): Promise<MatchWire>
  release(): Promise<EventWire>
}

export interface RemoteMatchesDeps {
  /** Every snapshot an object answers with, refusals included: the club keeps its copy up to date */
  snapshot: (snapshot: MatchSnapshot) => void
  /** The club's copy of a match, for an object that answers it has none: it adopts the copy and the call is made again */
  copy: (matchId: string) => TeamMatch | null
}

/** One match in its own Durable Object, as the club sees it */
class RemoteMatch implements MatchApi {
  private readonly id: string
  private readonly rpc: MatchRpc
  private readonly deps: RemoteMatchesDeps

  constructor(id: string, rpc: MatchRpc, deps: RemoteMatchesDeps) {
    this.id = id
    this.rpc = rpc
    this.deps = deps
  }

  private unwrap(wire: MatchWire): MatchSnapshot | null {
    if (wire.snapshot) this.deps.snapshot(wire.snapshot)
    if (wire.error) throw new ClubError(wire.error.code, wire.error.params, wire.error.status)
    return wire.snapshot
  }

  async adopt(match: TeamMatch) {
    const found = this.unwrap(await this.rpc.adoptMatch(match))
    if (!found) throw new ClubError('serverError', {}, 503)
    return found
  }

  async step(step: MatchStep) {
    const found = this.unwrap(await this.rpc.stepMatch(step))
    if (found) return found
    // The object has no match: it takes the club's copy, and the step is made once more
    const copy = this.deps.copy(this.id)
    if (!copy) throw new ClubError('matchGone', {}, 404)
    this.unwrap(await this.rpc.adoptMatch(copy))
    const again = this.unwrap(await this.rpc.stepMatch(step))
    if (!again) throw new ClubError('serverError', {}, 503)
    return again
  }
}

/** The matches in production: each its own `EventObject` (`idFromName('match:<id>')`), reached over RPC */
export class RemoteMatches implements Matches {
  private readonly stub: (matchId: string) => MatchRpc
  /** Set by the club: what it does with the snapshots and where its copies are */
  attach: RemoteMatchesDeps = { snapshot: () => {}, copy: () => null }

  constructor(stub: (matchId: string) => MatchRpc) {
    this.stub = stub
  }

  get(matchId: string): MatchApi {
    return new RemoteMatch(matchId, this.stub(matchId), this.attach)
  }

  /** Takes a match back out of its object, for the switch back into the club; null when it has none */
  async handOver(matchId: string): Promise<TeamMatch | null> {
    const wire = await this.stub(matchId).handOverMatch()
    if (wire.error) throw new ClubError(wire.error.code, wire.error.params, wire.error.status)
    return wire.snapshot?.match ?? null
  }

  async release(matchId: string): Promise<void> {
    const wire = await this.stub(matchId).release()
    if (wire.error) throw new ClubError(wire.error.code, wire.error.params, wire.error.status)
  }
}

/**
 * The club's own bookkeeping about matches (never in an `EventObject`), as `EventHomes` for the
 * challenges:
 * - `match_homes`: the matches that live in their own object, with the number of the last
 *   snapshot written into the club's copy (`rev`, -1 until the object confirmed it adopted it).
 *   A match without a row lives in the club (`LocalMatches`).
 * - `match_settled`: whether the club already closed up a match that ended (its tables told, its
 *   boards shown to everyone, a finished match announced), so it happens once however often (or
 *   late) the end is reported.
 */
export class MatchHomes {
  private readonly sql: Sql

  constructor(sql: Sql) {
    this.sql = sql
  }

  /**
   * Creates the tables. When `match_settled` is new (H2c), every match that already ended is
   * marked as closed up, so nothing is announced again. Run after `TeamMatchStore.createTables`
   */
  createTables() {
    this.sql.transaction(() => {
      this.sql.exec('CREATE TABLE IF NOT EXISTS match_homes (match_id TEXT PRIMARY KEY, rev INTEGER NOT NULL) WITHOUT ROWID')
      const exists = this.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'match_settled'").length
      if (exists) return
      this.sql.exec('CREATE TABLE match_settled (match_id TEXT PRIMARY KEY, ended INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID')
      this.sql.exec(
        "INSERT INTO match_settled (match_id, ended) SELECT match_id, 1 FROM matches WHERE status NOT IN ('setup', 'playing')",
      )
    })
  }

  /** Whether the match lives in its own object, and the last snapshot written from it */
  rev(id: string): number | undefined {
    return this.sql.exec<{ rev: number }>('SELECT rev FROM match_homes WHERE match_id = ?', id)[0]?.rev
  }

  setRev(id: string, rev: number) {
    this.sql.exec(
      'INSERT INTO match_homes (match_id, rev) VALUES (?, ?) ON CONFLICT (match_id) DO UPDATE SET rev = excluded.rev',
      id,
      rev,
    )
  }

  drop(id: string) {
    this.sql.exec('DELETE FROM match_homes WHERE match_id = ?', id)
  }

  ids(): string[] {
    return this.sql.exec<{ match_id: string }>('SELECT match_id FROM match_homes ORDER BY match_id').map((r) => r.match_id)
  }

  unconfirmed(): string[] {
    return this.sql
      .exec<{ match_id: string }>('SELECT match_id FROM match_homes WHERE rev < 0 ORDER BY match_id')
      .map((r) => r.match_id)
  }

  ended(id: string): boolean {
    return this.sql.exec<{ ended: number }>('SELECT ended FROM match_settled WHERE match_id = ?', id)[0]?.ended === 1
  }

  /** Notes that the end was closed up, before doing it, so a failure halfway never does it twice */
  settleEnd(id: string) {
    this.sql.exec(
      'INSERT INTO match_settled (match_id, ended) VALUES (?, 1) ON CONFLICT (match_id) DO UPDATE SET ended = 1',
      id,
    )
  }

  /** How many matches live in objects, and how many wait for their object to confirm (`/api/health`) */
  counts(): { objects: number; unconfirmed: number } {
    const row = this.sql.exec<{ n: number; u: number }>(
      'SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN rev < 0 THEN 1 ELSE 0 END), 0) AS u FROM match_homes',
    )[0]
    return { objects: row.n, unconfirmed: row.u }
  }
}
