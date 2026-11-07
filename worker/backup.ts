import { ClubError } from './errors.ts'
import type { BackupSteps } from './backup-steps.ts'
import type { Sql, SqlValue, Store } from './store.ts'

/**
 * Daily backup of the accounts and TKU BridgeBook's data to R2 (BridgeBook e10-t08, AC-10.5; part
 * of this repo's e11-t12). A cron trigger (wrangler.jsonc `triggers.crons`) calls `Club.backup()`,
 * which exports every key under BACKUP_PREFIXES as one JSON Lines object `daily/<date>.jsonl` and
 * then deletes the daily objects older than BACKUP_KEEP_DAYS. Admins list, run and restore backups
 * at /api/admin/backups (DEPLOY.md §4.4 has the restore steps and the drill).
 *
 * Format: the first line is the header (`BackupHeader`), then one `{"k": key, "v": value}` line per
 * key, sorted by key. Values are stored exactly as the Durable Object holds them, so `bookpart:`
 * chunks stay chunks and a restore writes the same keys back. JSON has no bytes, so from version 2 a
 * `Uint8Array` (an avatar's picture) is written as `{"$bytes": "<base64>"}` (`encodeValue`), and a
 * real key that looks like that tag gets one more `$` so it reads back unchanged (`decodeValue`).
 * Version 1 (book only, no tags) is still read and restored, over its own prefixes only.
 *
 * From version 3 the forum's SQL tables (BACKUP_TABLES) follow the keys: one `{"t": table, "r": row}`
 * line per row, in the order they were written, and the header lists the tables (`tables`) and
 * counts the rows (`rows`). A restore empties each listed table and writes its rows back in one
 * transaction; a version 1 or 2 backup has no tables and leaves the forum alone.
 *
 * The export only reads the Durable Object's storage from its first key to its last, so no other
 * request runs in between (input gates): a member's `user:` and `avatar:` come from the same moment
 * and a restore puts back a matching pair.
 *
 * From version 4 that one object is the snapshot's small core, and two more kinds of object hold
 * what does not fit one request's 10 ms of CPU (`worker/backup-steps.ts` writes and reads them, a
 * step per alarm; DEPLOY.md §4.4 has the numbers):
 * - `activity/<date>/<part>.jsonl`: the ACTIVITY_PREFIXES and ACTIVITY_TABLES, in parts, kept as
 *   long as that day's snapshot;
 * - `games/<seq>.jsonl`: the `board:` records as a log of what changed, not per day: thirty daily
 *   copies of tens of thousands of boards would not fit R2's free 10 GB.
 * The core's restore rolls back (below). These two only ever add what is missing, so a restore
 * leaves the tables and matches being played alone and comes to the same thing whichever day it
 * names: boards played after that day stay. A version 3 or older backup has neither.
 */

/**
 * What a backup holds: `book*` is TKU BridgeBook's online content, revisions, categories, drafts
 * and the `bookpart:` chunks; `profile*` and `article*` are its system profiles and articles once
 * they are stored (BridgeBook PRD E10); `team:`, `pair:`, `userteam:` and `userpair:` are its teams
 * and partnerships (BridgeBook E2), which own profiles. `user:`, `app:` and `avatar:` are the
 * accounts (both sites'), the registrations waiting for approval and the pictures, together so a
 * member's `avatar` version always matches their picture. Not in it: `session:` (a restore signs
 * everyone out), `meta:settings` (the invite code and member cap: the env values stand in when it is
 * missing, and a restore must not bring back a code rotated since); the games and what grew up
 * around them are in the objects of their own (ACTIVITY_PREFIXES, ACTIVITY_TABLES, the `board:`
 * log). The forum's SQL tables are in it (BACKUP_TABLES), and from 2026-11-04 the
 * friends and blocks (`friend:`, `block:`, 社長): read with the accounts, so they name members of
 * the same moment, and a restore drops any that name an account the backup does not have.
 * The platform's registry and club applications (`platform:`, 淡江's object only, e12-t06) are in
 * it for a disaster by hand, but a restore never writes or deletes them (KEPT_ON_RESTORE): going
 * back to an older backup must not forget a club opened, or bring back one suspended, since.
 */
export const BACKUP_PREFIXES = [
  'book',
  'profile',
  'article',
  // The library's e-books (BridgeHall e5-t09); their PDFs stay in R2
  'ebook:',
  'team:',
  'pair:',
  'userteam:',
  'userpair:',
  'user:',
  'app:',
  'avatar:',
  // The pictures' owners and the key that signs their addresses (e11-t02); the pictures stay in R2
  'file:meta:',
  'file:secret',
  // Who follows and who blocked whom (worker/relations.ts), from the backup's moment like the accounts
  'friend:',
  'block:',
  // The platform's registry and applications (e12-t06): backed up, never restored (KEPT_ON_RESTORE)
  'platform:',
] as const
/**
 * The SQL tables a backup holds: TKU-BridgeHall's forum (E11; worker/forum.ts), with the order its
 * rows are written and restored in. Tables with a rowid go by it, so restored posts and comments
 * keep the order ties are broken by. The forum's pictures stay in R2 (their `file:meta:` is a key
 * above); the history index's tables are not here, they are rebuilt from the games.
 */
export const BACKUP_TABLES: readonly { name: string; order: string }[] = [
  { name: 'forum_boards', order: 'id' },
  { name: 'forum_posts', order: 'rowid' },
  { name: 'forum_comments', order: 'rowid' },
  { name: 'forum_reactions', order: 'target, target_id, user_id' },
  { name: 'forum_reports', order: 'rowid' },
]
/**
 * What else a member would miss (e11-t12), written in parts and restored only where missing, so
 * none of it can overwrite a tournament or a ledger still moving (ACTIVITY_TABLES below):
 * featured boards, tournaments, team events, pairs events, directors' logs, the audit trail (never
 * rewound: a restore must not forget what was done since), the book's pending notes, members' own
 * practice settings and deals, quiz rounds, reading places and learning progress, the points rules,
 * the weekly and daily challenges' schedules, the feature flags and where the events live.
 *
 * Left out on purpose:
 * - Rebuilt from the records: `hist:`, `uhist:` (and the SQL `boards_index`, `board_players`,
 *   `board_rulings`, which `indexRecord` writes), the D1 copy and its `replq:` and `meta:replica`.
 * - Worthless or wrong later: `session:`, `google:`, `line:`, `file:ticket:`, `file:day:`,
 *   `meta:registrations`, `meta:clubApplications`, `meta:metrics`,
 *   `meta:backfill`, `partnerBid:sweep`, `meta:banner`, `file:usage` (counted again from `file:meta:`).
 * - Live state with its own lifecycle: `table:`, `tabledir:` (a table lives in its own object; a
 *   finished board reaches `board:` by its outbox), `meta:schema` (a new object writes its own).
 * - Read and forgotten, and large: `notif:` (500 a member). Tied to a device: `push:` (a push
 *   service's address goes stale; members turn it on again).
 * - Personal data with a short life: `seen:` (90 days, anti-cheating), `importPurge:` (a mark that
 *   would delete the boards of an account the restore just brought back).
 * - Decided elsewhere: `meta:settings`, `meta:club`, `platform:` (see above and DEPLOY.md §4.20).
 */
export const ACTIVITY_PREFIXES = [
  'featured:',
  'tourn:',
  'teamev:',
  'teamevdeal:',
  'pairsev:',
  'referee:',
  'audit:',
  'pendingmeta:',
  'pendingdone:',
  'practicePresets:',
  'practiceOwnDeals:',
  'quizlog:',
  'pathprogress:',
  'reading:',
  'meta:points',
  'meta:weekly',
  'meta:daily',
  'meta:features',
  'meta:events',
  'meta:matches',
] as const
/**
 * The SQL tables in the parts, each with its primary key: a part reads on from the last key it
 * wrote (an OFFSET would read every earlier row again, and rows read are what the free plan counts).
 * Favorites, shared boards, challenges with their results and comments, team matches with their
 * chat, private messages, the points ledger and ratings, puzzles' publications and progress.
 * `event_homes` and `match_homes` say which event lives in its own `EventObject` (which a
 * lost club does not lose), and the `*_settled` tables keep a club from notifying everyone again of
 * events it already finished.
 *
 * Left out: the history index's tables (rebuilt, above); `partner_bid_*` (practice that expires,
 * ARCHITECTURE.md §5.11); `match_watchers` (who looked); `support_reports` (short-lived, §1: 30 more
 * days in a backup do nobody any good); `book_*` and `product_*` (anonymous counts
 * that start again, §5.15, §5.27).
 */
export const ACTIVITY_TABLES: readonly { name: string; key: readonly string[] }[] = [
  { name: 'favorites', key: ['user_id', 'board_id'] },
  { name: 'favorite_tags', key: ['user_id', 'tag', 'board_id'] },
  { name: 'board_shares', key: ['token'] },
  { name: 'challenges', key: ['challenge_id'] },
  { name: 'challenge_players', key: ['challenge_id', 'user_id'] },
  { name: 'challenge_results', key: ['challenge_id', 'user_id', 'seq'] },
  { name: 'challenge_comments', key: ['id'] },
  { name: 'challenge_settled', key: ['challenge_id'] },
  { name: 'event_homes', key: ['event_id'] },
  { name: 'matches', key: ['match_id'] },
  { name: 'match_seats', key: ['match_id', 'room', 'seat'] },
  { name: 'match_boards', key: ['match_id', 'seq'] },
  { name: 'match_chat', key: ['match_id', 'at', 'id'] },
  { name: 'match_settled', key: ['match_id'] },
  { name: 'match_homes', key: ['match_id'] },
  { name: 'direct_threads', key: ['user_id', 'other_id'] },
  { name: 'direct_messages', key: ['id'] },
  { name: 'ranked_events', key: ['event_id'] },
  { name: 'points_entries', key: ['event_id', 'user_id'] },
  { name: 'points_adjustments', key: ['id'] },
  { name: 'ratings', key: ['user_id'] },
  { name: 'rating_history', key: ['user_id', 'event_id'] },
  { name: 'puzzle_publications', key: ['puzzle_id'] },
  { name: 'puzzle_progress', key: ['user_id', 'puzzle_id'] },
]
/** The prefixes that hold accounts: restoring a backup with them reloads the club's members */
export const ACCOUNT_PREFIXES: readonly string[] = ['user:', 'app:', 'avatar:']
/** Friends and blocks: `<kind>:<userId>:<otherId>`, each naming two accounts */
const RELATION_PREFIXES: readonly string[] = ['friend:', 'block:']
/** Daily objects kept; older ones are deleted after each successful backup */
export const BACKUP_KEEP_DAYS = 30
export const BACKUP_FORMAT = 'tku-bridge-backup'
/** 4: the games and the activity in objects of their own; 3: the forum's SQL tables too; 2: accounts and avatars, binary values tagged; 1: TKU BridgeBook only. All are read */
export const BACKUP_FORMAT_VERSION = 4
const READABLE_VERSIONS: readonly number[] = [1, 2, 3, 4]
const DAILY = 'daily/'
/** Where `worker/backup-steps.ts` writes */
export const ACTIVITY_OBJECTS = 'activity/'
export const GAME_OBJECTS = 'games/'
const DAILY_KEY = /^daily\/(\d{4}-\d{2}-\d{2})\.jsonl$/
/** The club is in Taiwan: a backup is named after its date there (UTC+8, no daylight saving) */
const TAIPEI_OFFSET_MS = 8 * 3600_000
const DAY_MS = 86_400_000
/** Keys that are never restored: one-time upload passes are worthless after 10 minutes */
const SKIPPED_ON_RESTORE = ['book:ticket:']
/** Keys a restore leaves exactly as they are, neither written nor deleted: the platform's (e12-t06) */
const KEPT_ON_RESTORE = ['platform:']
const kept = (key: string) => KEPT_ON_RESTORE.some((p) => key.startsWith(p))
/** The online content's version, which is the ETag of /api/book/content and /api/book/manifest */
const BOOK_VERSION_KEY = 'book:version'
const LIST_PAGE = 500

export interface BackupHeader {
  format: typeof BACKUP_FORMAT
  /** 1 for the old book-only backups, 2 before the forum, 3 before the games; new ones are BACKUP_FORMAT_VERSION */
  version: 1 | 2 | 3 | typeof BACKUP_FORMAT_VERSION
  createdAt: string
  prefixes: string[]
  keys: number
  /** From version 3: the SQL tables in it, and their rows in all */
  tables?: string[]
  rows?: number
  /** From version 4: the boards the club had at this moment, to compare after a restore */
  boards?: number
}

export type SqlRow = Record<string, SqlValue>

export interface Backup {
  header: BackupHeader
  entries: [key: string, value: unknown][]
  /** The SQL tables' rows, in the order they are written back; none before version 3 */
  rows: [table: string, row: SqlRow][]
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
  /** The SQL tables' rows */
  rows: number
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
  /** The prefixes the restore put back (the backup's own) */
  prefixes: string[]
  puts: number
  deletes: number
  /** The SQL tables it emptied and wrote back, and their rows; none for a backup before version 3 */
  tables: string[]
  rows: number
  /** The backup's own version: from 4 the activity and the games follow, a step at a time */
  version: number
  /** What the steps after this request read (`BackupSteps.plan`) */
  steps?: RestoreStepsPlan
}

export interface RestoreStepsPlan {
  activityParts: number
  /** False when that day's export of the activity never finished: what is there still comes back */
  activityComplete: boolean
  gameObjects: number
  boardsNow: number
}

// ── Binary values ────────────────────────────────────────────────────────────────────────────

const BYTES_TAG = '$bytes'
/** `$bytes`, `$$bytes`, …: object keys that would read as the tag, escaped with one more `$` */
const TAG_LIKE = /^\$+bytes$/
const ESCAPED_TAG = /^\$\$+bytes$/
/** Bytes per `String.fromCharCode` call: well under the engine's argument limit */
const BASE64_CHUNK = 0x8000

export function bytesToBase64(bytes: Uint8Array) {
  let binary = ''
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK))
  return btoa(binary)
}

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/**
 * A stored value made JSON-safe: each `Uint8Array` becomes `{"$bytes": base64}` and keys that look
 * like the tag get one more `$`. A value with neither comes back as the same object, untouched, so
 * the book's long strings cost nothing. Other binary values are refused rather than written wrong.
 */
export function encodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Uint8Array) return { [BYTES_TAG]: bytesToBase64(value) }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) throw new Error('A backup holds only Uint8Array bytes')
  if (Array.isArray(value)) {
    let out: unknown[] | undefined
    value.forEach((item: unknown, i) => {
      const encoded = encodeValue(item)
      if (encoded !== item) (out ??= value.slice())[i] = encoded
    })
    return out ?? value
  }
  if (!isPlainObject(value)) return value
  let changed = false
  const entries = Object.entries(value).map(([key, item]) => {
    const encoded = encodeValue(item)
    const escaped = TAG_LIKE.test(key) ? `$${key}` : key
    if (encoded !== item || escaped !== key) changed = true
    return [escaped, encoded] as const
  })
  return changed ? Object.fromEntries(entries) : value
}

/** `encodeValue` undone; a `$bytes` tag that is not base64 throws */
export function decodeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decodeValue)
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length === 1 && keys[0] === BYTES_TAG) {
    const text = object[BYTES_TAG]
    if (typeof text !== 'string') throw new Error('$bytes is not text')
    return base64ToBytes(text)
  }
  const out: Record<string, unknown> = {}
  for (const key of keys) out[ESCAPED_TAG.test(key) ? key.slice(1) : key] = decodeValue(object[key])
  return out
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

/** The BACKUP_TABLES this database has (a store without SQL, as in the book's tests, has none) */
export function backupTables(sql: Sql) {
  let names: string[]
  try {
    names = sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").map((t) => t.name)
  } catch {
    return []
  }
  return BACKUP_TABLES.filter((t) => names.includes(t.name))
}

/** Every row of the BACKUP_TABLES there are, table by table in their order */
export function exportRows(sql: Sql): { tables: string[]; rows: [string, SqlRow][] } {
  const tables = backupTables(sql)
  const rows: [string, SqlRow][] = []
  for (const { name, order } of tables) for (const row of sql.exec<SqlRow>(`SELECT * FROM ${name} ORDER BY ${order}`)) rows.push([name, { ...row }])
  return { tables: tables.map((t) => t.name), rows }
}

export function serializeBackup(
  entries: [string, unknown][],
  createdAt: Date,
  prefixes: readonly string[] = BACKUP_PREFIXES,
  sql: { tables: string[]; rows: [string, SqlRow][] } = { tables: [], rows: [] },
  boards?: number,
) {
  const header: BackupHeader = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: createdAt.toISOString(),
    prefixes: [...prefixes],
    keys: entries.length,
    tables: [...sql.tables],
    rows: sql.rows.length,
    ...(boards !== undefined && { boards }),
  }
  const lines = [header, ...entries.map(([k, v]) => ({ k, v: encodeValue(v) })), ...sql.rows.map(([t, r]) => ({ t, r }))]
  return lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
}

const isSqlValue = (value: unknown): value is SqlValue =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))

/**
 * Reads a backup back, either version; anything that does not look exactly like one is refused
 * (`badBackup`). Version 2's binary tags become bytes again; version 1 had none, so its values are
 * taken as they are.
 */
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
  if (!header || header.format !== BACKUP_FORMAT || !READABLE_VERSIONS.includes(header.version as number)) bad('header')
  const { createdAt, prefixes, keys } = header as BackupHeader
  if (typeof createdAt !== 'string' || !Array.isArray(prefixes) || !prefixes.every((p) => typeof p === 'string' && p !== ''))
    bad('header')
  const { version } = header as BackupHeader
  const tagged = version !== 1
  const tables = version >= 3 ? (header as BackupHeader).tables : []
  const rowCount = version >= 3 ? (header as BackupHeader).rows : 0
  if (!Array.isArray(tables) || !tables.every((t) => BACKUP_TABLES.some((b) => b.name === t)) || typeof rowCount !== 'number')
    bad('header')
  const entries: [string, unknown][] = []
  const rows: [string, SqlRow][] = []
  const seen = new Set<string>()
  lines.slice(1).forEach((line, i) => {
    const entry = parse(line, i + 1) as { k?: unknown; v?: unknown; t?: unknown; r?: unknown } | null
    if (entry && typeof entry === 'object' && 't' in entry) {
      // A table's row: after every key, in a table the header lists, with plain SQL values
      const { t, r } = entry
      if (typeof t !== 'string' || !tables!.includes(t) || !r || typeof r !== 'object' || Array.isArray(r)) bad(`line ${i + 2}`)
      if (!Object.values(r as object).every(isSqlValue)) bad(`line ${i + 2}`)
      rows.push([t as string, r as SqlRow])
      return
    }
    if (rows.length) bad(`line ${i + 2}: a key after the tables' rows`)
    if (!entry || typeof entry.k !== 'string' || !('v' in entry)) bad(`line ${i + 2}`)
    const key = entry!.k as string
    if (!prefixes.some((p) => key.startsWith(p))) bad(`key ${key} is outside the backup's prefixes`)
    if (seen.has(key)) bad(`key ${key} twice`)
    seen.add(key)
    let value = entry!.v
    if (tagged)
      try {
        value = decodeValue(value)
      } catch {
        bad(`line ${i + 2}`)
      }
    entries.push([key, value])
  })
  if (entries.length !== keys) bad(`expected ${keys} keys, found ${entries.length}`)
  if (rows.length !== rowCount) bad(`expected ${rowCount} rows, found ${rows.length}`)
  return { header: header as BackupHeader, entries, rows }
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
 * backup (keys made since are deleted), except that one-time upload passes and friends or blocks
 * naming an account the backup does not have are left out, and
 * `book:version` moves past both the backup's and the current version, so a browser holding the
 * current ETag cannot be told "not modified" about content that changed under it.
 */
export function planRestore(backup: Backup, current: [string, unknown][]): RestorePlan {
  const { prefixes } = backup.header
  // A friend or block whose member the backup does not have would point at nobody: the accounts
  // come back as of the backup, so its relations come back only between the accounts in it
  const members = prefixes.includes('user:')
    ? new Set(backup.entries.filter(([key]) => key.startsWith('user:')).map(([key]) => key.slice('user:'.length)))
    : null
  const dangling = (key: string) => {
    const kind = RELATION_PREFIXES.find((p) => key.startsWith(p))
    if (!kind || !members) return false
    const [userId, otherId] = key.slice(kind.length).split(':')
    return !members.has(userId) || !members.has(otherId)
  }
  const restored = backup.entries.filter(([key]) => !SKIPPED_ON_RESTORE.some((p) => key.startsWith(p)) && !dangling(key) && !kept(key))
  const keep = new Set(restored.map(([key]) => key))
  const deletes = current.map(([key]) => key).filter((key) => prefixes.some((p) => key.startsWith(p)) && !keep.has(key) && !kept(key))
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
  // Read right after the keys, with no await in between that would let another request in
  const sql = exportRows(store.sql)
  const text = serializeBackup(entries, new Date(now), BACKUP_PREFIXES, sql, countBoards(store.sql))
  const name = backupName(now)
  await bucket.put(name, text, { httpMetadata: { contentType: 'application/x-ndjson; charset=utf-8' } })
  // Only after the new backup is safely written
  const deleted = expiredBackups((await listBackups(bucket)).map((b) => b.name), now, keepDays)
  if (deleted.length) await bucket.delete(deleted)
  return { name, keys: entries.length, rows: sql.rows.length, bytes: new TextEncoder().encode(text).length, deleted }
}

/** The boards in the history index, or undefined for a store without SQL */
export function countBoards(sql: Sql) {
  try {
    return Number(sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM boards_index')[0]?.n ?? 0)
  } catch {
    return undefined
  }
}

/** Every object under a prefix, in key order */
export async function listObjects(bucket: BackupBucket, prefix: string) {
  const objects: { key: string; size: number; uploaded: Date }[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor })
    objects.push(...page.objects)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return objects
}

/** R2 room this club's backups take, by kind (each prefix on its own: 淡江's bucket also holds the other clubs') */
export async function backupUsage(bucket: BackupBucket) {
  const sum = async (prefix: string) => {
    const objects = await listObjects(bucket, prefix)
    return { objects: objects.length, bytes: objects.reduce((n, o) => n + o.size, 0) }
  }
  const [daily, activity, games] = await Promise.all([sum(DAILY), sum(ACTIVITY_OBJECTS), sum(GAME_OBJECTS)])
  return { daily, activity, games, bytes: daily.bytes + activity.bytes + games.bytes }
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
 * Restores a backup over the current data, under the backup's own prefixes only (a version 1
 * backup leaves the accounts alone). With `dryRun` it only says how many keys it would write and
 * delete. Callers must drop whatever they hold in memory from these keys afterwards (`Club` makes a
 * new BookService and, when accounts came back, calls `ClubService.reloadAccounts`). This is the
 * core only: from version 4 `BackupSteps.startRestore` goes on with the activity and the games.
 */
export async function restoreBackup(store: Store, bucket: BackupBucket, name: string, dryRun: boolean): Promise<RestoreResult> {
  if (!DAILY_KEY.test(name)) throw new ClubError('backupNotFound', { name }, 404)
  const object = await bucket.get(name)
  if (!object) throw new ClubError('backupNotFound', { name }, 404)
  const backup = parseBackup(await object.text())
  const tables = backup.header.tables ?? []
  // Checked before anything is written, in a dry run too
  const statements = rowStatements(store.sql, tables, backup.rows)
  const plan = planRestore(backup, await exportEntries(store, backup.header.prefixes))
  if (!dryRun) {
    for (const key of plan.deletes) await store.delete(key)
    for (const [key, value] of plan.puts) await store.put(key, value)
    if (tables.length)
      store.sql.transaction(() => {
        for (const table of tables) store.sql.exec(`DELETE FROM ${table}`)
        for (const [query, params] of statements) store.sql.exec(query, ...params)
      })
  }
  return {
    name,
    dryRun,
    createdAt: backup.header.createdAt,
    prefixes: backup.header.prefixes,
    puts: plan.puts.length,
    deletes: plan.deletes.length,
    tables,
    rows: backup.rows.length,
    version: backup.header.version,
  }
}

/**
 * The INSERTs that write a backup's rows back. Every table must be here now and every column one
 * it has (a column added since is left to its default), so a backup cannot name anything else:
 * the names in the statements are only ever the database's own.
 */
function rowStatements(sql: Sql, tables: string[], rows: [string, SqlRow][]): [string, SqlValue[]][] {
  const here = new Set(backupTables(sql).map((t) => t.name))
  const columns = new Map<string, string[]>()
  for (const table of tables) {
    if (!here.has(table)) throw new ClubError('badBackup', { why: `table ${table} is missing` })
    columns.set(table, sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name))
  }
  return rows.map(([table, row]) => {
    const known = columns.get(table)!
    const names = Object.keys(row).map((key) => {
      const name = known.find((c) => c === key)
      if (!name) throw new ClubError('badBackup', { why: `column ${table}.${key} is not there` })
      return name
    })
    return [`INSERT INTO ${table} (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((n) => row[n])]
  })
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
    /** After a real restore, with the prefixes and SQL tables it put back */
    restored: (prefixes: string[], tables: string[]) => void | Promise<void>
    /** The objects written and restored a step at a time; without it only the core */
    steps?: BackupSteps
  },
): Promise<unknown> {
  const { bucket } = club
  if (!bucket) throw new ClubError('backupUnavailable', {}, 503)
  if (method === 'GET' && path === '/backups')
    return { backups: await listBackups(bucket), keepDays: BACKUP_KEEP_DAYS, usage: await backupUsage(bucket), steps: club.steps?.status() ?? null }
  if (method === 'POST' && path === '/backups') {
    await club.steps?.startExport()
    return { backup: await runBackup(club.store, bucket, club.now) }
  }
  if (method === 'POST' && path === '/backups/restore') {
    const b = await body()
    const name = String(b.name ?? '')
    const dryRun = b.dryRun !== false
    if (!dryRun && b.confirm !== name) throw new ClubError('backupConfirm', { name })
    const result = await restoreBackup(club.store, bucket, name, dryRun)
    if (!dryRun) await club.restored(result.prefixes, result.tables)
    if (club.steps && result.version >= 4) {
      result.steps = await club.steps.plan(name)
      if (!dryRun) await club.steps.startRestore(name)
    }
    return { restore: result }
  }
  throw new ClubError('noSuchApi', {}, 404)
}
