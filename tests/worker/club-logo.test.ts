// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { applicationLogoUrl, clubLogoUrl, inspectLogo, LOGO_BURST, LOGO_MAX_BYTES, logoProblem } from '../../shared/club-logo.ts'
import type { ClubStatus, ClubUsage } from '../../shared/platform.ts'
import type { Me, ServerMessage } from '../../shared/protocol.ts'
import { AuditLog } from '../../worker/audit.ts'
import { hashPassword } from '../../worker/auth.ts'
import { ACTIVITY_PREFIXES, BACKUP_PREFIXES } from '../../worker/backup.ts'
import { ClubError } from '../../worker/errors.ts'
import { LOGO_CHECK_CACHE, LOGO_KEY, LOGO_LONG_CACHE, logoFromBase64, logoResponse, readLogoUpload } from '../../worker/logos.ts'
import { clubManifest } from '../../worker/manifest.ts'
import { CLUB_APPLICATIONS_PER_ADDRESS, PlatformService, type ClubDirectory, type ClubSetup } from '../../worker/platform.ts'
import { RegistrationLimit } from '../../worker/register-limit.ts'
import { route, type Routes } from '../../worker/routing.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'
import { adminWithTwoFactor } from './admin-two-factor.ts'
import { memoryStore } from './sqlite.ts'

/**
 * A club's logo (AC-12.2, ARCHITECTURE.md §1「社團 Logo」): only plain square pictures are kept,
 * only the club's own admins change it (never 淡江's), anyone may read it, an application may
 * bring one that only the platform owner sees until the club opens with it, and the manifest
 * makes it the club's home-screen icon.
 */

// ── Pictures built byte by byte: just enough structure for the check (no real pixels) ───────────

const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const le32 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]
const be16 = (n: number) => [(n >>> 8) & 255, n & 255]

const pngChunk = (type: string, data: number[] = []) => [...be32(data.length), ...ascii(type), ...data, 0, 0, 0, 0]
function png(side = 512, height = side, extra: number[][] = [], trailing: number[] = []) {
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [...be32(side), ...be32(height), 8, 6, 0, 0, 0]),
    ...extra.flat(),
    ...pngChunk('IDAT', [1, 2, 3, 4, 5]),
    ...pngChunk('IEND'),
    ...trailing,
  ])
}

const riffChunk = (type: string, data: number[]) => [...ascii(type), ...le32(data.length), ...data, ...(data.length % 2 ? [0] : [])]
function webp(chunks: number[][]) {
  const body = [...ascii('WEBP'), ...chunks.flat()]
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body])
}
const vp8l = (w: number, h: number) => riffChunk('VP8L', [0x2f, ...le32((w - 1) | ((h - 1) << 14)), 0, 0, 0])
const vp8 = (w: number, h: number) => riffChunk('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...[w & 255, w >> 8], ...[h & 255, h >> 8], 0, 0])
const vp8x = (w: number, h: number, flags = 0x10) => riffChunk('VP8X', [flags, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)])

const segment = (marker: number, data: number[]) => [0xff, marker, ...be16(data.length + 2), ...data]
function jpeg(side = 512, more: number[][] = [], end = [0xff, 0xd9]) {
  return new Uint8Array([
    0xff, 0xd8,
    ...segment(0xe0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...more.flat(),
    ...segment(0xdb, new Array(65).fill(1)),
    ...segment(0xc0, [8, ...be16(side), ...be16(side), 1, 1, 0x11, 0]),
    ...segment(0xda, [1, 1, 0, 0, 63, 0]),
    7, 7, 7, 7,
    ...end,
  ])
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error instanceof ClubError ? `${error.code} ${error.status}` : String(error)
  }
  return 'no error'
}

describe('the logo’s structure check', () => {
  it('takes square WebP, PNG and JPEG pictures and reads their size', () => {
    expect(inspectLogo(png(512))).toEqual({ type: 'image/png', width: 512, height: 512 })
    expect(inspectLogo(png(256, 256, [pngChunk('sRGB', [0]), pngChunk('pHYs', new Array(9).fill(0))]))).toMatchObject({ width: 256 })
    expect(inspectLogo(webp([vp8l(512, 512)]))).toEqual({ type: 'image/webp', width: 512, height: 512 })
    expect(inspectLogo(webp([vp8(300, 300)]))).toEqual({ type: 'image/webp', width: 300, height: 300 })
    expect(inspectLogo(webp([vp8x(128, 128), riffChunk('ALPH', [0, 1, 2]), vp8(128, 128)]))).toEqual({ type: 'image/webp', width: 128, height: 128 })
    expect(inspectLogo(jpeg(400))).toEqual({ type: 'image/jpeg', width: 400, height: 400 })
    for (const good of [png(512), webp([vp8l(64, 64)]), jpeg(512)]) expect(logoProblem(good)).toBeNull()
  })

  it('refuses anything but picture data: text, EXIF, XMP, comments, bytes after the end', () => {
    const text = pngChunk('tEXt', ascii('Comment\0<script>alert(1)</script>'))
    expect(inspectLogo(png(512, 512, [text]))).toBeNull()
    expect(inspectLogo(png(512, 512, [pngChunk('eXIf', [1, 2, 3])]))).toBeNull()
    expect(inspectLogo(png(512, 512, [], ascii('<html>')))).toBeNull()
    expect(inspectLogo(webp([vp8l(512, 512), riffChunk('EXIF', [1, 2, 3, 4])]))).toBeNull()
    expect(inspectLogo(webp([vp8x(512, 512), riffChunk('XMP ', ascii('<x:xmpmeta/>')), vp8(512, 512)]))).toBeNull()
    // A RIFF size that does not cover the whole file (something appended)
    expect(inspectLogo(new Uint8Array([...webp([vp8l(512, 512)]), ...ascii('zip!')]))).toBeNull()
    // An animation is not a logo
    expect(inspectLogo(webp([vp8x(512, 512, 0x02), vp8(512, 512)]))).toBeNull()
    expect(inspectLogo(jpeg(512, [segment(0xe1, [...ascii('Exif'), 0, 0, 1, 2])]))).toBeNull()
    expect(inspectLogo(jpeg(512, [segment(0xfe, ascii('a comment'))]))).toBeNull()
    expect(inspectLogo(jpeg(512, [], [...ascii('PK'), 0xff, 0xd9, 0]))).toBeNull()
    expect(inspectLogo(jpeg(512, [], []))).toBeNull()
    // Not a picture at all
    expect(inspectLogo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'))).toBeNull()
    expect(inspectLogo(new TextEncoder().encode('GIF89a......'))).toBeNull()
    expect(inspectLogo(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
    expect(inspectLogo(new Uint8Array())).toBeNull()
  })

  it('takes only a square of 64 to 512 pixels, under the size limit', () => {
    expect(logoProblem(png(512, 400))).toBe('logoBadFormat')
    expect(logoProblem(png(1024))).toBe('logoBadFormat')
    expect(logoProblem(png(32))).toBe('logoBadFormat')
    expect(logoProblem(webp([vp8l(600, 600)]))).toBe('logoBadFormat')
    const huge = png(512, 512, [pngChunk('IDAT', new Array(LOGO_MAX_BYTES).fill(0))])
    expect(logoProblem(huge)).toBe('logoTooLarge')
  })

  it('reads an application’s base64 logo, checked, or none', () => {
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
    expect(logoFromBase64(undefined)).toBeUndefined()
    expect(logoFromBase64('')).toBeUndefined()
    expect([...logoFromBase64(b64(png(256)))!]).toEqual([...png(256)])
    const refused = (value: unknown) => {
      try {
        logoFromBase64(value)
      } catch (error) {
        return error instanceof ClubError ? error.code : String(error)
      }
      return 'no error'
    }
    expect(refused(b64(new TextEncoder().encode('<html><script></script></html>')))).toBe('logoBadFormat')
    expect(refused('!!not base64!!')).toBe('logoBadFormat')
    expect(refused({ bytes: [1, 2] })).toBe('logoBadFormat')
    expect(refused('A'.repeat(Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4))).toBe('logoTooLarge')
  })
})

class Sockets implements Connections {
  onlineUserIds() {
    return []
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect() {}
}

let now = 10_000_000_000

/** A club with an admin who may act as one, and a member: 淡江, or a club the platform opened */
async function makeClub(clubId: string) {
  const store = memoryStore()
  const club = new ClubService(store, new Sockets(), { clubId, maxUsers: 10, schedule: () => {}, now: () => now })
  await club.load()
  if (clubId !== 'tku') await club.provisionFounder('boss', await hashPassword('club-secret-1'))
  const first = clubId === 'tku' ? await club.register('boss', 'club-secret-1', '') : await club.login('boss', 'club-secret-1', '', '')
  if (!('user' in first)) throw new Error('the first account should sign in')
  await adminWithTwoFactor(club, first.user.id)
  const member = await club.adminCreateUser('amy', 'club-secret-1')
  return { club, store, admin: first.user.id, member: member.id }
}

const get = (query = '', headers: Record<string, string> = {}) => new Request(`https://example.org/api/logo${query}`, { headers })

describe('a club’s logo, set by its admins', () => {
  beforeEach(() => {
    now = 10_000_000_000
  })

  it('is set and removed by the club’s admin, recorded in its audit trail, and served to anyone', async () => {
    const { club, store, admin } = await makeClub('ntu')
    expect(await code(club.logos.get().then((logo) => logoResponse(logo, get())))).toBe('noLogo 404')
    const set = await club.adminSetLogo(admin, png(512))
    expect(set).toEqual({ version: now, type: 'image/png', size: 512 })
    expect(await club.logos.ref()).toEqual(set)
    expect((await store.get<{ bytes: Uint8Array }>(LOGO_KEY))?.bytes.length).toBe(png(512).length)

    // The current version's address is kept a year; any other is checked each time
    const fresh = logoResponse(await club.logos.get(), get(`?club=ntu&v=${set.version}`))
    expect(fresh.status).toBe(200)
    expect(fresh.headers.get('Content-Type')).toBe('image/png')
    expect(fresh.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(fresh.headers.get('Cache-Control')).toBe(LOGO_LONG_CACHE)
    expect([...new Uint8Array(await fresh.arrayBuffer())]).toEqual([...png(512)])
    expect(logoResponse(await club.logos.get(), get('?club=ntu')).headers.get('Cache-Control')).toBe(LOGO_CHECK_CACHE)
    expect(logoResponse(await club.logos.get(), get('', { 'If-None-Match': `"logo-${set.version}"` })).status).toBe(304)

    // A new picture gets a new version (the address changes, so browsers show it at once)
    now += 1
    const changed = await club.adminSetLogo(admin, webp([vp8l(256, 256)]))
    expect(changed).toMatchObject({ type: 'image/webp', size: 256 })
    expect(changed.version).toBeGreaterThan(set.version)
    await club.adminClearLogo(admin)
    expect(await club.logos.ref()).toBeNull()
    expect(await store.get(LOGO_KEY)).toBeUndefined()
    // Removing none is nothing to record
    await club.adminClearLogo(admin)

    const audit = await new AuditLog(store).list()
    expect(audit.map((e) => `${e.by} ${e.action} ${e.target}`).reverse()).toEqual([
      `boss club:logo ${set.version}`,
      `boss club:logo ${changed.version}`,
      `boss club:logoClear ${changed.version}`,
    ])
  })

  it('is the admins’ alone, and only once they may act as admins', async () => {
    const { club, member } = await makeClub('ntu')
    expect(await code(club.adminSetLogo(member, png(512)))).toBe('adminOnly 403')
    expect(await code(club.adminClearLogo(member))).toBe('adminOnly 403')
    expect(await code(club.adminSetLogo('nobody', png(512)))).toBe('adminOnly 403')
    expect(await club.logos.ref()).toBeNull()
  })

  it('waits for the new club’s admin to turn on two-step sign-in, like every admin action', async () => {
    const club = new ClubService(memoryStore(), new Sockets(), { clubId: 'ntu', maxUsers: 10, schedule: () => {}, now: () => now })
    await club.load()
    const founder = await club.provisionFounder('boss', await hashPassword('club-secret-1'))
    expect(await code(club.adminSetLogo(founder.id, png(512)))).toBe('adminTwoFactorRequired 403')
  })

  it('refuses what is not a plain square picture, too large uploads, and too many changes', async () => {
    const { club, admin } = await makeClub('ntu')
    expect(await code(club.adminSetLogo(admin, new TextEncoder().encode('<svg onload="alert(1)"/>') as Uint8Array<ArrayBuffer>))).toBe('logoBadFormat 415')
    expect(await code(club.adminSetLogo(admin, png(512, 512, [pngChunk('tEXt', ascii('hidden'))])))).toBe('logoBadFormat 415')
    expect(await code(club.adminSetLogo(admin, png(512, 300)))).toBe('logoBadFormat 415')
    expect(await code(club.adminSetLogo(admin, new Uint8Array(LOGO_MAX_BYTES + 1)))).toBe('logoTooLarge 413')
    expect(await club.logos.ref()).toBeNull()
    // The upload itself stops at the limit
    const body = new Uint8Array(LOGO_MAX_BYTES + 10)
    expect(await code(readLogoUpload(new Request('https://example.org/api/admin/logo', { method: 'PUT', body })))).toBe('logoTooLarge 413')
    // Refused uploads used up the burst (5 a club), then one a minute
    for (let i = 4; i < LOGO_BURST; i++) await club.adminSetLogo(admin, png(512))
    expect(await code(club.adminSetLogo(admin, png(512)))).toBe('slowDown 429')
    now += 61_000
    expect(await code(club.adminSetLogo(admin, png(512)))).toBe('no error')
  })

  it('never changes 淡江’s lantern', async () => {
    const { club, admin } = await makeClub('tku')
    expect(await code(club.adminSetLogo(admin, png(512)))).toBe('logoDefaultClub 403')
    expect(await code(club.adminClearLogo(admin))).toBe('logoDefaultClub 403')
    await club.logos.provision(png(512))
    expect(await club.logos.ref()).toBeNull()
  })

  it('stays in its own club: another club’s admin is nobody here, and each club serves its own', async () => {
    const ntu = await makeClub('ntu')
    const nccu = await makeClub('nccu')
    await ntu.club.adminSetLogo(ntu.admin, png(512))
    expect(await nccu.club.logos.ref()).toBeNull()
    // Member ids are only unique within a club: ntu's admin id is no one in nccu
    if (ntu.admin !== nccu.admin) expect(await code(nccu.club.adminSetLogo(ntu.admin, png(256)))).toBe('adminOnly 403')
    expect(await nccu.club.logos.ref()).toBeNull()

    // The Worker sends `/api/logo?club=<id>` to that club's object and no other
    const asked: string[] = []
    const routes: Routes = {
      clubs: ['tku', 'ntu', 'nccu'],
      club: (clubId) => ({
        fetch: async (request) => (asked.push(`${clubId} ${new URL(request.url).pathname}`), new Response(clubId)),
        socketUser: async () => null,
      }),
      table: () => ({ fetch: async () => new Response('table') }),
      assets: { fetch: async () => new Response('page') },
    }
    expect(await (await route(new Request(`https://example.org${clubLogoUrl('ntu', 5)}`), routes)).text()).toBe('ntu')
    expect(await (await route(new Request(`https://example.org${clubLogoUrl('nccu', 5)}`), routes)).text()).toBe('nccu')
    expect(asked).toEqual(['ntu /api/logo', 'nccu /api/logo'])
    // A suspended club's logo is not served either
    const suspended = await route(new Request(`https://example.org${clubLogoUrl('gone', 5)}`), { ...routes, findClub: async () => 'suspended' })
    expect(suspended.status).toBe(403)
  })

  it('takes the logo the club applied with only while it has none', async () => {
    const { club, admin } = await makeClub('ntu')
    await club.logos.provision(png(256))
    expect(await club.logos.ref()).toMatchObject({ size: 256 })
    now += 1
    await club.adminSetLogo(admin, png(512))
    await club.logos.provision(png(128))
    expect(await club.logos.ref()).toMatchObject({ size: 512 })
  })

  it('is in the backup with the activity (restored only where missing); an application’s waits under platform:', () => {
    expect(ACTIVITY_PREFIXES).toContain(LOGO_KEY)
    expect(BACKUP_PREFIXES.some((p) => LOGO_KEY.startsWith(p))).toBe(false)
    expect(BACKUP_PREFIXES.some((p) => 'platform:logo:a1'.startsWith(p))).toBe(true)
  })
})

describe('the logo on the home screen', () => {
  const STATIC = { name: 'Overtrick', icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }] }

  it('is the club’s only icon when it has one; without one the platform’s stay', () => {
    expect(clubManifest(STATIC, 'ntu', '臺大橋藝社', { version: 7, type: 'image/webp', size: 512 }).icons).toEqual([
      { src: '/api/logo?club=ntu&v=7', sizes: '512x512', type: 'image/webp', purpose: 'any' },
    ])
    expect(clubManifest(STATIC, 'ntu', '臺大橋藝社').icons).toEqual(STATIC.icons)
  })

  it('comes from the club’s object with its name', async () => {
    const routes: Routes = {
      clubs: ['tku', 'ntu'],
      club: () => ({
        fetch: async () => new Response('club'),
        socketUser: async () => null,
        clubBrand: async () => ({ name: '臺大橋藝社', logo: { version: 9, type: 'image/png', size: 256 } }),
      }),
      table: () => ({ fetch: async () => new Response('table') }),
      assets: { fetch: async () => new Response(JSON.stringify(STATIC)) },
    }
    const manifest = await (await route(new Request('https://example.org/c/ntu/manifest.webmanifest'), routes)).json()
    expect(manifest).toMatchObject({ short_name: '臺大橋藝社', icons: [{ src: '/api/logo?club=ntu&v=9', sizes: '256x256' }] })
  })
})

describe('an application’s logo', () => {
  const owner = { id: 'owner1', username: 'gene', admin: true } as unknown as Me
  const good = {
    clubId: 'ntu',
    name: '臺大橋藝社',
    organisation: '國立臺灣大學',
    contactEmail: 'officer@example.org',
    reason: '我們社團每週練習，想要有自己的線上牌桌。',
    username: 'ntuhead',
    password: 'river-bridge-77',
  }
  const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
  let store: MemoryStore
  let setups: ClubSetup[]
  let platform: PlatformService

  beforeEach(() => {
    store = new MemoryStore()
    setups = []
    const directory: ClubDirectory = {
      provision: async (_id, setup) => void setups.push(setup),
      setStatus: async (_id: string, _status: ClubStatus) => {},
      usage: async (): Promise<ClubUsage> => ({ members: 1, admins: [], tables: 0, boards: 0, storageBytes: 0, filesBytes: 0, backupBytes: null, historyRows: null, logo: null }),
      forwardedSupport: async () => [],
      setSupportStatus: async () => true,
    }
    let n = 0
    platform = new PlatformService(store, {
      now: () => 1_000,
      newId: () => `a${++n}`,
      audit: new AuditLog(store, () => 1_000),
      clubs: directory,
      limit: new RegistrationLimit(store, () => 1_000, null, { key: 'meta:clubApplications', label: 'clubApply', max: CLUB_APPLICATIONS_PER_ADDRESS }),
    })
  })

  it('waits apart from the application, only the owner sees it, and the club opens with it', async () => {
    const { id } = await platform.apply({ ...good, logo: b64(png(512)) }, '1.2.3.4')
    expect(await store.get(`platform:logo:${id}`)).toBeDefined()
    const view = await platform.view()
    expect(view.applications[0]).toMatchObject({ id, logo: true })
    expect(JSON.stringify(view)).not.toContain(b64(png(512)).slice(0, 20))
    const logo = await platform.applicationLogo(id)
    expect(logo).toMatchObject({ type: 'image/png', size: 512 })
    const answer = logoResponse(logo, new Request(`https://example.org${applicationLogoUrl(id)}`), 'private')
    expect(answer.headers.get('Cache-Control')).toBe('private, no-store')

    await platform.approve(owner, id, 'https://example.org')
    expect([...setups[0].logo!]).toEqual([...png(512)])
    // Gone from 淡江 once the club has it
    expect(await store.get(`platform:logo:${id}`)).toBeUndefined()
    expect(await platform.applicationLogo(id)).toBeUndefined()
    expect((await platform.view()).applications[0].logo).toBeUndefined()
  })

  it('is optional, and goes when the application is rejected', async () => {
    const plain = await platform.apply({ ...good, clubId: 'nccu' }, '1.2.3.4')
    expect(await platform.applicationLogo(plain.id)).toBeUndefined()
    await platform.approve(owner, plain.id, 'https://example.org')
    expect(setups[0].logo).toBeUndefined()

    const { id } = await platform.apply({ ...good, logo: b64(webp([vp8l(256, 256)])) }, '1.2.3.4')
    await platform.reject(owner, id, '名稱不清楚')
    expect(await store.get(`platform:logo:${id}`)).toBeUndefined()
  })

  it('turns a bad logo away before the application is counted against the address', async () => {
    const html = b64(new TextEncoder().encode('<!doctype html><script>alert(1)</script>'))
    expect(await code(platform.apply({ ...good, logo: html }, '1.2.3.4'))).toBe('logoBadFormat 415')
    expect(await code(platform.apply({ ...good, logo: b64(png(512, 512, [], ascii('payload'))) }, '1.2.3.4'))).toBe('logoBadFormat 415')
    expect(await code(platform.apply({ ...good, logo: 'A'.repeat(200_000) }, '1.2.3.4'))).toBe('logoTooLarge 413')
    expect((await platform.view()).applications).toEqual([])
    // Still three good ones from that address this hour
    for (const clubId of ['ntu', 'nccu', 'nthu']) await platform.apply({ ...good, clubId, logo: b64(png(512)) }, '1.2.3.4')
    expect(await code(platform.apply({ ...good, clubId: 'ncku' }, '1.2.3.4'))).toBe('tooManyClubApplications 429')
  })
})
