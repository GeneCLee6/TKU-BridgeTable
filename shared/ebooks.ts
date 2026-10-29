/**
 * E-books in TKU BridgeHall's library (淡江橋館 叢書, BridgeHall E5 e5-t09 e5-t11 e5-t15): PDFs a
 * reviewer uploads to the R2 bucket `bridgebook-files` (the same bucket and passes as the pictures,
 * `shared/files.ts`, `worker/files.ts`) and the record that names them (`worker/ebooks.ts`).
 *
 * 1. `POST /api/book/ebooks/ticket` with the size: a single-use pass and the PDF's key (reviewers).
 * 2. `PUT` the bytes to `uploadUrl` before the pass expires (`/api/files/upload/<pass>`, as a picture).
 * 3. `POST /api/book/ebooks` with the record (title, authors, series, license…, `fileKey`).
 *
 * Reading: `GET /api/book/ebooks[/:id]` needs no sign-in, but `members-only` books are left out
 * for someone signed out, and their PDF's address is only ever signed for a member. The addresses
 * are short-lived (`EBOOK_LIMITS.urlMs`).
 */

export const EBOOK_TYPE = 'application/pdf'
export type EbookFileType = typeof EBOOK_TYPE

/** A PDF's key in the bucket */
export const EBOOK_KEY = /^ebook\/[0-9a-f]{24}\.pdf$/

/** The same three as an article's (`worker/articles.ts` ARTICLE_LICENSES): every book needs one */
export const EBOOK_LICENSES = ['own', 'permitted', 'members-only'] as const
export type EbookLicense = (typeof EBOOK_LICENSES)[number]

export const EBOOK_LIMITS = {
  /** The largest PDF */
  maxBytes: 50 * 1024 * 1024,
  titleMax: 120,
  authorsMax: 10,
  nameMax: 40,
  seriesMax: 40,
  /** How long a PDF's signed address works */
  urlMs: 15 * 60 * 1000,
  booksMax: 500,
} as const

/** The bucket's room (R2's free plan is 10 GB): admins are told past `warnBytes`, uploads stop at `maxBytes` */
export const STORAGE_LIMITS = {
  warnBytes: 8 * 1024 ** 3,
  maxBytes: 10 * 1024 ** 3,
} as const

/** What the uploaded files take up in the bucket, pictures and PDFs together */
export interface FileUsage {
  bytes: number
  warnBytes: number
  maxBytes: number
}

/** `POST /api/book/ebooks/ticket` */
export interface EbookTicketRequest {
  /** The PDF's size in bytes, checked again when it arrives */
  size: number
}

/** What a reviewer writes (`POST /api/book/ebooks`, `PUT /api/book/ebooks/:id`) */
export interface EbookInput {
  title: string
  authors: string[]
  series: string
  year?: number
  license: EbookLicense
  /** The uploaded PDF's key (`EBOOK_KEY`) */
  fileKey: string
  pages?: number
  /** An uploaded picture's key (purpose `article`), never an address */
  cover?: string
}

export interface Ebook extends EbookInput {
  id: string
  /** The PDF's size in bytes, from the upload */
  size: number
  uploadedBy: string
  createdAt: number
  updatedAt: number
  updatedBy: string
}

/** Signed addresses by file key: the covers, and on a book's own page its PDF */
export type EbookFiles = Record<string, { url: string; thumbUrl?: string }>

/** `GET /api/book/ebooks`: the books the reader may see, oldest first; `usage` for editors only */
export interface EbookList {
  ebooks: Ebook[]
  files: EbookFiles
  usage?: FileUsage
}

/** `GET /api/book/ebooks/:id`: the book with addresses for its cover and its PDF */
export interface EbookResponse {
  ebook: Ebook
  files: EbookFiles
}
