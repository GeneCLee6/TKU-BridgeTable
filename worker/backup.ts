import { ClubError } from './service.ts'
import type { Store } from './store.ts'

/**
 * Daily backup of TKU BridgeBook's data to R2 (BridgeBook e10-t08, AC-10.5; the start of this
 * repo's e11-t12). A cron trigger (wrangler.jsonc `triggers.crons`) calls `Club.backup()`, which
 * exports every key under BACKUP_PREFIXES as one JSON Lines object `daily/<date>.jsonl` and then
 * deletes the daily objects older than BACKUP_KEEP_DAYS. Admins list, run and restore backups at
 * /api/admin/backups (DEPLOY.md §4.3 has the restore steps and the drill).
 *
 * Format: the first line is the header (`BackupHeader`), then one `{"k": key, "v": value}` line per
 * key, sorted by key. Values are stored exactly as the Durable Object holds them, so `bookpart:`
 * chunks stay chunks and a restore writes the same keys back.
 */

/**
 * What a backup holds: `book*` is TKU BridgeBook's online content, revisions, categories, drafts
 * and the `bookpart:` chunks; `profile*` and `article*` are its system profiles and articles once
 * they are stored (BridgeBook PRD E10). Accounts, games and the SQL tables are not in it yet
 * (e11-t12).
 */
export const BACKUP_PREFIXES = ['book', 'profile', 'article'] as const
/** Daily objects kept; older ones are deleted after each successful backup */
export const BACKUP_KEEP_DAYS = 30
export const BACKUP_FORMAT = 'tku-bridge-backup'
export const BACKUP_FORMAT_VERSION = 1
const DAILY = 'daily/'
const DAILY_KEY = /^daily\/(\d{4}-\d{2}-\d{2})\.jsonl$/
/** The club is in Taiwan: a backup is named after its date there (UTC+8, no daylight saving) */
const TAIPEI_OFFSET_MS = 8 * 3600_000
const DAY_MS = 86_400_000
/** Keys that are never restored: one-time upload passes are worthless after 10 minutes */
const SKIPPED_ON_RESTORE = ['book:ticket:']
/** The online content's version, which is the ETag of /api/book/content and /api/book/manifest */
const BOOK_VERSION_KEY = 'book:version'
const LIST_PAGE = 500

export interface BackupHeader {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_FORMAT_VERSION
  createdAt: string
  prefixes: string[]
  keys: number
}

export interface Backup {
  header: BackupHeader
  entries: [key: string, value: unknown][]
}

/** The part of an R2 bucket a backup uses; R2Bucket satisfies it and tests use MemoryBucket */
export interface BackupBucket {
  put(key: string, value: string, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<{ text(): Promise<string> } | null>
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: { key: string; size: number; uploaded: Date }[]
    truncated: boolean
    cursor?: string
  }>
  delete(keys: string | string[]): Promise<void>
}

export interface BackupObject {
  name: string
  size: number
  uploadedAt: number
}

export interface BackupResult {
  name: string
  keys: number
  bytes: number
  deleted: string[]
}

export interface RestorePlan {
  puts: [key: string, value: unknown][]
  deletes: string[]
}

export interface RestoreResult {
  name: string
  dryRun: boolean
  createdAt: string
  puts: number
  deletes: number
}

// ── Export ────────────────────────────────────────────────────────────────────────────────────

/** Every key under the prefixes, sorted, read a page at a time */
export async function exportEntries(store: Store, prefixes: readonly string[] = BACKUP_PREFIXES) {
  const entries: [string, unknown][] = []
  for (const prefix of prefixes) {
    let start: string | undefined
    for (;;) {
      const page = await store.list<unknown>(prefix, { start, limit: LIST_PAGE })
      for (const entry of page) entries.push(entry)
      if (page.size < LIST_PAGE) break
      // The next page starts just after the last key
      start = `${[...page.keys()].at(-1)}\0`
    }
  }
  return entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
}

export function serializeBackup(entries: [string, unknown][], createdAt: Date, prefixes: readonly string[] = BACKUP_PREFIXES) {
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: createdAt.toISOString(),
    prefixes: [...prefixes],
    keys: entries.length,
  }
  return [header, ...entries.map(([k, v]) => ({ k, v }))].map((line) => JSON.stringify(line)).join('\n') + '\n'
}

/** Reads a backup back; anything that does not look exactly like one is refused (`badBackup`) */
export function parseBackup(text: string): Backup {
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const bad = (why: string): never => {
    throw new ClubError('badBackup', { why })
  }
  const parse = (line: string, n: number) => {
    try {
      return JSON.parse(line) as unknown
    } catch {
      return bad(`line ${n + 1}`)
    }
  }
  if (lines.length === 0) bad('empty')
  const header = parse(lines[0], 0) as Partial<BackupHeader> | null
  if (!header || header.format !== BACKUP_FORMAT || header.version !== BACKUP_FORMAT_VERSION) bad('header')
  const { createdAt, prefixes, keys } = header as BackupHeader
  if (typeof createdAt !== 'string' || !Array.isArray(prefixes) || !prefixes.every((p) => typeof p === 'string' && p !== ''))
    bad('header')
  const entries: [string, unknown][] = []
  const seen = new Set<string>()
  lines.slice(1).forEach((line, i) => {
    const entry = parse(line, i + 1) as { k?: unknown; v?: unknown } | null
    if (!entry || typeof entry.k !== 'string' || !('v' in entry)) bad(`line ${i + 2}`)
    const key = entry!.k as string
    if (!prefixes.some((p) => key.startsWith(p))) bad(`key ${key} is outside the backup's prefixes`)
    if (seen.has(key)) bad(`key ${key} twice`)
    seen.add(key)
    entries.push([key, entry!.v])
  })
  if (entries.length !== keys) bad(`expected ${keys} keys, found ${entries.length}`)
  return { header: header as BackupHeader, entries }
}

// ── Names and retention ──────────────────────────────────────────────────────────────────────

/** `daily/2026-10-25.jsonl`: the date in Taiwan when the backup ran */
export function backupName(now: number) {
  return `${DAILY}${new Date(now + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)}.jsonl`
}

/**
 * Daily objects to delete: those whose date is more than `keepDays - 1` days before today (Taiwan),
 * so today's and the previous ones make `keepDays` in all. Objects with any other name are never
 * deleted, and the newest daily object is always kept, even if the cron stopped for a while.
 */
export function expiredBackups(names: string[], now: number, keepDays = BACKUP_KEEP_DAYS) {
  const today = Date.parse(backupName(now).slice(DAILY.length, -'.jsonl'.length))
  const cutoff = today - (keepDays - 1) * DAY_MS
  const daily = names
    .map((name) => ({ name, match: DAILY_KEY.exec(name) }))
    .filter((d): d is { name: string; match: RegExpExecArray } => d.match !== null)
    .map(({ name, match }) => ({ name, day: Date.parse(match[1]) }))
    .filter(({ day }) => !Number.isNaN(day))
    .sort((a, b) => a.day - b.day)
  const newest = daily.at(-1)?.name
  return daily.filter(({ name, day }) => day < cutoff && name !== newest).map(({ name }) => name)
}

// ── Restore ──────────────────────────────────────────────────────────────────────────────────

/**
 * What restoring a backup writes: every key under the backup's prefixes ends up exactly as in the
 * backup (keys made since are deleted), except that one-time upload passes are left out and
 * `book:version` moves past both the backup's and the current version, so a browser holding the
 * current ETag cannot be told "not modified" about content that changed under it.
 */
export function planRestore(backup: Backup, current: [string, unknown][]): RestorePlan {
  const { prefixes } = backup.header
  const restored = backup.entries.filter(([key]) => !SKIPPED_ON_RESTORE.some((p) => key.startsWith(p)))
  const keep = new Set(restored.map(([key]) => key))
  const deletes = current.map(([key]) => key).filter((key) => prefixes.some((p) => key.startsWith(p)) && !keep.has(key))
  const versionOf = (entries: [string, unknown][]) => {
    const value = entries.find(([key]) => key === BOOK_VERSION_KEY)?.[1]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  const puts = restored.filter(([key]) => key !== BOOK_VERSION_KEY)
  if (prefixes.some((p) => BOOK_VERSION_KEY.startsWith(p)))
    puts.push([BOOK_VERSION_KEY, Math.max(versionOf(backup.entries), versionOf(current)) + 1])
  return { puts, deletes: deletes.filter((key) => key !== BOOK_VERSION_KEY) }
}

// ── With the bucket ──────────────────────────────────────────────────────────────────────────

export async function runBackup(store: Store, bucket: BackupBucket, now: number, keepDays = BACKUP_KEEP_DAYS): Promise<BackupResult> {
  const entries = await exportEntries(store)
  const text = serializeBackup(entries, new Date(now))
  const name = backupName(now)
  await bucket.put(name, text, { httpMetadata: { contentType: 'application/x-ndjson; charset=utf-8' } })
  // Only after the new backup is safely written
  const deleted = expiredBackups((await listBackups(bucket)).map((b) => b.name), now, keepDays)
  if (deleted.length) await bucket.delete(deleted)
  return { name, keys: entries.length, bytes: new TextEncoder().encode(text).length, deleted }
}

/** Every backup object, newest first */
export async function listBackups(bucket: BackupBucket): Promise<BackupObject[]> {
  const objects: BackupObject[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix: DAILY, cursor })
    for (const o of page.objects) objects.push({ name: o.key, size: o.size, uploadedAt: o.uploaded.getTime() })
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return objects.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
}

/**
 * Restores a backup over the current data. With `dryRun` it only says how many keys it would write
 * and delete. Callers must drop whatever they hold in memory from these keys afterwards
 * (`Club.restoreBackup` makes a new BookService).
 */
export async function restoreBackup(store: Store, bucket: BackupBucket, name: string, dryRun: boolean): Promise<RestoreResult> {
  if (!DAILY_KEY.test(name)) throw new ClubError('backupNotFound', { name }, 404)
  const object = await bucket.get(name)
  if (!object) throw new ClubError('backupNotFound', { name }, 404)
  const backup = parseBackup(await object.text())
  const plan = planRestore(backup, await exportEntries(store, backup.header.prefixes))
  if (!dryRun) {
    for (const key of plan.deletes) await store.delete(key)
    for (const [key, value] of plan.puts) await store.put(key, value)
  }
  return { name, dryRun, createdAt: backup.header.createdAt, puts: plan.puts.length, deletes: plan.deletes.length }
}

/**
 * /api/admin/backups (admins only; the caller has checked): `GET` lists them, `POST` runs one now,
 * `POST /restore` with `{ name, dryRun }` restores one. A real restore also needs
 * `confirm` equal to `name`, so it cannot happen by a mistyped request.
 */
export async function backupAdmin(
  method: string,
  path: string,
  body: () => Promise<Record<string, unknown>>,
  club: {
    bucket: BackupBucket | undefined
    store: Store
    now: number
    restored: () => void
  },
): Promise<unknown> {
  const { bucket } = club
  if (!bucket) throw new ClubError('backupUnavailable', {}, 503)
  if (method === 'GET' && path === '/backups') return { backups: await listBackups(bucket), keepDays: BACKUP_KEEP_DAYS }
  if (method === 'POST' && path === '/backups') return { backup: await runBackup(club.store, bucket, club.now) }
  if (method === 'POST' && path === '/backups/restore') {
    const b = await body()
    const name = String(b.name ?? '')
    const dryRun = b.dryRun !== false
    if (!dryRun && b.confirm !== name) throw new ClubError('backupConfirm', { name })
    const result = await restoreBackup(club.store, bucket, name, dryRun)
    if (!dryRun) club.restored()
    return { restore: result }
  }
  throw new ClubError('noSuchApi', {}, 404)
}
