import {
  CLUB_PROFILE_ID,
  isProfileScope,
  type Me,
  PROFILE_LIMITS,
  type ProfileInput,
  type ProfileNote,
  type ProfileOverride,
  type ProfileRevision,
  type ProfileScope,
  type ProfileSummary,
  type SystemProfile,
} from '../shared/protocol.ts'
import { randomId } from './auth.ts'
import { checkSections, dropParts, getParts, isObject, isSectionId, isSlug, isString, isStrings, putParts } from './book.ts'
import { ClubError } from './service.ts'
import type { Store } from './store.ts'

/**
 * TKU BridgeBook's system profiles (制度集, handbook E1): which conventions a team or partnership
 * plays and where its agreements differ from the club's. The handbook resolves them
 * (TKU-BridgeBook src/lib/profiles.ts); this keeps them, with every saved version.
 *
 * Keys: `book:profile:<id>` is the summary (ProfileSummary plus how many parts its body has); the
 * body (`adopted`, `overrides`, `notes`) is in `bookpart:` parts, since a profile may reach 200 kB.
 * `book:profilerev:<id>:<version, 8 digits>` keeps each version, the whole profile in parts.
 *
 * The club's profile always exists: until someone saves it, it is an empty one at version 0. It
 * cannot be deleted. Like conventions, profiles are checked here for shape only: an override that
 * points at a section or row that is not there is the handbook's to report.
 */

interface Header {
  parts: number
}

type Body = Pick<SystemProfile, 'adopted' | 'overrides' | 'notes'>

/** Who may come after whom: a team inherits the club; a partnership the club or a team */
const PARENT_SCOPES: Record<Exclude<ProfileScope, 'club'>, ProfileScope[]> = {
  team: ['club'],
  partnership: ['club', 'team'],
}

const PROFILE_ID = /^[\w-]{1,40}$/
const REVISIONS_LISTED = 100
const SCOPE_ORDER: ProfileScope[] = ['club', 'team', 'partnership']

const summaryKey = (id: string) => `book:profile:${id}`
const revisionKey = (id: string, version: number) => `book:profilerev:${id}:${String(version).padStart(8, '0')}`
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length
const noteOf = (note: unknown) => String(note ?? '').trim().slice(0, 200)

/** The club's profile before anyone saves it */
export const emptyClubProfile = (): SystemProfile => ({
  id: CLUB_PROFILE_ID,
  name: '社團預設',
  scope: 'club',
  adopted: {},
  overrides: [],
  notes: [],
  version: 0,
  updatedAt: 0,
  updatedBy: '',
})

export function profileSummary({ adopted, overrides, notes, ...rest }: SystemProfile): ProfileSummary {
  return { ...rest, counts: { adopted: Object.keys(adopted).length, overrides: overrides.length, notes: notes.length } }
}

const fail = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

function checkOverride(value: unknown): ProfileOverride {
  if (!isObject(value) || !isSlug(value.slug)) return fail('每條覆寫要有特約代稱（slug）')
  const { slug } = value
  if (value.kind === 'row') {
    const { sectionId, blockIndex, rowIndex, meaning, note } = value
    if (!isSectionId(sectionId)) return fail('叫品列覆寫要有段落 id')
    if (!Number.isInteger(blockIndex) || (blockIndex as number) < 0 || !Number.isInteger(rowIndex) || (rowIndex as number) < 0)
      return fail('叫品列覆寫的位置（blockIndex、rowIndex）要是 0 以上的整數')
    if (!isString(meaning)) return fail('叫品列覆寫要有意義（meaning）')
    if (note !== undefined && !isString(note)) return fail('叫品列覆寫的備註要是文字')
    const row: ProfileOverride = { kind: 'row', slug, sectionId, blockIndex: blockIndex as number, rowIndex: rowIndex as number, meaning }
    if (note !== undefined) row.note = note
    return row
  }
  if (value.kind === 'section') {
    const { sectionId, section } = value
    if (!isSectionId(sectionId)) return fail('整段覆寫要有段落 id')
    if (!isObject(section) || section.id !== sectionId) return fail('整段覆寫的段落 id 要和 sectionId 相同')
    checkSections([section])
    return { kind: 'section', slug, sectionId, section }
  }
  if (value.kind === 'meta') {
    const { summary, tags } = value
    if (summary !== undefined && !isString(summary)) return fail('摘要覆寫要是文字')
    if (tags !== undefined && !isStrings(tags)) return fail('標籤覆寫要是文字清單')
    const meta: ProfileOverride = { kind: 'meta', slug }
    if (summary !== undefined) meta.summary = summary
    if (tags !== undefined) meta.tags = tags as string[]
    return meta
  }
  return fail('不明的覆寫種類')
}

function checkNote(value: unknown): ProfileNote {
  if (!isObject(value) || !isSlug(value.slug)) return fail('每則備忘要有特約代稱（slug）')
  const { slug, sectionId, text, by, at } = value
  if (sectionId !== undefined && !isSectionId(sectionId)) return fail('備忘的段落 id 格式不正確')
  if (!isString(text) || !text.trim()) return fail('備忘要有文字')
  if (text.length > PROFILE_LIMITS.noteMax) return fail(`每則備忘最多 ${PROFILE_LIMITS.noteMax} 字`)
  if (!isString(by) || typeof at !== 'number' || !Number.isFinite(at)) return fail('備忘要有作者與時間')
  const note: ProfileNote = { slug, text, by, at }
  if (sectionId !== undefined) note.sectionId = sectionId
  return note
}

/**
 * Throws `badContent` unless `value` has the shape of a profile's editable fields; returns them
 * with nothing else. Whether `scope` and `parentId` fit the other profiles is ProfileService's check.
 */
export function checkProfileInput(value: unknown): ProfileInput {
  if (!isObject(value)) return fail('不是一個制度集')
  const name = isString(value.name) ? value.name.trim() : ''
  if (!name || name.length > PROFILE_LIMITS.nameMax) fail(`制度集名稱要有 1 到 ${PROFILE_LIMITS.nameMax} 個字`)
  if (!isProfileScope(value.scope)) fail('制度集種類（scope）要是 club、team 或 partnership')
  if (value.parentId !== undefined && (!isString(value.parentId) || !PROFILE_ID.test(value.parentId)))
    fail('母制度集（parentId）格式不正確')
  if (!isObject(value.adopted)) fail('採用清單（adopted）格式不正確')
  const adopted: SystemProfile['adopted'] = {}
  for (const [slug, on] of Object.entries(value.adopted as Record<string, unknown>)) {
    if (!isSlug(slug) || (on !== 'on' && on !== 'off')) fail('採用清單的每一項要是特約代稱對 on 或 off')
    adopted[slug] = on as 'on' | 'off'
  }
  if (!Array.isArray(value.overrides)) fail('覆寫（overrides）要是清單')
  const overridesIn = value.overrides as unknown[]
  if (overridesIn.length > PROFILE_LIMITS.overridesMax)
    fail(`覆寫最多 ${PROFILE_LIMITS.overridesMax} 條，超過請另開一個特約`)
  if (!Array.isArray(value.notes)) fail('備忘（notes）要是清單')
  const input: ProfileInput = {
    name,
    scope: value.scope as ProfileScope,
    adopted,
    overrides: overridesIn.map(checkOverride),
    notes: (value.notes as unknown[]).map(checkNote),
  }
  if (value.parentId !== undefined) input.parentId = value.parentId as string
  return input
}

export class ProfileService {
  private readonly store: Store
  private readonly now: () => number
  private readonly nameOf: (userId: string) => string | undefined
  /** Every stored profile without its body, loaded on first use; the club's is here only once saved */
  private summaries: Map<string, ProfileSummary & Header> | null = null

  constructor(store: Store, now: () => number = Date.now, nameOf: (userId: string) => string | undefined = () => undefined) {
    this.store = store
    this.now = now
    this.nameOf = nameOf
  }

  private async load() {
    if (this.summaries) return this.summaries
    const summaries = new Map<string, ProfileSummary & Header>()
    for (const header of (await this.store.list<ProfileSummary & Header>('book:profile:')).values()) summaries.set(header.id, header)
    this.summaries = summaries
    return summaries
  }

  /** The club's first, then teams, then partnerships, each by name */
  async list(): Promise<ProfileSummary[]> {
    const summaries = await this.load()
    const list: ProfileSummary[] = [...summaries.values()].map(({ parts: _parts, ...summary }) => summary)
    if (!summaries.has(CLUB_PROFILE_ID)) list.push(profileSummary(emptyClubProfile()))
    return list.sort(
      (a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.name.localeCompare(b.name, 'zh-Hant') || a.id.localeCompare(b.id),
    )
  }

  async get(id: string): Promise<SystemProfile> {
    const header = (await this.load()).get(id)
    if (!header) {
      if (id === CLUB_PROFILE_ID) return emptyClubProfile()
      throw new ClubError('profileGone', {}, 404)
    }
    const { parts, counts: _counts, ...rest } = header
    return { ...rest, ...(await getParts<Body>(this.store, summaryKey(id), parts)) }
  }

  /** Adds a team's or partnership's profile at version 1 */
  async create(actor: Me, body: { profile?: unknown; note?: unknown }): Promise<SystemProfile> {
    const input = checkProfileInput(body.profile)
    if (input.scope === 'club') fail('社團預設的制度集只有一個')
    return this.write(actor.id, await this.newId(), input, 0, noteOf(body.note))
  }

  /**
   * Saves a profile. `baseVersion` is the version the editor started from (0 for the club's before
   * anyone saved it); if someone saved in between, nothing is written (409 `profileConflict`).
   */
  async save(actor: Me, id: string, body: { profile?: unknown; baseVersion?: unknown; note?: unknown }): Promise<SystemProfile> {
    const summaries = await this.load()
    const current = summaries.get(id)
    if (!current && id !== CLUB_PROFILE_ID) throw new ClubError('profileGone', {}, 404)
    const input = checkProfileInput(body.profile)
    this.checkBase(current, body.baseVersion)
    if (id === CLUB_PROFILE_ID ? input.scope !== 'club' : input.scope === 'club') fail('不能改變社團預設的制度集種類')
    // A team cannot become a partnership while partnerships still inherit it
    if (current && input.scope !== current.scope) {
      const child = this.children(id)[0]
      if (child) throw new ClubError('profileInUse', { name: child.name }, 409)
    }
    return this.write(actor.id, id, input, current?.version ?? 0, noteOf(body.note))
  }

  /** Deletes a profile and its versions; never the club's, nor one others still inherit */
  async remove(id: string, body: { baseVersion?: unknown }) {
    if (id === CLUB_PROFILE_ID) throw new ClubError('profileProtected', {}, 403)
    const summaries = await this.load()
    const current = summaries.get(id)
    if (!current) throw new ClubError('profileGone', {}, 404)
    this.checkBase(current, body.baseVersion)
    const child = this.children(id)[0]
    if (child) throw new ClubError('profileInUse', { name: child.name }, 409)
    for (const [key, header] of await this.store.list<Header>(`book:profilerev:${id}:`)) {
      await dropParts(this.store, key, header.parts)
      await this.store.delete(key)
    }
    await dropParts(this.store, summaryKey(id), current.parts)
    await this.store.delete(summaryKey(id))
    summaries.delete(id)
  }

  /** Newest first, without the profiles */
  async revisions(id: string): Promise<ProfileRevision[]> {
    if (id !== CLUB_PROFILE_ID && !(await this.load()).has(id)) throw new ClubError('profileGone', {}, 404)
    const list = await this.store.list<ProfileRevision & Header>(`book:profilerev:${id}:`, { reverse: true, limit: REVISIONS_LISTED })
    return [...list.values()].map(({ parts: _parts, ...meta }) => meta)
  }

  async revision(id: string, version: number): Promise<ProfileRevision> {
    const key = revisionKey(id, version)
    const header = Number.isInteger(version) && version > 0 ? await this.store.get<ProfileRevision & Header>(key) : undefined
    if (!header) throw new ClubError('profileGone', {}, 404)
    const { parts, ...meta } = header
    return { ...meta, profile: await getParts<SystemProfile>(this.store, key, parts) }
  }

  private children(id: string) {
    return [...(this.summaries?.values() ?? [])].filter((p) => p.parentId === id)
  }

  private checkBase(current: ProfileSummary | undefined, baseVersion: unknown) {
    if (Number(baseVersion) !== (current?.version ?? 0)) {
      const name = (current && this.nameOf(current.updatedBy)) ?? '別人'
      throw new ClubError('profileConflict', { name }, 409)
    }
  }

  /**
   * A team's or partnership's own profile, empty and at version 1, made with the team or when a
   * partnership is accepted (worker/teams.ts). Counts toward PROFILE_LIMITS.profilesMax like any other.
   */
  async createOwned(by: string, name: string, scope: Exclude<ProfileScope, 'club'>, parentId: string, note: string): Promise<SystemProfile> {
    const input: ProfileInput = { name: name.trim().slice(0, PROFILE_LIMITS.nameMax), scope, parentId, adopted: {}, overrides: [], notes: [] }
    return this.write(by, await this.newId(), input, 0, noteOf(note))
  }

  /** A free id for a new profile; throws when the club has as many as it may */
  private async newId() {
    const summaries = await this.load()
    const others = [...summaries.keys()].filter((id) => id !== CLUB_PROFILE_ID).length
    if (others >= PROFILE_LIMITS.profilesMax) fail(`制度集最多 ${PROFILE_LIMITS.profilesMax} 個`)
    let id = randomId(6)
    while (summaries.has(id)) id = randomId(6)
    return id
  }

  private async write(by: string, id: string, input: ProfileInput, version: number, note: string): Promise<SystemProfile> {
    const summaries = await this.load()
    const profile: SystemProfile = { id, ...input, version: version + 1, updatedAt: this.now(), updatedBy: by }
    if (id === CLUB_PROFILE_ID) delete profile.parentId
    else {
      const parentId = profile.parentId ?? CLUB_PROFILE_ID
      const parent = parentId === CLUB_PROFILE_ID ? { scope: 'club' as const } : summaries.get(parentId)
      if (!parent || parentId === id) fail('找不到母制度集')
      if (!PARENT_SCOPES[profile.scope as Exclude<ProfileScope, 'club'>].includes(parent!.scope))
        fail('隊伍的制度集要繼承社團預設；搭檔的制度集繼承社團預設或隊伍')
      profile.parentId = parentId
    }
    if (bytesOf(profile) > PROFILE_LIMITS.bytesMax) throw new ClubError('contentTooLarge', {}, 413)

    const key = summaryKey(id)
    const { adopted, overrides, notes } = profile
    const parts = await putParts(this.store, key, { adopted, overrides, notes } satisfies Body, summaries.get(id)?.parts)
    const header: ProfileSummary & Header = { ...profileSummary(profile), parts }
    await this.store.put(key, header)
    summaries.set(id, header)

    const revision = revisionKey(id, profile.version)
    const revisionParts = await putParts(this.store, revision, profile)
    await this.store.put<Omit<ProfileRevision, 'profile'> & Header>(revision, {
      profileId: id,
      version: profile.version,
      at: profile.updatedAt,
      by,
      note,
      parts: revisionParts,
    })
    return profile
  }
}

/** A profile as someone who has not signed in sees it: the club's only, without its private notes */
export async function anonymousProfileResponse(profiles: ProfileService, request: Request, pathname: string): Promise<SystemProfile | ProfileSummary[] | null> {
  if (request.method !== 'GET') return null
  if (pathname === '/api/book/profiles') {
    const club = profileSummary(await profiles.get(CLUB_PROFILE_ID))
    return [{ ...club, counts: { ...club.counts, notes: 0 } }]
  }
  if (pathname === `/api/book/profiles/${CLUB_PROFILE_ID}`) return { ...(await profiles.get(CLUB_PROFILE_ID)), notes: [] }
  return null
}
