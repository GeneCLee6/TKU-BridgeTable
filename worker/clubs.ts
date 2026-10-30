import { CLUB_IDS, clubObjectName, DEFAULT_CLUB_ID } from '../shared/clubs.ts'
import type { Env } from './club.ts'

/**
 * A club's Durable Object (e12-t02): one per club, by the name shared/clubs.ts gives it. Throws for
 * a club no one knows; the routing turns those away before asking
 */
export function clubStub(env: Env, clubId: string) {
  const name = clubObjectName(clubId)
  if (name === null) throw new Error(`Unknown club ${clubId}`)
  return env.CLUB.get(env.CLUB.idFromName(name))
}

/**
 * The club a table or a challenge reports to. Every table and challenge is 淡江's until a second
 * club opens (e12-t04 gives them their club when they are made)
 */
export function homeClubStub(env: Env) {
  return clubStub(env, DEFAULT_CLUB_ID)
}

/** Every club's object, for the daily backup */
export function everyClubStub(env: Env) {
  return CLUB_IDS.map((id) => clubStub(env, id))
}
