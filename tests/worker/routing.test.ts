// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { route, TABLE_USER_HEADER, type Routes } from '../../worker/routing.ts'

/** The Worker's routing (`worker/index.ts`), with the Durable Objects faked (ARCHITECTURE.md §5.10) */

let seen: { to: string; request: Request }[]
let sessions: Map<string, string>
let routes: Routes

const answer = (to: string) => ({
  fetch: async (request: Request) => {
    seen.push({ to, request })
    return new Response(to)
  },
})

beforeEach(() => {
  seen = []
  sessions = new Map([['good-token', 'amy']])
  routes = {
    club: () => ({ ...answer('club'), socketUser: async (token) => (token && sessions.get(token)) ?? null }),
    table: (tableId) => answer(`table:${tableId}`),
    assets: answer('assets'),
  }
})

const upgrade = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://example.org${path}`, { headers: { Upgrade: 'websocket', ...headers } })

describe('the Worker routing', () => {
  it('sends the API and the club socket to the club, the rest to the app', async () => {
    await route(new Request('https://example.org/api/me'), routes)
    await route(upgrade('/ws'), routes)
    await route(new Request('https://example.org/table/abc'), routes)
    expect(seen.map((s) => s.to)).toEqual(['club', 'club', 'assets'])
  })

  it('forwards a table socket to its table with the member the session belongs to', async () => {
    const response = await route(upgrade('/ws/table/abc123', { Cookie: 'tbt_session=good-token' }), routes)
    expect(await response.text()).toBe('table:abc123')
    expect(seen[0].request.headers.get(TABLE_USER_HEADER)).toBe('amy')
  })

  it('never passes on a member id the browser made up', async () => {
    const response = await route(upgrade('/ws/table/abc123', { [TABLE_USER_HEADER]: 'admin' }), routes)
    expect(response.status).toBe(401)
    await route(upgrade('/ws/table/abc123', { Cookie: 'tbt_session=good-token', [TABLE_USER_HEADER]: 'admin' }), routes)
    expect(seen[0].request.headers.get(TABLE_USER_HEADER)).toBe('amy')
  })

  it('turns away what is not a table socket', async () => {
    expect((await route(upgrade('/ws/table/abc123', { Cookie: 'tbt_session=stale' }), routes)).status).toBe(401)
    expect((await route(new Request('https://example.org/ws/table/abc123'), routes)).status).toBe(426)
    expect((await route(upgrade('/ws/table/a.b'), routes)).status).toBe(404)
    expect((await route(upgrade(`/ws/table/${'x'.repeat(40)}`), routes)).status).toBe(404)
    expect(seen).toEqual([])
  })
})
