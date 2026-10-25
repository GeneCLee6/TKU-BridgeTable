import type { Me } from '../shared/protocol.ts'
import { randomId } from './auth.ts'
import type { ImportCategory, ImportRequest } from './importer.ts'
import { ClubError } from './service.ts'
import type { Store } from './store.ts'

/**
 * TKU BridgeBook (淡江橋譜) content edited on the site. The handbook ships its conventions in its own
 * bundle; this keeps what members change online: one entry per convention that replaces the
 * bundled one with the same slug, adds a new one, or hides one (`convention: null`), plus every
 * saved version, the handbook's categories once they are edited online (`book:category:<id>`), the
 * drafts made by AI import and the short-lived passes the import page uses.
 * The handbook merges the entries over its bundle when it loads (TKU-BridgeBook ARCHITECTURE.md).
 *
 * Conventions are checked here only for shape (so a bad save cannot break the handbook); what they
 * say is up to the editors. Storage values are limited to 128 KiB, so large bodies are split into
 * parts (`bookpart:`) next to a small header.
 */

/** One convention as edited online. `convention` is null when it is hidden from the handbook. */
export interface BookEntry {
  slug: string
  version: number
  convention: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
  updatedBy: string
  /** The `updated` date of the bundled convention the first edit started from, if there was one */
  bundledUpdated?: string
}

/** A section's place in the outline, without its content */
export interface SectionOutline {
  id: string
  title: string
  children?: SectionOutline[]
}

/** A 待確認 note's position; the same as the handbook's PendingNote (src/lib/sections.ts) */
export interface PendingNoteRef {
  sectionId: string
  /** Position among the notes that belong directly to this section, in page order */
  index: number
  /** Section titles from the top level down to this section */
  trail: string[]
  text: string
}

/** The handbook's ConventionKind and Level (TKU-BridgeBook src/types/convention.ts) */
export type ConventionKind = 'system' | 'convention' | 'signal' | 'defense'
export type ConventionLevel = 'basic' | 'intermediate' | 'advanced'
const KINDS: readonly string[] = ['system', 'convention', 'signal', 'defense']
const LEVELS: readonly string[] = ['basic', 'intermediate', 'advanced']

/** Everything about a convention except its content: the Convention fields minus `sections` */
export interface ConventionMeta {
  slug: string
  nameZh: string
  nameEn: string
  aliases?: string[]
  category: string
  /** The handbook's Convention.kind; absent means 'convention' */
  kind?: ConventionKind
  level?: ConventionLevel
  /** Slugs of the conventions to read first */
  prerequisites?: string[]
  /** Convention card slots (handbook E3) */
  cardSlots?: string[]
  tags: string[]
  summary: string
  source: { title: string; note?: string }
  updated: string
  outline: SectionOutline[]
  pending: PendingNoteRef[]
}

/** A manifest entry: the online entry without its content; `meta` is null when hidden */
export type BookEntrySummary = Omit<BookEntry, 'convention'> & { meta: ConventionMeta | null }

/**
 * A group in the handbook's catalogue (TKU-BridgeBook src/types/convention.ts Category). Conventions
 * point at it by `id`, which never changes; `order` is its place in the list, from 0.
 */
export interface BookCategory {
  id: string
  label: string
  description: string
  order: number
}

/**
 * GET /api/book/categories. An empty list means the categories were never edited online, so the
 * handbook uses the ones it ships with. `version` counts the saves, for `baseVersion`.
 */
export interface BookCategories {
  version: number
  categories: BookCategory[]
  updatedAt?: number
  updatedBy?: string
}

/** GET /api/book/manifest; `categories` is the same list as GET /api/book/categories */
export interface BookManifest {
  version: number
  entries: BookEntrySummary[]
  categories: BookCategory[]
}

export type RevisionAction = 'save' | 'hide' | 'reset'

/** A saved version; the list leaves out `convention` */
export interface BookRevision {
  id: string
  slug: string
  version: number
  action: RevisionAction
  at: number
  by: string
  note: string
  convention?: Record<string, unknown> | null
}

export interface ImportDraftSummary {
  id: string
  fileName: string
  createdAt: number
  createdBy: string
  /** How many conventions the AI made from the file */
  conventions: number
}

export interface ImportDraft extends ImportDraftSummary {
  result: unknown
}

interface Header {
  parts: number
}

interface Ticket {
  userId: string
  expires: number
}

const CHUNK = 40_000
export const BOOK_LIMITS = {
  /** Characters of JSON for one convention */
  conventionMax: 600_000,
  draftMax: 2_000_000,
  revisionsListed: 100,
  draftsKept: 30,
  ticketMs: 10 * 60_000,
  sectionDepthMax: 8,
}

/** Category limits; the import sends at most `max` categories to Claude (importRequestFrom) */
export const CATEGORY_LIMITS = { max: 20, idMax: 40, labelMax: 40, descriptionMax: 200 }
const CATEGORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SECTION_ID = /^[a-z0-9][a-z0-9-]*$/
const BLOCK_KINDS = ['paragraph', 'rules', 'responses', 'note', 'hand']
const TEXT_FIELDS = ['nameZh', 'nameEn', 'category', 'summary', 'updated']

export const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export const isString = (value: unknown): value is string => typeof value === 'string'
const isOptionalString = (value: unknown) => value === undefined || isString(value)
export const isStrings = (value: unknown) => Array.isArray(value) && value.every(isString)
const isOptionalLevel = (value: unknown) => value === undefined || LEVELS.includes(value as string)

export const isSectionId = (value: unknown): value is string => isString(value) && value.length <= 80 && SECTION_ID.test(value)
export const isSlug = (value: unknown): value is string => isString(value) && value.length <= 60 && SLUG.test(value)

/** Throws `badContent` with a short reason unless `value` has the shape of a Convention */
export function checkConvention(value: unknown, slug: string): Record<string, unknown> {
  const fail = (reason: string): never => {
    throw new ClubError('badContent', { reason })
  }
  if (!isObject(value)) return fail('不是一個特約')
  if (value.slug !== slug) fail('網址代稱（slug）不符')
  for (const key of TEXT_FIELDS) if (!isString(value[key])) fail(`缺少 ${key}`)
  if (!String(value.nameZh).trim()) fail('缺少中文名稱')
  if (!isStrings(value.tags)) fail('標籤（tags）要是文字清單')
  if (value.aliases !== undefined && !isStrings(value.aliases)) fail('別名（aliases）要是文字清單')
  if (value.kind !== undefined && !KINDS.includes(value.kind as string)) fail('種類（kind）不存在')
  if (!isOptionalLevel(value.level)) fail('程度（level）不存在')
  if (value.prerequisites !== undefined && !isStrings(value.prerequisites)) fail('前置特約（prerequisites）要是文字清單')
  if (value.cardSlots !== undefined && !isStrings(value.cardSlots)) fail('制度卡位置（cardSlots）要是文字清單')
  if (!isObject(value.source) || !isString(value.source.title) || !isOptionalString(value.source.note))
    fail('缺少來源（source.title）')
  if (!Array.isArray(value.sections)) fail('缺少段落（sections）')
  checkSections(value.sections as unknown[])
  return value
}

/**
 * Throws `badContent` unless `sections` is a list of handbook Sections, with ids that are unique
 * among them and their children. Also used for a system profile's replaced sections (profiles.ts)
 */
export function checkSections(sections: unknown[]) {
  const fail = (reason: string): never => {
    throw new ClubError('badContent', { reason })
  }
  const ids = new Set<string>()
  const rules = (items: unknown): void => {
    if (!Array.isArray(items)) return fail('條列要是清單')
    for (const item of items) {
      if (!isObject(item) || !isString(item.text) || !isOptionalString(item.pending)) fail('條列項目缺少文字')
      if ((item as Record<string, unknown>).children !== undefined) rules((item as Record<string, unknown>).children)
    }
  }
  const block = (b: unknown) => {
    if (!isObject(b) || !BLOCK_KINDS.includes(String(b.kind))) return fail('不明的內容區塊')
    if (b.kind === 'paragraph' && (!isString(b.text) || !isOptionalString(b.pending))) fail('段落缺少文字')
    if (b.kind === 'rules') rules(b.items)
    if (b.kind === 'note' && (!isString(b.text) || (b.tone !== 'info' && b.tone !== 'warning'))) fail('注意事項格式不正確')
    if (b.kind === 'hand') {
      const hand = b.hand
      if (!isObject(hand) || !['spades', 'hearts', 'diamonds', 'clubs'].every((suit) => isString(hand[suit])))
        fail('牌例要有四門花色')
    }
    if (b.kind === 'responses') {
      if (!Array.isArray(b.rows)) return fail('叫品表缺少列')
      for (const row of b.rows)
        if (!isObject(row) || !isString(row.call) || !isString(row.meaning) || !isOptionalString(row.note) || !isOptionalString(row.pending))
          fail('叫品表的每一列要有叫品與意義')
      if (b.auction !== undefined) {
        const auction = b.auction
        if (!isObject(auction) || !isStrings(auction.seats) || (auction.seats as string[]).length !== 4 || !Array.isArray(auction.calls))
          return fail('叫牌過程要有四個座位')
        for (const call of auction.calls as unknown[])
          if (!isString(call) && !(isObject(call) && isString(call.call) && isOptionalString(call.note))) fail('叫牌過程的叫品格式不正確')
      }
    }
  }
  const section = (s: unknown, depth: number) => {
    if (depth > BOOK_LIMITS.sectionDepthMax) fail('段落層數太多')
    if (!isObject(s) || !isString(s.id) || !SECTION_ID.test(s.id) || !isString(s.title))
      return fail('每個段落要有 id（小寫英數與連字號）與標題')
    if (ids.has(s.id)) fail(`段落 id 重複：${s.id}`)
    ids.add(s.id)
    for (const key of ['originalTitle', 'summary', 'pending']) if (!isOptionalString(s[key])) fail(`段落的 ${key} 要是文字`)
    if (!isOptionalLevel(s.level)) fail('段落的程度（level）不存在')
    if (s.blocks !== undefined) {
      if (!Array.isArray(s.blocks)) fail('段落的內容要是清單')
      for (const b of s.blocks as unknown[]) block(b)
    }
    if (s.children !== undefined) {
      if (!Array.isArray(s.children)) fail('子段落要是清單')
      for (const child of s.children as unknown[]) section(child, depth + 1)
    }
  }
  for (const s of sections) section(s, 1)
}

interface SectionLike {
  id: string
  title: string
  pending?: string
  blocks?: { kind: string; pending?: string; rows?: { pending?: string }[]; items?: RuleLike[] }[]
  children?: SectionLike[]
}
interface RuleLike {
  pending?: string
  children?: RuleLike[]
}

function outlineOf(sections: SectionLike[]): SectionOutline[] {
  return sections.map((s) => {
    const item: SectionOutline = { id: s.id, title: s.title }
    if (s.children?.length) item.children = outlineOf(s.children)
    return item
  })
}

const flattenRules = (items: RuleLike[]): RuleLike[] => items.flatMap((i) => [i, ...flattenRules(i.children ?? [])])

/** Every 待確認 note in page order; a faithful copy of the handbook's pendingNotes() */
function pendingOf(sections: SectionLike[]): PendingNoteRef[] {
  const notes: PendingNoteRef[] = []
  const walk = (list: SectionLike[], ancestors: SectionLike[]) => {
    for (const section of list) {
      let index = 0
      const trail = [...ancestors, section].map((s) => s.title)
      const add = (text?: string) => {
        if (text) notes.push({ sectionId: section.id, index: index++, trail, text })
      }
      add(section.pending)
      for (const block of section.blocks ?? []) {
        if (block.kind === 'paragraph') add(block.pending)
        if (block.kind === 'responses') (block.rows ?? []).forEach((r) => add(r.pending))
        if (block.kind === 'rules') flattenRules(block.items ?? []).forEach((i) => add(i.pending))
      }
      if (section.children) walk(section.children, [...ancestors, section])
    }
  }
  walk(sections, [])
  return notes
}

/** A convention's manifest data: everything but `sections`, plus its outline and 待確認 notes */
export function conventionMeta(convention: Record<string, unknown>): ConventionMeta {
  const { sections, ...rest } = convention
  const list = (Array.isArray(sections) ? sections : []) as SectionLike[]
  return { ...(rest as Omit<ConventionMeta, 'outline' | 'pending'>), outline: outlineOf(list), pending: pendingOf(list) }
}

export function entrySummary({ convention, ...rest }: BookEntry): BookEntrySummary {
  return { ...rest, meta: convention ? conventionMeta(convention) : null }
}

/** JSON with a weak ETag; 304 when the browser already has it */
function cachedJson(request: Request, etag: string, body: () => string) {
  const headers = { ETag: etag, 'Cache-Control': 'no-cache' }
  if (request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers })
  return new Response(body(), { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } })
}

/**
 * Throws `badContent` unless `value` is a list of categories: ids in lower-case letters, digits and
 * hyphens, each once, with a label. Their `order` is their place in the list.
 */
export function checkCategories(value: unknown): BookCategory[] {
  const fail = (reason: string): never => {
    throw new ClubError('badContent', { reason })
  }
  if (!Array.isArray(value) || !value.length) return fail('至少要有一個分類')
  if (value.length > CATEGORY_LIMITS.max) fail(`分類最多 ${CATEGORY_LIMITS.max} 個`)
  const ids = new Set<string>()
  return value.map((c, order) => {
    if (!isObject(c) || !isString(c.id) || c.id.length > CATEGORY_LIMITS.idMax || !CATEGORY_ID.test(c.id))
      return fail('分類代號只能用小寫英數與連字號')
    if (ids.has(c.id)) fail(`分類代號重複：${c.id}`)
    ids.add(c.id)
    const label = isString(c.label) ? c.label.trim() : ''
    if (!label || label.length > CATEGORY_LIMITS.labelMax) fail(`分類名稱要有 1 到 ${CATEGORY_LIMITS.labelMax} 個字`)
    if (!isOptionalString(c.description)) fail('分類說明要是文字')
    const description = String(c.description ?? '').trim()
    if (description.length > CATEGORY_LIMITS.descriptionMax) fail(`分類說明最多 ${CATEGORY_LIMITS.descriptionMax} 個字`)
    return { id: c.id, label, description, order }
  })
}

/**
 * The handbook routes anyone may read, without signing in: every online entry
 * (`/api/book/content`, kept for older handbooks), the manifest, the categories and one entry by slug.
 * Returns null for any other request.
 */
export async function publicBookResponse(book: BookService, request: Request, pathname: string): Promise<Response | null> {
  if (request.method !== 'GET') return null
  if (pathname === '/api/book/content') {
    const { json, version } = await book.content()
    return cachedJson(request, `W/"book-${version}"`, () => json)
  }
  if (pathname === '/api/book/manifest') {
    const { json, version } = await book.manifest()
    return cachedJson(request, `W/"book-manifest-${version}"`, () => json)
  }
  if (pathname === '/api/book/categories') {
    const categories = await book.categories()
    return cachedJson(request, `W/"book-categories-${categories.version}"`, () => JSON.stringify(categories))
  }
  const one = pathname.match(/^\/api\/book\/content\/([^/]+)$/)
  if (one) {
    const slug = one[1]
    const entry = isSlug(slug) ? await book.entry(slug) : undefined
    if (!entry) throw new ClubError('conventionGone', {}, 404)
    return cachedJson(request, `W/"book-${slug}-${entry.version}"`, () => JSON.stringify({ entry }))
  }
  return null
}

// ── Large values ──────────────────────────────────────────────────────────────────────────────
// Storage values are limited to 128 KiB, so a large JSON body is kept in parts (`bookpart:<key>:<i>`)
// next to a small header that says how many there are.

/** Writes `value` in parts and removes any parts a longer previous value left behind; returns the count */
export async function putParts(store: Store, key: string, value: unknown, previousParts = 0) {
  const text = JSON.stringify(value)
  const parts = Math.max(1, Math.ceil(text.length / CHUNK))
  for (let i = 0; i < parts; i++) await store.put(`bookpart:${key}:${i}`, text.slice(i * CHUNK, (i + 1) * CHUNK))
  for (let i = parts; i < previousParts; i++) await store.delete(`bookpart:${key}:${i}`)
  return parts
}

export async function getParts<T>(store: Store, key: string, parts: number): Promise<T> {
  let text = ''
  for (let i = 0; i < parts; i++) text += (await store.get<string>(`bookpart:${key}:${i}`)) ?? ''
  return JSON.parse(text) as T
}

export async function dropParts(store: Store, key: string, parts: number) {
  for (let i = 0; i < parts; i++) await store.delete(`bookpart:${key}:${i}`)
}

export class BookService {
  private readonly store: Store
  private readonly now: () => number
  private entries: Map<string, BookEntry> | null = null
  /** Sorted by `order`; empty until someone edits them online */
  private categoryList: BookCategory[] = []
  private categoryInfo: Omit<BookCategories, 'categories'> = { version: 0 }
  private version = 0
  /** GET /api/book/content as sent last time; cleared on every change */
  private contentJson: string | null = null
  /** GET /api/book/manifest as sent last time; cleared on every change */
  private manifestJson: string | null = null
  private lastStamp = 0

  constructor(store: Store, now: () => number = Date.now) {
    this.store = store
    this.now = now
  }

  /** Ids that sort by time: zero-padded and strictly increasing, even within one millisecond */
  private orderedId() {
    this.lastStamp = Math.max(this.now(), this.lastStamp + 1)
    return `${String(this.lastStamp).padStart(14, '0')}-${randomId(3)}`
  }

  private putBody(key: string, value: unknown, previousParts = 0) {
    return putParts(this.store, key, value, previousParts)
  }

  private getBody<T>(key: string, parts: number): Promise<T> {
    return getParts<T>(this.store, key, parts)
  }

  private dropBody(key: string, parts: number) {
    return dropParts(this.store, key, parts)
  }

  // ── Content ─────────────────────────────────────────────────────────────────────────────────

  /** Loaded on first use, so games never pay for reading the handbook */
  private async load() {
    if (this.entries) return this.entries
    const entries = new Map<string, BookEntry>()
    for (const [key, header] of await this.store.list<Omit<BookEntry, 'convention'> & Header>('book:entry:')) {
      const { parts, ...meta } = header
      entries.set(meta.slug, { ...meta, convention: await this.getBody(key, parts) })
    }
    this.version = (await this.store.get<number>('book:version')) ?? 0
    const categories = await this.store.list<BookCategory>('book:category:')
    this.categoryList = [...categories.values()].sort((a, b) => a.order - b.order)
    this.categoryInfo = (await this.store.get<Omit<BookCategories, 'categories'>>('book:categoryInfo')) ?? { version: 0 }
    this.entries = entries
    return entries
  }

  /** Every online change, as one JSON text; `version` changes whenever anything does */
  async content(): Promise<{ json: string; version: number }> {
    const entries = await this.load()
    this.contentJson ??= JSON.stringify({ version: this.version, entries: [...entries.values()] })
    return { json: this.contentJson, version: this.version }
  }

  /** Every online entry without its content, as one JSON text; same `version` as content() */
  async manifest(): Promise<{ json: string; version: number }> {
    const entries = await this.load()
    this.manifestJson ??= JSON.stringify({
      version: this.version,
      entries: [...entries.values()].map(entrySummary),
      categories: this.categoryList,
    } satisfies BookManifest)
    return { json: this.manifestJson, version: this.version }
  }

  /** One online entry; undefined when the convention has none (the handbook shows its bundled copy) */
  async entry(slug: string): Promise<BookEntry | undefined> {
    return (await this.load()).get(slug)
  }

  /** The categories as edited online; an empty list when they never were */
  async categories(): Promise<BookCategories> {
    await this.load()
    return { ...this.categoryInfo, categories: this.categoryList }
  }

  /**
   * Replaces the whole list of categories: adding, renaming, reordering and removing are one save.
   * `baseVersion` is the categories' version the editor started from (0 for the bundled ones). A
   * category cannot be removed while a convention edited online is still in it; the handbook checks
   * its bundled conventions itself, since only it knows them.
   */
  async saveCategories(actor: Me, body: { categories?: unknown; baseVersion?: unknown }): Promise<BookCategories> {
    const next = checkCategories(body.categories)
    const entries = await this.load()
    if (Number(body.baseVersion) !== this.categoryInfo.version)
      throw new ClubError('categoryConflict', { name: this.categoryInfo.updatedBy ?? '別人' }, 409)
    const kept = new Set(next.map((c) => c.id))
    for (const entry of entries.values()) {
      const category = entry.convention?.category
      if (isString(category) && !kept.has(category)) {
        const name = this.categoryList.find((c) => c.id === category)?.label ?? category
        throw new ClubError('categoryInUse', { name, convention: String(entry.convention?.nameZh ?? entry.slug) }, 409)
      }
    }
    for (const old of this.categoryList) if (!kept.has(old.id)) await this.store.delete(`book:category:${old.id}`)
    for (const category of next) await this.store.put(`book:category:${category.id}`, category)
    this.categoryInfo = { version: this.categoryInfo.version + 1, updatedAt: this.now(), updatedBy: actor.username }
    await this.store.put('book:categoryInfo', this.categoryInfo)
    this.categoryList = next
    await this.changed()
    return this.categories()
  }

  private async changed() {
    this.version++
    this.contentJson = null
    this.manifestJson = null
    await this.store.put('book:version', this.version)
  }

  private async write(entry: BookEntry) {
    const key = `book:entry:${entry.slug}`
    const old = await this.store.get<Header>(key)
    const { convention, ...meta } = entry
    const parts = await this.putBody(key, convention, old?.parts)
    await this.store.put(key, { ...meta, parts })
  }

  private async record(revision: BookRevision) {
    const key = `book:rev:${revision.slug}:${revision.id}`
    const { convention, ...meta } = revision
    const parts = convention === undefined ? 0 : await this.putBody(key, convention)
    await this.store.put(key, { ...meta, parts })
  }

  private checkBase(entry: BookEntry | undefined, baseVersion: unknown) {
    if (Number(baseVersion) !== (entry?.version ?? 0))
      throw new ClubError('bookConflict', { name: entry?.updatedBy ?? '別人' }, 409)
  }

  /**
   * Saves a convention. `baseVersion` is the version the editor started from (0 for the bundled
   * one or a new convention); if someone saved in between, nothing is written.
   */
  async save(
    actor: Me,
    slug: string,
    body: { convention?: unknown; baseVersion?: unknown; bundledUpdated?: unknown; note?: unknown },
  ) {
    if (!isSlug(slug)) throw new ClubError('badContent', { reason: '網址代稱（slug）只能用小寫英數與連字號' })
    if (JSON.stringify(body.convention ?? null).length > BOOK_LIMITS.conventionMax)
      throw new ClubError('contentTooLarge', {}, 413)
    const convention = checkConvention(body.convention, slug)
    const entries = await this.load()
    const current = entries.get(slug)
    this.checkBase(current, body.baseVersion)
    const time = this.now()
    const entry: BookEntry = {
      slug,
      version: (current?.version ?? 0) + 1,
      convention,
      createdAt: current?.createdAt ?? time,
      updatedAt: time,
      updatedBy: actor.username,
    }
    const bundled = current ? current.bundledUpdated : body.bundledUpdated
    if (isString(bundled)) entry.bundledUpdated = bundled
    await this.write(entry)
    entries.set(slug, entry)
    await this.record({ id: this.orderedId(), slug, version: entry.version, action: 'save', at: time, by: actor.username, note: noteOf(body.note), convention })
    await this.changed()
    return entry
  }

  /** Hides a convention from the handbook; its versions stay, so it can be brought back */
  async hide(actor: Me, slug: string, body: { baseVersion?: unknown; note?: unknown }) {
    if (!isSlug(slug)) throw new ClubError('conventionGone', {}, 404)
    const entries = await this.load()
    const current = entries.get(slug)
    this.checkBase(current, body.baseVersion)
    const time = this.now()
    const entry: BookEntry = {
      slug,
      version: (current?.version ?? 0) + 1,
      convention: null,
      createdAt: current?.createdAt ?? time,
      updatedAt: time,
      updatedBy: actor.username,
    }
    if (current?.bundledUpdated) entry.bundledUpdated = current.bundledUpdated
    await this.write(entry)
    entries.set(slug, entry)
    await this.record({ id: this.orderedId(), slug, version: entry.version, action: 'hide', at: time, by: actor.username, note: noteOf(body.note), convention: null })
    await this.changed()
    return entry
  }

  /** Drops the online entry, so the handbook shows its bundled version again (or nothing) */
  async reset(actor: Me, slug: string, body: { baseVersion?: unknown; note?: unknown }) {
    const entries = await this.load()
    const current = entries.get(slug)
    if (!current) throw new ClubError('conventionGone', {}, 404)
    this.checkBase(current, body.baseVersion)
    const key = `book:entry:${slug}`
    const header = await this.store.get<Header>(key)
    await this.dropBody(key, header?.parts ?? 0)
    await this.store.delete(key)
    entries.delete(slug)
    const time = this.now()
    await this.record({ id: this.orderedId(), slug, version: 0, action: 'reset', at: time, by: actor.username, note: noteOf(body.note) })
    await this.changed()
  }

  /** Newest first */
  async revisions(slug: string): Promise<BookRevision[]> {
    const list = await this.store.list<BookRevision & Header>(`book:rev:${slug}:`, {
      reverse: true,
      limit: BOOK_LIMITS.revisionsListed,
    })
    return [...list.values()].map(({ parts: _parts, ...meta }) => meta)
  }

  async revision(slug: string, id: string): Promise<BookRevision> {
    const key = `book:rev:${slug}:${id}`
    const header = await this.store.get<BookRevision & Header>(key)
    if (!header) throw new ClubError('conventionGone', {}, 404)
    const { parts, ...meta } = header
    return parts ? { ...meta, convention: await this.getBody(key, parts) } : meta
  }

  // ── AI import ───────────────────────────────────────────────────────────────────────────────

  /**
   * A single-use pass for the import upload. The upload goes straight to the Worker instead of
   * through the handbook's proxy (which gives up after two minutes), so it carries this instead of
   * the session cookie.
   */
  async createTicket(actor: Me) {
    const token = randomId(24)
    await this.store.put<Ticket>(`book:ticket:${token}`, { userId: actor.id, expires: this.now() + BOOK_LIMITS.ticketMs })
    return token
  }

  /** The member the pass was made for; the pass is used up */
  async useTicket(token: string) {
    const key = `book:ticket:${token}`
    const ticket = /^[0-9a-f]{48}$/.test(token) ? await this.store.get<Ticket>(key) : undefined
    if (ticket) await this.store.delete(key)
    if (!ticket || ticket.expires < this.now()) throw new ClubError('ticketExpired', {}, 401)
    return ticket.userId
  }

  async saveDraft(actor: Me, body: { fileName?: unknown; result?: unknown }) {
    const result = body.result
    if (!isObject(result) || !Array.isArray(result.conventions)) throw new ClubError('badContent', { reason: '匯入結果格式不正確' })
    if (JSON.stringify(result).length > BOOK_LIMITS.draftMax) throw new ClubError('contentTooLarge', {}, 413)
    const time = this.now()
    const summary: ImportDraftSummary = {
      id: this.orderedId(),
      fileName: String(body.fileName ?? '').slice(0, 200),
      createdAt: time,
      createdBy: actor.username,
      conventions: result.conventions.length,
    }
    const key = `book:draft:${summary.id}`
    const parts = await this.putBody(key, result)
    await this.store.put(key, { ...summary, parts })
    // Keep the newest drafts only
    const all = await this.store.list<ImportDraftSummary & Header>('book:draft:', { reverse: true })
    for (const [oldKey, old] of [...all].slice(BOOK_LIMITS.draftsKept)) {
      await this.dropBody(oldKey, old.parts)
      await this.store.delete(oldKey)
    }
    return summary
  }

  async drafts(): Promise<ImportDraftSummary[]> {
    const all = await this.store.list<ImportDraftSummary & Header>('book:draft:', { reverse: true })
    return [...all.values()].map(({ parts: _parts, ...summary }) => summary)
  }

  async draft(id: string): Promise<ImportDraft> {
    const key = `book:draft:${id}`
    const header = await this.store.get<ImportDraftSummary & Header>(key)
    if (!header) throw new ClubError('draftGone', {}, 404)
    const { parts, ...summary } = header
    return { ...summary, result: await this.getBody(key, parts) }
  }

  async deleteDraft(id: string) {
    const key = `book:draft:${id}`
    const header = await this.store.get<Header>(key)
    if (!header) throw new ClubError('draftGone', {}, 404)
    await this.dropBody(key, header.parts)
    await this.store.delete(key)
  }
}

const noteOf = (note: unknown) => String(note ?? '').trim().slice(0, 200)

export const IMPORT_LIMITS = { pdfMb: 20, textMax: 400_000, catalogueMax: 60_000, instructionsMax: 2_000 }

/**
 * The import upload, a multipart form: `ticket`, `meta` (JSON: fileName, instructions, catalogue,
 * categories) and either `file` (a PDF) or `text` (taken out of a .doc or .docx in the browser).
 */
export function importRequestFrom(form: FormData | null): { ticket: string; request: ImportRequest } {
  const bad = () => new ClubError('badFile', { max: IMPORT_LIMITS.pdfMb }, 400)
  if (!form) throw bad()
  let meta: Record<string, unknown>
  try {
    meta = JSON.parse(String(form.get('meta') ?? '{}'))
  } catch {
    throw bad()
  }
  const categories = Array.isArray(meta.categories)
    ? meta.categories.filter(
        (c): c is ImportCategory => isObject(c) && isString(c.id) && /^[a-z0-9-]{1,40}$/.test(c.id) && isString(c.label),
      )
    : []
  if (!categories.length) throw new ClubError('badContent', { reason: '缺少分類' })
  const file = form.get('file')
  const text = form.get('text')
  let source: ImportRequest['source']
  if (file instanceof Blob && file.size > 0) {
    if (file.size > IMPORT_LIMITS.pdfMb * 1024 * 1024) throw bad()
    source = { kind: 'pdf', file }
  } else if (isString(text) && text.trim() && text.length <= IMPORT_LIMITS.textMax) source = { kind: 'text', text }
  else throw bad()
  return {
    ticket: String(form.get('ticket') ?? ''),
    request: {
      fileName: String(meta.fileName ?? '').slice(0, 200),
      instructions: String(meta.instructions ?? '').slice(0, IMPORT_LIMITS.instructionsMax),
      catalogue: String(meta.catalogue ?? '').slice(0, IMPORT_LIMITS.catalogueMax),
      categories: categories.slice(0, 20).map((c) => ({
        id: c.id,
        label: String(c.label).slice(0, 40),
        description: String(c.description ?? '').slice(0, 200),
      })),
      source,
    },
  }
}
