import type { Env } from './club.ts'
import { route } from './routing.ts'

export { Club } from './club.ts'
export { TableObject } from './table-object.ts'

/**
 * API and the club's WebSocket go to the club's Durable Object, a table's WebSocket to that
 * table's own object (ARCHITECTURE.md §5.10); everything else is the React app
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
    })
  },
} satisfies ExportedHandler<Env>
