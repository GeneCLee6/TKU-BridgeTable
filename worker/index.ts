import type { Env } from './club.ts'

export { Club } from './club.ts'

/** API and WebSocket requests go to the club's Durable Object; everything else is the React app */
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url)
    if (pathname === '/ws' || pathname.startsWith('/api/')) {
      return env.CLUB.get(env.CLUB.idFromName('club')).fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>
