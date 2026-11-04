// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { ServerMessage } from '../../shared/protocol.ts'
import type { PushMessage } from '../../shared/push-texts.ts'
import { pushDeviceId } from '../../shared/push.ts'
import { hashPassword } from '../../worker/auth.ts'
import { clubManifest, manifestClub } from '../../worker/manifest.ts'
import { route, type Routes } from '../../worker/routing.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { base64url, type PushSender, type PushTarget } from '../../worker/web-push.ts'
import { memoryStore } from './sqlite.ts'

/**
 * Each club's home-screen app and pushes (ARCHITECTURE.md §1「加入主畫面」, §5.4「每個社團各自訂閱」):
 * another club's pages link a manifest that opens that club; one browser's subscription may be
 * registered with several clubs, each keeping its own, and each club's pushes open its own pages.
 */

const STATIC_MANIFEST = {
  name: 'TKU BridgeTable 淡江牌桌',
  short_name: '淡江牌桌',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  theme_color: '#0f3d7a',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }],
}

function routes(more: Partial<Routes> = {}): Routes & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    clubs: ['tku', 'ntu'],
    club: (clubId) => ({
      fetch: async () => new Response(clubId),
      socketUser: async () => null,
      clubName: async () => (asked.push(clubId), clubId === 'ntu' ? '臺大橋藝社' : '淡江橋藝社'),
    }),
    table: () => ({ fetch: async () => new Response('table') }),
    assets: {
      fetch: async (request) =>
        new URL(request.url).pathname === '/manifest.webmanifest'
          ? new Response(JSON.stringify(STATIC_MANIFEST), { headers: { 'Content-Type': 'application/manifest+json' } })
          : new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }),
    },
    ...more,
  }
}

const get = (path: string, r: Routes) => route(new Request(`https://example.org${path}`), r)

describe('a home-screen app per club', () => {
  it('reads the club from the manifest’s path, nothing else', () => {
    expect(manifestClub('/c/ntu/manifest.webmanifest')).toBe('ntu')
    expect(manifestClub('/manifest.webmanifest')).toBeNull()
    expect(manifestClub('/c/ntu/table/manifest.webmanifest')).toBeNull()
    expect(manifestClub('/c/NTU/manifest.webmanifest')).toBeNull()
  })

  it('serves another club’s manifest: 淡江’s icons and colours, the club’s name, opening and staying in /c/<id>/', async () => {
    const r = routes()
    const answer = await get('/c/ntu/manifest.webmanifest', r)
    expect(answer.status).toBe(200)
    expect(answer.headers.get('Content-Type')).toMatch(/^application\/manifest\+json/)
    expect(await answer.json()).toEqual({
      ...STATIC_MANIFEST,
      name: '臺大橋藝社・TKU BridgeTable',
      short_name: '臺大橋藝社',
      description: '臺大橋藝社的線上牌桌',
      id: '/c/ntu/',
      start_url: '/c/ntu/',
      scope: '/c/ntu/',
    })
    expect(r.asked).toEqual(['ntu'])
  })

  it('gives 淡江’s own manifest for /c/tku/, unchanged', async () => {
    const r = routes()
    expect(await (await get('/c/tku/manifest.webmanifest', r)).json()).toEqual(STATIC_MANIFEST)
    expect(r.asked).toEqual([])
  })

  it('answers 404 for a club no one knows and 403 for a suspended one, without asking any club', async () => {
    const r = routes({ findClub: async (id) => (id === 'nccu' ? 'suspended' : id === 'nthu' ? 'active' : null) })
    const unknown = await get('/c/nowhere/manifest.webmanifest', r)
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'unknownClub' })
    expect((await get('/c/nccu/manifest.webmanifest', r)).status).toBe(403)
    // A club the platform opened is served like the others
    expect(await (await get('/c/nthu/manifest.webmanifest', r)).json()).toMatchObject({ start_url: '/c/nthu/' })
    expect(r.asked).toEqual(['nthu'])
  })

  it('keeps the club’s id as its name when the club cannot say', async () => {
    expect(clubManifest(STATIC_MANIFEST, 'ntu', 'ntu')).toMatchObject({ short_name: 'ntu', scope: '/c/ntu/' })
  })
})

/** A push service that records what it got */
class FakePush implements PushSender {
  readonly publicKey = 'BPublicKey'
  sent: { endpoint: string; message: PushMessage }[] = []
  async send(target: PushTarget, message: string) {
    this.sent.push({ endpoint: target.endpoint, message: JSON.parse(message) })
    return { status: 201 }
  }
}

const nobody: Connections = { onlineUserIds: () => [], send: (_u: string, _m: ServerMessage) => undefined, disconnect: () => undefined }

async function openClub(clubId: string, sender: FakePush) {
  const club = new ClubService(memoryStore(), nobody, { clubId, maxUsers: 10, now: () => 1_700_000_000_000, schedule: () => {}, push: sender })
  await club.load()
  if (clubId !== 'tku') await club.provisionFounder('amy', await hashPassword('club-secret-1'))
  const first = clubId === 'tku' ? await club.register('amy', 'club-secret-1', '') : await club.login('amy', 'club-secret-1', '', '')
  if (!('token' in first)) throw new Error('the first account should sign in at once')
  return { club, userId: first.user.id }
}

async function subscription() {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair
  const p256dh = base64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))
  return { endpoint: 'https://fcm.googleapis.com/fcm/send/one-browser', keys: { p256dh, auth: base64url(crypto.getRandomValues(new Uint8Array(16))) } }
}

const CHROME = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'

describe('push subscriptions per club', () => {
  it('registers one browser with two clubs; removing it from one leaves the other’s, whose pushes open its own pages', async () => {
    const sender = new FakePush()
    const tku = await openClub('tku', sender)
    const ntu = await openClub('ntu', sender)
    const sub = await subscription()
    const id = await pushDeviceId(sub.endpoint)
    await tku.club.push.subscribe(tku.userId, sub, CHROME)
    await ntu.club.push.subscribe(ntu.userId, sub, CHROME)
    expect((await tku.club.push.view(tku.userId)).devices.map((d) => d.id)).toEqual([id])
    expect((await ntu.club.push.view(ntu.userId)).devices.map((d) => d.id)).toEqual([id])

    // Signed out of ntu on this browser: ntu forgets it, 淡江 still has it
    await ntu.club.push.unsubscribe(ntu.userId, id)
    expect((await ntu.club.push.view(ntu.userId)).devices).toEqual([])
    expect((await tku.club.push.view(tku.userId)).devices.map((d) => d.id)).toEqual([id])

    // Each club's push opens its own pages
    await ntu.club.push.subscribe(ntu.userId, sub, CHROME)
    await tku.club.notifications.notify(tku.userId, 'tableInvited', { tableId: 't1', number: 1, username: 'ben' })
    await ntu.club.notifications.notify(ntu.userId, 'tableInvited', { tableId: 't1', number: 1, username: 'ben' })
    await tku.club.push.idle()
    await ntu.club.push.idle()
    expect(sender.sent.map((s) => s.message.url).sort()).toEqual(['/c/ntu/table/t1', '/table/t1'])
  })
})
