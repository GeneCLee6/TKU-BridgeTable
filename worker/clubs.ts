import { CLUB_ID_PATTERN, clubObjectName, clubOfScopedName, DEFAULT_CLUB_ID, eventObjectName, knownClubs, tableObjectName } from '../shared/clubs.ts'
import type { ClubStatus } from '../shared/platform.ts'

/**
 * The Durable Objects of the clubs (e12-t02, e12-t03), by the names shared/clubs.ts gives them. Only
 * this file turns a club and an id into an object, so a club can only ever reach its own tables and
 * events: another club's names start differently. The namespaces are typed by shape only (a
 * `DurableObjectNamespace` is one), so tests can run this without Cloudflare's types.
 */

interface Namespace<Id, Stub> {
  idFromName(name: string): Id
  get(id: Id): Stub
}

/** The clubs this Worker serves: 淡江 and the `CLUBS` variable's */
export function clubsOf(env: { CLUBS?: string }): readonly string[] {
  return knownClubs(env.CLUBS)
}

/**
 * A club's Durable Object (e12-t02): one per club, for any id that looks like one. Whether a club
 * is served is the routing's to check (the registry, `ClubRegistryCache`) and the club object's own
 * (its `meta:club`, e12-t05): an object of a club never opened answers nothing (`unknownClub`), so
 * a name reaching it never reaches another club. Throws for an id that does not look like a club's
 */
export function clubStub<Id, Stub>(env: { CLUB: Namespace<Id, Stub>; CLUBS?: string }, clubId: string): Stub {
  const known = clubsOf(env)
  const name = clubObjectName(clubId, known.includes(clubId) || !CLUB_ID_PATTERN.test(clubId) ? known : [...known, clubId])
  if (name === null) throw new Error(`Unknown club ${clubId}`)
  return env.CLUB.get(env.CLUB.idFromName(name))
}

/** A club's table in its own object (§5.10): only the club's names reach it */
export function tableStub<Id, Stub>(env: { TABLE: Namespace<Id, Stub> }, clubId: string, tableId: string): Stub {
  return env.TABLE.get(env.TABLE.idFromName(tableObjectName(clubId, tableId)))
}

/** A club's challenge, match or pairs event in its own object (§5.12) */
export function eventStub<Id, Stub>(env: { EVENT: Namespace<Id, Stub> }, clubId: string, kind: 'challenge' | 'match' | 'pairs', id: string): Stub {
  return env.EVENT.get(env.EVENT.idFromName(eventObjectName(clubId, kind, id)))
}

/**
 * The stub of the club a table's or an event's object belongs to, by the object's own name
 * (e12-t03), made on first use and kept, so its reports reach the club in the order they were made.
 * Only ever that club's object: one never opened turns every report away (the object offers them
 * again later), so they never reach another club
 */
export function ownClub<Id, Stub>(env: { CLUB: Namespace<Id, Stub>; CLUBS?: string }, objectName: string | undefined) {
  const clubId = clubOfScopedName(objectName)
  let stub: Stub | undefined
  return { clubId, stub: (): Stub => (stub ??= clubStub(env, clubId)) }
}

/** Every club's object, for the daily backup: 淡江, `CLUBS`'s and the registry's (`registered`) */
export function everyClubStub<Id, Stub>(env: { CLUB: Namespace<Id, Stub>; CLUBS?: string }, registered: readonly string[] = []): Stub[] {
  return [...new Set([...clubsOf(env), ...registered.filter((id) => CLUB_ID_PATTERN.test(id))])].map((id) => clubStub(env, id))
}

/** How long a Worker trusts what it read of the registry (e12-t06): a new club is served within this */
export const REGISTRY_TTL_MS = 30_000

/**
 * The registry as the Worker routes by it (e12-t06): the clubs the platform opened, with their
 * status, read from 淡江's object (`Club.platformRegistry`) at most once per REGISTRY_TTL_MS per
 * isolate and only for a request naming a club that is not 淡江 (淡江's requests never ask), so
 * an id no one knows costs nothing more than a lookup in memory. A suspension is enforced by the
 * club's own object at once; this copy only spares it the requests. When 淡江's object does not
 * answer, the last copy is used (or none: every other club waits)
 */
export class ClubRegistryCache {
  private readonly load: () => Promise<{ id: string; status: ClubStatus }[]>
  private readonly now: () => number
  private readonly ttlMs: number
  private copy: { at: number; clubs: Map<string, ClubStatus> } | null = null
  private loading: Promise<Map<string, ClubStatus>> | null = null

  constructor(load: () => Promise<{ id: string; status: ClubStatus }[]>, now: () => number = Date.now, ttlMs = REGISTRY_TTL_MS) {
    this.load = load
    this.now = now
    this.ttlMs = ttlMs
  }

  /** The club's status, or null for a club the platform never opened (淡江 is not in the registry) */
  async status(clubId: string): Promise<ClubStatus | null> {
    if (clubId === DEFAULT_CLUB_ID || !CLUB_ID_PATTERN.test(clubId)) return null
    return (await this.clubs()).get(clubId) ?? null
  }

  /** Every club in the registry */
  async ids(): Promise<string[]> {
    return [...(await this.clubs()).keys()]
  }

  /** Read again on the next request (after the owner changed something) */
  forget() {
    this.copy = null
  }

  private async clubs(): Promise<Map<string, ClubStatus>> {
    if (this.copy && this.now() - this.copy.at < this.ttlMs) return this.copy.clubs
    this.loading ??= this.load()
      .then((list) => {
        const clubs = new Map(list.map((c) => [c.id, c.status] as const))
        this.copy = { at: this.now(), clubs }
        return clubs
      })
      .catch(() => this.copy?.clubs ?? new Map<string, ClubStatus>())
      .finally(() => {
        this.loading = null
      })
    return this.loading
  }
}
