import { clubPath } from '../shared/clubs.ts'

/**
 * Another club's web app manifest (ARCHITECTURE.md §1「加入主畫面」): a member who adds
 * `/c/<id>/` to their home screen gets an app that opens their own club, named after it. 淡江's
 * stays the static `public/manifest.webmanifest` at `/`; another club's is that same file with the
 * club's name and its own `id`, `start_url` and `scope`, so the icons and colours stay in one place.
 * The page links it instead of 淡江's when it is another club's (`src/lib/club.ts` `linkClubManifest`).
 */

/** The club a manifest's path names (`/c/<id>/manifest.webmanifest`), or null for any other path */
export function manifestClub(pathname: string): string | null {
  return /^\/c\/([a-z][a-z0-9-]{1,23})\/manifest\.webmanifest$/.exec(pathname)?.[1] ?? null
}

/** The static manifest made the club's */
export function clubManifest(base: Record<string, unknown>, clubId: string, name: string): Record<string, unknown> {
  const home = clubPath(clubId, '/')
  return {
    ...base,
    name: `${name}・Overtrick`,
    short_name: name,
    description: `${name} on Overtrick`,
    // Its own app (not 淡江's, whose id is its start_url `/`): opens and stays in the club's pages
    id: home,
    start_url: home,
    scope: home,
  }
}

export function manifestAnswer(base: Record<string, unknown>, clubId: string, name: string): Response {
  return new Response(JSON.stringify(clubManifest(base, clubId, name)), {
    headers: {
      'Content-Type': 'application/manifest+json; charset=utf-8',
      // A renamed club shows within minutes
      'Cache-Control': 'public, max-age=300',
    },
  })
}
