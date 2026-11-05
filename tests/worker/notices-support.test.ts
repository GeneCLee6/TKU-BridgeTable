// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { noticeDismissKey, NOTICE_LIMITS, type ClubBanner, type NoticesView } from '../../shared/notices.ts'
import { notificationLink } from '../../shared/notification-link.ts'
import type { ForwardedSupport } from '../../shared/support.ts'
import { SUPPORT_LIMITS } from '../../shared/support.ts'
import type { Me, Notification, ServerMessage } from '../../shared/protocol.ts'
import { AuditLog } from '../../worker/audit.ts'
import { hashPassword } from '../../worker/auth.ts'
import { BACKUP_PREFIXES, BACKUP_TABLES } from '../../worker/backup.ts'
import { ClubRegistryCache } from '../../worker/clubs.ts'
import { ClubError } from '../../worker/errors.ts'
import { PlatformService, type ClubDirectory } from '../../worker/platform.ts'
import { RegistrationLimit } from '../../worker/register-limit.ts'
import { route, type Routes } from '../../worker/routing.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'
import { adminWithTwoFactor } from './admin-two-factor.ts'
import { memoryStore } from './sqlite.ts'

/**
 * Announcements (e12-t15) and the support form (e12-t16): the platform's notices through the
 * Worker's cached read, a club's own banner, reports staying in their club, forwarding, the account
 * export and deletion. The clubs are real `ClubService`s; their objects are faked by a directory.
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
  onlineUserIds() {
    return []
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect() {}
}

let now = 10_000_000_000

/** A club with an admin who may act as one, and a member; 淡江 or a club the platform opened */
async function makeClub(clubId: string, extra: Partial<ConstructorParameters<typeof ClubService>[2]> = {}) {
  const store = memoryStore()
  const club = new ClubService(store, new Sockets(), { clubId, maxUsers: 10, schedule: () => {}, now: () => now, ...extra })
  await club.load()
  if (clubId !== 'tku') await club.provisionFounder('boss', await hashPassword('club-secret-1'))
  const first = clubId === 'tku' ? await club.register('boss', 'club-secret-1', '') : await club.login('boss', 'club-secret-1', '', '')
  if (!('user' in first)) throw new Error('the first account should sign in')
  await adminWithTwoFactor(club, first.user.id)
  const member = await club.adminCreateUser('amy', 'club-secret-1')
  const signedIn = await club.login('amy', 'club-secret-1', '', '')
  return { club, store, admin: first.user.id, member: member.id, memberToken: signedIn.token }
}

const owner = { id: 'owner', username: 'gene', admin: true } as unknown as Me
const report = { category: 'bug', text: '叫牌框打不開', version: 'abc123', tableId: 't1', boardId: 'b1' }
const CHROME = 'Mozilla/5.0 Chrome/130'

const inbox = async (club: ClubService, userId: string): Promise<Notification[]> => (await club.notifications.view(userId)).items

describe('the platform’s notices (e12-t15)', () => {
  let store: MemoryStore
  let platform: PlatformService
  let audit: AuditLog

  beforeEach(() => {
    now = 10_000_000_000
    store = new MemoryStore()
    audit = new AuditLog(store, () => now)
    let n = 0
    const clubs: ClubDirectory = {
      provision: async () => {},
      setStatus: async () => {},
      usage: async () => {
        throw new Error('not in these tests')
      },
      forwardedSupport: async () => [],
      setSupportStatus: async () => true,
    }
    platform = new PlatformService(store, {
      now: () => now,
      newId: () => `n${++n}`,
      audit,
      clubs,
      limit: new RegistrationLimit(store, () => now, null, { key: 'meta:clubApplications', label: 'clubApply', max: 3 }),
    })
  })

  const firstId = async () => (await platform.saveNotice(owner, { text: '週六停機維護' })).notices[0].id

  it('keeps a draft in the back office, and members get it only once it is published', async () => {
    const id = await firstId()
    expect((await platform.snapshot()).notices).toEqual([])
    const view = await platform.publishNotice(owner, id)
    expect(view.notices[0]).toMatchObject({ id, status: 'published', publishedAt: now })
    const { notices } = await platform.snapshot()
    expect(notices).toEqual([{ id, text: '週六停機維護', publishedAt: now }])
    // Nothing of the back office's bookkeeping goes to members
    expect(Object.keys(notices[0]).sort()).toEqual(['id', 'publishedAt', 'text'])
  })

  it('stops showing a notice at its end, and refuses an end in the past', async () => {
    const { notices } = await platform.saveNotice(owner, { text: '短期', expiresAt: now + 1_000 })
    await platform.publishNotice(owner, notices[0].id)
    expect((await platform.snapshot()).notices).toHaveLength(1)
    now += 1_000
    expect((await platform.snapshot()).notices).toEqual([])
    expect(await code(platform.saveNotice(owner, { text: '過去', expiresAt: now - 1 }))).toBe('badNoticeExpiry')
    // It cannot go out again past its end, but the owner can give it a new one
    await platform.withdrawNotice(owner, notices[0].id)
    expect(await code(platform.publishNotice(owner, notices[0].id))).toBe('badNoticeExpiry')
    await platform.saveNotice(owner, { id: notices[0].id, text: '短期', expiresAt: now + 5_000 })
    await platform.publishNotice(owner, notices[0].id)
    expect((await platform.snapshot()).notices).toHaveLength(1)
  })

  it('takes a withdrawn notice back, and one published again shows to whoever dismissed it', async () => {
    const id = await firstId()
    await platform.publishNotice(owner, id)
    const [before] = (await platform.snapshot()).notices
    await platform.withdrawNotice(owner, id)
    expect((await platform.snapshot()).notices).toEqual([])
    now += 10
    await platform.publishNotice(owner, id)
    const [after] = (await platform.snapshot()).notices
    expect(noticeDismissKey(after)).not.toBe(noticeDismissKey(before))
  })

  it('keeps editing a notice that is out from showing it again to whoever dismissed it', async () => {
    const id = await firstId()
    await platform.publishNotice(owner, id)
    const [before] = (await platform.snapshot()).notices
    now += 10
    await platform.saveNotice(owner, { id, text: '週六停機維護（改到晚上）' })
    const [after] = (await platform.snapshot()).notices
    expect(after.text).toBe('週六停機維護（改到晚上）')
    expect(noticeDismissKey(after)).toBe(noticeDismissKey(before))
  })

  it('checks text and limits', async () => {
    expect(await code(platform.saveNotice(owner, { text: '   ' }))).toBe('badNoticeText')
    expect(await code(platform.saveNotice(owner, { text: 'x'.repeat(NOTICE_LIMITS.textMax + 1) }))).toBe('badNoticeText')
    expect(await code(platform.publishNotice(owner, 'nobody'))).toBe('noSuchNotice')
    const ids: string[] = []
    for (let i = 0; i <= NOTICE_LIMITS.activeMax; i++) {
      now += 1
      ids.push((await platform.saveNotice(owner, { text: `公告 ${i}` })).notices[0].id)
    }
    for (const id of ids.slice(0, NOTICE_LIMITS.activeMax)) await platform.publishNotice(owner, id)
    expect(await code(platform.publishNotice(owner, ids[NOTICE_LIMITS.activeMax]))).toBe('tooManyActiveNotices')
    for (let i = ids.length; i < NOTICE_LIMITS.storedMax; i++) await store.put(`platform:notice:x${i}`, { id: `x${i}`, text: 'x', status: 'draft', createdAt: 0, updatedAt: 0 })
    expect(await code(platform.saveNotice(owner, { text: '太多了' }))).toBe('tooManyNotices')
  })

  it('audits every action', async () => {
    const id = await firstId()
    await platform.publishNotice(owner, id)
    await platform.withdrawNotice(owner, id)
    await platform.deleteNotice(owner, id)
    expect(await code(platform.deleteNotice(owner, id))).toBe('noSuchNotice')
    const entries = await audit.list()
    expect(entries.map((e) => e.action).reverse()).toEqual(['platform:noticeSave', 'platform:noticePublish', 'platform:noticeWithdraw', 'platform:noticeDelete'])
    expect(entries.every((e) => e.by === 'gene' && e.target === id && e.note === '週六停機維護')).toBe(true)
  })

  it('is in the backup with the registry, which a restore leaves alone', () => {
    expect(BACKUP_PREFIXES).toContain('platform:')
  })
})

describe('a club’s banner (e12-t15)', () => {
  beforeEach(() => {
    now = 10_000_000_000
  })

  it('is for admins, audited, gone at its end, and new each time it is set', async () => {
    const { club, store, admin, member } = await makeClub('tku')
    expect(await code(club.adminSetBanner(member, { text: '社課取消' }))).toBe('adminOnly')
    expect(await code(club.adminClearBanner(member))).toBe('adminOnly')
    expect(await code(club.adminSetBanner(admin, { text: '' }))).toBe('badNoticeText')
    expect(await code(club.adminSetBanner(admin, { text: '社課取消', expiresAt: now - 1 }))).toBe('badNoticeExpiry')
    const first = await club.adminSetBanner(admin, { text: '社課取消', expiresAt: now + 100 })
    expect(await club.banners.current()).toEqual(first)
    expect(await club.adminBanner(admin)).toEqual(first)
    const second = await club.adminSetBanner(admin, { text: '社課改時間' })
    expect(second.id).not.toBe(first.id)
    await club.adminClearBanner(admin)
    expect(await club.banners.current()).toBeNull()
    const ended = await club.adminSetBanner(admin, { text: '社課取消', expiresAt: now + 100 })
    now += 100
    expect(ended.id).toBeTruthy()
    expect(await club.banners.current()).toBeNull()
    const audit = await new AuditLog(store).list()
    expect(audit.map((e) => e.action).reverse()).toEqual(['club:banner', 'club:banner', 'club:bannerClear', 'club:banner'])
    expect(audit.every((e) => e.by === 'boss')).toBe(true)
  })

  it('stays out of the backup: a restore never brings an old one back', () => {
    expect(BACKUP_PREFIXES.some((p) => 'meta:banner'.startsWith(p))).toBe(false)
  })
})

describe('GET /api/notices (e12-t15)', () => {
  const banner = (clubId: string): ClubBanner => ({ id: `b-${clubId}`, text: `${clubId} 的橫幅`, setAt: 1 })
  const asked: string[] = []
  let reads = 0
  let time = 0
  const notice = { id: 'n1', text: '平台公告', publishedAt: 1 }
  const cache = () =>
    new ClubRegistryCache(
      async () => {
        reads++
        return { clubs: [{ id: 'ntu', status: 'active' }], notices: [notice, { id: 'n2', text: '結束了', publishedAt: 1, expiresAt: 50 }] }
      },
      () => time,
      1_000,
    )
  const routes = (known = cache()): Routes => ({
    clubs: ['tku'],
    findClub: (id) => known.status(id),
    platformNotices: () => known.notices(),
    club: (clubId) => ({
      fetch: async () => new Response('club'),
      socketUser: async () => null,
      memberNotices: async (token) => {
        asked.push(clubId)
        return token === 'good' ? { signedIn: true, banner: banner(clubId) } : { signedIn: false, banner: null }
      },
    }),
    table: () => ({ fetch: async () => new Response('table') }),
    assets: { fetch: async () => new Response('assets') },
    edge: { now: () => time },
  })
  const get = (cookie: string, clubId?: string) =>
    new Request('https://t.example/api/notices', { headers: { Cookie: cookie, ...(clubId && { 'X-Club-Id': clubId }) } })

  beforeEach(() => {
    asked.length = 0
    reads = 0
    time = 0
  })

  it('answers signed-in members only', async () => {
    const answer = await route(get('tbt_session=nope'), routes())
    expect(answer.status).toBe(401)
    expect(reads).toBe(0)
  })

  it('gives each club’s members their own banner and the same platform notices, asking no other club', async () => {
    const shared = routes()
    const tku = (await (await route(get('tbt_session=good'), shared)).json()) as NoticesView
    expect(tku.club?.id).toBe('b-tku')
    expect(tku.platform.map((n) => n.id)).toEqual(['n1', 'n2'])
    const ntu = (await (await route(get('tbt_session_ntu=good', 'ntu'), shared)).json()) as NoticesView
    expect(ntu.club?.id).toBe('b-ntu')
    expect(ntu.platform.map((n) => n.id)).toEqual(['n1', 'n2'])
    expect(asked).toEqual(['tku', 'ntu'])
  })

  it('does not take another club’s session cookie', async () => {
    expect((await route(get('tbt_session=good', 'ntu'), routes())).status).toBe(401)
  })

  it('reads 淡江’s object at most once per copy, however many pages open', async () => {
    const shared = routes()
    for (let i = 0; i < 20; i++) await route(get('tbt_session=good'), shared)
    await route(get('tbt_session_ntu=good', 'ntu'), shared)
    expect(reads).toBe(1)
    time = 1_001
    await route(get('tbt_session=good'), shared)
    expect(reads).toBe(2)
  })

  it('checks a notice’s end when answering, whatever the copy holds', async () => {
    time = 50
    const view = (await (await route(get('tbt_session=good'), routes())).json()) as NoticesView
    expect(view.platform.map((n) => n.id)).toEqual(['n1'])
  })

  it('keeps the last notices when 淡江’s object does not answer', async () => {
    let fail = false
    const known = new ClubRegistryCache(
      async () => {
        if (fail) throw new Error('down')
        return { clubs: [], notices: [notice] }
      },
      () => time,
      1_000,
    )
    expect(await known.notices()).toEqual([notice])
    fail = true
    time = 5_000
    expect(await known.notices()).toEqual([notice])
  })

  it('still shows the club’s banner when the platform’s notices cannot be read', async () => {
    const broken = { ...routes(), platformNotices: async () => Promise.reject(new Error('down')) }
    const view = (await (await route(get('tbt_session=good'), broken)).json()) as NoticesView
    expect(view).toEqual({ platform: [], club: banner('tku') })
  })
})

describe('support reports (e12-t16)', () => {
  beforeEach(() => {
    now = 10_000_000_000
  })

  it('keeps what is listed and nothing else, and tells the admins', async () => {
    const { club, store, admin, member } = await makeClub('tku')
    const { id } = await club.sendSupportReport(member, report, CHROME)
    const row = store.sql.exec<Record<string, unknown>>('SELECT * FROM support_reports WHERE id = ?', id)[0]
    expect(Object.keys(row).sort()).toEqual(
      ['board_id', 'browser', 'category', 'created_at', 'forwarded_at', 'forwarded_by', 'id', 'resolved_at', 'status', 'table_id', 'text', 'user_id', 'version'].sort(),
    )
    const [listed] = club.adminSupport(admin).reports
    expect(listed).toMatchObject({
      id,
      clubId: 'tku',
      category: 'bug',
      text: '叫牌框打不開',
      browser: CHROME,
      version: 'abc123',
      boardId: 'b1',
      tableId: 't1',
      status: 'open',
      userId: member,
      username: 'amy',
    })
    const told = await inbox(club, admin)
    expect(told[0]).toMatchObject({ kind: 'supportReport', params: { username: 'amy' } })
    // Never the report's text in a notification
    expect(JSON.stringify(told[0].params)).not.toContain('叫牌框')
    expect(notificationLink(told[0])).toBe('/admin')
    expect(await inbox(club, member)).toEqual([])
  })

  it('checks what comes in, and drops ids that do not look like ids', async () => {
    const { club, admin, member } = await makeClub('tku')
    expect(await code(club.sendSupportReport(member, { ...report, category: 'nope' }, ''))).toBe('badSupportCategory')
    expect(await code(club.sendSupportReport(member, { ...report, text: '短' }, ''))).toBe('badSupportText')
    expect(await code(club.sendSupportReport(member, { ...report, text: 'x'.repeat(SUPPORT_LIMITS.textMax + 1) }, ''))).toBe('badSupportText')
    await club.sendSupportReport(member, { category: 'other', text: '沒有附牌局', boardId: '../etc', tableId: 7, ip: '1.2.3.4' }, 'x'.repeat(1000))
    const [listed] = club.adminSupport(admin).reports
    expect(listed.boardId).toBeUndefined()
    expect(listed.tableId).toBeUndefined()
    expect(listed.browser).toHaveLength(SUPPORT_LIMITS.browserMax)
    expect(JSON.stringify(listed)).not.toContain('1.2.3.4')
  })

  it('limits a member per hour and how many they keep open, not everyone together', async () => {
    const { club, admin, member } = await makeClub('tku')
    for (let i = 0; i < SUPPORT_LIMITS.perHour; i++) await club.sendSupportReport(member, report, '')
    expect(await code(club.sendSupportReport(member, report, ''))).toBe('tooManySupportReports')
    expect(await code(club.sendSupportReport(admin, report, ''))).toBe('no error')
    for (let i = 0; i < SUPPORT_LIMITS.openPerMember - SUPPORT_LIMITS.perHour; i++) {
      now += 61 * 60_000
      await club.sendSupportReport(member, report, '')
    }
    now += 2 * 60 * 60_000
    expect(await code(club.sendSupportReport(member, report, ''))).toBe('tooManySupportReports')
    const own = club.adminSupport(admin).reports.find((r) => r.userId === member)!
    await club.adminSetSupportStatus(admin, own.id, 'resolved')
    expect(await code(club.sendSupportReport(member, report, ''))).toBe('no error')
  })

  it('is for admins to read and resolve, audited without the text', async () => {
    const { club, store, admin, member } = await makeClub('tku')
    const { id } = await club.sendSupportReport(member, report, '')
    expect(() => club.adminSupport(member)).toThrow(ClubError)
    expect(await code(club.adminSetSupportStatus(member, id, 'resolved'))).toBe('adminOnly')
    expect(await code(club.adminSetSupportStatus(admin, 'nobody', 'resolved'))).toBe('noSuchSupportReport')
    expect(await code(club.adminSetSupportStatus(admin, id, 'nope'))).toBe('badMessage')
    const resolved = await club.adminSetSupportStatus(admin, id, 'resolved')
    expect(resolved.reports[0]).toMatchObject({ status: 'resolved', resolvedAt: now })
    const opened = await club.adminSetSupportStatus(admin, id, 'open')
    expect(opened.reports[0].resolvedAt).toBeUndefined()
    const audit = await new AuditLog(store).list()
    expect(audit.map((e) => e.action).reverse()).toEqual(['support:resolve', 'support:reopen'])
    expect(JSON.stringify(audit)).not.toContain('叫牌框')
  })

  it('keeps open reports and only the newest resolved ones', async () => {
    const { club, store, admin, member } = await makeClub('tku')
    const old = SUPPORT_LIMITS.resolvedKept + 3
    for (let i = 0; i < old; i++)
      store.sql.exec(
        "INSERT INTO support_reports (id, user_id, category, text, browser, version, created_at, status, resolved_at) VALUES (?, ?, 'bug', 'old', '', '', 1, 'resolved', ?)",
        `old${i}`,
        member,
        i + 1,
      )
    const { id } = await club.sendSupportReport(member, report, '')
    await club.adminSetSupportStatus(admin, id, 'resolved')
    const left = store.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM support_reports')[0].n
    expect(left).toBe(SUPPORT_LIMITS.resolvedKept)
    expect(store.sql.exec('SELECT id FROM support_reports WHERE id = ?', id)).toHaveLength(1)
    expect(club.adminSupport(admin).reports).toHaveLength(SUPPORT_LIMITS.resolvedListed)
  })

  it('cannot be forwarded without a platform owner', async () => {
    const { club, admin, member } = await makeClub('ntu')
    const { id } = await club.sendSupportReport(member, report, '')
    expect(club.adminSupport(admin).canForward).toBe(false)
    expect(await code(club.adminForwardSupport(admin, id))).toBe('supportForwardOff')
  })

  it('is in the account export, and goes with the account; a deleted admin’s name goes too', async () => {
    const told: string[] = []
    const { club, store, admin, member } = await makeClub('ntu', { tellPlatformOwner: async () => void told.push('owner') })
    const { id } = await club.sendSupportReport(member, report, CHROME)
    const data = await club.exportAccount(member, null)
    expect(data.supportReports).toEqual([expect.objectContaining({ id, clubId: 'ntu', text: '叫牌框打不開', browser: CHROME, boardId: 'b1', tableId: 't1', status: 'open' })])
    expect((await club.exportAccount(admin, null)).supportReports).toEqual([])
    // The second admin forwards someone's report, then leaves: it stays, without their name
    const second = await club.adminCreateUser('ben', 'club-secret-1')
    await club.adminSetAdmin(admin, second.id, true)
    await adminWithTwoFactor(club, second.id)
    const other = await club.sendSupportReport(admin, { ...report, text: '管理員自己的回報' }, '')
    await club.adminForwardSupport(second.id, other.id)
    expect(club.support.forwarded()[0].forwardedBy).toBe('ben')
    await club.deleteOwnAccount(second.id, 'club-secret-1')
    expect(club.support.forwarded()[0].forwardedBy).toBeUndefined()
    await club.deleteOwnAccount(member, 'club-secret-1')
    expect(store.sql.exec('SELECT id FROM support_reports WHERE user_id = ?', member)).toEqual([])
    expect(club.adminSupport(admin).reports.map((r) => r.id)).toEqual([other.id])
  })

  it('stays out of the backup', () => {
    expect(BACKUP_TABLES.map((t) => t.name)).not.toContain('support_reports')
    expect(BACKUP_PREFIXES.some((p) => 'support'.startsWith(p))).toBe(false)
  })
})

describe('reports across clubs (e12-t16)', () => {
  beforeEach(() => {
    now = 10_000_000_000
  })

  /** Two clubs, and the platform's back office in 淡江's object, reaching them as `worker/club.ts` does */
  async function twoClubs() {
    const toldOwner: string[] = []
    const tku = await makeClub('tku', { tellPlatformOwner: async () => void toldOwner.push('tku') })
    const ntu = await makeClub('ntu', { tellPlatformOwner: async () => void toldOwner.push('ntu') })
    const byId = { tku, ntu } as Record<string, typeof tku>
    const store = new MemoryStore()
    await store.put('platform:club:ntu', { id: 'ntu', name: '臺大', organisation: '', contactEmail: '', status: 'active', applicationId: 'a', adminUsername: 'boss', approvedAt: 1 })
    const clubs: ClubDirectory = {
      provision: async () => {},
      setStatus: async () => {},
      usage: async () => ({ members: 0, admins: [], tables: 0, boards: 0, storageBytes: 0, filesBytes: 0, backupBytes: null, historyRows: null }),
      forwardedSupport: async (id) => byId[id].club.support.forwarded(),
      setSupportStatus: async (id, reportId, status) => byId[id].club.support.setForwardedStatus(reportId, status),
    }
    const audit = new AuditLog(store, () => now)
    const platform = new PlatformService(store, {
      now: () => now,
      newId: () => 'x',
      audit,
      clubs,
      limit: new RegistrationLimit(store, () => now, null, { key: 'meta:clubApplications', label: 'clubApply', max: 3 }),
    })
    return { tku, ntu, platform, audit, toldOwner }
  }

  it('never shows a club’s reports in another club, nor lets its admin touch them', async () => {
    const { tku, ntu } = await twoClubs()
    const { id } = await ntu.club.sendSupportReport(ntu.member, { ...report, text: '臺大的回報內容' }, '')
    expect(ntu.club.adminSupport(ntu.admin).reports.map((r) => r.id)).toEqual([id])
    expect(tku.club.adminSupport(tku.admin).reports).toEqual([])
    expect(JSON.stringify(tku.club.adminSupport(tku.admin))).not.toContain('臺大的回報內容')
    expect(await code(tku.club.adminSetSupportStatus(tku.admin, id, 'resolved'))).toBe('noSuchSupportReport')
    expect(await code(tku.club.adminForwardSupport(tku.admin, id))).toBe('noSuchSupportReport')
    expect((await tku.club.exportAccount(tku.member, null)).supportReports).toEqual([])
    // Each club's own member ids mean nothing in the other
    expect(await code(tku.club.sendSupportReport(ntu.member, report, ''))).not.toBe('no error')
    expect(ntu.club.adminSupport(ntu.admin).reports[0].status).toBe('open')
  })

  it('never tells another club’s admins', async () => {
    const { tku, ntu } = await twoClubs()
    await ntu.club.sendSupportReport(ntu.member, report, '')
    expect((await inbox(ntu.club, ntu.admin)).map((n) => n.kind)).toEqual(['supportReport'])
    expect(await inbox(tku.club, tku.admin)).toEqual([])
  })

  it('shows the owner only what admins forwarded, from every club, without the member', async () => {
    const { tku, ntu, platform, toldOwner } = await twoClubs()
    const kept = await ntu.club.sendSupportReport(ntu.member, { ...report, text: '只給社團看' }, '')
    const sent = await ntu.club.sendSupportReport(ntu.member, { ...report, text: '轉交平台的回報' }, CHROME)
    now += 1
    const ours = await tku.club.sendSupportReport(tku.member, { ...report, text: '淡江轉交的回報' }, '')
    expect((await platform.view()).support).toEqual([])
    await ntu.club.adminForwardSupport(ntu.admin, sent.id)
    now += 1
    await tku.club.adminForwardSupport(tku.admin, ours.id)
    // Forwarding again tells nobody again
    await ntu.club.adminForwardSupport(ntu.admin, sent.id)
    expect(toldOwner).toEqual(['ntu', 'tku'])
    const { support } = await platform.view()
    expect(support.map((r: ForwardedSupport) => [r.clubId, r.id])).toEqual([
      ['ntu', sent.id],
      ['tku', ours.id],
    ])
    expect(support[0]).toMatchObject({ text: '轉交平台的回報', browser: CHROME, version: 'abc123', boardId: 'b1', tableId: 't1', forwardedBy: 'boss', status: 'open' })
    const seen = JSON.stringify(support)
    expect(seen).not.toContain('只給社團看')
    expect(seen).not.toContain(ntu.member)
    expect(seen).not.toContain('amy')
    expect(seen).not.toContain(kept.id)
  })

  it('lets the owner resolve a forwarded report in its club, audited in 淡江’s trail, and nothing else', async () => {
    const { ntu, platform, audit } = await twoClubs()
    const kept = await ntu.club.sendSupportReport(ntu.member, report, '')
    const sent = await ntu.club.sendSupportReport(ntu.member, report, '')
    await ntu.club.adminForwardSupport(ntu.admin, sent.id)
    expect(await code(platform.setSupportStatus(owner, 'ntu', kept.id, 'resolved'))).toBe('noSuchSupportReport')
    expect(await code(platform.setSupportStatus(owner, 'nobody', sent.id, 'resolved'))).toBe('unknownClub')
    expect(await code(platform.setSupportStatus(owner, 'tku', sent.id, 'resolved'))).toBe('noSuchSupportReport')
    expect(await code(platform.setSupportStatus(owner, 'ntu', sent.id, 'maybe'))).toBe('badMessage')
    const view = await platform.setSupportStatus(owner, 'ntu', sent.id, 'resolved')
    expect(view.support[0]).toMatchObject({ id: sent.id, status: 'resolved' })
    // Its club's admins see it resolved too
    expect(ntu.club.adminSupport(ntu.admin).reports.find((r) => r.id === sent.id)?.status).toBe('resolved')
    expect(ntu.club.adminSupport(ntu.admin).reports.find((r) => r.id === kept.id)?.status).toBe('open')
    const entries = await audit.list()
    expect(entries.map((e) => [e.action, e.target])).toEqual([['platform:supportResolve', `ntu/${sent.id}`]])
  })

  it('leaves a club that does not answer out of the list, and the rest in', async () => {
    const { tku, platform } = await twoClubs()
    const ours = await tku.club.sendSupportReport(tku.member, report, '')
    await tku.club.adminForwardSupport(tku.admin, ours.id)
    const directory = (platform as unknown as { config: { clubs: ClubDirectory } }).config.clubs
    const works = directory.forwardedSupport
    directory.forwardedSupport = async (id) => {
      if (id === 'ntu') throw new Error('no answer')
      return works(id)
    }
    expect((await platform.view()).support.map((r) => r.id)).toEqual([ours.id])
  })

  it('forgets a forwarded report with its member, so the owner no longer sees it', async () => {
    const { ntu, platform } = await twoClubs()
    const sent = await ntu.club.sendSupportReport(ntu.member, report, '')
    await ntu.club.adminForwardSupport(ntu.admin, sent.id)
    expect((await platform.view()).support).toHaveLength(1)
    await ntu.club.deleteOwnAccount(ntu.member, 'club-secret-1')
    expect((await platform.view()).support).toEqual([])
  })
})
