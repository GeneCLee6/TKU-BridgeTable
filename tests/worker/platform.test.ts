// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { ClubStatus, ClubUsage } from '../../shared/platform.ts'
import type { Me, ServerMessage } from '../../shared/protocol.ts'
import { AuditLog } from '../../worker/audit.ts'
import { planRestore, type Backup } from '../../worker/backup.ts'
import { ClubRegistryCache } from '../../worker/clubs.ts'
import { ClubError } from '../../worker/errors.ts'
import type { MailMessage } from '../../worker/mail.ts'
import { CLUB_APPLICATIONS_PER_ADDRESS, PlatformService, requireApplyClub, requirePlatformOwner, type ClubDirectory } from '../../worker/platform.ts'
import { notificationLink } from '../../shared/notification-link.ts'
import { PUSH_GROUPS } from '../../shared/push.ts'
import { pushMessage } from '../../shared/push-texts.ts'
import { RegistrationLimit } from '../../worker/register-limit.ts'
import { route, type Routes } from '../../worker/routing.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

/**
 * The platform (e12-t05, e12-t06; worker/platform.ts): who the owner is, applying for a club,
 * approving it (the applicant becomes its first admin), suspending it, and the registry the
 * Worker routes by. The clubs are real `ClubService`s; their objects are faked by a directory
 */

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error instanceof ClubError ? error.code : String(error)
  }
  return 'no error'
}

class Sockets implements Connections {
  readonly online = new Set<string>()
  onlineUserIds() {
    return [...this.online]
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect(userId: string) {
    this.online.delete(userId)
  }
}

async function makeClub(clubId: string) {
  const sockets = new Sockets()
  const club = new ClubService(memoryStore(), sockets, { clubId, maxUsers: 10, schedule: () => {} })
  await club.load()
  return { club, sockets }
}

const good = {
  clubId: 'ntu',
  name: '臺大橋藝社',
  organisation: '國立臺灣大學',
  contactEmail: 'Officer@Example.org',
  reason: '我們社團每週練習，想要有自己的線上牌桌。',
  username: 'ntuhead',
  password: 'river-bridge-77',
}

let store: MemoryStore
let clubs: Map<string, Awaited<ReturnType<typeof makeClub>>>
let statuses: Map<string, ClubStatus>
let mails: MailMessage[]
let platform: PlatformService
let audit: AuditLog
let usageFails: Set<string>
const owner = { id: 'owner1', username: 'gene', admin: true, permissions: [], twoFactor: { enabled: true, recoveryLeft: 8 } } as unknown as Me

function newPlatform(extra: Partial<ConstructorParameters<typeof PlatformService>[1]> = {}) {
  const directory: ClubDirectory = {
    provision: async (id, setup) => {
      const made = clubs.get(id) ?? (await makeClub(id))
      clubs.set(id, made)
      await made.club.provisionFounder(setup.username, setup.passwordHash)
      statuses.set(id, 'active')
    },
    setStatus: async (id, status) => {
      statuses.set(id, status)
      if (status === 'suspended') await clubs.get(id)!.club.endEverySession()
    },
    usage: async (id): Promise<ClubUsage> => {
      if (usageFails.has(id)) throw new Error('no answer')
      const counts = clubs.get(id)?.club.platformCounts() ?? { members: 0, admins: [], tables: 0, boards: 0 }
      return { ...counts, storageBytes: 100, filesBytes: 10, backupBytes: 5, historyRows: id === 'tku' ? 3 : null }
    },
  }
  return new PlatformService(store, {
    now: () => 1_000,
    newId: (() => {
      let n = 0
      return () => `a${++n}`
    })(),
    audit,
    clubs: directory,
    limit: new RegistrationLimit(store, () => 1_000, null, { key: 'meta:clubApplications', label: 'clubApply', max: CLUB_APPLICATIONS_PER_ADDRESS }),
    mailer: { send: async (m) => void mails.push(m) },
    ...extra,
  })
}

beforeEach(async () => {
  store = new MemoryStore()
  clubs = new Map([['tku', await makeClub('tku')]])
  statuses = new Map()
  mails = []
  usageFails = new Set()
  audit = new AuditLog(store, () => 1_000)
  platform = newPlatform()
})

describe('the platform owner', () => {
  const me = (patch: Partial<Me> = {}) => ({ ...owner, ...patch }) as Me

  it('is only the 淡江 account PLATFORM_OWNER names, and the back office is not there for anyone else', () => {
    const notThere = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return error instanceof ClubError ? `${error.code} ${error.status}` : String(error)
      }
      return 'no error'
    }
    expect(requirePlatformOwner(me(), 'owner1', 'tku').id).toBe('owner1')
    expect(notThere(() => requirePlatformOwner(me(), undefined, 'tku'))).toBe('noSuchApi 404')
    expect(notThere(() => requirePlatformOwner(me(), '', 'tku'))).toBe('noSuchApi 404')
    expect(notThere(() => requirePlatformOwner(me({ id: 'someone' }), 'owner1', 'tku'))).toBe('noSuchApi 404')
    expect(notThere(() => requirePlatformOwner(null, 'owner1', 'tku'))).toBe('noSuchApi 404')
    // The same user id in another club is someone else
    expect(notThere(() => requirePlatformOwner(me(), 'owner1', 'ntu'))).toBe('noSuchApi 404')
    // The owner without two-step sign-in, or without the admin role, hears why
    expect(notThere(() => requirePlatformOwner(me({ twoFactor: { enabled: false, recoveryLeft: 0 } }), 'owner1', 'tku'))).toBe('platformNeedsTwoFactor 403')
    expect(notThere(() => requirePlatformOwner(me({ twoFactor: undefined }), 'owner1', 'tku'))).toBe('platformNeedsTwoFactor 403')
    expect(notThere(() => requirePlatformOwner(me({ admin: false }), 'owner1', 'tku'))).toBe('platformNeedsTwoFactor 403')
  })

  it('is told so on /api/me, in 淡江 only', async () => {
    const store2 = memoryStore()
    const a = new ClubService(store2, new Sockets(), { maxUsers: 10, schedule: () => {} })
    await a.load()
    const made = await a.register('gene', 'club-secret-1', '')
    if (!('token' in made)) throw new Error('the first account of 淡江 signs in at once')
    expect(made.user.platformOwner).toBeUndefined()
    const b =new ClubService(store2, new Sockets(), { maxUsers: 10, schedule: () => {}, platformOwnerId: made.user.id })
    await b.load()
    expect((await b.userForToken(made.token))?.platformOwner).toBe(true)
    const c = new ClubService(store2, new Sockets(), { clubId: 'ntu', maxUsers: 10, schedule: () => {}, platformOwnerId: made.user.id })
    await c.load()
    expect((await c.userForToken(made.token))?.platformOwner).toBeUndefined()
  })
})

describe('registering first', () => {
  it('makes the admin only in 淡江: another club’s first registrant waits like everyone else', async () => {
    const { club: ntu } = await makeClub('ntu')
    const result = await ntu.register('eager', 'club-secret-1', '')
    expect(result).toEqual({ pending: true, username: 'eager' })
    expect(ntu.memberDirectory()).toEqual([])
    const { club: tku } = await makeClub('tku')
    const first = await tku.register('gene', 'club-secret-1', '')
    expect('user' in first && first.user.admin).toBe(true)
  })

  it('never provisions a founder in 淡江, and a club with an admin keeps it', async () => {
    const { club: tku } = await makeClub('tku')
    expect(await code(tku.provisionFounder('x', 'hash'))).toBe('noPermission')
    const { club: ntu } = await makeClub('ntu')
    const first = await ntu.provisionFounder('head', 'hash-1')
    const again = await ntu.provisionFounder('someone', 'hash-2')
    expect(again.id).toBe(first.id)
    expect(ntu.memberDirectory().map((m) => m.username)).toEqual(['head'])
  })
})

describe('applying for a club (e12-t06)', () => {
  it('keeps a valid application with the password’s hash only, and mails the applicant', async () => {
    const { id, clubId } = await platform.apply({ ...good, clubId: ' NTU ', lang: 'en' }, '1.2.3.4')
    expect(clubId).toBe('ntu')
    const stored = await store.get<Record<string, unknown>>(`platform:apply:${id}`)
    expect(stored).toMatchObject({ clubId: 'ntu', contactEmail: 'officer@example.org', status: 'pending', username: 'ntuhead' })
    expect(String(stored?.passwordHash)).not.toContain(good.password)
    expect(JSON.stringify(stored)).not.toContain(good.password)
    expect(mails).toHaveLength(1)
    expect(mails[0]).toMatchObject({ to: 'officer@example.org' })
    expect(mails[0].subject).toContain('臺大橋藝社')
    // The back office never shows the hash
    const view = await platform.view()
    expect(JSON.stringify(view.applications)).not.toContain('passwordHash')
    expect(view.applications[0]).toMatchObject({ id, status: 'pending' })
  })

  it('checks every field', async () => {
    const apply = (patch: Record<string, unknown>) => code(platform.apply({ ...good, ...patch }, ''))
    expect(await apply({ clubId: '1abc' })).toBe('badClubId')
    expect(await apply({ clubId: 'a' })).toBe('badClubId')
    expect(await apply({ clubId: 'has space' })).toBe('badClubId')
    expect(await apply({ clubId: 'tku' })).toBe('clubIdReserved')
    expect(await apply({ clubId: 'platform' })).toBe('clubIdReserved')
    expect(await apply({ clubId: 'admin' })).toBe('clubIdReserved')
    expect(await apply({ name: 'x' })).toBe('badClubName')
    expect(await apply({ name: 'x'.repeat(41) })).toBe('badClubName')
    expect(await apply({ organisation: '' })).toBe('badOrganisation')
    expect(await apply({ contactEmail: 'not-an-address' })).toBe('badEmail')
    expect(await apply({ reason: 'short' })).toBe('badReason')
    expect(await apply({ username: 'a b' })).toBe('badUsername')
    expect(await apply({ password: 'short' })).toBe('shortPassword')
    expect(await apply({ password: 'ntuhead-is-here' })).toBe('passwordHasUsername')
    expect(await apply({})).toBe('no error')
  })

  it('keeps every id to one club: one waiting, one opened, one the CLUBS override serves', async () => {
    await platform.apply(good, '')
    expect(await code(platform.apply({ ...good, contactEmail: 'b@example.org' }, ''))).toBe('clubIdTaken')
    const [pending] = (await platform.view()).applications
    await platform.approve(owner, pending.id, 'https://example.org')
    expect(await code(platform.apply(good, ''))).toBe('clubIdTaken')
    const withOverride = newPlatform({ extraClubs: ['demo'] })
    expect(await code(withOverride.apply({ ...good, clubId: 'demo' }, ''))).toBe('clubIdTaken')
  })

  it('limits applications per address, and how many may wait', async () => {
    for (let i = 0; i < CLUB_APPLICATIONS_PER_ADDRESS; i++) await platform.apply({ ...good, clubId: `club-${i}` }, '5.6.7.8')
    expect(await code(platform.apply({ ...good, clubId: 'one-more' }, '5.6.7.8'))).toBe('tooManyClubApplications')
    // Another address may still apply
    expect(await code(platform.apply({ ...good, clubId: 'one-more' }, '9.9.9.9'))).toBe('no error')
    for (let i = 0; i < 46; i++) await platform.apply({ ...good, clubId: `many-${i}` }, '')
    expect(await code(platform.apply({ ...good, clubId: 'too-many' }, ''))).toBe('clubApplicationsFull')
  })

  it('works without mail, and when the mail provider fails', async () => {
    const quiet = newPlatform({ mailer: undefined })
    expect(await code(quiet.apply(good, ''))).toBe('no error')
    const failing = newPlatform({
      mailer: {
        send: async () => {
          throw new Error('Resend answered 500')
        },
      },
    })
    expect(await code(failing.apply({ ...good, clubId: 'other' }, ''))).toBe('no error')
  })

  it('tells the platform owner in 淡江’s bell, leading to the back office; nobody without an owner', async () => {
    const tku = clubs.get('tku')!.club
    const told = newPlatform({ notifyOwner: (params) => tku.notifications.notify('owner1', 'clubApplication', params) })
    await told.apply(good, '1.2.3.4')
    const { items, unread } = await tku.notifications.view('owner1')
    expect(unread).toBe(1)
    expect(items[0]).toMatchObject({ kind: 'clubApplication', params: { clubId: 'ntu', name: '臺大橋藝社' } })
    expect(notificationLink(items[0])).toBe('/platform')
    expect(pushMessage(items[0], 'zh').body).toBe('有新的建社申請：「臺大橋藝社」，到平台後台審核')
    // The owner's own push group, shown to them alone ("My account")
    expect(PUSH_GROUPS.platform).toEqual(['clubApplication'])
    // A refused application tells nobody
    expect(await code(told.apply({ ...good, clubId: 'ntu' }, '1.2.3.4'))).toBe('clubIdTaken')
    expect((await tku.notifications.view('owner1')).items).toHaveLength(1)
    // No owner (PLATFORM_OWNER unset): no notification at all, and the application stands when telling fails
    expect(await code(platform.apply({ ...good, clubId: 'nccu' }, ''))).toBe('no error')
    expect((await tku.notifications.view('owner1')).items).toHaveLength(1)
    const failing = newPlatform({
      notifyOwner: async () => {
        throw new Error('store failed')
      },
    })
    expect(await code(failing.apply({ ...good, clubId: 'nthu' }, ''))).toBe('no error')
  })

  it('is 淡江’s alone: another club’s object refuses it', () => {
    expect(() => requireApplyClub('tku')).not.toThrow()
    try {
      requireApplyClub('ntu')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ClubError)
      expect((error as ClubError).code).toBe('clubApplyElsewhere')
      expect((error as ClubError).status).toBe(404)
    }
  })
})

describe('the back office (e12-t05)', () => {
  it('approves: the club opens with the applicant as its first admin, and the registry serves it', async () => {
    const { id } = await platform.apply(good, '')
    mails = []
    const view = await platform.approve(owner, id, 'https://example.org')
    expect(await platform.registry()).toEqual([{ id: 'ntu', status: 'active' }])
    const ntu = clubs.get('ntu')!.club
    const signedIn = await ntu.login('ntuhead', good.password, '', '')
    expect(signedIn.user).toMatchObject({ admin: true, clubId: 'ntu', username: 'ntuhead' })
    // Isolation still holds: the new admin is nobody in 淡江
    expect(await code(clubs.get('tku')!.club.login('ntuhead', good.password, '', ''))).toBe('badLogin')
    expect(await clubs.get('tku')!.club.userForToken(signedIn.token)).toBeNull()
    // The application is decided, without its hash; the club is listed with its admins
    expect(JSON.stringify(await store.get(`platform:apply:${id}`))).not.toContain('passwordHash')
    expect(view.applications[0]).toMatchObject({ status: 'approved', decidedAt: 1_000 })
    const listed = view.clubs.find((c) => c.id === 'ntu')!
    expect(listed).toMatchObject({ name: '臺大橋藝社', status: 'active', approvedAt: 1_000 })
    expect(listed.usage?.admins.map((a) => a.username)).toEqual(['ntuhead'])
    expect(view.clubs[0]).toMatchObject({ id: 'tku', status: 'active' })
    expect(view.totals.historyRows).toBe(3)
    // Audited, and the applicant hears how to sign in
    expect((await audit.list())[0]).toMatchObject({ by: 'gene', action: 'platform:approve', target: 'ntu' })
    expect(mails[0].text).toContain('https://example.org/c/ntu')
    // Deciding again changes nothing
    expect(await code(platform.approve(owner, id, 'https://example.org'))).toBe('clubApplicationDecided')
    expect(await code(platform.reject(owner, id, ''))).toBe('clubApplicationDecided')
    expect(await code(platform.approve(owner, 'nope', ''))).toBe('noSuchClubApplication')
  })

  it('leaves nothing written when the club’s object fails, so approving again works', async () => {
    const { id } = await platform.apply(good, '')
    const broken = newPlatform({
      clubs: {
        provision: async () => {
          throw new Error('object unreachable')
        },
        setStatus: async () => {},
        usage: async () => {
          throw new Error('no')
        },
      },
    })
    expect(await code(broken.approve(owner, id, ''))).toBe('Error: object unreachable')
    expect(await platform.registry()).toEqual([])
    await platform.approve(owner, id, '')
    expect(await platform.registry()).toEqual([{ id: 'ntu', status: 'active' }])
  })

  it('rejects: the hash goes, the applicant hears why, the id is free again', async () => {
    const { id } = await platform.apply(good, '')
    mails = []
    const view = await platform.reject(owner, id, '資料不完整')
    expect(view.applications[0]).toMatchObject({ status: 'rejected', note: '資料不完整' })
    expect(JSON.stringify(await store.get(`platform:apply:${id}`))).not.toContain('passwordHash')
    expect(mails[0].text).toContain('資料不完整')
    expect((await audit.list())[0]).toMatchObject({ action: 'platform:reject', target: 'ntu', note: '資料不完整' })
    expect(await platform.registry()).toEqual([])
    expect(await code(platform.apply(good, ''))).toBe('no error')
  })

  it('suspends a club: every session ends, the data stays; and serves it again', async () => {
    const { id } = await platform.apply(good, '')
    await platform.approve(owner, id, '')
    const ntu = clubs.get('ntu')!
    const { token, user } = await ntu.club.login('ntuhead', good.password, '', '')
    ntu.sockets.online.add(user.id)
    await platform.setStatus(owner, 'ntu', 'suspended', '未繳費')
    expect(await platform.registry()).toEqual([{ id: 'ntu', status: 'suspended' }])
    expect(statuses.get('ntu')).toBe('suspended')
    expect(await ntu.club.userForToken(token)).toBeNull()
    expect(ntu.sockets.online.size).toBe(0)
    expect(ntu.club.memberDirectory().map((m) => m.username)).toEqual(['ntuhead'])
    expect((await audit.list())[0]).toMatchObject({ action: 'platform:suspend', target: 'ntu', note: '未繳費' })
    // The same status again is nothing new
    const entries = (await audit.list()).length
    await platform.setStatus(owner, 'ntu', 'suspended', '')
    expect((await audit.list()).length).toBe(entries)
    await platform.setStatus(owner, 'ntu', 'active', '')
    expect(await platform.registry()).toEqual([{ id: 'ntu', status: 'active' }])
    expect((await audit.list())[0]).toMatchObject({ action: 'platform:unsuspend', target: 'ntu' })
    expect((await ntu.club.login('ntuhead', good.password, '', '')).user.admin).toBe(true)
  })

  it('never suspends 淡江, nor a club it never opened', async () => {
    expect(await code(platform.setStatus(owner, 'tku', 'suspended', ''))).toBe('cannotSuspendDefaultClub')
    expect(await code(platform.setStatus(owner, 'nobody', 'suspended', ''))).toBe('unknownClub')
    expect(await code(platform.setStatus(owner, 'ntu', 'gone', ''))).toBe('badMessage')
  })

  it('lists a club whose object does not answer, without its usage', async () => {
    usageFails.add('tku')
    const view = await platform.view()
    expect(view.clubs[0]).toMatchObject({ id: 'tku', usage: null })
    expect(view.totals.members).toBe(0)
  })
})

describe('the registry the Worker routes by', () => {
  it('is read once per TTL and only for other clubs, keeps the last copy when 淡江 fails', async () => {
    let now = 0
    let reads = 0
    let fail = false
    const cache = new ClubRegistryCache(
      async () => {
        reads++
        if (fail) throw new Error('down')
        return [{ id: 'ntu', status: 'active' }]
      },
      () => now,
      1_000,
    )
    expect(await cache.status('tku')).toBeNull()
    expect(await cache.status('Bad Id')).toBeNull()
    expect(reads).toBe(0)
    expect(await cache.status('ntu')).toBe('active')
    expect(await cache.status('nobody')).toBeNull()
    expect(reads).toBe(1)
    now = 2_000
    fail = true
    expect(await cache.status('ntu')).toBe('active')
    expect(reads).toBe(2)
    fail = false
    cache.forget()
    expect(await cache.ids()).toEqual(['ntu'])
    expect(reads).toBe(3)
  })

  it('routes an opened club to its object, turns a suspended one away, never asks for 淡江', async () => {
    const seen: string[] = []
    const asked: string[] = []
    const registry = new Map<string, ClubStatus>([
      ['ntu', 'active'],
      ['nccu', 'suspended'],
    ])
    const routes: Routes = {
      club: (clubId) => ({
        fetch: async () => (seen.push(clubId), new Response(clubId)),
        socketUser: async () => 'amy',
      }),
      table: (clubId, tableId) => ({ fetch: async () => (seen.push(`${clubId}/${tableId}`), new Response('table')) }),
      assets: { fetch: async () => (seen.push('assets'), new Response('app')) },
      findClub: async (id) => (asked.push(id), registry.get(id) ?? null),
    }
    const at = (path: string, club?: string, headers: Record<string, string> = {}) =>
      route(new Request(`https://example.org${path}`, { headers: { ...(club && { 'X-Club-Id': club }), ...headers } }), routes)
    await at('/api/me')
    await at('/api/me', 'tku')
    expect(asked).toEqual([])
    expect((await at('/api/me', 'ntu')).status).toBe(200)
    expect(seen).toEqual(['tku', 'tku', 'ntu'])
    const unknown = await at('/api/me', 'nobody')
    expect(unknown.status).toBe(404)
    expect(await unknown.json()).toMatchObject({ code: 'unknownClub' })
    const suspended = await at('/api/me', 'nccu')
    expect(suspended.status).toBe(403)
    expect(await suspended.json()).toMatchObject({ code: 'clubSuspended' })
    expect((await at('/ws?club=nccu', undefined, { Upgrade: 'websocket' })).status).toBe(403)
    expect((await at('/ws/table/abc123?club=nccu', undefined, { Upgrade: 'websocket' })).status).toBe(403)
    // The app itself still loads, to show the error
    expect((await at('/', 'nccu')).status).toBe(200)
    expect(seen.filter((s) => s.startsWith('nccu'))).toEqual([])
    // Club applications reach 淡江's object whichever club the page names, even an unknown or suspended one
    seen.length = 0
    asked.length = 0
    for (const club of ['ntu', 'nccu', 'nobody', undefined]) expect((await at('/api/clubs/apply', club)).status).toBe(200)
    expect((await at('/api/clubs/apply?club=ntu')).status).toBe(200)
    expect(seen).toEqual(['tku', 'tku', 'tku', 'tku', 'tku'])
    expect(asked).toEqual([])
  })
})

describe('a restore', () => {
  it('neither writes nor deletes the platform’s keys', () => {
    const backup = {
      header: { prefixes: ['user:', 'platform:'] },
      entries: [
        ['user:a', { id: 'a' }],
        ['platform:club:old', { id: 'old' }],
      ],
    } as unknown as Backup
    const plan = planRestore(backup, [
      ['user:b', { id: 'b' }],
      ['platform:club:new', { id: 'new' }],
    ])
    expect(plan.puts.map(([k]) => k)).toEqual(['user:a'])
    expect(plan.deletes).toEqual(['user:b'])
  })
})
