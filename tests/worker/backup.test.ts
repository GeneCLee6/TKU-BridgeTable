// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Me } from '../../shared/protocol.ts'
import {
  ACCOUNT_PREFIXES,
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_PREFIXES,
  BACKUP_KEEP_DAYS,
  BACKUP_TABLES,
  type BackupBucket,
  backupAdmin,
  backupName,
  decodeValue,
  encodeValue,
  expiredBackups,
  exportEntries,
  listBackups,
  parseBackup,
  planRestore,
  restoreBackup,
  runBackup,
  serializeBackup,
} from '../../worker/backup.ts'
import { BookService } from '../../worker/book.ts'
import { ForumService } from '../../worker/forum.ts'
import { ClubService, type Connections } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'
import { memoryStore } from './sqlite.ts'

const amy: Me = { id: 'u1', username: 'amy', admin: true, permissions: ['bookEdit'] }

/** An R2 bucket in memory, paging its list like R2 does */
class MemoryBucket implements BackupBucket {
  readonly objects = new Map<string, { text: string; uploaded: Date }>()
  pageSize = 1000
  now = new Date('2026-10-25T19:00:00Z')

  async put(key: string, value: string) {
    this.objects.set(key, { text: value, uploaded: this.now })
  }
  async get(key: string) {
    const object = this.objects.get(key)
    return object ? { text: async () => object.text } : null
  }
  async list({ prefix = '', cursor }: { prefix?: string; cursor?: string } = {}) {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix)).sort()
    const from = cursor ? Number(cursor) : 0
    const page = keys.slice(from, from + this.pageSize)
    const truncated = from + this.pageSize < keys.length
    return {
      objects: page.map((key) => ({ key, size: this.objects.get(key)!.text.length, uploaded: this.objects.get(key)!.uploaded })),
      truncated,
      cursor: truncated ? String(from + this.pageSize) : undefined,
    }
  }
  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) this.objects.delete(key)
  }
}

function convention(slug: string, summary = '敵方插叫後的 2NT 接力。') {
  return {
    slug,
    nameZh: '雷本索',
    nameEn: 'Lebensohl',
    category: 'competitive',
    tags: ['2NT'],
    summary,
    source: { title: 'Lebensohl' },
    updated: '2026-10-23',
    sections: [{ id: 'rules', title: '答叫原則', blocks: [{ kind: 'paragraph', text: '原文。' }] }],
  }
}

/** 2026-10-25 03:00 in Taiwan, when the cron runs */
const NOW = Date.parse('2026-10-24T19:00:00Z')
const day = (date: string) => `daily/${date}.jsonl`

let store: MemoryStore
let bucket: MemoryBucket

beforeEach(() => {
  store = new MemoryStore()
  bucket = new MemoryBucket()
})

describe('export', () => {
  it('takes the book, the accounts and their pictures, sorted, and nothing else', async () => {
    await store.put('user:u1', { username: 'amy' })
    await store.put('app:a1', { username: 'cat' })
    await store.put('avatar:u1', { version: 5, type: 'image/webp', bytes: new Uint8Array([1, 2, 3]) })
    await store.put('userteam:u1:t1', true)
    await store.put('session:t', { userId: 'u1' })
    await store.put('meta:settings', { inviteCode: 'x' })
    await store.put('friend:u1:u2', 1)
    await store.put('board:b1', {})
    await store.put('book:version', 3)
    await store.put('bookpart:book:entry:x:0', '{"a":1}')
    await store.put('book:entry:x', { slug: 'x', parts: 1 })
    await store.put('profile:club', { id: 'club' })
    await store.put('article:a', { id: 'a' })
    expect((await exportEntries(store)).map(([k]) => k)).toEqual([
      'app:a1',
      'article:a',
      'avatar:u1',
      'book:entry:x',
      'book:version',
      'bookpart:book:entry:x:0',
      'profile:club',
      'user:u1',
      'userteam:u1:t1',
    ])
  })

  it('reads past one page of keys', async () => {
    for (let i = 0; i < 1234; i++) await store.put(`book:rev:x:${String(i).padStart(5, '0')}`, i)
    const entries = await exportEntries(store)
    expect(entries).toHaveLength(1234)
    expect(new Set(entries.map(([k]) => k)).size).toBe(1234)
  })

  it('writes JSON Lines that read back to the same entries', () => {
    const entries: [string, unknown][] = [
      ['book:entry:x', { slug: 'x', convention: null }],
      ['book:version', 7],
      ['bookpart:k:0', '{"text":"含換行\\n與「引號」"}'],
    ]
    const text = serializeBackup(entries, new Date(NOW))
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(4)
    expect(JSON.parse(lines[0])).toEqual({
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      createdAt: '2026-10-24T19:00:00.000Z',
      prefixes: [...BACKUP_PREFIXES],
      keys: 3,
      tables: [],
      rows: 0,
    })
    expect(parseBackup(text).entries).toEqual(entries)
  })

  it('refuses anything that is not exactly a backup', () => {
    const good = serializeBackup([['book:version', 1]], new Date(NOW))
    const [header, line] = good.trimEnd().split('\n')
    expect(() => parseBackup('')).toThrow()
    expect(() => parseBackup('{"format":"other"}')).toThrow()
    expect(() => parseBackup(`${header}\nnot json`)).toThrow()
    expect(() => parseBackup(`${header}\n${line}\n${line}`)).toThrow()
    expect(() => parseBackup(header)).toThrow()
    expect(() => parseBackup(`${header}\n{"k":"session:t","v":{}}`)).toThrow()
    expect(() => parseBackup(`${header}\n{"k":"book:version"}`)).toThrow()
    expect(() => parseBackup(header.replace(`"version":${BACKUP_FORMAT_VERSION}`, '"version":9'))).toThrow()
    expect(() => parseBackup(`${header}\n{"k":"avatar:u1","v":{"$bytes":"%%"}}`)).toThrow()
  })

  it('writes bytes as base64 and reads them back, with keys that look like the tag kept as they were', () => {
    const big = new Uint8Array(64 * 1024).map((_, i) => (i * 7) & 0xff)
    const entries: [string, unknown][] = [
      ['avatar:u1', { version: 1_700_000_000_000, type: 'image/webp', bytes: big }],
      ['avatar:u2', { version: 2, type: 'image/png', bytes: new Uint8Array() }],
      ['book:entry:x', { $bytes: 'not bytes', note: { $$bytes: 1 }, list: [{ $bytes: 'alone' }, new Uint8Array([255])] }],
      ['user:u1', { username: 'amy', avatar: 1_700_000_000_000 }],
    ]
    const text = serializeBackup(entries, new Date(NOW))
    expect(text).toContain('{"$bytes":"')
    const read = parseBackup(text).entries
    expect(read).toEqual(entries)
    const bytes = (read[0][1] as { bytes: Uint8Array }).bytes
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBe(64 * 1024)
    // A value with no bytes in it is written as it is
    const plain = { slug: 'x', sections: [{ id: 'a' }] }
    expect(encodeValue(plain)).toBe(plain)
    expect(decodeValue(encodeValue(entries[2][1]))).toEqual(entries[2][1])
    expect(() => encodeValue({ x: new Uint16Array(2) })).toThrow()
  })

  it('still reads a version 1 backup (the book only) as it was written', () => {
    const v1 = [
      JSON.stringify({ format: BACKUP_FORMAT, version: 1, createdAt: '2026-10-20T19:00:00.000Z', prefixes: ['book', 'profile'], keys: 2 }),
      JSON.stringify({ k: 'book:entry:a', v: { $bytes: 'kept as text in version 1' } }),
      JSON.stringify({ k: 'book:version', v: 4 }),
    ].join('\n')
    const backup = parseBackup(v1)
    expect(backup.header).toMatchObject({ version: 1, prefixes: ['book', 'profile'] })
    expect(backup.entries).toEqual([
      ['book:entry:a', { $bytes: 'kept as text in version 1' }],
      ['book:version', 4],
    ])
    // A version 1 backup has no accounts: restoring it leaves them alone
    const plan = planRestore(backup, [
      ['book:entry:b', {}],
      ['user:u1', {}],
      ['avatar:u1', {}],
    ])
    expect(plan.deletes).toEqual(['book:entry:b'])
    expect(plan.puts.map(([k]) => k)).toEqual(['book:entry:a', 'book:version'])
  })
})

describe('names and retention', () => {
  it('names a backup by its date in Taiwan', () => {
    expect(backupName(NOW)).toBe(day('2026-10-25'))
    expect(backupName(Date.parse('2026-10-25T15:59:59Z'))).toBe(day('2026-10-25'))
    expect(backupName(Date.parse('2026-10-25T16:00:00Z'))).toBe(day('2026-10-26'))
  })

  it(`keeps ${BACKUP_KEEP_DAYS} days and deletes the older ones`, () => {
    const names = Array.from({ length: 40 }, (_, i) => day(new Date(Date.parse('2026-09-16') + i * 86_400_000).toISOString().slice(0, 10)))
    expect(names.at(-1)).toBe(day('2026-10-25'))
    const expired = expiredBackups(names, NOW)
    expect(expired).toEqual(names.slice(0, 10))
    expect(expired.at(-1)).toBe(day('2026-09-25'))
    expect(names.length - expired.length).toBe(BACKUP_KEEP_DAYS)
  })

  it('never deletes the newest backup or objects with other names', () => {
    const names = [day('2026-01-01'), day('2026-01-02'), 'daily/notes.txt', 'manual/2020-01-01.jsonl', 'daily/2026-13-45.jsonl']
    expect(expiredBackups(names, NOW)).toEqual([day('2026-01-01')])
    expect(expiredBackups([day('2025-01-01')], NOW)).toEqual([])
  })
})

describe('restore plan', () => {
  const backup = (entries: [string, unknown][]) => parseBackup(serializeBackup(entries, new Date(NOW)))

  it('puts back every backed-up key and deletes the ones made since, under the prefixes only', () => {
    const plan = planRestore(
      backup([
        ['book:entry:a', { v: 1 }],
        ['bookpart:book:entry:a:0', 'old'],
      ]),
      [
        ['book:entry:a', { v: 2 }],
        ['book:entry:b', { v: 1 }],
        ['bookpart:book:entry:a:0', 'new'],
        ['bookpart:book:entry:a:1', 'more'],
        ['session:t', {}],
      ],
    )
    expect(plan.puts).toEqual([
      ['book:entry:a', { v: 1 }],
      ['bookpart:book:entry:a:0', 'old'],
      ['book:version', 1],
    ])
    expect(plan.deletes).toEqual(['book:entry:b', 'bookpart:book:entry:a:1'])
  })

  it('moves book:version past both versions, so no browser keeps a stale ETag', () => {
    const old = backup([['book:version', 4]])
    expect(planRestore(old, [['book:version', 9]]).puts).toEqual([['book:version', 10]])
    expect(planRestore(backup([['book:version', 12]]), [['book:version', 9]]).puts).toEqual([['book:version', 13]])
    expect(planRestore(old, []).puts).toEqual([['book:version', 5]])
  })

  it('deletes accounts, applications and pictures made after the backup', () => {
    const plan = planRestore(
      backup([
        ['avatar:u1', { version: 5, type: 'image/webp', bytes: new Uint8Array([1]) }],
        ['user:u1', { username: 'amy', avatar: 5 }],
      ]),
      [
        ['app:a9', { username: 'late' }],
        ['avatar:u1', { version: 9, type: 'image/png', bytes: new Uint8Array([2]) }],
        ['avatar:u2', { version: 7, type: 'image/png', bytes: new Uint8Array([3]) }],
        ['session:t', { userId: 'u2' }],
        ['user:u1', { username: 'amy', avatar: 9 }],
        ['user:u2', { username: 'ben', avatar: 7 }],
      ],
    )
    expect(plan.deletes).toEqual(['app:a9', 'avatar:u2', 'user:u2'])
    expect(plan.puts).toEqual([
      ['avatar:u1', { version: 5, type: 'image/webp', bytes: new Uint8Array([1]) }],
      ['user:u1', { username: 'amy', avatar: 5 }],
      ['book:version', 1],
    ])
  })

  it('leaves out one-time upload passes', () => {
    const plan = planRestore(backup([['book:ticket:abc', { userId: 'u1' }]]), [['book:ticket:new', {}]])
    expect(plan.puts).toEqual([['book:version', 1]])
    expect(plan.deletes).toEqual(['book:ticket:new'])
  })
})

describe('with the bucket', () => {
  it('backs up, restores and the handbook reads the restored content', async () => {
    let book = new BookService(store, () => NOW)
    await store.put('user:u1', { username: 'amy' })
    await book.save(amy, 'lebensohl', { convention: convention('lebensohl'), baseVersion: 0 })
    const result = await runBackup(store, bucket, NOW)
    expect(result).toMatchObject({ name: day('2026-10-25'), deleted: [] })
    expect(result.keys).toBeGreaterThan(2)
    expect(bucket.objects.has(day('2026-10-25'))).toBe(true)

    // A bad edit, a new convention, and a new account after the backup
    await book.save(amy, 'lebensohl', { convention: convention('lebensohl', '改壞了'), baseVersion: 1 })
    await book.save(amy, 'stayman', { convention: convention('stayman'), baseVersion: 0 })
    await store.put('user:u2', { username: 'ben' })
    await store.put('session:t', { userId: 'u1' })
    const versionBefore = (await book.content()).version

    const dry = await restoreBackup(store, bucket, day('2026-10-25'), true)
    expect(dry).toMatchObject({ dryRun: true, createdAt: new Date(NOW).toISOString() })
    expect(dry.deletes).toBeGreaterThan(0)
    expect(JSON.parse((await book.content()).json).entries).toHaveLength(2)

    await restoreBackup(store, bucket, day('2026-10-25'), false)
    book = new BookService(store, () => NOW)
    const content = await book.content()
    const entries = JSON.parse(content.json).entries
    expect(entries.map((e: { slug: string }) => e.slug)).toEqual(['lebensohl'])
    expect(entries[0].convention.summary).toBe('敵方插叫後的 2NT 接力。')
    expect(content.version).toBeGreaterThan(versionBefore)
    // The account made after the backup is gone; sessions are not in the backup's scope: untouched
    expect(await store.get('user:u2')).toBeUndefined()
    expect(await store.get('user:u1')).toEqual({ username: 'amy' })
    expect(await store.get('session:t')).toEqual({ userId: 'u1' })
    // The revisions made after the backup are gone with it
    expect(await book.revisions('stayman')).toEqual([])
  })

  it('deletes expired backups after writing the new one', async () => {
    bucket.pageSize = 7
    for (let i = 0; i < 37; i++)
      await bucket.put(day(new Date(Date.parse('2026-09-19') + i * 86_400_000).toISOString().slice(0, 10)), 'x')
    await bucket.put('manual/keep.jsonl', 'x')
    const result = await runBackup(store, bucket, NOW)
    expect(result.deleted).toEqual([day('2026-09-19'), day('2026-09-20'), day('2026-09-21'), day('2026-09-22'), day('2026-09-23'), day('2026-09-24'), day('2026-09-25')])
    const left = await listBackups(bucket)
    expect(left).toHaveLength(BACKUP_KEEP_DAYS)
    expect(left[0].name).toBe(day('2026-10-25'))
    expect(bucket.objects.has('manual/keep.jsonl')).toBe(true)
  })

  it('refuses a name that is not a daily backup', async () => {
    await expect(restoreBackup(store, bucket, '../user:u1', true)).rejects.toMatchObject({ code: 'backupNotFound' })
    await expect(restoreBackup(store, bucket, day('2020-01-01'), true)).rejects.toMatchObject({ code: 'backupNotFound' })
  })
})

describe("the forum's SQL tables", () => {
  const forumStore = () => {
    const sqlStore = memoryStore()
    new ForumService(sqlStore.sql, { now: () => NOW, newId: () => 'x', members: () => [] }).createTables()
    return sqlStore
  }
  const post = (id: string, title: string) => [id, 'chat', 'u1', title, '[{"kind":"paragraph","text":"hi"}]', '[]', NOW, `${title} hi`] as const
  const insertPost = (s: MemoryStore, id: string, title: string) =>
    s.sql.exec(
      'INSERT INTO forum_posts (id, board_id, author_id, title, blocks, mentions, created_at, body_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ...post(id, title),
    )
  const titles = (s: MemoryStore) => s.sql.exec<{ title: string }>('SELECT title FROM forum_posts ORDER BY rowid').map((r) => r.title)

  it('backs up every forum table and restores it as it was, rows made since gone', async () => {
    const s = forumStore()
    insertPost(s, 'p2', '第二篇')
    insertPost(s, 'p1', '第一篇')
    s.sql.exec("INSERT INTO forum_comments (id, post_id, parent_id, author_id, blocks, mentions, created_at) VALUES ('c1', 'p1', NULL, 'u1', '[]', '[]', ?)", NOW)
    s.sql.exec("INSERT INTO forum_reactions (target, target_id, user_id, emoji, created_at) VALUES ('post', 'p1', 'u2', '👍', ?)", NOW)
    s.sql.exec("INSERT INTO forum_reports (id, target, target_id, reporter_id, reason, created_at, status) VALUES ('r1', 'post', 'p2', 'u2', 'spam', ?, 'open')", NOW)
    await s.put('user:u1', { username: 'amy' })
    const result = await runBackup(s, bucket, NOW)
    const boards = s.sql.exec('SELECT * FROM forum_boards').length
    expect(result.rows).toBe(boards + 5)
    const backup = parseBackup(bucket.objects.get(day('2026-10-25'))!.text)
    expect(backup.header).toMatchObject({ version: 3, tables: BACKUP_TABLES.map((t) => t.name), rows: boards + 5 })

    // After the backup: a post edited, one added, a reaction removed, a board renamed
    s.sql.exec("UPDATE forum_posts SET title = '改過' WHERE id = 'p2'")
    insertPost(s, 'p3', '新的')
    s.sql.exec('DELETE FROM forum_reactions')
    s.sql.exec("UPDATE forum_boards SET name = '改名' WHERE id = 'chat'")

    const dry = await restoreBackup(s, bucket, day('2026-10-25'), true)
    expect(dry).toMatchObject({ tables: BACKUP_TABLES.map((t) => t.name), rows: boards + 5 })
    expect(titles(s)).toEqual(['改過', '第一篇', '新的'])

    await restoreBackup(s, bucket, day('2026-10-25'), false)
    // Same rows, in the same rowid order (ties in a board's list are broken by it)
    expect(titles(s)).toEqual(['第二篇', '第一篇'])
    expect(s.sql.exec('SELECT id, post_id FROM forum_comments')).toEqual([{ id: 'c1', post_id: 'p1' }])
    expect(s.sql.exec('SELECT emoji FROM forum_reactions')).toEqual([{ emoji: '👍' }])
    expect(s.sql.exec("SELECT status FROM forum_reports WHERE id = 'r1'")).toEqual([{ status: 'open' }])
    expect(s.sql.exec("SELECT name FROM forum_boards WHERE id = 'chat'")).not.toEqual([{ name: '改名' }])
    expect(s.sql.exec('SELECT * FROM forum_boards').length).toBe(boards)
  })

  it('leaves the forum alone when restoring a backup from before it (version 2)', async () => {
    const s = forumStore()
    await s.put('book:entry:a', { v: 1 })
    const v2 = [
      JSON.stringify({ format: BACKUP_FORMAT, version: 2, createdAt: '2026-10-24T19:00:00.000Z', prefixes: ['book'], keys: 1 }),
      JSON.stringify({ k: 'book:entry:a', v: { v: 2 } }),
    ].join('\n')
    await bucket.put(day('2026-10-25'), v2)
    insertPost(s, 'p1', '留著')
    expect(await restoreBackup(s, bucket, day('2026-10-25'), false)).toMatchObject({ tables: [], rows: 0 })
    expect(titles(s)).toEqual(['留著'])
    expect(await s.get('book:entry:a')).toEqual({ v: 2 })
  })

  it('refuses rows it cannot put back, before writing anything', async () => {
    const s = forumStore()
    insertPost(s, 'p1', '原本')
    await runBackup(s, bucket, NOW)
    const text = bucket.objects.get(day('2026-10-25'))!.text
    const lines = text.trimEnd().split('\n')
    const header = lines[0]
    // An unknown table, a column that is not there, a value that is not plain SQL, a key after the rows
    expect(() => parseBackup(`${header.replace('"forum_posts"', '"users"')}\n${lines.slice(1).join('\n')}`)).toThrow()
    expect(() => parseBackup(text.replace('"title":"原本"', '"title":{"x":1}'))).toThrow()
    expect(() => parseBackup(`${text}{"k":"book:x","v":1}`)).toThrow()
    await bucket.put(day('2026-10-24'), text.replace('"title":"原本"', '"title; DROP TABLE forum_posts; --":"x"'))
    await s.put('book:entry:a', { v: 1 })
    await expect(restoreBackup(s, bucket, day('2026-10-24'), false)).rejects.toMatchObject({ code: 'badBackup' })
    expect(titles(s)).toEqual(['原本'])
    expect(await s.get('book:entry:a')).toEqual({ v: 1 })
  })
})

describe('admin API', () => {
  const call = (method: string, path: string, body: Record<string, unknown> = {}, restored = () => {}) =>
    backupAdmin(method, path, async () => body, { bucket, store, now: NOW, restored })

  it('lists, runs and restores, a real restore only with confirm', async () => {
    await store.put('book:entry:a', { v: 1 })
    expect(await call('POST', '/backups')).toMatchObject({ backup: { name: day('2026-10-25') } })
    expect(await call('GET', '/backups')).toMatchObject({ backups: [{ name: day('2026-10-25') }], keepDays: BACKUP_KEEP_DAYS })
    await store.put('book:entry:b', { v: 1 })

    let restored = 0
    const name = day('2026-10-25')
    expect(await call('POST', '/backups/restore', { name }, () => restored++)).toMatchObject({ restore: { dryRun: true, deletes: 1 } })
    expect(await store.get('book:entry:b')).toEqual({ v: 1 })
    await expect(call('POST', '/backups/restore', { name, dryRun: false })).rejects.toMatchObject({ code: 'backupConfirm' })
    await expect(call('POST', '/backups/restore', { name, dryRun: false, confirm: 'other' })).rejects.toMatchObject({ code: 'backupConfirm' })
    expect(restored).toBe(0)
    expect(await call('POST', '/backups/restore', { name, dryRun: false, confirm: name }, () => restored++)).toMatchObject({
      restore: { dryRun: false, deletes: 1 },
    })
    expect(restored).toBe(1)
    expect(await store.get('book:entry:b')).toBeUndefined()
  })

  it('says so when the bucket is not set up', async () => {
    await expect(backupAdmin('GET', '/backups', async () => ({}), { bucket: undefined, store, now: NOW, restored: () => {} })).rejects.toMatchObject({
      code: 'backupUnavailable',
      status: 503,
    })
    await expect(call('DELETE', '/backups')).rejects.toMatchObject({ code: 'noSuchApi' })
  })
})

describe('restoring the accounts into a running club', () => {
  const WEBP = [0x52, 0x49, 0x46, 0x46, 0x10, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20]
  const picture = (fill: number) => {
    const bytes = new Uint8Array(3000).fill(fill)
    bytes.set(WEBP)
    return bytes
  }

  it('brings members and pictures back as of the backup and signs everyone out', async () => {
    let time = NOW
    const online = new Set<string>()
    const disconnected: string[] = []
    const connections: Connections = {
      onlineUserIds: () => [...online],
      send: () => undefined,
      disconnect: (id) => void disconnected.push(id),
    }
    const sqlStore = memoryStore()
    const club = new ClubService(sqlStore, connections, { maxUsers: 20, now: () => time, schedule: () => undefined })
    await club.load()
    const founder = await club.register('admin', 'secret1', '')
    if (!('user' in founder)) throw new Error('the first account should sign in at once')
    const member = async (name: string) => {
      await club.register(name, 'secret1', '')
      return (await club.adminApprove(club.adminApplications().find((a) => a.username === name)!.id)).id
    }
    const amy = await member('amy')
    const first = (await club.setAvatar(amy, picture(1))).avatar
    expect((await runBackup(sqlStore, bucket, NOW)).keys).toBeGreaterThanOrEqual(3)

    // After the backup: a new picture, a new member with one, a registration waiting, sessions
    time += 60_000
    const second = (await club.setAvatar(amy, picture(2))).avatar
    expect(second).not.toBe(first)
    const ben = await member('ben')
    await club.setAvatar(ben, picture(3))
    await club.register('cat', 'secret1', '')
    const { token } = await club.login('amy', 'secret1')
    expect(await club.userForToken(token)).toMatchObject({ id: amy })
    online.add(amy).add(ben)

    const name = day('2026-10-25')
    const result = (await backupAdmin('POST', '/backups/restore', async () => ({ name, dryRun: false, confirm: name }), {
      bucket,
      store: sqlStore,
      now: time,
      // As `Club` does it
      restored: async (prefixes) => {
        if (prefixes.some((p) => ACCOUNT_PREFIXES.includes(p))) await club.reloadAccounts()
      },
    })) as { restore: { deletes: number } }
    expect(result.restore.deletes).toBeGreaterThanOrEqual(3)

    // Ben joined after the backup: gone, picture and all
    expect((await club.adminUsers()).map((u) => u.username).sort()).toEqual(['admin', 'amy'])
    expect(club.usernameOf(ben)).toBeUndefined()
    expect(await sqlStore.get(`avatar:${ben}`)).toBeUndefined()
    // Amy's account and picture are the pair from the backup
    const user = await sqlStore.get<{ avatar?: number }>(`user:${amy}`)
    const avatar = await club.avatar(amy)
    expect(user?.avatar).toBe(first)
    expect(avatar?.version).toBe(first)
    expect([...avatar!.bytes.slice(16, 20)]).toEqual([1, 1, 1, 1])
    expect(club.lobbyView(founder.user.id, []).members.find((m) => m.id === amy)?.avatar).toBe(first)
    // Cat's registration came after the backup
    expect(club.adminApplications()).toEqual([])
    // Sessions are not in the backup: everyone signs in again
    expect(await club.userForToken(token)).toBeNull()
    expect((await sqlStore.list('session:')).size).toBe(0)
    expect(new Set(disconnected)).toEqual(new Set([amy, ben]))
    expect((await club.login('amy', 'secret1')).user.avatar).toBe(first)
  })
})
