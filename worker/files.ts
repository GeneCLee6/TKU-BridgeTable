import { sniffAvatar } from '../shared/avatar.ts'
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
 * Keys in the club's storage (ARCHITECTURE.md §5):
 * - `file:ticket:<pass>`: a single-use upload pass, until it expires
 * - `file:meta:<key>`: who uploaded a file, its type and size, and whether it has a thumbnail
 * - `file:day:<userId>`: how many passes the member took on which day (Taiwan time)
 * - `file:secret`: the random key that signs the addresses, made on first use
 */

export interface FileBucket {
  put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>
  get(key: string): Promise<{ body: ReadableStream; size: number; httpMetadata?: { contentType?: string } } | null>
  delete(keys: string | string[]): Promise<void>
}

interface StoredTicket {
  userId: string
  key: string
  type: FileType
  expires: number
  /** The parts already uploaded; each only once */
  done: ('file' | 'thumb')[]
}

export interface StoredFile {
  owner: string
  type: FileType
  size: number
  createdAt: number
  thumb?: { type: FileType; size: number }
}

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
  private signingKey: Promise<CryptoKey> | undefined

  constructor(store: Store, bucket: FileBucket | undefined, now: () => number = Date.now) {
    this.store = store
    this.bucket = bucket
    this.now = now
  }

  private requireBucket(): FileBucket {
    if (!this.bucket) throw new ClubError('filesOff', {}, 503)
    return this.bucket
  }

  /** `POST /api/files/ticket`: a single-use pass for one picture (and its thumbnail) */
  async createTicket(userId: string, body: Record<string, unknown>): Promise<FileTicket> {
    this.requireBucket()
    const { purpose, type, size } = body
    if (!isFilePurpose(purpose)) throw new ClubError('badMessage')
    if (!isFileType(type)) throw new ClubError('fileBadFormat')
    if (typeof size !== 'number' || !(size > 0)) throw new ClubError('badMessage')
    if (size > FILE_LIMITS.maxBytes) throw new ClubError('fileTooLarge', { max: FILE_LIMITS.maxBytes / 1024 / 1024 }, 413)
    const now = this.now()
    const dayKey = `file:day:${userId}`
    const day = dayOf(now)
    const counted = await this.store.get<{ day: string; count: number }>(dayKey)
    const used = counted?.day === day ? counted.count : 0
    if (used >= FILE_LIMITS.perDay) throw new ClubError('fileDailyLimit', { max: FILE_LIMITS.perDay }, 429)
    await this.store.put(dayKey, { day, count: used + 1 })
    const token = randomId(24)
    const key = `${purpose}/${randomId(12)}.${fileExtension(type)}`
    const expires = now + FILE_LIMITS.ticketMs
    await this.store.put<StoredTicket>(`file:ticket:${token}`, { userId, key, type, expires, done: [] })
    const base = `${FILES_PATH}upload/${token}`
    return { key, uploadUrl: base, thumbUrl: `${base}?part=thumb`, expires }
  }

  /**
   * `PUT /api/files/upload/<pass>[?part=thumb]`: the picture (its type must be the one the pass
   * was for) or its thumbnail (any of the three types). Each part only once; the pass is used up
   * once both are in, or when it expires.
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
    const max = part === 'file' ? FILE_LIMITS.maxBytes : FILE_LIMITS.thumbMaxBytes
    if (bytes.length > max) throw new ClubError('fileTooLarge', { max: Math.round((max / 1024 / 1024) * 100) / 100 }, 413)
    const type = sniffAvatar(bytes)
    if (!type || (part === 'file' && type !== ticket.type)) throw new ClubError('fileBadFormat')
    if (part === 'thumb' && !ticket.done.includes('file')) throw new ClubError('badMessage')

    const metaKey = `file:meta:${ticket.key}`
    let meta: StoredFile
    if (part === 'file') {
      await bucket.put(ticket.key, bytes, { httpMetadata: { contentType: type } })
      meta = { owner: ticket.userId, type, size: bytes.length, createdAt: this.now() }
    } else {
      await bucket.put(thumbKey(ticket.key), bytes, { httpMetadata: { contentType: type } })
      const stored = await this.store.get<StoredFile>(metaKey)
      if (!stored) throw new ClubError('fileTicketExpired', {}, 401)
      meta = { ...stored, thumb: { type, size: bytes.length } }
    }
    await this.store.put(metaKey, meta)
    ticket.done.push(part)
    if (ticket.done.length === 2) await this.store.delete(ticketKey)
    else await this.store.put(ticketKey, ticket)
    return this.uploaded(ticket.key, meta)
  }

  /** `POST /api/files/urls`: fresh signed addresses; keys with no file are left out */
  async urls(keys: unknown): Promise<FileUrls> {
    this.requireBucket()
    if (!Array.isArray(keys) || keys.length > FILE_LIMITS.urlsMax) throw new ClubError('badMessage')
    const urls: FileUrls['urls'] = {}
    for (const key of new Set(keys)) {
      if (typeof key !== 'string' || !FILE_KEY.test(key)) continue
      const meta = await this.store.get<StoredFile>(`file:meta:${key}`)
      if (!meta) continue
      const { url, thumbUrl } = await this.uploaded(key, meta)
      urls[key] = thumbUrl ? { url, thumbUrl } : { url }
    }
    return { urls }
  }

  /**
   * `DELETE /api/files/<key>`: its uploader, or `mayDeleteAny` (a moderator, later), removes the
   * file and its thumbnail
   */
  async remove(userId: string, key: string, mayDeleteAny: boolean) {
    const bucket = this.requireBucket()
    const meta = FILE_KEY.test(key) ? await this.store.get<StoredFile>(`file:meta:${key}`) : undefined
    if (!meta) throw new ClubError('fileGone', {}, 404)
    if (meta.owner !== userId && !mayDeleteAny) throw new ClubError('noPermission', {}, 403)
    await bucket.delete(meta.thumb ? [key, thumbKey(key)] : key)
    await this.store.delete(`file:meta:${key}`)
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
    if (!FILE_KEY.test(key) || !(expires > now) || signature !== (await this.sign(key, expires))) throw new ClubError('fileGone', {}, 404)
    const object = await bucket.get(key)
    if (!object) throw new ClubError('fileGone', {}, 404)
    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        'Content-Length': String(object.size),
        'Cache-Control': `private, max-age=${Math.floor((expires - now) / 1000)}, immutable`,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    })
  }

  private async uploaded(key: string, meta: StoredFile): Promise<UploadedFile> {
    // Rounded to the hour, so every page asking within the same hour gets the same address and the browser's copy
    const hour = 3600_000
    const expires = Math.ceil(this.now() / hour) * hour + FILE_LIMITS.urlMs
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
  if (Number(request.headers.get('Content-Length') ?? 0) > max) throw tooLarge()
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.length > max) throw tooLarge()
  return bytes
}
