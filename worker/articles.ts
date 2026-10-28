import type { Me } from '../shared/protocol.ts'
import { FILE_KEY, type FileUrls } from '../shared/files.ts'
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

/** GET /api/book/articles: the articles the reader may see, and signed addresses for their covers */
export interface ArticleList {
  version: number
  entries: ArticleEntrySummary[]
  files: FileUrls['urls']
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
} as const

const ARTICLE_BLOCKS = ['heading', 'quote', 'image']
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

/** An article's block: one of the handbook's, or a heading, a quote or a picture */
export function checkArticleBlock(b: unknown) {
  const fail = (reason: string): never => {
    throw new ClubError('badContent', { reason })
  }
  if (!isObject(b) || !ARTICLE_BLOCKS.includes(String(b.kind))) return checkBlock(b)
  if (b.kind === 'heading' && ((b.level !== 2 && b.level !== 3) || !isString(b.text))) fail('小標題要有層級（2 或 3）與文字')
  if (b.kind === 'quote' && (!isString(b.text) || !isOptionalString(b.cite))) fail('引文格式不正確')
  if (b.kind === 'image' && (!isPictureKey(b.src) || !isString(b.alt) || !isOptionalString(b.caption)))
    fail('圖片要是上傳的檔案，並有替代文字')
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

  /** The articles `reader` may see, oldest first, with addresses for their covers */
  async list(reader: ArticleReader): Promise<ArticleList> {
    const entries = [...(await this.load()).values()].filter((e) => mayRead(reader, e)).sort((a, b) => a.createdAt - b.createdAt)
    const covers = entries.flatMap((e) => (isPictureKey(e.article?.cover) ? [e.article.cover as string] : []))
    return { version: this.version, entries: entries.map(articleSummary), files: await this.files(covers) }
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
