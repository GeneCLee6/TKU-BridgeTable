import { DEFAULT_CLUB_ID } from '../shared/clubs.ts'
import type { GuestTable } from '../shared/public-lobby.ts'
import type { Env } from './club.ts'
import { ClubRegistryCache, clubsOf, clubStub, everyClubStub, tableStub } from './clubs.ts'
import { d1Replica } from './d1.ts'
import { edgeSecret } from './edge-auth.ts'
import { jsonLog } from './log.ts'
import { route } from './routing.ts'
import { withSecurityHeaders } from './security-headers.ts'

export { Club } from './club.ts'
export { TableObject } from './table-object.ts'
export { EventObject } from './event-object.ts'

/** The clubs the platform opened (e12-t06), read from 淡江's object only for requests naming another club */
let registry: ClubRegistryCache | undefined
const registryOf = (env: Env) => (registry ??= new ClubRegistryCache(() => clubStub(env, DEFAULT_CLUB_ID).platformSnapshot()))

/**
 * API and the club's WebSocket go to the club's Durable Object, a table's WebSocket to that
 * table's own object (ARCHITECTURE.md §5.10); the history pages are answered here from D1 when the
 * edge pass and the copy allow it (§5.12); everything else is the React app
 */
export default {
  async fetch(request, env) {
    const response = await route(request, {
      clubs: clubsOf(env),
      // The platform's registry (e12-t06): never asked for 淡江's requests
      findClub: (clubId) => registryOf(env).status(clubId),
      // The cross-club lobby (e12-t07) asks every opened club that is not suspended
      openClubs: async () => {
        const known = registryOf(env)
        const ids = await known.ids()
        const statuses = await Promise.all(ids.map((id) => known.status(id)))
        return ids.filter((_, i) => statuses[i] === 'active')
      },
      // The platform's notices (e12-t15): with the registry's cached read; no owner, no notices and no read
      platformNotices: () => (env.PLATFORM_OWNER ? registryOf(env).notices() : Promise.resolve([])),
      // Each club its own object (e12-t02, shared/clubs.ts)
      club: (clubId) => {
        const stub = clubStub(env, clubId)
        return {
          fetch: (r) => stub.fetch(r),
          socketUser: (token) => stub.socketUser(token),
          // The cross-club lobby (e12-t07): RPC only, never reachable from a browser
          publicViewer: (userId) => stub.publicViewer(userId),
          publicTables: () => stub.publicTables(),
          guestTable: (tableId) => stub.guestTable(tableId) as Promise<GuestTable | null>,
          clubName: () => stub.clubName(),
          clubBrand: () => stub.clubBrand(),
          memberNotices: (token) => stub.memberNotices(token),
        }
      },
      // A club's tables are named after it (e12-t03): 淡江's by the table id as before
      table: (clubId, tableId) => {
        const stub = tableStub(env, clubId, tableId)
        return { fetch: (r) => stub.fetch(r) }
      },
      assets: env.ASSETS,
      edge: {
        secret: edgeSecret(env),
        // Ended sessions (e11-t28): kept whatever HISTORY_D1 says, since passes need them
        revocations: env.HISTORY ? d1Replica(env.HISTORY) : undefined,
        history: env.HISTORY && env.HISTORY_D1 !== 'off' ? d1Replica(env.HISTORY) : undefined,
        log: jsonLog,
      },
    })
    const { pathname } = new URL(request.url)
    // The owner changed the registry (approved or suspended a club): this isolate reads it again at once
    if (request.method === 'POST' && pathname.startsWith('/api/platform/') && response.ok) registry?.forget()
    // CSP and the other security headers (e11-t23, worker/security-headers.ts)
    return withSecurityHeaders(response, pathname)
  },
  /**
   * The cron trigger in wrangler.jsonc: every club's daily backup to R2 (worker/backup.ts), each in
   * its own part of the bucket (淡江's `daily/…`, another club's `clubs/<id>/daily/…`, e12-t03)
   */
  async scheduled(_controller, env, ctx) {
    // The clubs the platform opened too (e12-t06), suspended ones included: their data is kept
    const registered = await clubStub(env, DEFAULT_CLUB_ID)
      .platformRegistry()
      .then((clubs) => clubs.map((c) => c.id))
      .catch(() => [] as string[])
    for (const club of everyClubStub(env, registered)) ctx.waitUntil(club.backup())
  },
} satisfies ExportedHandler<Env>

