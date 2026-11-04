// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Contract } from '../../shared/auction.ts'
import type { Seat } from '../../shared/cards.ts'
import { clubStoragePrefix, eventObjectName, tableObjectName } from '../../shared/clubs.ts'
import type { BoardState } from '../../shared/game.ts'
import { taiwanDayStart } from '../../shared/history-query.ts'
import type { BoardRecord, ServerMessage } from '../../shared/protocol.ts'
import { type BackupBucket, listBackups, runBackup } from '../../worker/backup.ts'
import { hashPassword } from '../../worker/auth.ts'
import { scopedBucket } from '../../worker/buckets.ts'
import { clubStub, eventStub, ownClub, tableStub } from '../../worker/clubs.ts'
import { mintPass, PASS_COOKIE, passCookieName, readPass } from '../../worker/edge-auth.ts'
import { ClubError } from '../../worker/errors.ts'
import { type FileBucket, FileService } from '../../worker/files.ts'
import { createHistoryIndex, indexRecord, listQuery } from '../../worker/history-index.ts'
import { daysReplica, REPLICA_SCHEMA, ReplicaSync, replicaWrites, searchReplica } from '../../worker/history-replica.ts'
import { route, TABLE_CLUB_HEADER, TABLE_USER_HEADER, type Routes } from '../../worker/routing.ts'
import type { Scheduler } from '../../worker/scheduler.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'
import { memoryD1, type MemoryD1 } from './d1.ts'
import { memorySql, memoryStore } from './sqlite.ts'

/**
 * Two clubs on one Worker (e12-t03, AC-12.1): 淡江 `tku` and a second club `ntu`. Each club is its
 * own Durable Object (e12-t02), so what is in its storage is its own by construction; these tests
 * cover that, and above all what is shared outside the objects: the tables' and events' object
 * names, the edge passes, the D1 history copy, the R2 buckets of files and backups. Nothing one club
 * makes may be read or written from the other.
 */

const CLUBS = ['tku', 'ntu'] as const
const DAY = taiwanDayStart('2026-10-20')
const NOW = DAY + 30 * 86_400_000
const SECRET = 'edge-secret-for-tests'

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error instanceof ClubError ? error.code : String(error)
  }
  return 'no error'
}

/** A finished board with these players (N, E, S, W) and contract level */
function record(id: string, players: [string, string, string, string], level = 3): BoardRecord {
  const seats = ['N', 'E', 'S', 'W'] as const
  const contract: Contract = { level: level as Contract['level'], strain: 'N', declarer: 'S', doubled: '' }
  const board = {
    boardNo: 1,
    dealer: 'N',
    vul: 'None',
    contract,
    auction: [],
    play: [],
    result: { declarerTricks: 9, scoreNS: 400, claimed: false },
  } as unknown as BoardState
  return {
    id,
    tableNumber: 1,
    finishedAt: DAY,
    players: Object.fromEntries(seats.map((s, i) => [s, { id: players[i], username: players[i] }])) as Record<Seat, { id: string; username: string }>,
    board,
  } as BoardRecord
}

// ── The objects outside the clubs' ─────────────────────────────────────────────────────────────

describe("a club's tables and events are objects of its own", () => {
  /** A Durable Object namespace that remembers the names asked for */
  const namespace = () => {
    const names: string[] = []
    return {
      names,
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => (names.push(id.name), { name: id.name }),
    }
  }
  const env = () => ({ CLUB: namespace(), TABLE: namespace(), EVENT: namespace(), CLUBS: 'ntu' }) as never

  it('names 淡江’s objects as before clubs, and every other club’s after it', () => {
    expect(tableObjectName('tku', 'abc123')).toBe('abc123')
    expect(tableObjectName('ntu', 'abc123')).toBe('ntu/abc123')
    expect(eventObjectName('tku', 'challenge', 'c1')).toBe('challenge:c1')
    expect(eventObjectName('ntu', 'match', 'm1')).toBe('ntu/match:m1')
    const e = env() as { CLUB: { names: string[] }; TABLE: { names: string[] }; EVENT: { names: string[] } }
    expect((tableStub(e as never, 'tku', 't1') as unknown as { name: string }).name).toBe('t1')
    expect((tableStub(e as never, 'ntu', 't1') as unknown as { name: string }).name).toBe('ntu/t1')
    expect((eventStub(e as never, 'ntu', 'pairs', 'p1') as unknown as { name: string }).name).toBe('ntu/pairs:p1')
    expect((clubStub(e as never, 'tku') as unknown as { name: string }).name).toBe('club')
    expect((clubStub(e as never, 'ntu') as unknown as { name: string }).name).toBe('club:ntu')
    // A club the platform opened (e12-t06) is reached by its own name, whatever CLUBS says; its
    // object decides whether it is open. Nothing that does not look like a club id reaches any object
    expect((clubStub({ ...(e as object), CLUBS: '' } as never, 'ntu') as unknown as { name: string }).name).toBe('club:ntu')
    expect(() => clubStub(e as never, 'Not A Club')).toThrow(/Unknown club/)
  })

  it('has a table or an event report only to the club its name says', () => {
    const e = env() as { CLUB: { names: string[] } }
    for (const [name, club] of [
      ['abc123', 'tku'],
      ['challenge:c1', 'tku'],
      ['ntu/abc123', 'ntu'],
      ['ntu/match:m1', 'ntu'],
    ] as const) {
      const own = ownClub(e as never, name)
      expect(own.clubId).toBe(club)
      own.stub()
      own.stub()
      expect(e.CLUB.names.at(-1)).toBe(club === 'tku' ? 'club' : 'club:ntu')
    }
    // A club no longer served: its reports reach only its own object (which turns them away), never 淡江's
    const gone = ownClub(e as never, 'old/abc123')
    expect(gone.clubId).toBe('old')
    gone.stub()
    expect(e.CLUB.names.at(-1)).toBe('club:old')
  })
})

// ── The Worker's routing with two clubs ────────────────────────────────────────────────────────

describe('the routing keeps each club to itself', () => {
  let seen: { to: string; request: Request }[]
  let routes: Routes
  /** Each club's sessions: the same member id in both, as nothing stops two clubs from making one */
  const sessions: Record<string, Map<string, string>> = {
    tku: new Map([['tku-token', 'u1']]),
    ntu: new Map([['ntu-token', 'u1']]),
  }

  beforeEach(() => {
    seen = []
    routes = {
      clubs: CLUBS,
      club: (clubId) => ({
        fetch: async (request) => (seen.push({ to: `club:${clubId}`, request }), new Response(clubId)),
        socketUser: async (token) => (token && sessions[clubId].get(token)) ?? null,
      }),
      table: (clubId, tableId) => ({
        fetch: async (request) => (seen.push({ to: `table:${tableObjectName(clubId, tableId)}`, request }), new Response('table')),
      }),
      assets: { fetch: async () => new Response('assets') },
    }
  })

  const upgrade = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://example.org${path}`, { headers: { Upgrade: 'websocket', ...headers } })

  it('sends each club’s API to its own object', async () => {
    await route(new Request('https://example.org/api/me', { headers: { 'X-Club-Id': 'ntu' } }), routes)
    await route(new Request('https://example.org/api/me'), routes)
    expect(seen.map((s) => s.to)).toEqual(['club:ntu', 'club:tku'])
  })

  it('sends a table socket to its own club’s table, with the club it was checked for', async () => {
    await route(upgrade('/ws/table/abc123?club=ntu', { Cookie: 'tbt_session_ntu=ntu-token' }), routes)
    await route(upgrade('/ws/table/abc123', { Cookie: 'tbt_session=tku-token', [TABLE_CLUB_HEADER]: 'ntu' }), routes)
    expect(seen.map((s) => s.to)).toEqual(['table:ntu/abc123', 'table:abc123'])
    expect(seen.map((s) => s.request.headers.get(TABLE_CLUB_HEADER))).toEqual(['ntu', 'tku'])
  })

  it('never takes one club’s session for another’s', async () => {
    expect((await route(upgrade('/ws/table/abc123?club=ntu', { Cookie: 'tbt_session=tku-token' }), routes)).status).toBe(401)
    expect((await route(upgrade('/ws/table/abc123', { Cookie: 'tbt_session=ntu-token' }), routes)).status).toBe(401)
    // Each club reads only its own cookie's name (e12-t04): 淡江's cookie at the other club, and the other club's at 淡江
    expect((await route(upgrade('/ws/table/abc123', { Cookie: 'tbt_session_ntu=ntu-token' }), routes)).status).toBe(401)
    expect((await route(upgrade('/ws/table/abc123?club=ntu', { Cookie: 'tbt_session_ntu=tku-token' }), routes)).status).toBe(401)
    expect(seen).toEqual([])
  })

  it('never takes one club’s edge pass for another’s, even for a member id both have', async () => {
    const d1 = memoryD1()
    routes.edge = { secret: SECRET, revocations: d1, now: () => NOW }
    const tkuPass = await mintPass(SECRET, 'u1', 'a1', NOW, 'tku')
    expect(await readPass(SECRET, tkuPass, NOW, 'tku')).toMatchObject({ userId: 'u1' })
    expect(await readPass(SECRET, tkuPass, NOW, 'ntu')).toBeNull()
    // 淡江's pass on a table socket of the other club: no pass, and no session there either
    expect((await route(upgrade('/ws/table/abc123?club=ntu', { Cookie: `${PASS_COOKIE}=${tkuPass}` }), routes)).status).toBe(401)
    const ntuPass = await mintPass(SECRET, 'u1', 'a1', NOW, 'ntu')
    await route(upgrade('/ws/table/abc123?club=ntu', { Cookie: `${passCookieName('ntu')}=${ntuPass}` }), routes)
    expect(seen.map((s) => [s.to, s.request.headers.get(TABLE_USER_HEADER)])).toEqual([['table:ntu/abc123', 'u1']])
  })

  it('answers each club’s history pages from its own rows of the D1 copy only', async () => {
    const d1 = memoryD1()
    await d1.batch(REPLICA_SCHEMA.map((sql) => ({ sql, params: [] })))
    // The same board id in both clubs, played by a member id both clubs have
    await d1.batch(replicaWrites([record('b1', ['u1', 'u2', 'u3', 'u4'])], [], 'tku'))
    await d1.batch(replicaWrites([record('b1', ['u1', 'x2', 'x3', 'x4'], 6), record('b2', ['u1', 'x2', 'x3', 'x4'])], [], 'ntu'))
    await d1.batch([{ sql: "INSERT INTO index_meta (club_id, key, value) VALUES ('tku', 'ready', '1'), ('ntu', 'ready', '1')", params: [] }])
    routes.edge = { secret: SECRET, revocations: d1, history: d1, now: () => NOW }
    const page = async (club: string) => {
      const pass = await mintPass(SECRET, 'u1', 'a1', NOW, club)
      const response = await route(
        new Request('https://example.org/api/history?scope=all', { headers: { 'X-Club-Id': club, Cookie: `${passCookieName(club)}=${pass}` } }),
        routes,
      )
      return (await response.json()) as { boards: { id: string; contract: Contract | null }[]; total: number }
    }
    const tku = await page('tku')
    const ntu = await page('ntu')
    expect(seen).toEqual([])
    expect(tku.boards.map((b) => [b.id, b.contract?.level])).toEqual([['b1', 3]])
    expect(ntu.total).toBe(2)
    expect(ntu.boards.map((b) => b.contract?.level).sort()).toEqual([3, 6])
  })
})

// ── The D1 history copy ───────────────────────────────────────────────────────────────────────

describe('each club keeps only its own rows of the D1 copy', () => {
  let d1: MemoryD1

  /** A club's object as far as the copy goes: its storage, index and sync */
  function club(clubId: string) {
    const store = new MemoryStore(memorySql())
    createHistoryIndex(store.sql)
    const jobs: (() => Promise<void>)[] = []
    const scheduler: Scheduler = { add: (_key, _kind, _ms, run) => void jobs.push(run), pending: () => false }
    const sync = new ReplicaSync({ clubId, store, db: d1, scheduler, now: () => NOW, log: () => {} })
    return {
      sync,
      async write(records: BoardRecord[]) {
        for (const r of records) {
          indexRecord(store.sql, r)
          await store.put(`board:${r.id}`, r)
          await sync.queue(r.id)
        }
      },
      async remove(id: string) {
        await store.delete(`board:${id}`)
        await sync.queue(id)
      },
      async drain() {
        while (jobs.length) await jobs.shift()!()
      },
    }
  }

  beforeEach(() => {
    d1 = memoryD1()
  })

  it('fills, writes, searches and deletes one club’s rows without touching the other’s', async () => {
    const tku = club('tku')
    const ntu = club('ntu')
    await tku.write([record('b1', ['u1', 'u2', 'u3', 'u4']), record('b2', ['u1', 'u2', 'u3', 'u4'])])
    await ntu.write([record('b1', ['u1', 'x2', 'x3', 'x4'], 6)])
    await tku.sync.load(true)
    await ntu.sync.load(true)
    await tku.drain()
    await ntu.drain()
    const search = (clubId: string) => searchReplica(d1, clubId, listQuery(true, 1, 20), 'u1', NOW)
    expect((await search('tku'))!.boards.map((b) => [b.id, b.contract?.level])).toEqual([
      ['b2', 3],
      ['b1', 3],
    ])
    expect((await search('ntu'))!.boards.map((b) => [b.id, b.contract?.level])).toEqual([['b1', 6]])
    expect((await daysReplica(d1, 'ntu', listQuery(false, 1, 20), 'u1', NOW))!.reduce((n, d) => n + d.count, 0)).toBe(1)
    // A third club no one filled reads as not complete, never as someone else's rows
    expect(await search('other')).toBeNull()

    // Taking a board out of one club leaves the other club's board of the same id
    await ntu.remove('b1')
    await ntu.drain()
    expect((await search('ntu'))!.total).toBe(0)
    expect((await search('tku'))!.total).toBe(2)
    expect(d1.rows('SELECT club_id, board_id FROM board_players WHERE seat = ? ORDER BY club_id, board_id', 'N')).toEqual([
      { club_id: 'tku', board_id: 'b1' },
      { club_id: 'tku', board_id: 'b2' },
    ])

    // One club switching its copy off (or filling it again) does not stop the other's
    await club('ntu').sync.load(false)
    await ntu.drain()
    const off = club('ntu')
    await off.sync.load(false)
    await off.drain()
    expect(await search('ntu')).toBeNull()
    expect((await search('tku'))!.total).toBe(2)
  })
})

// ── R2: files and backups ─────────────────────────────────────────────────────────────────────

/** One R2 bucket in memory, shared by both clubs as the real one is */
class MemoryBucket implements FileBucket, BackupBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; type?: string; uploaded: Date }>()
  async put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string } }) {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)
    this.objects.set(key, { bytes, type: options?.httpMetadata?.contentType, uploaded: new Date(NOW) })
  }
  async get(key: string) {
    const object = this.objects.get(key)
    if (!object) return null
    const bytes = object.bytes as Uint8Array<ArrayBuffer>
    return {
      body: new Blob([bytes]).stream(),
      size: bytes.length,
      httpMetadata: { contentType: object.type },
      text: async () => new TextDecoder().decode(bytes),
    }
  }
  async list(options: { prefix?: string } = {}) {
    const objects = [...this.objects]
      .filter(([key]) => key.startsWith(options.prefix ?? ''))
      .map(([key, o]) => ({ key, size: o.bytes.length, uploaded: o.uploaded }))
    return { objects, truncated: false }
  }
  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) this.objects.delete(key)
  }
}

const webp = (size = 64) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  return bytes
}

describe('each club’s files and backups are in its own part of the bucket', () => {
  let bucket: MemoryBucket
  const files = (clubId: string, store = new MemoryStore(memorySql())) =>
    new FileService(store, scopedBucket(bucket, clubStoragePrefix(clubId)), () => NOW, async () => {}, clubId)

  beforeEach(() => {
    bucket = new MemoryBucket()
  })

  const upload = async (service: FileService, user: string) => {
    const ticket = await service.createTicket(user, { purpose: 'post', type: 'image/webp', size: 64 })
    const token = ticket.uploadUrl.split('/').pop()!.split('?')[0]
    return { ticket, file: await service.upload(token, 'file', webp()) }
  }

  it('keeps 淡江’s keys and addresses as they were, and puts another club’s under clubs/<id>/', async () => {
    const tku = files('tku')
    const ntu = files('ntu')
    const a = await upload(tku, 'u1')
    const b = await upload(ntu, 'u1')
    expect(bucket.objects.has(a.file.key)).toBe(true)
    expect(bucket.objects.has(`clubs/ntu/${b.file.key}`)).toBe(true)
    expect(a.ticket.uploadUrl).not.toContain('club=')
    expect(a.file.url).not.toContain('club=')
    expect(b.ticket.uploadUrl).toContain('?club=ntu')
    expect(b.ticket.thumbUrl).toContain('?part=thumb&club=ntu')
    expect(b.file.url).toMatch(/&club=ntu$/)
  })

  it('never serves, signs or deletes another club’s file', async () => {
    const tkuStore = new MemoryStore(memorySql())
    const tku = files('tku', tkuStore)
    const ntu = files('ntu')
    const a = await upload(tku, 'u1')
    const b = await upload(ntu, 'u1')
    const serve = (service: FileService, url: string) => {
      const parsed = new URL(url, 'https://example.org')
      return service.serve(decodeURIComponent(parsed.pathname.slice('/api/files/'.length)), parsed)
    }
    expect((await serve(tku, a.file.url)).status).toBe(200)
    expect((await serve(ntu, b.file.url)).status).toBe(200)
    // Each club's address at the other: a signature it did not make
    expect(await code(serve(ntu, a.file.url))).toBe('fileGone')
    expect(await code(serve(tku, b.file.url))).toBe('fileGone')
    // A key from the other club: no record here, so no address and nothing to delete
    expect((await ntu.urls([a.file.key])).urls).toEqual({})
    expect(await code(ntu.remove('u1', a.file.key, true))).toBe('fileGone')
    expect(bucket.objects.has(a.file.key)).toBe(true)
    // Even the same signing secret signs differently for another club (the club is in what is signed)
    const twin = files('ntu', tkuStore)
    expect((await twin.urls([a.file.key])).urls[a.file.key].url.split('&s=')[1]).not.toBe(a.file.url.split('&s=')[1])
  })

  it('backs up each club apart, and neither lists nor expires the other’s backups', async () => {
    const tkuStore = memoryStore()
    const ntuStore = memoryStore()
    await tkuStore.put('user:u1', { id: 'u1', username: 'gene' })
    await ntuStore.put('user:u1', { id: 'u1', username: 'amy' })
    const tkuBackups = scopedBucket(bucket, clubStoragePrefix('tku'))
    const ntuBackups = scopedBucket(bucket, clubStoragePrefix('ntu'))
    // An old 淡江 backup the next run deletes
    await bucket.put('daily/2026-01-01.jsonl', 'old')
    await bucket.put('clubs/ntu/daily/2026-01-01.jsonl', 'old')
    await runBackup(ntuStore, ntuBackups, NOW)
    const tku = await runBackup(tkuStore, tkuBackups, NOW)
    expect(tku.name).toMatch(/^daily\//)
    expect([...bucket.objects.keys()].sort()).toEqual([`clubs/ntu/${tku.name}`, tku.name])
    expect((await listBackups(tkuBackups)).map((b) => b.name)).toEqual([tku.name])
    expect((await listBackups(ntuBackups)).map((b) => b.name)).toEqual([tku.name])
    expect(await (await bucket.get(`clubs/ntu/${tku.name}`))!.text()).toContain('amy')
    expect(await (await bucket.get(tku.name))!.text()).not.toContain('amy')
  })
})

// ── What is in each club's own object ────────────────────────────────────────────────────────

class Sockets implements Connections {
  online = new Set<string>()
  onlineUserIds() {
    return [...this.online]
  }
  send(_userId: string, _message: ServerMessage) {}
  disconnect(userId: string) {
    this.online.delete(userId)
  }
}

describe('members, sessions, records, shares, notifications and the rest stay in their club', () => {
  async function makeClub(clubId: string) {
    const club = new ClubService(memoryStore(), new Sockets(), { clubId, maxUsers: 10, now: () => NOW, schedule: () => {} })
    await club.load()
    return club
  }

  it('signs in, finds and shows nothing of one club in the other', async () => {
    const tku = await makeClub('tku')
    const ntu = await makeClub('ntu')
    // The same name in both clubs: two different accounts
    const gene = await tku.register('gene', 'club-secret-1', '')
    // Another club's first admin comes from the platform's approval (e12-t06), not from registering first
    await ntu.provisionFounder('gene', await hashPassword('club-secret-2'))
    const other = await ntu.login('gene', 'club-secret-2', '', '')
    if (!('token' in gene)) throw new Error('the first account should sign in at once')
    expect(gene.user.clubId).toBe('tku')
    expect(other.user.clubId).toBe('ntu')
    expect(gene.user.id).not.toBe(other.user.id)
    // Sessions: a club's token is nobody in the other
    expect((await tku.userForToken(gene.token))?.id).toBe(gene.user.id)
    expect(await ntu.userForToken(gene.token)).toBeNull()
    expect(await tku.userForToken(other.token)).toBeNull()
    // Passwords: one club's does not sign in at the other
    expect(await code(ntu.login('gene', 'club-secret-1', '', ''))).toBe('badLogin')

    // Records and their share links
    const board = record('b1', [gene.user.id, 'robot:tku:E', 'robot:tku:S', 'robot:tku:W'])
    await tku.link.boardFinished(board, null)
    expect((await tku.record('b1', gene.user.id))?.id).toBe('b1')
    expect(await ntu.record('b1', other.user.id)).toBeNull()
    expect((await ntu.search(other.user.id, listQuery(true, 1, 20))).total).toBe(0)
    const share = await tku.shares.create(gene.user.id, 'b1')
    expect((await tku.shares.open(share.token, '1.2.3.4')).finishedAt).toBe(DAY)
    expect(await code(ntu.shares.open(share.token, '1.2.3.4'))).toBe('shareGone')
    expect(await code(ntu.shares.create(other.user.id, 'b1'))).not.toBe('no error')

    // Notifications
    await tku.notifications.notify(gene.user.id, 'filesNearlyFull', { gb: 9 })
    expect((await tku.notifications.view(gene.user.id)).unread).toBeGreaterThan(0)
    expect((await ntu.notifications.view(gene.user.id)).items).toEqual([])

    // Members: neither club lists the other's
    expect(tku.memberDirectory().map((m) => m.id)).toEqual([gene.user.id])
    expect(ntu.memberDirectory().map((m) => m.id)).toEqual([other.user.id])
  })
})
