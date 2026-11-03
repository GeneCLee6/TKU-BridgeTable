/**
 * Pictures members upload for posts and articles (TKU-BridgeBook e11-t02; E5's articles reuse it),
 * kept in the R2 bucket `bridgebook-files` (`worker/files.ts`, ARCHITECTURE.md §5.14). The browser
 * shrinks the picture and makes its thumbnail; the Worker never decodes one, it only checks the
 * size and the file's first bytes.
 *
 * 1. `POST /api/files/ticket` with the type and size: a single-use pass and the file's key, counted
 *    against the member's daily uploads.
 * 2. `PUT` the bytes to `uploadUrl` (and the thumbnail to `thumbUrl`, optional) before the pass
 *    expires. The pass is the check, so the upload may go straight to the Worker.
 * 3. Show it with `GET /api/files/<key>?e=&s=`: a signed address that works for a while without
 *    signing in (an `<img>` sends no cookie across sites); `POST /api/files/urls` signs fresh ones.
 *
 * Every address is a path (`/api/files/…`): each site's `/api/` reaches this Worker. The upload
 * also answers CORS, so a page may send it straight to the Worker's own address instead.
 *
 * Avatars are not files: they stay in the club's storage (`shared/avatar.ts`).
 *
 * The table's forum pictures (e13-t13): GIF is taken for posts only (an article's pictures stay the
 * three types BridgeHall's article editor reads), uploaded as it is so it keeps moving; SVG never
 * (it may carry script). A `post/` picture is signed only for someone who may see a post using
 * it, and goes with its post (`worker/post-images.ts`, ARCHITECTURE.md §5.14).
 */

import { sniffAvatar } from './avatar.ts'
import type { EbookFileType } from './ebooks.ts'

export const FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export type FileType = (typeof FILE_TYPES)[number]
export const isFileType = (value: unknown): value is FileType => FILE_TYPES.includes(value as FileType)
/** The types only a post's picture may be (e13-t13) */
export const POST_ONLY_TYPES: readonly FileType[] = ['image/gif']

const GIF87 = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]
const GIF89 = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]

/**
 * A picture's type from its first bytes (magic numbers), whatever the upload's Content-Type says:
 * JPEG, PNG, WebP (as for avatars) or GIF; null for anything else, SVG included
 */
export function sniffFile(bytes: Uint8Array): FileType | null {
  const known = sniffAvatar(bytes)
  if (known) return known
  if (bytes.length >= 6 && (GIF87.every((b, i) => bytes[i] === b) || GIF89.every((b, i) => bytes[i] === b))) return 'image/gif'
  return null
}

/** What a file is for; the first part of its key */
export const FILE_PURPOSES = ['post', 'article'] as const
export type FilePurpose = (typeof FILE_PURPOSES)[number]
export const isFilePurpose = (value: unknown): value is FilePurpose => FILE_PURPOSES.includes(value as FilePurpose)

export const FILE_LIMITS = {
  /** The largest picture, after the browser shrank it */
  maxBytes: 2 * 1024 * 1024,
  /** The largest thumbnail */
  thumbMaxBytes: 256 * 1024,
  /** The longest side the browser shrinks a picture to, and its thumbnail to */
  pixels: 2048,
  thumbPixels: 480,
  /** Uploads (passes) per member per day, Taiwan time */
  perDay: 30,
  /** How long a pass may be used */
  ticketMs: 10 * 60 * 1000,
  /** How long a signed address works */
  urlMs: 60 * 60 * 1000,
  /** Most addresses signed in one `POST /api/files/urls` */
  urlsMax: 50,
} as const

/** `POST /api/files/ticket` */
export interface FileTicketRequest {
  purpose: FilePurpose
  type: FileType
  /** The picture's size in bytes, checked again when it arrives */
  size: number
}

/** The answer: where to put the picture and its thumbnail, until `expires` */
export interface FileTicket {
  key: string
  uploadUrl: string
  thumbUrl: string
  expires: number
}

/** A stored file as the uploader gets it back, with signed addresses */
export interface UploadedFile {
  key: string
  /** A picture's, or a PDF's for an e-book (`shared/ebooks.ts`, BridgeHall e5-t09) */
  type: FileType | EbookFileType
  size: number
  url: string
  /** None until a thumbnail was uploaded */
  thumbUrl?: string
}

/** `POST /api/files/urls`: fresh signed addresses for keys, e.g. a post's pictures; unknown keys are left out */
export interface FileUrls {
  urls: Record<string, { url: string; thumbUrl?: string }>
}

const EXTENSIONS: Record<FileType, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' }
export const fileExtension = (type: FileType) => EXTENSIONS[type]

/** A file's key: `<purpose>/<24 hex digits>.<ext>`; its thumbnail adds `-thumb` before the extension */
export const FILE_KEY = /^(post|article)\/[0-9a-f]{24}(-thumb)?\.(jpg|png|webp|gif)$/
export const thumbKey = (key: string) => key.replace(/\.(\w+)$/, '-thumb.$1')
