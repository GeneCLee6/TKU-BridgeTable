// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { clubOfPath, clubPath } from '../../shared/clubs.ts'
import type { Notification, ServerMessage } from '../../shared/protocol.ts'
import { pushMessage, testPushMessage } from '../../shared/push-texts.ts'
import { sessionCookie } from '../../worker/auth.ts'
import { PASS_COOKIE, passCookie, passCookieName } from '../../worker/edge-auth.ts'
import type { MailMessage } from '../../worker/mail.ts'
import { callbackPath, flowCookie, flowCookieName } from '../../worker/oauth.ts'
import { route, TABLE_USER_HEADER, type Routes } from '../../worker/routing.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { memoryStore } from './sqlite.ts'

/**
 * Two clubs on one site (e12-t04, e12-t07; ARCHITECTURE.md §1): 淡江 `tku` at the plain addresses and
 * `ntu` under `/c/ntu/`. Each club's pages, links and sign-in cookies are its own, so a browser can
 * be signed in to both; members of different clubs never message or invite each other, and only see
 * each other's tables through the cross-club lobby, as guests who watch.
 */

const NOW = Date.UTC(2026, 10, 4, 4)

/** Remembers the errors each member was sent */
class Inbox implements Connections {
  online = new Set<string>()
  errors: string[] = []
  onlineUserIds() {
    return [...this.online]
  }
  send(_userId: string, message: ServerMessage) {
    if (message.type === 'error') this.errors.push(message.code)
  }
  disconnect(userId: string) {
    this.online.delete(userId)
  }
}

async function makeClub(clubId: string, name: string, extra: { mailer?: { send(m: MailMessage): Promise<void> } } = {}) {
  const sockets = new Inbox()
  const club = new ClubService(memoryStore(), sockets, { clubId, maxUsers: 10, now: () => NOW, schedule: () => {}, ...extra })
  await club.load()
  const first = await club.register(name, 'club-secret-1', '')
  if (!('token' in first)) throw new Error('the first account should sign in at once')
  sockets.online.add(first.user.id)
  return { club, sockets, user: first.user }
}

describe('club addresses (e12-t04)', () => {
  it('keeps 淡江’s addresses and puts another club’s under /c/<id>/', () => {
    expect(clubPath('tku', '/table/abc')).toBe('/table/abc')
    expect(clubPath('ntu', '/table/abc')).toBe('/c/ntu/table/abc')
    expect(clubPath('ntu', '/')).toBe('/c/ntu/')
    expect(clubPath('ntu', 'https://book.example/forum')).toBe('https://book.example/forum')
    expect(clubOfPath('/c/ntu/history/b1')).toEqual({ clubId: 'ntu', rest: '/history/b1' })
    expect(clubOfPath('/c/ntu')).toEqual({ clubId: 'ntu', rest: '/' })
    // 淡江 under /c/tku/ is sent to the plain address by the page
    expect(clubOfPath('/c/tku/table/x')).toEqual({ clubId: 'tku', rest: '/table/x' })
    expect(clubOfPath('/table/x')).toBeNull()
    expect(clubOfPath('/c/../x')).toBeNull()
  })

  it('sends push and mail links to the member’s own club', async () => {
    const invited = { id: 'n1', kind: 'tableInvited', params: { tableId: 't1', username: 'gene' }, at: NOW, read: false } as Notification
    expect(pushMessage(invited, 'zh').url).toBe('/table/t1')
    expect(pushMessage(invited, 'zh', { clubId: 'ntu' }).url).toBe('/c/ntu/table/t1')
    expect(testPushMessage('en').url).toBe('/account')
    expect(testPushMessage('en', 'ntu').url).toBe('/c/ntu/account')
    // A link to 淡江橋館 stays on its site
    const pair = { id: 'n2', kind: 'pairInvited', params: { pairId: 'p1' }, at: NOW, read: false } as Notification
    expect(pushMessage(pair, 'zh', { clubId: 'ntu' }).url).toMatch(/^https:\/\//)

    const sent: MailMessage[] = []
    const mailer = { send: async (m: MailMessage) => void sent.push(m) }
    for (const [clubId, prefix] of [
      ['tku', 'https://bridge.example/email/verify#'],
      ['ntu', 'https://bridge.example/c/ntu/email/verify#'],
    ] as const) {
      const { club, user } = await makeClub(clubId, 'amy', { mailer })
      await club.setEmail(user.id, `amy-${clubId}@example.org`, 'club-secret-1', 'https://bridge.example')
      expect(sent.at(-1)?.text).toContain(prefix)
    }
  })
})

describe('sign-in cookies per club (e12-t04, docs/SECURITY.md)', () => {
  it('names every sign-in cookie per club, keeping 淡江’s names so nobody there is signed out', () => {
    expect(sessionCookie('t', true)).toMatch(/^tbt_session=t; Path=\/; HttpOnly; SameSite=Lax/)
    expect(sessionCookie('t', true, 'ntu')).toMatch(/^tbt_session_ntu=t; Path=\/; HttpOnly; SameSite=Lax/)
    expect(passCookie('p', true, 'ntu')).toMatch(/^tbt_pass_ntu=p; Path=\/; HttpOnly/)
    expect(passCookieName('tku')).toBe(PASS_COOKIE)
    expect(flowCookie('google', 'f', true)).toMatch(/^tbt_google=f; Path=\/api\//)
    expect(flowCookie('line', 'f', true, undefined, 'ntu')).toMatch(/^tbt_line_ntu=f; Path=\/api\//)
    expect(flowCookieName('google', 'ntu')).toBe('tbt_google_ntu')
    // The provider's way back names the club; 淡江's stays as registered with Google and LINE
    expect(callbackPath('google')).toBe('/api/auth/google/callback')
    expect(callbackPath('line', 'ntu')).toBe('/api/auth/line/callback?club=ntu')
  })

  it('lets one browser be signed in to two clubs at once, each cookie only for its own club', async () => {
    const sessions: Record<string, Map<string, string>> = { tku: new Map([['a', 'u1']]), ntu: new Map([['b', 'u7']]) }
    const seen: string[] = []
    const routes: Routes = {
      clubs: ['tku', 'ntu'],
      club: (clubId) => ({
        fetch: async () => new Response(clubId),
        socketUser: async (token) => (token && sessions[clubId].get(token)) ?? null,
      }),
      table: (clubId, tableId) => ({
        fetch: async (request) => (seen.push(`${clubId}:${request.headers.get(TABLE_USER_HEADER)}:${tableId}`), new Response('ok')),
      }),
      assets: { fetch: async () => new Response('assets') },
    }
    const socket = (path: string, cookie: string) =>
      route(new Request(`https://example.org${path}`, { headers: { Upgrade: 'websocket', Cookie: cookie } }), routes)
    await socket('/ws/table/t1', 'tbt_session=a; tbt_session_ntu=b')
    await socket('/ws/table/t1?club=ntu', 'tbt_session=a; tbt_session_ntu=b')
    expect(seen).toEqual(['tku:u1:t1', 'ntu:u7:t1'])
    // The other club's cookie under this club's name, or this club's under the other's: nobody
    expect((await socket('/ws/table/t1?club=ntu', 'tbt_session=b')).status).toBe(401)
    expect((await socket('/ws/table/t1', 'tbt_session_ntu=a')).status).toBe(401)
  })
})

describe('members of different clubs (e12-t07)', () => {
  it('cannot message, invite or befriend each other: someone of another club is no member here', async () => {
    const tku = await makeClub('tku', 'gene')
    const ntu = await makeClub('ntu', 'amy')
    expect(ntu.user.id).not.toBe(tku.user.id)
    const amy = ntu.user.id
    await ntu.club.handle(amy, { type: 'sendDirect', to: tku.user.id, text: 'hi' } as never)
    await ntu.club.handle(amy, { type: 'createTable', invitees: [tku.user.id], settings: { access: 'hidden' } } as never)
    await ntu.club.handle(amy, { type: 'createChallenge', invitees: [tku.user.id], boards: 4 } as never)
    await ntu.club.handle(amy, { type: 'setFriend', userId: tku.user.id, friend: true } as never)
    expect(ntu.sockets.errors).toEqual(['userGone', 'userGone', 'userGone', 'userGone'])
  })

  it('shows another club only the tables opened to other clubs, by name, never an id or the chat', async () => {
    const tku = await makeClub('tku', 'gene')
    const gene = tku.user.id
    const act = (message: unknown) => tku.club.handle(gene, message as never)
    // Without the flag nobody opens a table to other clubs, and nobody uses the lobby
    expect(tku.club.publicViewer(gene)).toBe(false)
    await act({ type: 'createTable', settings: { openToClubs: true } })
    expect(tku.sockets.errors).toEqual(['publicLobbyOff'])
    expect(tku.club.publicTables()).toEqual([])

    await tku.club.adminSetFeature({ flag: 'publicLobby', state: 'on', usernames: [] })
    expect(tku.club.publicViewer(gene)).toBe(true)
    // A table not opened to other clubs is not listed
    await act({ type: 'createTable', settings: {} })
    expect(tku.club.publicTables()).toEqual([])
    await act({ type: 'updateTableSettings', settings: { openToClubs: true } })
    const [listed] = tku.club.publicTables()
    expect(listed).toMatchObject({ clubId: 'tku', clubName: '淡江橋藝社', seats: { S: { username: 'gene', online: true }, N: null } })
    await act({ type: 'chat', text: 'secret plan' })
    const watched = await tku.club.guestTable(listed.tableId)
    expect(watched).toMatchObject({ clubId: 'tku', tableId: listed.tableId, board: null })
    const shown = JSON.stringify([listed, watched])
    expect(shown).not.toContain(gene)
    expect(shown).not.toContain('secret plan')
    expect(watched).not.toHaveProperty('chat')
    expect(watched).not.toHaveProperty('spectators')

    // No longer public, or no longer watchable: not shown
    await act({ type: 'updateTableSettings', settings: { access: 'hidden' } })
    expect(tku.club.publicTables()).toEqual([])
    expect(await tku.club.guestTable(listed.tableId)).toBeNull()
    await act({ type: 'updateTableSettings', settings: { access: 'public', allowKibitz: false } })
    expect(await tku.club.guestTable(listed.tableId)).toBeNull()
    await act({ type: 'updateTableSettings', settings: { allowKibitz: true } })
    expect(tku.club.publicTables()).toHaveLength(1)
    // The club leaving the lobby takes its tables out at once
    await tku.club.adminSetFeature({ flag: 'publicLobby', state: 'off', usernames: [] })
    expect(tku.club.publicTables()).toEqual([])
    expect(await tku.club.guestTable(listed.tableId)).toBeNull()
    expect(tku.sockets.errors).toEqual(['publicLobbyOff'])
  })

  it('shows a guest the board as any spectator sees it once it is dealt', async () => {
    const tku = await makeClub('tku', 'gene')
    const gene = tku.user.id
    await tku.club.adminSetFeature({ flag: 'publicLobby', state: 'on', usernames: [] })
    await tku.club.handle(gene, { type: 'createTable', settings: { openToClubs: true } } as never)
    const [listed] = tku.club.publicTables()
    for (const seat of ['N', 'E', 'W']) await tku.club.handle(gene, { type: 'addRobot', seat } as never)
    const watched = await tku.club.guestTable(listed.tableId)
    expect(watched?.board).not.toBeNull()
    // All four hands, as kibitzers see them
    expect(Object.values(watched!.board!.hands).every((hand) => hand && hand.length === 13)).toBe(true)
    expect(watched!.seats.N).toMatchObject({ robot: true })
  })
})

describe('the Worker answers the cross-club lobby from every club, for a member whose club joined it', () => {
  const table = (clubId: string, tableId: string) => ({
    clubId,
    clubName: clubId,
    tableId,
    number: 1,
    seats: { N: null, E: null, S: { username: 'x', online: true }, W: null },
    boardsPlayed: 0,
    playing: false,
  })
  let viewers: Record<string, boolean>
  let routes: Routes
  beforeEach(() => {
    viewers = { tku: true, ntu: true, cyc: false }
    routes = {
      clubs: ['tku', 'ntu', 'cyc'],
      club: (clubId) => ({
        fetch: async () => new Response(clubId),
        socketUser: async (token) => (token === `${clubId}-token` ? 'u1' : null),
        publicViewer: async () => viewers[clubId],
        publicTables: async () => (clubId === 'cyc' ? [] : [table(clubId, 't1')]),
        guestTable: async (tableId) => (tableId === 't1' ? { ...table(clubId, 't1'), board: null } : null),
      }),
      table: () => ({ fetch: async () => new Response('table') }),
      assets: { fetch: async () => new Response('assets') },
    }
  })
  const get = (path: string, club: string, cookie = club === 'tku' ? 'tbt_session=tku-token' : `tbt_session_${club}=${club}-token`) =>
    route(new Request(`https://example.org${path}`, { headers: { 'X-Club-Id': club, Cookie: cookie } }), routes)

  it('lists the other clubs’ tables, not the viewer’s own', async () => {
    const lobby = (await (await get('/api/public/lobby', 'ntu')).json()) as { tables: { clubId: string }[] }
    expect(lobby.tables.map((t) => t.clubId)).toEqual(['tku'])
    const fromTku = (await (await get('/api/public/lobby', 'tku')).json()) as { tables: { clubId: string }[] }
    expect(fromTku.tables.map((t) => t.clubId)).toEqual(['ntu'])
  })

  it('shows one table of another club, and nothing for the viewer’s own club or a club no one knows', async () => {
    expect(await (await get('/api/public/tables/tku/t1', 'ntu')).json()).toMatchObject({ table: { clubId: 'tku', tableId: 't1' } })
    expect(await (await get('/api/public/tables/tku/t2', 'ntu')).json()).toMatchObject({ code: 'tableGone' })
    expect((await get('/api/public/tables/ntu/t1', 'ntu')).status).toBe(404)
    expect(await (await get('/api/public/tables/xyz/t1', 'ntu')).json()).toMatchObject({ code: 'unknownClub' })
  })

  it('turns away the signed-out, a member whose club did not join, and anything but GET', async () => {
    expect(await (await get('/api/public/lobby', 'ntu', '')).json()).toMatchObject({ code: 'signInFirst' })
    // 淡江's cookie is nobody at the other club
    expect((await get('/api/public/lobby', 'ntu', 'tbt_session=ntu-token')).status).toBe(401)
    expect(await (await get('/api/public/lobby', 'cyc')).json()).toMatchObject({ code: 'publicLobbyOff' })
    const post = await route(
      new Request('https://example.org/api/public/lobby', { method: 'POST', headers: { Cookie: 'tbt_session=tku-token' } }),
      routes,
    )
    expect(post.status).toBe(404)
  })
})
