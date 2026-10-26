import type { Env } from './club.ts'
import { d1Replica } from './d1.ts'
import { edgeSecret } from './edge-auth.ts'
import { jsonLog } from './log.ts'
import { route } from './routing.ts'

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
    const club = () => env.CLUB.get(env.CLUB.idFromName('club'))
    return route(request, {
      club: () => {
        const stub = club()
        return { fetch: (r) => stub.fetch(r), socketUser: (token) => stub.socketUser(token) }
      },
      table: (tableId) => {
        const stub = env.TABLE.get(env.TABLE.idFromName(tableId))
        return { fetch: (r) => stub.fetch(r) }
      },
      assets: env.ASSETS,
      edge: {
        secret: edgeSecret(env),
        history: env.HISTORY && env.HISTORY_D1 !== 'off' ? d1Replica(env.HISTORY) : undefined,
        log: jsonLog,
      },
    })
  },
  /** The cron trigger in wrangler.jsonc: the daily backup to R2 (worker/backup.ts) */
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(env.CLUB.get(env.CLUB.idFromName('club')).backup())
  },
} satisfies ExportedHandler<Env>

