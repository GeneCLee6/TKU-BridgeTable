/**
 * The clubs (BridgeBook e10-t10, TKU-BridgeTable e12-t02): each club is its own Durable Object, so
 * its keys need no `club:<id>:` prefix and nothing moves when a second club comes (ARCHITECTURE.md §1). A request names its club with the `X-Club-Id` header (or `?club=`
 * on a WebSocket, which cannot carry headers); none means 淡江, so every page and client from before
 * clubs works as it did. A club no one knows is turned away.
 */

/** 淡江橋藝社, the only club so far */
export const DEFAULT_CLUB_ID = 'tku'

/**
 * Every club and the name of its Durable Object. 淡江's object was `idFromName('club')` before there
 * were clubs, and keeps that name so its data stays where it is
 */
export const CLUB_OBJECTS: Readonly<Record<string, string>> = { [DEFAULT_CLUB_ID]: 'club' }

export const CLUB_IDS: readonly string[] = Object.keys(CLUB_OBJECTS)

/** The header a page sends its club in */
export const CLUB_HEADER = 'X-Club-Id'
/** The query parameter a WebSocket sends it in */
export const CLUB_PARAM = 'club'

export function isClubId(value: string): boolean {
  return Object.hasOwn(CLUB_OBJECTS, value)
}

/** The Durable Object name of a club, or null for one no one knows */
export function clubObjectName(clubId: string): string | null {
  return isClubId(clubId) ? CLUB_OBJECTS[clubId] : null
}

/** The club an object name belongs to (the reverse of clubObjectName), or null */
export function clubIdOfObject(name: string | undefined): string | null {
  return CLUB_IDS.find((id) => CLUB_OBJECTS[id] === name) ?? null
}

/**
 * The club a request is for: its `X-Club-Id` header, else its `?club=`, else 淡江; null when it
 * names a club no one knows
 */
export function requestClubId(request: Request): string | null {
  const named = request.headers.get(CLUB_HEADER) ?? new URL(request.url).searchParams.get(CLUB_PARAM)
  if (named === null || named === '') return DEFAULT_CLUB_ID
  return isClubId(named) ? named : null
}
