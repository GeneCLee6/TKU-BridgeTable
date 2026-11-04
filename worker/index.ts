import type { GuestTable } from '../shared/public-lobby.ts'
import type { Env } from './club.ts'
import { clubsOf, clubStub, everyClubStub, tableStub } from './clubs.ts'
import { d1Replica } from './d1.ts'
import { edgeSecret } from './edge-auth.ts'
import { jsonLog } from './log.ts'
import { route } from './routing.ts'
import { withSecurityHeaders } from './security-headers.ts'

export { Club } from './club.ts'
export { TableObject } from './table-object.ts'
export { EventObject } from './event-object.ts'

/**
 * API and the club's WebSocket go to the club's Durable Object, a table's WebSocket to that
 * table's own object (ARCHITECTURE.md §5.10); the history pages are answered here from D1 when the
 * edge pass and the copy allow it (§5.12); everything else is the React app
 */
export default {
  async fetch(request, env) {
    const response = await route(request, {
      clubs: clubsOf(env),
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
    // CSP and the other security headers (e11-t23, worker/security-headers.ts)
    return withSecurityHeaders(response, new URL(request.url).pathname)
  },
  /**
   * The cron trigger in wrangler.jsonc: every club's daily backup to R2 (worker/backup.ts), each in
   * its own part of the bucket (淡江's `daily/…`, another club's `clubs/<id>/daily/…`, e12-t03)
   */
  async scheduled(_controller, env, ctx) {
    for (const club of everyClubStub(env)) ctx.waitUntil(club.backup())
  },
} satisfies ExportedHandler<Env>

