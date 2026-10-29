import type { Me } from '../shared/protocol.ts'
import {
  EBOOK_KEY,
  EBOOK_LICENSES,
  EBOOK_LIMITS,
  EBOOK_TYPE,
  type Ebook,
  type EbookFiles,
  type EbookInput,
  type EbookLicense,
  type EbookList,
  type EbookResponse,
  type FileUsage,
} from '../shared/ebooks.ts'
import type { FileUrls } from '../shared/files.ts'
import { isPictureKey } from './articles.ts'
import { AuditLog } from './audit.ts'
import { randomId } from './auth.ts'
import { isObject, isString, isStrings } from './book.ts'
import { ClubError } from './errors.ts'
import type { StoredFile } from './files.ts'
import type { Store } from './store.ts'

/**
 * E-books in TKU BridgeHall's library (淡江橋館 叢書, BridgeHall E5 e5-t09, e5-t11): one record per
 * book (`ebook:<id>`) naming a PDF uploaded to R2 (files.ts, `ebook/<hex>.pdf`) and its cover (an
 * uploaded picture, purpose `article`). The daily backup covers `ebook:` (backup.ts); the PDFs
 * themselves stay in the bucket.
 *
 * Reviewers (`bookReview`) add, change and remove books; every book needs a license. Who may
 * read: anyone, but a `members-only` book only signed-in members: signed out, it is left out of
 * the list and its page is 404, so neither its link nor its PDF's signed address is ever given out
 * (AC-5.6). The PDF's address is short-lived (`EBOOK_LIMITS.urlMs`, files.ts).
 */

/** Who is reading: signed out, a member, or an editor (who also sees how full the bucket is) */
export type EbookReader = 'anyone' | 'member' | 'editor'

/** What the book service needs from the files (files.ts FileService) */
export interface EbookFilesDeps {
  sign(keys: string[]): Promise<FileUrls>
  meta(key: string): Promise<StoredFile | undefined>
  remove(userId: string, key: string, mayDeleteAny: boolean): Promise<void>
  usage(): Promise<FileUsage>
}

const mayRead = (reader: EbookReader, ebook: Ebook) => reader !== 'anyone' || ebook.license !== 'members-only'

const fail = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

const trimmed = (value: unknown, max: number, what: string): string => {
  const text = isString(value) ? value.trim() : ''
  if (!text || text.length > max) fail(`${what}要有 1 到 ${max} 個字`)
  return text
}

/** Throws `badContent` with a short reason unless `value` is a book's record; returns it cleaned */
export function checkEbook(value: unknown): EbookInput {
  if (!isObject(value)) return fail('不是一本書')
  const title = trimmed(value.title, EBOOK_LIMITS.titleMax, '書名')
  const series = trimmed(value.series, EBOOK_LIMITS.seriesMax, '系列')
  if (!isStrings(value.authors)) return fail('作者（authors）要是文字清單')
  const authors = (value.authors as string[]).map((a) => a.trim()).filter(Boolean)
  if (!authors.length || authors.length > EBOOK_LIMITS.authorsMax) fail(`作者要有 1 到 ${EBOOK_LIMITS.authorsMax} 位`)
  if (authors.some((a) => a.length > EBOOK_LIMITS.nameMax)) fail(`作者名字最多 ${EBOOK_LIMITS.nameMax} 個字`)
  if (!EBOOK_LICENSES.includes(value.license as EbookLicense)) fail('授權（license）必填')
  if (!isString(value.fileKey) || !EBOOK_KEY.test(value.fileKey)) fail('檔案（fileKey）要是上傳的 PDF')
  const year = value.year
  if (year !== undefined && !(Number.isInteger(year) && (year as number) >= 1900 && (year as number) <= 2100)) fail('年代要是 1900 到 2100 的西元年')
  const pages = value.pages
  if (pages !== undefined && !(Number.isInteger(pages) && (pages as number) > 0 && (pages as number) < 100_000)) fail('頁數要是正整數')
  if (value.cover !== undefined && !isPictureKey(value.cover)) fail('封面（cover）要是上傳的圖片')
  const input: EbookInput = { title, authors, series, license: value.license as EbookLicense, fileKey: value.fileKey as string }
  if (year !== undefined) input.year = year as number
  if (pages !== undefined) input.pages = pages as number
  if (value.cover !== undefined) input.cover = value.cover as string
  return input
}

export class EbookService {
  private readonly store: Store
  private readonly files: EbookFilesDeps
  private readonly now: () => number
  private readonly audit: AuditLog
  private books: Map<string, Ebook> | null = null

  constructor(store: Store, files: EbookFilesDeps, now: () => number = Date.now, audit: AuditLog = new AuditLog(store, now)) {
    this.store = store
    this.files = files
    this.now = now
    this.audit = audit
  }

  /** Loaded on first use, so games never pay for reading the library */
  private async load() {
    if (this.books) return this.books
    this.books = new Map([...(await this.store.list<Ebook>('ebook:')).values()].map((b) => [b.id, b]))
    return this.books
  }

  /** Signed addresses, or none at all while the R2 bucket is not there (503 `filesOff`) */
  private async signed(keys: string[]): Promise<EbookFiles> {
    const urls: EbookFiles = {}
    try {
      for (let i = 0; i < keys.length; i += 50) Object.assign(urls, (await this.files.sign(keys.slice(i, i + 50))).urls)
    } catch (error) {
      if (!(error instanceof ClubError && error.code === 'filesOff')) throw error
    }
    return urls
  }

  /** The books `reader` may see, oldest first, with addresses for their covers; editors also get the bucket's usage */
  async list(reader: EbookReader): Promise<EbookList> {
    const ebooks = [...(await this.load()).values()].filter((b) => mayRead(reader, b)).sort((a, b) => a.createdAt - b.createdAt)
    const list: EbookList = { ebooks, files: await this.signed(ebooks.flatMap((b) => (b.cover ? [b.cover] : []))) }
    if (reader === 'editor') list.usage = await this.files.usage()
    return list
  }

  /** One book with addresses for its cover and its PDF; 404 when `reader` may not see it */
  async get(reader: EbookReader, id: string): Promise<EbookResponse> {
    const ebook = (await this.load()).get(id)
    if (!ebook || !mayRead(reader, ebook)) throw new ClubError('ebookGone', {}, 404)
    return { ebook, files: await this.signed(ebook.cover ? [ebook.fileKey, ebook.cover] : [ebook.fileKey]) }
  }

  /** The PDF must be uploaded, and be a PDF */
  private async uploaded(fileKey: string) {
    const meta = await this.files.meta(fileKey)
    if (!meta || meta.type !== EBOOK_TYPE) fail('找不到上傳的 PDF，請重新上傳')
    return meta as StoredFile
  }

  /** `POST /api/book/ebooks`: a new book, for a PDF just uploaded */
  async create(actor: Me, body: unknown): Promise<Ebook> {
    const books = await this.load()
    if (books.size >= EBOOK_LIMITS.booksMax) fail(`最多 ${EBOOK_LIMITS.booksMax} 本書`)
    const input = checkEbook(body)
    if ([...books.values()].some((b) => b.fileKey === input.fileKey)) fail('這個 PDF 已經是另一本書')
    const meta = await this.uploaded(input.fileKey)
    const time = this.now()
    const ebook: Ebook = {
      ...input,
      id: randomId(6),
      size: meta.size,
      uploadedBy: actor.username,
      createdAt: time,
      updatedAt: time,
      updatedBy: actor.username,
    }
    return this.write(actor, ebook)
  }

  /**
   * `PUT /api/book/ebooks/:id`: the book's record; a new `fileKey` replaces its PDF, and the old
   * one is removed from the bucket
   */
  async update(actor: Me, id: string, body: unknown): Promise<Ebook> {
    const books = await this.load()
    const current = books.get(id)
    if (!current) throw new ClubError('ebookGone', {}, 404)
    const input = checkEbook(body)
    let size = current.size
    if (input.fileKey !== current.fileKey) {
      if ([...books.values()].some((b) => b.fileKey === input.fileKey)) fail('這個 PDF 已經是另一本書')
      size = (await this.uploaded(input.fileKey)).size
    }
    const ebook: Ebook = {
      ...input,
      id,
      size,
      uploadedBy: input.fileKey === current.fileKey ? current.uploadedBy : actor.username,
      createdAt: current.createdAt,
      updatedAt: this.now(),
      updatedBy: actor.username,
    }
    await this.write(actor, ebook)
    if (input.fileKey !== current.fileKey) await this.removeFile(actor, current.fileKey)
    return ebook
  }

  /** `DELETE /api/book/ebooks/:id`: takes a book down (幹部下架), its PDF too; its cover stays (it may be used elsewhere) */
  async remove(actor: Me, id: string) {
    const books = await this.load()
    const current = books.get(id)
    if (!current) throw new ClubError('ebookGone', {}, 404)
    await this.store.delete(`ebook:${id}`)
    books.delete(id)
    await this.audit.record({ by: actor.username, action: 'ebook:remove', target: id, note: current.title })
    await this.removeFile(actor, current.fileKey)
  }

  private async write(actor: Me, ebook: Ebook) {
    await this.store.put(`ebook:${ebook.id}`, ebook)
    ;(await this.load()).set(ebook.id, ebook)
    await this.audit.record({ by: actor.username, action: 'ebook:save', target: ebook.id, note: ebook.title })
    return ebook
  }

  private async removeFile(actor: Me, key: string) {
    try {
      await this.files.remove(actor.id, key, true)
    } catch (error) {
      // Already gone, or the bucket is not there: the record is what matters
      if (!(error instanceof ClubError)) throw error
    }
  }
}
