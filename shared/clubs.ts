/**
 * The clubs (BridgeBook e10-t10, TKU-BridgeTable e12-t02, e12-t03): each club is its own Durable Object, so
 * its keys need no `club:<id>:` prefix and nothing moves when a second club comes (ARCHITECTURE.md §1). A request names its club with the `X-Club-Id` header (or `?club=`
 * on a WebSocket, which cannot carry headers); none means 淡江, so every page and client from before
 * clubs works as it did. A club no one knows is turned away.
 *
 * What lives outside a club's object carries the club too (e12-t03): its tables' and events' object
 * names (`tableObjectName`, `eventObjectName`), its files and backups in R2 (`clubStoragePrefix`),
 * its rows in the D1 history copy and its edge passes. 淡江 keeps every name and path it had before
 * clubs, so none of its data moves.
 */

/** 淡江橋藝社, the first club */
export const DEFAULT_CLUB_ID = 'tku'

/**
 * Clubs whose object has a name of its own. 淡江's object was `idFromName('club')` before there
 * were clubs, and keeps that name so its data stays where it is; any other club's is `club:<id>`
 */
export const CLUB_OBJECTS: Readonly<Record<string, string>> = { [DEFAULT_CLUB_ID]: 'club' }

/** The clubs every Worker serves; others are named by the `CLUBS` variable (`knownClubs`) */
export const CLUB_IDS: readonly string[] = Object.keys(CLUB_OBJECTS)

/** What a club id looks like: lower-case letters, digits and dashes, starting with a letter */
export const CLUB_ID_PATTERN = /^[a-z][a-z0-9-]{1,23}$/

/** The header a page sends its club in */
export const CLUB_HEADER = 'X-Club-Id'
/** The query parameter a WebSocket sends it in */
export const CLUB_PARAM = 'club'

/**
 * The clubs a Worker serves: 淡江, and the ones its `CLUBS` variable lists (comma-separated ids,
 * e12-t03; none in production until clubs can be opened and run, e12-t05, e12-t06). Ids that do not
 * look like one are left out
 */
export function knownClubs(extra?: string): readonly string[] {
  const more = (extra ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => CLUB_ID_PATTERN.test(id) && !CLUB_IDS.includes(id))
  return more.length ? [...CLUB_IDS, ...new Set(more)] : CLUB_IDS
}

export function isClubId(value: string, known: readonly string[] = CLUB_IDS): boolean {
  return known.includes(value)
}

/** The Durable Object name of a club, or null for one no one knows */
export function clubObjectName(clubId: string, known: readonly string[] = CLUB_IDS): string | null {
  if (!isClubId(clubId, known)) return null
  return Object.hasOwn(CLUB_OBJECTS, clubId) ? CLUB_OBJECTS[clubId] : `club:${clubId}`
}

/** The club an object name belongs to (the reverse of clubObjectName), or null */
export function clubIdOfObject(name: string | undefined, known: readonly string[] = CLUB_IDS): string | null {
  return known.find((id) => clubObjectName(id, known) === name) ?? null
}

/**
 * The club a request is for: its `X-Club-Id` header, else its `?club=`, else 淡江; null when it
 * names a club no one knows
 */
export function requestClubId(request: Request, known: readonly string[] = CLUB_IDS): string | null {
  const named = request.headers.get(CLUB_HEADER) ?? new URL(request.url).searchParams.get(CLUB_PARAM)
  if (named === null || named === '') return DEFAULT_CLUB_ID
  return isClubId(named, known) ? named : null
}

// ── Names outside the club's object (e12-t03) ──────────────────────────────────────────────────

/**
 * `<club>/` before a name another club could also make (a table's or a challenge's id); nothing for
 * 淡江, whose names stay as they were
 */
const scoped = (clubId: string, name: string) => (clubId === DEFAULT_CLUB_ID ? name : `${clubId}/${name}`)

/** The Durable Object name of a club's table (`TableObject`, ARCHITECTURE.md §5.10): 淡江's is the table id */
export function tableObjectName(clubId: string, tableId: string): string {
  return scoped(clubId, tableId)
}

/** The Durable Object name of a club's challenge, match or pairs event (`EventObject`, §5.12): `<kind>:<id>` for 淡江 */
export function eventObjectName(clubId: string, kind: 'challenge' | 'match' | 'pairs', id: string): string {
  return scoped(clubId, `${kind}:${id}`)
}

/**
 * The club a table's or an event's object belongs to, from its name: `<club>/…` for a club named
 * there, 淡江 for a name without one (every object made before clubs, and 淡江's since) or none at
 * all. Whether the club is still served is the caller's to check (its stub throws when it is not)
 */
export function clubOfScopedName(name: string | undefined): string {
  const slash = name?.indexOf('/') ?? -1
  return name && slash > 0 ? name.slice(0, slash) : DEFAULT_CLUB_ID
}

/**
 * The club a club's own object is, from its name (`clubObjectName`): 淡江's `club` (or no name),
 * else `club:<id>`. Read from the name rather than from the clubs served, so an object woken by its
 * alarm after its club stopped being served never takes itself for 淡江
 */
export function clubOfClubObject(name: string | undefined): string {
  return name?.startsWith('club:') && name.length > 'club:'.length ? name.slice('club:'.length) : DEFAULT_CLUB_ID
}

/**
 * Where a club's things start in an R2 bucket (backups, pictures and e-books): nothing for 淡江, whose
 * objects keep the keys they always had (`daily/…`, `post/…`), and `clubs/<id>/` for any other club
 */
export function clubStoragePrefix(clubId: string): string {
  return clubId === DEFAULT_CLUB_ID ? '' : `clubs/${clubId}/`
}

// ── Club addresses and sign-in scope (e12-t04) ─────────────────────────────────────────────────

/** Where another club's pages are: `/c/<id>/…`; 淡江's stay where they always were */
export const CLUB_PATH_PREFIX = '/c/'

/**
 * A page's address in a club: the path as it is for 淡江, `/c/<id>` before it for any other club
 * (`/` becomes `/c/<id>/`). Addresses on another site (`https://…`) are left alone
 */
export function clubPath(clubId: string, path: string): string {
  if (clubId === DEFAULT_CLUB_ID || /^[a-z][a-z0-9+.-]*:/i.test(path)) return path
  const rest = path.startsWith('/') ? path : `/${path}`
  return `${CLUB_PATH_PREFIX}${clubId}${rest}`
}

/**
 * The club a page's path names (`/c/<id>/…`), and the path inside it; null for a path without one
 * (淡江's pages, and anything that only looks like a club). `/c/tku/…` names 淡江: the page goes to
 * the plain address
 */
export function clubOfPath(pathname: string): { clubId: string; rest: string } | null {
  if (!pathname.startsWith(CLUB_PATH_PREFIX)) return null
  const after = pathname.slice(CLUB_PATH_PREFIX.length)
  const slash = after.indexOf('/')
  const clubId = slash === -1 ? after : after.slice(0, slash)
  if (!CLUB_ID_PATTERN.test(clubId)) return null
  return { clubId, rest: slash === -1 ? '/' : after.slice(slash) }
}

/**
 * A sign-in cookie's name in a club (e12-t04, docs/SECURITY.md): the name as it always was for
 * 淡江, so nobody there is signed out, and `<name>_<id>` for any other club. Every club's cookies are
 * on the whole site (`Path=/`), so a member may be signed in to two clubs at once in one browser;
 * each club reads only its own names, so one club's session never reaches another
 */
export function clubCookieName(name: string, clubId: string): string {
  return clubId === DEFAULT_CLUB_ID ? name : `${name}_${clubId}`
}

/**
 * The names the clubs are shown by to other clubs (the cross-club lobby, e12-t07); a club without
 * one here is shown by its id until the platform's registry names it (e12-t05, e12-t06)
 */
export const CLUB_NAMES: Readonly<Record<string, string>> = { [DEFAULT_CLUB_ID]: '淡江橋藝社' }

export function clubName(clubId: string): string {
  return Object.hasOwn(CLUB_NAMES, clubId) ? CLUB_NAMES[clubId] : clubId
}
