import { sniffAvatar } from '../shared/avatar.ts'
import { readBytes } from './body.ts'
import { EBOOK_KEY, EBOOK_LIMITS, EBOOK_TYPE, type EbookFileType, type FileUsage, STORAGE_LIMITS } from '../shared/ebooks.ts'
import {
  FILE_KEY,
  FILE_LIMITS,
  fileExtension,
  type FileTicket,
  type FileType,
  type FileUrls,
  isFilePurpose,
  isFileType,
  thumbKey,
  type UploadedFile,
} from '../shared/files.ts'
import { randomId } from './auth.ts'
import { ClubError } from './errors.ts'
import type { Store } from './store.ts'

/**
 * Pictures for posts and articles in R2 (TKU-BridgeBook e11-t02, `shared/files.ts`), without
 * Cloudflare APIs so the tests can run it: the bucket is the small `FileBucket` below, which an
 * `R2Bucket` satisfies. With no bucket bound (before `bridgebook-files` is created, DEPLOY.md §4.8)
 * every call answers 503 `filesOff`, so the rest of the Worker deploys and runs without it.
 *
 * E-books' PDFs (BridgeHall e5-t09, `shared/ebooks.ts`) use the same passes, upload and signed
 * addresses, with their own key (`ebook/<hex>.pdf`), limit and no thumbnail; their addresses are
 * short-lived (e5-t11).
 *
 * Keys in the club's storage (ARCHITECTURE.md §5):
 * - `file:ticket:<pass>`: a single-use upload pass, until it expires
 * - `file:meta:<key>`: who uploaded a file, its type and size, and whether it has a thumbnail
 * - `file:day:<userId>`: how many passes the member took on which day (Taiwan time)
 * - `file:secret`: the random key that signs the addresses, made on first use
 * - `file:usage`: how many bytes the files take up, and whether admins were told it is nearly
 *   full (BridgeHall e5-t15); counted from `file:meta:` the first time it is missing
 */

export interface FileBucket {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<{ body: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>
  delete(keys: string | string[]): Promise<void>
}

type StoredType = FileType | EbookFileType

interface StoredTicket {
  userId: string
  key: string
  type: StoredType
  expires: number
  /** The parts already uploaded; each only once */
  done: ('file' | 'thumb')[]
}

export interface StoredFile {
  owner: string
  type: StoredType
  size: number
  createdAt: number
  thumb?: { type: FileType; size: number }
}

interface StoredUsage {
  bytes: number
  /** Admins were told; told again only after it went back under the line */
  warned: boolean
}

/** A picture's key or an e-book's */
export const isStoredKey = (key: string) => FILE_KEY.test(key) || EBOOK_KEY.test(key)
// %PDF-
const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]
const isPdf = (bytes: Uint8Array) => PDF_MAGIC.every((b, i) => bytes[i] === b)

/** Where the files' addresses start (`/api/files/<key>`) */
export const FILES_PATH = '/api/files/'
const TAIPEI_OFFSET_MS = 8 * 3600_000
const dayOf = (now: number) => new Date(now + TAIPEI_OFFSET_MS).toISOString().slice(0, 10)
const encoder = new TextEncoder()
const toBase64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

export class FileService {
  private readonly store: Store
  private readonly bucket: FileBucket | undefined
  private readonly now: () => number
  /** Told once when the files pass `STORAGE_LIMITS.warnBytes`; the club tells its admins */
  private readonly onNearlyFull: (bytes: number) => Promise<void>
  private signingKey: Promise<CryptoKey> | undefined

  constructor(
    store: Store,
    bucket: FileBucket | undefined,
    now: () => number = Date.now,
    onNearlyFull: (bytes: number) => Promise<void> = async () => {},
  ) {
    this.store = store
    this.bucket = bucket
    this.now = now
    this.onNearlyFull = onNearlyFull
  }

  private requireBucket(): FileBucket {
    if (!this.bucket) throw new ClubError('filesOff', {}, 503)
    return this.bucket
  }

  /** What the files take up (BridgeHall e5-t15) */
  async usage(): Promise<FileUsage> {
    return { bytes: (await this.loadUsage()).bytes, warnBytes: STORAGE_LIMITS.warnBytes, maxBytes: STORAGE_LIMITS.maxBytes }
  }

  private async loadUsage(): Promise<StoredUsage> {
    const stored = await this.store.get<StoredUsage>('file:usage')
    if (stored) return stored
    let bytes = 0
    for (const meta of (await this.store.list<StoredFile>('file:meta:')).values()) bytes += meta.size + (meta.thumb?.size ?? 0)
    return { bytes, warned: false }
  }

  /** `usage` as it was before the file's record changed, since the first count reads the records */
  private async addUsage(change: number, usage: StoredUsage) {
    const bytes = Math.max(0, usage.bytes + change)
    const over = bytes >= STORAGE_LIMITS.warnBytes
    const tell = over && !usage.warned
    await this.store.put<StoredUsage>('file:usage', { bytes, warned: over })
    if (tell) await this.onNearlyFull(bytes)
  }

  /** Refuses a file that would take the bucket past R2's free room */
  private async requireRoom(size: number) {
    if ((await this.loadUsage()).bytes + size > STORAGE_LIMITS.maxBytes) throw new ClubError('fileStorageFull', {}, 507)
  }

  /** Counts a pass against the member's uploads today */
  private async countPass(userId: string, now: number) {
    const dayKey = `file:day:${userId}`
    const day = dayOf(now)
    const counted = await this.store.get<{ day: string; count: number }>(dayKey)
    const used = counted?.day === day ? counted.count : 0
    if (used >= FILE_LIMITS.perDay) throw new ClubError('fileDailyLimit', { max: FILE_LIMITS.perDay }, 429)
    await this.store.put(dayKey, { day, count: used + 1 })
  }

  private async issue(userId: string, key: string, type: StoredType, now: number): Promise<FileTicket> {
    const token = randomId(24)
    const expires = now + FILE_LIMITS.ticketMs
    await this.store.put<StoredTicket>(`file:ticket:${token}`, { userId, key, type, expires, done: [] })
    const base = `${FILES_PATH}upload/${token}`
    return { key, uploadUrl: base, thumbUrl: `${base}?part=thumb`, expires }
  }

  /** `POST /api/files/ticket`: a single-use pass for one picture (and its thumbnail) */
  async createTicket(userId: string, body: Record<string, unknown>): Promise<FileTicket> {
    this.requireBucket()
    const { purpose, type, size } = body
    if (!isFilePurpose(purpose)) throw new ClubError('badMessage')
    if (!isFileType(type)) throw new ClubError('fileBadFormat')
    if (typeof size !== 'number' || !(size > 0)) throw new ClubError('badMessage')
    if (size > FILE_LIMITS.maxBytes) throw new ClubError('fileTooLarge', { max: FILE_LIMITS.maxBytes / 1024 / 1024 }, 413)
    await this.requireRoom(size)
    const now = this.now()
    await this.countPass(userId, now)
    return this.issue(userId, `${purpose}/${randomId(12)}.${fileExtension(type)}`, type, now)
  }

  /** `POST /api/book/ebooks/ticket` (a reviewer's, roles.ts): a single-use pass for one PDF (e5-t09) */
  async createEbookTicket(userId: string, body: Record<string, unknown>): Promise<FileTicket> {
    this.requireBucket()
    const { size } = body
    if (typeof size !== 'number' || !(size > 0)) throw new ClubError('badMessage')
    if (size > EBOOK_LIMITS.maxBytes) throw new ClubError('ebookTooLarge', { max: EBOOK_LIMITS.maxBytes / 1024 / 1024 }, 413)
    await this.requireRoom(size)
    const now = this.now()
    await this.countPass(userId, now)
    return this.issue(userId, `ebook/${randomId(12)}.pdf`, EBOOK_TYPE, now)
  }

  /** The most bytes `PUT /api/files/upload/<pass>` may read for this pass: a PDF's limit, or a picture's */
  async uploadMax(token: string, part: 'file' | 'thumb'): Promise<number> {
    if (part === 'thumb') return FILE_LIMITS.thumbMaxBytes
    const ticket = /^[0-9a-f]{48}$/.test(token) ? await this.store.get<StoredTicket>(`file:ticket:${token}`) : undefined
    return ticket?.type === EBOOK_TYPE ? EBOOK_LIMITS.maxBytes : FILE_LIMITS.maxBytes
  }

  /** A file's record; e-books check the PDF they name with it (worker/ebooks.ts) */
  meta(key: string): Promise<StoredFile | undefined> {
    return isStoredKey(key) ? this.store.get<StoredFile>(`file:meta:${key}`) : Promise.resolve(undefined)
  }

  /**
   * `PUT /api/files/upload/<pass>[?part=thumb]`: the picture (its type must be the one the pass
   * was for) or its thumbnail (any of the three types), or a PDF. Each part only once; the pass is
   * used up once both are in (a PDF's at once), or when it expires.
   */
  async upload(token: string, part: 'file' | 'thumb', bytes: Uint8Array<ArrayBuffer>): Promise<UploadedFile> {
    const bucket = this.requireBucket()
    const ticketKey = `file:ticket:${token}`
    const ticket = /^[0-9a-f]{48}$/.test(token) ? await this.store.get<StoredTicket>(ticketKey) : undefined
    if (!ticket || ticket.expires < this.now()) {
      if (ticket) await this.store.delete(ticketKey)
      throw new ClubError('fileTicketExpired', {}, 401)
    }
    if (ticket.done.includes(part)) throw new ClubError('fileTicketExpired', {}, 401)
    const pdf = ticket.type === EBOOK_TYPE
    if (pdf && part === 'thumb') throw new ClubError('badMessage')
    const max = pdf ? EBOOK_LIMITS.maxBytes : part === 'file' ? FILE_LIMITS.maxBytes : FILE_LIMITS.thumbMaxBytes
    if (bytes.length > max)
      throw new ClubError(pdf ? 'ebookTooLarge' : 'fileTooLarge', { max: Math.round((max / 1024 / 1024) * 100) / 100 }, 413)
    const sniffed = pdf ? (isPdf(bytes) ? EBOOK_TYPE : null) : sniffAvatar(bytes)
    if (!sniffed || (part === 'file' && sniffed !== ticket.type)) throw new ClubError(pdf ? 'ebookBadFormat' : 'fileBadFormat')
    if (part === 'thumb' && !ticket.done.includes('file')) throw new ClubError('badMessage')

    const metaKey = `file:meta:${ticket.key}`
    const usage = await this.loadUsage()
    let meta: StoredFile
    if (part === 'file') {
      await bucket.put(ticket.key, bytes, { httpMetadata: { contentType: sniffed } })
      meta = { owner: ticket.userId, type: sniffed, size: bytes.length, createdAt: this.now() }
    } else {
      const type = sniffed as FileType
      await bucket.put(thumbKey(ticket.key), bytes, { httpMetadata: { contentType: type } })
      const stored = await this.store.get<StoredFile>(metaKey)
      if (!stored) throw new ClubError('fileTicketExpired', {}, 401)
      meta = { ...stored, thumb: { type, size: bytes.length } }
    }
    await this.store.put(metaKey, meta)
    await this.addUsage(bytes.length, usage)
    ticket.done.push(part)
    // A PDF has no thumbnail, so its pass is used up at once
    if (ticket.done.length === 2 || pdf) await this.store.delete(ticketKey)
    else await this.store.put(ticketKey, ticket)
    return this.uploaded(ticket.key, meta)
  }

  /** `POST /api/files/urls`: fresh signed addresses; keys with no file are left out */
  async urls(keys: unknown): Promise<FileUrls> {
    this.requireBucket()
    if (!Array.isArray(keys) || keys.length > FILE_LIMITS.urlsMax) throw new ClubError('badMessage')
    const urls: FileUrls['urls'] = {}
    for (const key of new Set(keys)) {
      if (typeof key !== 'string' || !isStoredKey(key)) continue
      const meta = await this.store.get<StoredFile>(`file:meta:${key}`)
      if (!meta) continue
      const { url, thumbUrl } = await this.uploaded(key, meta)
      urls[key] = thumbUrl ? { url, thumbUrl } : { url }
    }
    return { urls }
  }

  /**
   * `DELETE /api/files/<key>`: its uploader, or `mayDeleteAny` (the forum's officers and admins), removes the
   * file and its thumbnail
   */
  async remove(userId: string, key: string, mayDeleteAny: boolean) {
    const bucket = this.requireBucket()
    const meta = isStoredKey(key) ? await this.store.get<StoredFile>(`file:meta:${key}`) : undefined
    if (!meta) throw new ClubError('fileGone', {}, 404)
    if (meta.owner !== userId && !mayDeleteAny) throw new ClubError('noPermission', {}, 403)
    const usage = await this.loadUsage()
    await bucket.delete(meta.thumb ? [key, thumbKey(key)] : key)
    await this.store.delete(`file:meta:${key}`)
    await this.addUsage(-(meta.size + (meta.thumb?.size ?? 0)), usage)
  }

  /**
   * `GET /api/files/<key>?e=&s=`: the file, when the address is signed and has not expired. No
   * sign-in: the signature is the check. The browser may keep it until the address expires
   */
  async serve(key: string, url: URL): Promise<Response> {
    const bucket = this.requireBucket()
    const expires = Number(url.searchParams.get('e'))
    const signature = url.searchParams.get('s') ?? ''
    const now = this.now()
    if (!isStoredKey(key) || !(expires > now) || signature !== (await this.sign(key, expires))) throw new ClubError('fileGone', {}, 404)
    const object = await bucket.get(key)
    if (!object) throw new ClubError('fileGone', {}, 404)
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        'Content-Length': String(object.size),
        'Cache-Control': `private, max-age=${Math.floor((expires - now) / 1000)}, immutable`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
        // The signature is the check, so any page may read it: TKU BridgeHall's PDF reader fetches
        // an e-book straight from the Worker rather than through its own /api rewrite (e5-t10)
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  private async uploaded(key: string, meta: StoredFile): Promise<UploadedFile> {
    // Rounded to the hour, so every page asking within the same hour gets the same address and the
    // browser's copy; a PDF's to five minutes, since its address is short-lived (e5-t11)
    const pdf = meta.type === EBOOK_TYPE
    const step = pdf ? 5 * 60_000 : 3600_000
    const expires = Math.ceil(this.now() / step) * step + (pdf ? EBOOK_LIMITS.urlMs : FILE_LIMITS.urlMs)
    const address = async (k: string) => `${FILES_PATH}${k}?e=${expires}&s=${await this.sign(k, expires)}`
    const file: UploadedFile = { key, type: meta.type, size: meta.size, url: await address(key) }
    if (meta.thumb) file.thumbUrl = await address(thumbKey(key))
    return file
  }

  private async sign(key: string, expires: number): Promise<string> {
    this.signingKey ??= this.loadKey()
    const signature = await crypto.subtle.sign('HMAC', await this.signingKey, encoder.encode(`${key}\n${expires}`))
    return toBase64Url(signature).slice(0, 32)
  }

  private async loadKey(): Promise<CryptoKey> {
    let secret = await this.store.get<string>('file:secret')
    if (!secret) {
      secret = randomId(32)
      await this.store.put('file:secret', secret)
    }
    return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  }
}

/** The upload's bytes, refused before or after reading when over `max` */
export async function readFileUpload(request: Request, max: number): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () => new ClubError('fileTooLarge', { max: Math.round((max / 1024 / 1024) * 100) / 100 }, 413)
  return readBytes(request, max, tooLarge)
}
