// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { taiwanDayStart } from '../../shared/history-query.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { EDGE_PASS_MS, mintPass, PASS_COOKIE, passCookie, passNeedsRefresh, readPass } from '../../worker/edge-auth.ts'
import { createHistoryIndex, indexRecord, listQuery, searchBoards } from '../../worker/history-index.ts'
import { REPLICA_SCHEMA, replicaWrites } from '../../worker/history-replica.ts'
import type { LogEntry } from '../../worker/log.ts'
import { route, TABLE_USER_HEADER, type Routes } from '../../worker/routing.ts'
import { memoryD1, type MemoryD1 } from './d1.ts'
import { memorySql } from './sqlite.ts'

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

// ── Edge passes and the history pages at the edge (ARCHITECTURE.md §5.12) ─────────────────────

const SECRET = 'test-secret-0123456789abcdef'
const NOW = taiwanDayStart('2026-10-26')

describe('edge passes', () => {
  it('says who it is for until it expires, and nothing once anything in it changes', async () => {
    const pass = await mintPass(SECRET, 'amy', NOW)
    expect(await readPass(SECRET, pass, NOW)).toEqual({ userId: 'amy', expires: NOW + EDGE_PASS_MS })
    expect(await readPass(SECRET, pass, NOW + EDGE_PASS_MS - 1)).toMatchObject({ userId: 'amy' })
    expect(await readPass(SECRET, pass, NOW + EDGE_PASS_MS)).toBeNull()
    expect(await readPass('another-secret', pass, NOW)).toBeNull()
    const [, expires, signature] = pass.split('.')
    // Someone else's id, a later expiry, a changed signature, junk
    expect(await readPass(SECRET, `ben.${expires}.${signature}`, NOW)).toBeNull()
    expect(await readPass(SECRET, `amy.${(NOW + EDGE_PASS_MS * 50).toString(36)}.${signature}`, NOW)).toBeNull()
    expect(await readPass(SECRET, `amy.${(NOW + EDGE_PASS_MS - 1).toString(36)}.${signature}`, NOW)).toBeNull()
    expect(await readPass(SECRET, `amy.${expires}.${signature.slice(1)}A`, NOW)).toBeNull()
    for (const junk of [null, '', 'amy', 'amy.x.y.z', `amy.${expires}.!!!`, 'a'.repeat(300)])
      expect(await readPass(SECRET, junk, NOW)).toBeNull()
    expect(await readPass('', pass, NOW)).toBeNull()
  })

  it('is handed out again once more than half used', async () => {
    const pass = await mintPass(SECRET, 'amy', NOW)
    expect(await passNeedsRefresh(SECRET, pass, NOW + EDGE_PASS_MS / 2 - 1)).toBe(false)
    expect(await passNeedsRefresh(SECRET, pass, NOW + EDGE_PASS_MS / 2 + 1)).toBe(true)
    expect(await passNeedsRefresh(SECRET, null, NOW)).toBe(true)
    expect(passCookie(pass, true)).toBe(`${PASS_COOKIE}=${pass}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600; Secure`)
    expect(passCookie('', false)).toBe(`${PASS_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  })
})

describe('the Worker at the edge', () => {
  let d1: MemoryD1
  let logs: LogEntry[]
  let socketUsers: number
  const records: BoardRecord[] = [1, 2, 3].map((n) => ({
    id: `b${n}`,
    tableNumber: 1,
    finishedAt: NOW - n * 60_000,
    players: {
      N: { id: 'amy', username: 'amy' },
      E: { id: 'ben', username: 'ben' },
      S: { id: 'cat', username: 'cat' },
      W: { id: 'robot:gib:W', username: 'TKB' },
    },
    board: { boardNo: n, dealer: 'N', vul: 'None', contract: null, result: { declarerTricks: 0, scoreNS: 0, claimed: false } } as never,
    // Board 3 is a challenge's, still kept back: Amy played it, Dan did not
    ...(n === 3 && { mode: 'challenge' as const, eventId: 'c1', revealAt: NOW + 86_400_000 }),
  }))

  beforeEach(async () => {
    d1 = memoryD1()
    logs = []
    socketUsers = 0
    await d1.batch([...REPLICA_SCHEMA.map((sql) => ({ sql, params: [] })), ...replicaWrites(records, [])])
    await d1.batch([{ sql: "INSERT INTO index_meta (key, value) VALUES ('ready', '1')", params: [] }])
    routes.club = () => ({
      ...answer('club'),
      socketUser: async (token) => {
        socketUsers++
        return (token && sessions.get(token)) ?? null
      },
    })
    routes.edge = { secret: SECRET, history: d1, now: () => NOW, log: (entry) => logs.push(entry) }
  })

  const get = async (path: string, userId: string | null, init: RequestInit = {}) => {
    const cookie = userId ? `${PASS_COOKIE}=${await mintPass(SECRET, userId, NOW)}` : ''
    return route(new Request(`https://example.org${path}`, { ...init, headers: { Cookie: cookie } }), routes)
  }

  it('answers the history pages from D1 without the club, exactly as the club would', async () => {
    const sql = memorySql()
    createHistoryIndex(sql)
    for (const r of records) indexRecord(sql, r)
    for (const viewer of ['amy', 'dan']) {
      const response = await get('/api/history?scope=all&page=1&size=20', viewer)
      expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      const page = (await response.json()) as { boards: { id: string }[]; total: number; page: number; size: number }
      const club = searchBoards(sql, listQuery(true, 1, 20), viewer, NOW)
      expect(page.boards.map((b) => b.id)).toEqual(club.ids)
      expect(page).toMatchObject({ total: club.total, page: 1, size: 20 })
    }
    // Dan never gets the board kept back; Amy, who played it, does
    const total = async (path: string, viewer: string) => ((await (await get(path, viewer)).json()) as { total: number }).total
    expect(await total('/api/history/search?scope=all', 'dan')).toBe(2)
    expect(await total('/api/history/search?scope=all', 'amy')).toBe(3)
    expect(await total('/api/history', 'amy')).toBe(3)
    expect(seen).toEqual([])
    expect(logs.every((entry) => entry.event === 'edge' && entry.status === 200)).toBe(true)
  })

  it('leaves the history to the club without a good pass, for a tag, a bad query, a copy not complete or D1 failing', async () => {
    const asks = async (path: string, userId: string | null, cookie?: string) => {
      seen = []
      const response = cookie
        ? await route(new Request(`https://example.org${path}`, { headers: { Cookie: cookie } }), routes)
        : await get(path, userId)
      return { to: seen.map((s) => s.to), body: await response.text() }
    }
    expect(await asks('/api/history', null)).toEqual({ to: ['club'], body: 'club' })
    expect((await asks('/api/history', null, `${PASS_COOKIE}=amy.zzzz.abc; tbt_session=good-token`)).to).toEqual(['club'])
    expect((await asks('/api/history/search?tag=slam', 'amy')).to).toEqual(['club'])
    expect((await asks('/api/history/search?level=9', 'amy')).to).toEqual(['club'])
    // Only GET, only these two pages
    seen = []
    await get('/api/history', 'amy', { method: 'POST' })
    await get('/api/history/b1', 'amy')
    expect(seen.map((s) => s.to)).toEqual(['club', 'club'])

    await d1.batch([{ sql: "UPDATE index_meta SET value = '0' WHERE key = 'ready'", params: [] }])
    expect((await asks('/api/history', 'amy')).to).toEqual(['club'])
    expect(logs.at(-1)).toMatchObject({ event: 'edge', fallback: 'notReady' })
    d1.fail = new Error('D1 is down')
    expect((await asks('/api/history', 'amy')).to).toEqual(['club'])
    expect(logs.at(-1)).toMatchObject({ event: 'edge', fallback: 'error' })
    // Switched off: no copy, no passes
    d1.fail = null
    routes.edge = {}
    expect((await asks('/api/history', 'amy')).to).toEqual(['club'])
  })

  it('opens a table socket from the pass without asking the club, and asks it when the pass is missing or bad', async () => {
    const pass = await mintPass(SECRET, 'amy', NOW)
    const response = await route(upgrade('/ws/table/abc123', { Cookie: `${PASS_COOKIE}=${pass}` }), routes)
    expect(await response.text()).toBe('table:abc123')
    expect(seen[0].request.headers.get(TABLE_USER_HEADER)).toBe('amy')
    expect(socketUsers).toBe(0)
    // An expired pass: the session decides, so a signed-out browser is turned away
    routes.edge!.now = () => NOW + EDGE_PASS_MS
    await route(upgrade('/ws/table/abc123', { Cookie: `${PASS_COOKIE}=${pass}; tbt_session=good-token` }), routes)
    expect(seen[1].request.headers.get(TABLE_USER_HEADER)).toBe('amy')
    expect(socketUsers).toBe(1)
    expect((await route(upgrade('/ws/table/abc123', { Cookie: `${PASS_COOKIE}=${pass}` }), routes)).status).toBe(401)
    // A pass for someone else cannot be made without the secret
    const [, expires, signature] = pass.split('.')
    const forged = `ben.${expires}.${signature}`
    routes.edge!.now = () => NOW
    expect((await route(upgrade('/ws/table/abc123', { Cookie: `${PASS_COOKIE}=${forged}`, [TABLE_USER_HEADER]: 'ben' }), routes)).status).toBe(401)
  })
})
