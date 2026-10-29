import type { Me } from '../shared/protocol.ts'
import { FILE_KEY, type FileUrls } from '../shared/files.ts'
import { isCard, isSeat, SEATS, type Card } from '../shared/cards.ts'
import { type AuditAction, AuditLog } from './audit.ts'
import { randomId } from './auth.ts'
import {
  checkBlock,
  getParts,
  type Header,
  isObject,
  isOptionalLevel,
  isOptionalString,
  isSlug,
  isString,
  isStrings,
  noteOf,
  putParts,
} from './book.ts'
import { ClubError } from './errors.ts'
import type { Store } from './store.ts'

/**
 * Articles in TKU BridgeHall's library (淡江橋館 叢書, BridgeHall E5 e5-t01, e5-t04): written on the
 * site, so unlike conventions there is no bundled copy. Stored the way the handbook's online
 * conventions are (book.ts): one entry per article (`article:entry:<slug>`) whose body is kept in
 * parts (`bookpart:article:entry:<slug>:<i>`), every saved version (`article:rev:<slug>:<id>`) and
 * a counter that changes with every save (`article:version`). The daily backup covers `article*`
 * and `bookpart:` (backup.ts BACKUP_PREFIXES).
 *
 * Only the published path for now: a reviewer (`bookReview`) publishes or hides an article
 * straight away, as with a convention without a draft. Drafts and review for articles come with
 * their editor (e5-t07). An article is checked here only for shape; what it says is the editors'.
 *
 * Pictures (an `image` block's `src`, the `cover`) are file keys from the uploads (files.ts,
 * e11-t02, purpose `article`), never addresses: addresses are signed and short-lived, so every
 * read signs fresh ones and sends them as `files`. Without the R2 bucket `files` is empty and the
 * handbook shows the picture's description instead.
 *
 * Who may read: anyone, but `members-only` articles only signed-in members (e5-t11 adds the rest
 * of AC-5.6), and hidden ones only editors.
 */

export const ARTICLE_LICENSES = ['own', 'permitted', 'members-only'] as const
export type ArticleLicense = (typeof ARTICLE_LICENSES)[number]

/** One article as published; `article` is null when it is hidden */
export interface ArticleEntry {
  slug: string
  version: number
  article: Record<string, unknown> | null
  createdAt: number
  updatedAt: number
  updatedBy: string
  status: 'published'
  /** The reviewer who published it, and when */
  reviewedBy: string
  reviewedAt: number
}

/** An article without its blocks: what the library's shelves need */
export interface ArticleMeta {
  slug: string
  title: string
  authors: string[]
  series: string
  level?: 'basic' | 'intermediate' | 'advanced'
  summary: string
  cover?: string
  published: string
  updated: string
  license: ArticleLicense
}

export type ArticleEntrySummary = Omit<ArticleEntry, 'article'> & { meta: ArticleMeta | null }

/** A shelf of the library (BridgeHall e5-t06): 主打、擠牌、社課講義…; an article's `series` is its id */
export interface ArticleSeries {
  id: string
  label: string
  description: string
  order: number
}

/**
 * The series as edited online. An empty list means they were never edited, so the handbook's
 * built-in ones apply; `version` is what a save sends back as `baseVersion`.
 */
export interface ArticleSeriesList {
  version: number
  series: ArticleSeries[]
  updatedAt?: number
  updatedBy?: string
}

/**
 * GET /api/book/articles: the articles the reader may see, signed addresses for their covers and
 * the series. With `?text=1` (the handbook's search, e5-t13) also every article's words, by slug.
 */
export interface ArticleList {
  version: number
  entries: ArticleEntrySummary[]
  files: FileUrls['urls']
  series: ArticleSeriesList
  text?: Record<string, string>
}

/** GET /api/book/articles/:slug: the article, and signed addresses for its cover and pictures */
export interface ArticleResponse {
  entry: ArticleEntry
  files: FileUrls['urls']
}

export type ArticleRevisionAction = 'save' | 'hide'

/** A saved version; the list leaves out `article` */
export interface ArticleRevision {
  id: string
  slug: string
  version: number
  action: ArticleRevisionAction
  at: number
  by: string
  note: string
  article?: Record<string, unknown> | null
}

/** Who is reading: signed out, a member, or an editor (who also sees hidden articles) */
export type ArticleReader = 'anyone' | 'member' | 'editor'

export const ARTICLE_LIMITS = {
  /** Characters of JSON for one article */
  articleMax: 600_000,
  blocksMax: 1_000,
  titleMax: 120,
  authorsMax: 10,
  revisionsListed: 100,
  /** Characters of an article's words sent for search */
  searchTextMax: 20_000,
} as const

/** Series limits (e5-t06), as the categories' (book.ts CATEGORY_LIMITS) */
export const SERIES_LIMITS = { max: 30, idMax: 40, labelMax: 40, descriptionMax: 200 } as const
const SERIES_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Throws `badContent` unless `value` is a list of series: ids in lower-case letters, digits and
 * hyphens, each once, with a name. Their `order` is their place in the list.
 */
export function checkSeries(value: unknown): ArticleSeries[] {
  const fail = (reason: string): never => {
    throw new ClubError('badContent', { reason })
  }
  if (!Array.isArray(value) || !value.length) return fail('至少要有一個系列')
  if (value.length > SERIES_LIMITS.max) fail(`系列最多 ${SERIES_LIMITS.max} 個`)
  const ids = new Set<string>()
  return value.map((c, order) => {
    if (!isObject(c) || !isString(c.id) || c.id.length > SERIES_LIMITS.idMax || !SERIES_ID.test(c.id))
      return fail('系列代號只能用小寫英數與連字號')
    if (ids.has(c.id)) fail(`系列代號重複：${c.id}`)
    ids.add(c.id)
    const label = isString(c.label) ? c.label.trim() : ''
    if (!label || label.length > SERIES_LIMITS.labelMax) fail(`系列名稱要有 1 到 ${SERIES_LIMITS.labelMax} 個字`)
    if (!isOptionalString(c.description)) fail('系列說明要是文字')
    const description = String(c.description ?? '').trim()
    if (description.length > SERIES_LIMITS.descriptionMax) fail(`系列說明最多 ${SERIES_LIMITS.descriptionMax} 個字`)
    return { id: c.id, label, description, order }
  })
}

/**
 * Keys whose values are not words: a block's kind and level, a picture's file key, a deal's cards
 * and a play block's contract, declarer and cards (their captions are words)
 */
const NOT_WORDS = new Set(['kind', 'src', 'level', 'deal', 'contract', 'declarer', 'tricks'])

/**
 * An article's words for search (e5-t13): its summary and every text in its blocks, as one line,
 * cut at ARTICLE_LIMITS.searchTextMax. The handbook takes the title and authors from the entry.
 */
export function searchText(article: Record<string, unknown>): string {
  const words: string[] = [String(article.summary ?? '')]
  const walk = (value: unknown, key = '') => {
    if (NOT_WORDS.has(key)) return
    if (isString(value)) words.push(value)
    else if (Array.isArray(value)) value.forEach((v) => walk(v))
    else if (isObject(value)) for (const [k, v] of Object.entries(value)) walk(v, k)
  }
  walk(article.blocks)
  return words.join(' ').replace(/\s+/g, ' ').trim().slice(0, ARTICLE_LIMITS.searchTextMax)
}

const ARTICLE_BLOCKS = ['heading', 'quote', 'image', 'deal', 'play']
const VULNERABILITIES = ['None', 'NS', 'EW', 'Both']
/** A play block's contract in the table's call notation: '4S', '3N', '4HX', '6NXX' (BridgeHall lib/play.ts) */
export const CONTRACT = /^[1-7][CDHSN](X|XX)?$/
const TEXT_FIELDS = ['title', 'series', 'summary', 'published', 'updated']

/** A picture's file key from the uploads; never a thumbnail's, which follows from it */
export const isPictureKey = (value: unknown): value is string =>
  isString(value) && FILE_KEY.test(value) && !value.includes('-thumb.')

/** Throws `badContent` with a short reason unless `value` has the shape of an Article */
export function checkArticle(value: unknown, slug: string): Record<string, unknown> {
  const fail = (reason: string): never => {
    throw new ClubError('badContent', { reason })
  }
  if (!isObject(value)) return fail('不是一篇文章')
  if (value.slug !== slug) fail('網址代稱（slug）不符')
  for (const key of TEXT_FIELDS) if (!isString(value[key])) fail(`缺少 ${key}`)
  const title = String(value.title).trim()
  if (!title || title.length > ARTICLE_LIMITS.titleMax) fail(`標題要有 1 到 ${ARTICLE_LIMITS.titleMax} 個字`)
  if (!isStrings(value.authors) || (value.authors as string[]).length > ARTICLE_LIMITS.authorsMax)
    fail(`作者（authors）要是文字清單，最多 ${ARTICLE_LIMITS.authorsMax} 位`)
  if (!isOptionalLevel(value.level)) fail('程度（level）不存在')
  if (!ARTICLE_LICENSES.includes(value.license as ArticleLicense)) fail('授權（license）不存在')
  if (value.cover !== undefined && !isPictureKey(value.cover)) fail('封面（cover）要是上傳的圖片')
  if (!Array.isArray(value.blocks)) return fail('缺少內容（blocks）')
  if (value.blocks.length > ARTICLE_LIMITS.blocksMax) fail(`內容區塊最多 ${ARTICLE_LIMITS.blocksMax} 個`)
  for (const b of value.blocks as unknown[]) checkArticleBlock(b)
  return value
}

/** An article's block: one of the handbook's, or a heading, a quote, a picture, a deal or a play */
export function checkArticleBlock(b: unknown) {
  const fail = (reason: string): never => {
    throw new ClubError('badContent', { reason })
  }
  if (!isObject(b) || !ARTICLE_BLOCKS.includes(String(b.kind))) return checkBlock(b)
  if (b.kind === 'heading' && ((b.level !== 2 && b.level !== 3) || !isString(b.text))) fail('小標題要有層級（2 或 3）與文字')
  if (b.kind === 'quote' && (!isString(b.text) || !isOptionalString(b.cite))) fail('引文格式不正確')
  if (b.kind === 'image' && (!isPictureKey(b.src) || !isString(b.alt) || !isOptionalString(b.caption)))
    fail('圖片要是上傳的檔案，並有替代文字')
  if (b.kind === 'deal') checkDealBlock(b, fail)
  if (b.kind === 'play') checkPlayBlock(b, fail)
}

/**
 * 牌例 (BridgeHall e5-t02): the forum's deal (forum.ts), so a seat may be left empty (an article
 * often shows only declarer's two hands); each card once, at most thirteen to a seat.
 */
function checkDealBlock(b: Record<string, unknown>, fail: (reason: string) => never) {
  const deal = b.deal
  if (!isObject(deal) || !isObject(deal.hands)) return fail('牌例要有四家的牌')
  if (!isSeat(deal.dealer)) fail('牌例要有發牌者')
  if (!VULNERABILITIES.includes(deal.vul as string)) fail('牌例的身價要是 None、NS、EW 或 Both')
  const hands = deal.hands
  const seen = new Set<Card>()
  for (const seat of SEATS) {
    const cards = hands[seat] ?? []
    if (!Array.isArray(cards) || cards.length > 13) fail('牌例每家最多 13 張牌')
    for (const card of cards as unknown[]) {
      if (!isCard(card)) fail(`牌例有不認得的牌：${String(card)}`)
      if (seen.has(card as Card)) fail(`牌例的 ${String(card)} 出現了兩次`)
      seen.add(card as Card)
    }
  }
  if (!seen.size) fail('牌例要至少有一張牌')
  if (!isOptionalString(b.caption)) fail('牌例的說明要是文字')
}

/**
 * 出牌過程 (BridgeHall e5-t03): the contract, declarer and the tricks in order, each trick's cards
 * from its leader on; only the last trick may stop part-way, and no card is played twice.
 */
function checkPlayBlock(b: Record<string, unknown>, fail: (reason: string) => never) {
  if (!isString(b.contract) || !CONTRACT.test(b.contract)) fail('出牌過程的合約要像 4S、3N、4HX')
  if (!isSeat(b.declarer)) fail('出牌過程要有莊家')
  const tricks = b.tricks
  if (!Array.isArray(tricks) || !tricks.length || tricks.length > 13) return fail('出牌過程要有 1 到 13 墩')
  const seen = new Set<Card>()
  tricks.forEach((trick: unknown, i) => {
    if (!Array.isArray(trick) || !trick.length || trick.length > 4) fail(`第 ${i + 1} 墩要有 1 到 4 張牌`)
    if ((trick as unknown[]).length < 4 && i < tricks.length - 1) fail(`第 ${i + 1} 墩少了牌：只有最後一墩可以沒出完`)
    for (const card of trick as unknown[]) {
      if (!isCard(card)) fail(`出牌過程有不認得的牌：${String(card)}`)
      if (seen.has(card as Card)) fail(`出牌過程的 ${String(card)} 出現了兩次`)
      seen.add(card as Card)
    }
  })
  if (!isOptionalString(b.caption)) fail('出牌過程的說明要是文字')
}

/** The article without its blocks */
export function articleMeta(article: Record<string, unknown>): ArticleMeta {
  const { blocks: _blocks, ...rest } = article
  return rest as unknown as ArticleMeta
}

export function articleSummary({ article, ...rest }: ArticleEntry): ArticleEntrySummary {
  return { ...rest, meta: article ? articleMeta(article) : null }
}

/** Every picture an article names: its cover and its image blocks */
export function pictureKeys(article: Record<string, unknown> | null): string[] {
  if (!article) return []
  const keys = isPictureKey(article.cover) ? [article.cover] : []
  for (const b of Array.isArray(article.blocks) ? article.blocks : [])
    if (isObject(b) && b.kind === 'image' && isPictureKey(b.src)) keys.push(b.src)
  return keys
}

/** Signs addresses for file keys (files.ts FileService.urls) */
export type SignFiles = (keys: string[]) => Promise<FileUrls>

const mayRead = (reader: ArticleReader, entry: ArticleEntry) =>
  reader === 'editor' || (entry.article !== null && (reader === 'member' || entry.article.license !== 'members-only'))

export class ArticleService {
  private readonly store: Store
  private readonly sign: SignFiles
  private readonly now: () => number
  private readonly audit: AuditLog
  private entries: Map<string, ArticleEntry> | null = null
  private version = 0
  private seriesList: ArticleSeriesList = { version: 0, series: [] }
  private lastStamp = 0

  constructor(store: Store, sign: SignFiles, now: () => number = Date.now, audit: AuditLog = new AuditLog(store, now)) {
    this.store = store
    this.sign = sign
    this.now = now
    this.audit = audit
  }

  private log(actor: Me, action: AuditAction, target: string, extra: { version?: number; revisionId?: string; note?: string }) {
    return this.audit.record({ by: actor.username, action, target, ...extra })
  }

  private orderedId() {
    this.lastStamp = Math.max(this.now(), this.lastStamp + 1)
    return `${String(this.lastStamp).padStart(14, '0')}-${randomId(3)}`
  }

  /** Loaded on first use, so games never pay for reading the library */
  private async load() {
    if (this.entries) return this.entries
    const entries = new Map<string, ArticleEntry>()
    for (const [key, header] of await this.store.list<Omit<ArticleEntry, 'article'> & Header>('article:entry:')) {
      const { parts, ...meta } = header
      entries.set(meta.slug, { ...meta, article: await getParts(this.store, key, parts) })
    }
    this.version = (await this.store.get<number>('article:version')) ?? 0
    this.seriesList = (await this.store.get<ArticleSeriesList>('article:series')) ?? { version: 0, series: [] }
    this.entries = entries
    return entries
  }

  /** Signed addresses, or none at all while the R2 bucket is not there (503 `filesOff`) */
  private async files(keys: string[]): Promise<FileUrls['urls']> {
    if (!keys.length) return {}
    try {
      return (await this.sign(keys.slice(0, 50))).urls
    } catch (error) {
      if (error instanceof ClubError && error.code === 'filesOff') return {}
      throw error
    }
  }

  /**
   * The articles `reader` may see, oldest first, with addresses for their covers and the series;
   * `withText` adds every article's words for the handbook's search (e5-t13)
   */
  async list(reader: ArticleReader, withText = false): Promise<ArticleList> {
    const entries = [...(await this.load()).values()].filter((e) => mayRead(reader, e)).sort((a, b) => a.createdAt - b.createdAt)
    const covers = entries.flatMap((e) => (isPictureKey(e.article?.cover) ? [e.article.cover as string] : []))
    const text = withText
      ? Object.fromEntries(entries.flatMap((e) => (e.article ? [[e.slug, searchText(e.article)]] : [])))
      : undefined
    return {
      version: this.version,
      entries: entries.map(articleSummary),
      files: await this.files(covers),
      series: this.seriesList,
      ...(text && { text }),
    }
  }

  /** The series as edited online (e5-t06); an empty list when they never were */
  async series(): Promise<ArticleSeriesList> {
    await this.load()
    return this.seriesList
  }

  /**
   * Replaces the whole list of series: adding, renaming, reordering and removing are one save.
   * `baseVersion` is the version the editor started from (0 for the built-in ones). A series that
   * was in the online list cannot be removed while an article is in it; until the list is first
   * saved the handbook checks its built-in ones itself, since only it knows them.
   */
  async saveSeries(actor: Me, body: { series?: unknown; baseVersion?: unknown }): Promise<ArticleSeriesList> {
    const next = checkSeries(body.series)
    const entries = await this.load()
    const old = this.seriesList
    if (Number(body.baseVersion) !== old.version) throw new ClubError('seriesConflict', { name: old.updatedBy ?? '別人' }, 409)
    const kept = new Set(next.map((s) => s.id))
    const removed = new Set(old.series.map((s) => s.id).filter((id) => !kept.has(id)))
    for (const entry of entries.values()) {
      const series = entry.article?.series
      if (isString(series) && removed.has(series)) {
        const name = old.series.find((s) => s.id === series)?.label ?? series
        throw new ClubError('seriesInUse', { name, article: String(entry.article?.title ?? entry.slug) }, 409)
      }
    }
    this.seriesList = { version: old.version + 1, series: next, updatedAt: this.now(), updatedBy: actor.username }
    await this.store.put('article:series', this.seriesList)
    await this.log(actor, 'article:series', 'series', { version: this.seriesList.version })
    return this.seriesList
  }

  /** One article, with addresses for its pictures; 404 when `reader` may not see it */
  async get(reader: ArticleReader, slug: string): Promise<ArticleResponse> {
    const entry = isSlug(slug) ? (await this.load()).get(slug) : undefined
    if (!entry || !mayRead(reader, entry)) throw new ClubError('articleGone', {}, 404)
    return { entry, files: await this.files(pictureKeys(entry.article)) }
  }

  private checkBase(entry: ArticleEntry | undefined, baseVersion: unknown) {
    if (Number(baseVersion) !== (entry?.version ?? 0))
      throw new ClubError('articleConflict', { name: entry?.updatedBy ?? '別人' }, 409)
  }

  private async write(entry: ArticleEntry) {
    const key = `article:entry:${entry.slug}`
    const old = await this.store.get<Header>(key)
    const { article, ...meta } = entry
    const parts = await putParts(this.store, key, article, old?.parts)
    await this.store.put(key, { ...meta, parts })
  }

  private async record(revision: ArticleRevision) {
    const key = `article:rev:${revision.slug}:${revision.id}`
    const { article, ...meta } = revision
    const parts = article === undefined ? 0 : await putParts(this.store, key, article)
    await this.store.put(key, { ...meta, parts })
  }

  private async changed() {
    this.version++
    await this.store.put('article:version', this.version)
  }

  /**
   * Publishes an article (a reviewer's). `baseVersion` is the published version the reviewer
   * started from, 0 for a new article; if someone published in between, nothing is written.
   */
  async save(actor: Me, slug: string, body: { article?: unknown; baseVersion?: unknown; note?: unknown }) {
    if (!isSlug(slug)) throw new ClubError('badContent', { reason: '網址代稱（slug）只能用小寫英數與連字號' })
    if (JSON.stringify(body.article ?? null).length > ARTICLE_LIMITS.articleMax) throw new ClubError('contentTooLarge', {}, 413)
    const article = checkArticle(body.article, slug)
    return this.publish(actor, slug, body, article, 'save')
  }

  /** Hides an article from the library; its versions stay, so it can be published again */
  async hide(actor: Me, slug: string, body: { baseVersion?: unknown; note?: unknown }) {
    if (!isSlug(slug) || !(await this.load()).has(slug)) throw new ClubError('articleGone', {}, 404)
    return this.publish(actor, slug, body, null, 'hide')
  }

  private async publish(
    actor: Me,
    slug: string,
    body: { baseVersion?: unknown; note?: unknown },
    article: Record<string, unknown> | null,
    action: ArticleRevisionAction,
  ) {
    const entries = await this.load()
    const current = entries.get(slug)
    this.checkBase(current, body.baseVersion)
    const time = this.now()
    const entry: ArticleEntry = {
      slug,
      version: (current?.version ?? 0) + 1,
      article,
      createdAt: current?.createdAt ?? time,
      updatedAt: time,
      updatedBy: actor.username,
      status: 'published',
      reviewedBy: actor.username,
      reviewedAt: time,
    }
    await this.write(entry)
    entries.set(slug, entry)
    const note = noteOf(body.note)
    const revisionId = this.orderedId()
    await this.record({ id: revisionId, slug, version: entry.version, action, at: time, by: actor.username, note, article })
    await this.changed()
    await this.log(actor, action === 'save' ? 'article:publish' : 'article:hide', slug, { version: entry.version, revisionId, note })
    return entry
  }

  /** Newest first */
  async revisions(slug: string): Promise<ArticleRevision[]> {
    const list = await this.store.list<ArticleRevision & Header>(`article:rev:${slug}:`, {
      reverse: true,
      limit: ARTICLE_LIMITS.revisionsListed,
    })
    return [...list.values()].map(({ parts: _parts, ...meta }) => meta)
  }

  async revision(slug: string, id: string): Promise<ArticleRevision> {
    const key = `article:rev:${slug}:${id}`
    const header = await this.store.get<ArticleRevision & Header>(key)
    if (!header) throw new ClubError('articleGone', {}, 404)
    const { parts, ...meta } = header
    return parts ? { ...meta, article: await getParts(this.store, key, parts) } : meta
  }
}
