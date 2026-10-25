// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Me } from '../../shared/protocol.ts'
import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_KEEP_DAYS,
  type BackupBucket,
  backupAdmin,
  backupName,
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
import { MemoryStore } from '../../worker/store.ts'

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
  it('takes every key under book*, profile* and article*, sorted, and nothing else', async () => {
    await store.put('user:u1', { username: 'amy' })
    await store.put('session:t', { userId: 'u1' })
    await store.put('board:b1', {})
    await store.put('book:version', 3)
    await store.put('bookpart:book:entry:x:0', '{"a":1}')
    await store.put('book:entry:x', { slug: 'x', parts: 1 })
    await store.put('profile:club', { id: 'club' })
    await store.put('article:a', { id: 'a' })
    expect((await exportEntries(store)).map(([k]) => k)).toEqual([
      'article:a',
      'book:entry:x',
      'book:version',
      'bookpart:book:entry:x:0',
      'profile:club',
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
      prefixes: ['book', 'profile', 'article'],
      keys: 3,
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
    expect(() => parseBackup(`${header}\n{"k":"user:u1","v":{}}`)).toThrow()
    expect(() => parseBackup(`${header}\n{"k":"book:version"}`)).toThrow()
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
        ['user:u1', {}],
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
    // Not in the backup's scope: untouched
    expect(await store.get('user:u2')).toEqual({ username: 'ben' })
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
