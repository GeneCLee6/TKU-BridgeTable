import { isCall } from '../shared/auction.ts'
import type { Me, RobotMeaningsItem, RobotMeaningsQuery, SyncedSystemSpec } from '../shared/protocol.ts'
import { CLUB_PROFILE_ID, SYSTEM_SPEC_LIMITS } from '../shared/protocol.ts'
import { bookNotes, robotMeanings, type BookNotes } from '../shared/robot/system/book-spec.ts'
import { TKU } from '../shared/robot/system/tku/index.ts'
import type { SystemSpec } from '../shared/systemSpec.ts'
import { getParts, isObject, isString, putParts } from './book.ts'
import { ClubError } from './errors.ts'
import type { Store } from './store.ts'

/**
 * 淡江橋館's rules for TKB (BridgeHall e7-t03, AC-7.1). The handbook turns a system profile's
 * conventions into a `SystemSpec` (`toSystemSpec`, the same file in both repositories) and an
 * editor syncs it here from the report page (/integrations/table): the bundled conventions are
 * only in the handbook, and turning 22 conventions into rules takes more CPU than one request has
 * on the free plan. Kept as `book:spec:<profileId>` (in the daily backup with the rest of the
 * book), the body in parts.
 *
 * TKB in the club's system follows one profile, `systemProfileId` (`ClubConfig`, the club's by
 * default): its calls carry that profile's words for them (`bookNotes`), which the tables ask for
 * once a board (`ClubLink.bookNotes`).
 */

interface Header {
  profileId: string
  version: number
  syncedAt: number
  syncedBy: string
  parts: number
}

const headerKey = (profileId: string) => `book:spec:${profileId}`
const partsKey = (profileId: string) => `spec:${profileId}`
const PROFILE_ID = /^[\w-]{1,40}$/

const bad = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

const isRange = (value: unknown) =>
  Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))

function checkShows(value: unknown) {
  if (!isObject(value)) bad('規則的 shows 格式不正確')
  const shows = value as Record<string, unknown>
  if (shows.name !== undefined && !isString(shows.name)) bad('規則的特約名稱格式不正確')
  if (shows.hcp !== undefined && !isRange(shows.hcp)) bad('規則的點力格式不正確')
  if (shows.len !== undefined && (!isObject(shows.len) || !Object.entries(shows.len).every(([s, r]) => 'SHDC'.includes(s) && s.length === 1 && isRange(r))))
    bad('規則的張數格式不正確')
  if (shows.balanced !== undefined && typeof shows.balanced !== 'boolean') bad('規則的牌型格式不正確')
  if (shows.forcing !== undefined && shows.forcing !== 'oneRound' && shows.forcing !== 'game') bad('規則的迫叫格式不正確')
}

const isRef = (value: unknown) => isObject(value) && isString(value.slug) && isString(value.sectionId)

/** Checks a synced spec's shape (what it says is the handbook's); returns it typed */
export function checkSystemSpec(value: unknown, profileId: string): SystemSpec {
  if (!isObject(value)) return bad('缺少 spec')
  if (value.profileId !== profileId) bad('spec 的制度集與網址不同')
  if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version < 0) bad('spec 的版本格式不正確')
  if (!Array.isArray(value.rules) || !Array.isArray(value.unresolved)) bad('spec 缺少 rules 或 unresolved')
  for (const rule of value.rules as unknown[]) {
    if (!isObject(rule)) return bad('規則格式不正確')
    if (!Array.isArray(rule.after) || !rule.after.every(isString) || !rule.after.length) bad('規則的叫牌過程格式不正確')
    if (!isString(rule.call) || !isString(rule.text) || !isRef(rule.ref)) bad('規則格式不正確')
    if (rule.note !== undefined && !isString(rule.note)) bad('規則的備註格式不正確')
    if (rule.unparsed !== undefined && !isString(rule.unparsed)) bad('規則格式不正確')
    if (rule.filled !== undefined && rule.filled !== true) bad('規則格式不正確')
    checkShows(rule.shows)
  }
  for (const row of value.unresolved as unknown[]) {
    if (!isObject(row) || !isRef(row.ref) || !isString(row.call) || !isString(row.text) || !isString(row.reason)) bad('未解析的列格式不正確')
  }
  return value as unknown as SystemSpec
}

/**
 * POST /api/book/robot-meanings (e7-t04): what TKB's rules in the club's system say the asked calls
 * show. A few auctions a request (`SYSTEM_SPEC_LIMITS`), so one request stays within the free
 * plan's CPU; the report page asks for the rest in turn
 */
export function robotMeaningsFor(body: unknown): RobotMeaningsItem[] {
  const items = isObject(body) ? body.items : undefined
  if (!Array.isArray(items) || items.length > SYSTEM_SPEC_LIMITS.meaningItemsMax) return bad(`一次最多查 ${SYSTEM_SPEC_LIMITS.meaningItemsMax} 個叫牌過程`)
  const query: RobotMeaningsQuery = { items: [] }
  for (const item of items as unknown[]) {
    if (!isObject(item) || !isString(item.after) || item.after.length > 120) return bad('叫牌過程格式不正確')
    if (!Array.isArray(item.calls) || item.calls.length > SYSTEM_SPEC_LIMITS.meaningCallsMax || !item.calls.every(isCall))
      return bad('叫品格式不正確')
    query.items.push({ after: item.after, calls: item.calls as string[] })
  }
  return robotMeanings(TKU, query)
}

export class SystemSpecStore {
  private readonly store: Store
  private readonly now: () => number
  /** The profile TKB follows in the club's system */
  readonly tableProfileId: string
  /** The words for TKB's calls, made once from the table profile's synced spec; null when it has none */
  private notes: Promise<BookNotes | null> | null = null

  constructor(store: Store, now: () => number, tableProfileId: string = CLUB_PROFILE_ID) {
    this.store = store
    this.now = now
    this.tableProfileId = tableProfileId
  }

  async get(profileId: string): Promise<Omit<SyncedSystemSpec, 'syncedByName'> | null> {
    if (!PROFILE_ID.test(profileId)) return null
    const header = await this.store.get<Header>(headerKey(profileId))
    if (!header) return null
    const spec = await getParts<SystemSpec>(this.store, partsKey(profileId), header.parts)
    return { spec, syncedAt: header.syncedAt, syncedBy: header.syncedBy }
  }

  /** Keeps a profile's spec, replacing the last one; the profile is checked to exist by the caller */
  async save(actor: Me, profileId: string, body: unknown): Promise<Omit<SyncedSystemSpec, 'syncedByName'>> {
    if (!PROFILE_ID.test(profileId)) throw new ClubError('profileGone', {}, 404)
    if (!isObject(body)) return bad('缺少 spec')
    const spec = checkSystemSpec(body.spec, profileId)
    if (JSON.stringify(spec).length > SYSTEM_SPEC_LIMITS.bytesMax) throw new ClubError('contentTooLarge', {}, 413)
    const previous = await this.store.get<Header>(headerKey(profileId))
    const parts = await putParts(this.store, partsKey(profileId), spec, previous?.parts ?? 0)
    const header: Header = { profileId, version: spec.version, syncedAt: this.now(), syncedBy: actor.id, parts }
    await this.store.put(headerKey(profileId), header)
    if (profileId === this.tableProfileId) this.notes = null
    return { spec, syncedAt: header.syncedAt, syncedBy: header.syncedBy }
  }

  /**
   * The words for TKB's calls (`ClubLink.bookNotes`): null when the table profile has no synced
   * spec, 'same' when the asker already has these (`known` is their key)
   */
  async bookNotes(known: string | null): Promise<BookNotes | 'same' | null> {
    this.notes ??= (async () => {
      const synced = await this.get(this.tableProfileId)
      return synced ? bookNotes(synced.spec, `${this.tableProfileId}:${synced.spec.version}:${synced.syncedAt}`) : null
    })()
    const pending = this.notes
    // A failed read is tried again next time
    const notes = await pending.catch((error: unknown) => {
      if (this.notes === pending) this.notes = null
      throw error
    })
    if (!notes) return null
    return notes.key === known ? 'same' : notes
  }

  /** Reads the spec again next time (after a backup is restored) */
  forget() {
    this.notes = null
  }
}
