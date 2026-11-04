import { CLUB_HEADER, CLUB_PARAM, CLUB_PATH_PREFIX, clubOfPath, clubPath, DEFAULT_CLUB_ID } from '../../shared/clubs.ts'

/**
 * Which club these pages are for (e12-t04, ARCHITECTURE.md §1): 淡江's at the site's own addresses
 * (`/`, `/table/<id>`…), any other club's under `/c/<id>/`. The club comes from the address the page
 * was opened at, once (`main.tsx`), and the router works inside it (`basename`), so every link and
 * page of the app stays in the club. Each call to the Worker names the club: `X-Club-Id` on
 * `fetch`, `?club=` where no header can go (a WebSocket, an `<img>`, a download link).
 */

let current: string = DEFAULT_CLUB_ID

/** Reads the club from a page's path; `main.tsx` calls it before anything is drawn, tests may too */
export function setClubFromPath(pathname: string): string {
  current = clubOfPath(pathname)?.clubId ?? DEFAULT_CLUB_ID
  return current
}

/** The club of these pages */
export function currentClub(): string {
  return current
}

/** What the router's paths start with: nothing for 淡江, `/c/<id>` for another club */
export function clubBase(): string {
  return current === DEFAULT_CLUB_ID ? '' : `${CLUB_PATH_PREFIX}${current}`
}

/**
 * `/c/tku/…` is 淡江 at the plain address (社長 2026-11-04): the address to go to instead, or null
 * when the page is already where it should be
 */
export function plainAddress(pathname: string, search = '', hash = ''): string | null {
  const named = clubOfPath(pathname)
  return named?.clubId === DEFAULT_CLUB_ID ? `${named.rest}${search}${hash}` : null
}

/** A page of this club as a full path, for links outside the router (a share link, an `href`) */
export function appPath(path: string): string {
  return clubPath(current, path)
}

/** The path inside the club (what the router matches), from a page's full path */
export function pathInClub(pathname: string): string {
  const base = clubBase()
  if (!base) return pathname
  return pathname === base ? '/' : pathname.startsWith(`${base}/`) ? pathname.slice(base.length) : pathname
}

/** A call's headers with the club; 淡江's calls carry none, as before clubs */
export function clubHeaders(headers?: HeadersInit): Headers {
  const all = new Headers(headers)
  if (current !== DEFAULT_CLUB_ID) all.set(CLUB_HEADER, current)
  return all
}

/** A Worker address with `?club=` for another club (relative addresses stay relative) */
export function withClub(url: string): string {
  if (current === DEFAULT_CLUB_ID) return url
  const parsed = new URL(url, 'https://relative.invalid')
  parsed.searchParams.set(CLUB_PARAM, current)
  return parsed.origin === 'https://relative.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString()
}

/** A localStorage key of this club: 淡江 keeps its keys, another club's get `@<id>`, so one club's drafts never show in another */
export function clubStorageKey(key: string): string {
  return current === DEFAULT_CLUB_ID ? key : `${key}@${current}`
}

/**
 * Another club's pages link its own web app manifest (`/c/<id>/manifest.webmanifest`, made by the
 * Worker from 淡江's with the club's name, `worker/manifest.ts`), so adding them to the home screen
 * makes an app that opens that club. 淡江's pages keep `/manifest.webmanifest` (index.html). The
 * home-screen title for iPhones comes from the manifest too: 淡江's `apple-mobile-web-app-title` is dropped
 */
export function linkClubManifest(doc: Document = document) {
  if (current === DEFAULT_CLUB_ID) return
  const link = doc.querySelector<HTMLLinkElement>('link[rel="manifest"]')
  if (link) link.href = `${CLUB_PATH_PREFIX}${current}/manifest.webmanifest`
  doc.querySelector('meta[name="apple-mobile-web-app-title"]')?.remove()
}
