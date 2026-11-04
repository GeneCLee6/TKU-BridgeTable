import { clubObjectName, clubOfScopedName, eventObjectName, knownClubs, tableObjectName } from '../shared/clubs.ts'

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
 * A club's Durable Object (e12-t02): one per club. Throws for a club no one knows; the routing
 * turns those away before asking
 */
export function clubStub<Id, Stub>(env: { CLUB: Namespace<Id, Stub>; CLUBS?: string }, clubId: string): Stub {
  const name = clubObjectName(clubId, clubsOf(env))
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
 * A club no longer served makes every report fail (the object offers them again later) rather
 * than reach another club
 */
export function ownClub<Id, Stub>(env: { CLUB: Namespace<Id, Stub>; CLUBS?: string }, objectName: string | undefined) {
  const clubId = clubOfScopedName(objectName)
  let stub: Stub | undefined
  return { clubId, stub: (): Stub => (stub ??= clubStub(env, clubId)) }
}

/** Every club's object, for the daily backup */
export function everyClubStub<Id, Stub>(env: { CLUB: Namespace<Id, Stub>; CLUBS?: string }): Stub[] {
  return clubsOf(env).map((id) => clubStub(env, id))
}
