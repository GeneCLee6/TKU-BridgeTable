// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { EBOOK_KEY, EBOOK_LIMITS, STORAGE_LIMITS } from '../../shared/ebooks.ts'
import type { Me } from '../../shared/protocol.ts'
import { EbookService } from '../../worker/ebooks.ts'
import { ClubError } from '../../worker/errors.ts'
import { type FileBucket, FileService } from '../../worker/files.ts'
import { bookRouteNeed, ebookReadRoute } from '../../worker/roles.ts'
import { MemoryStore } from '../../worker/store.ts'

/** BridgeHall e5-t09 (upload and records), e5-t11 (who sees what), e5-t15 (the bucket's usage) */

class MemoryBucket implements FileBucket {
  readonly objects = new Map<string, { bytes: Uint8Array; type?: string }>()
  async put(key: string, value: ArrayBuffer | Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    this.objects.set(key, { bytes: new Uint8Array(value), type: options?.httpMetadata?.contentType })
  }
  async get(key: string) {
    const object = this.objects.get(key)
    if (!object) return null
    return { body: new Blob([object.bytes as Uint8Array<ArrayBuffer>]).stream(), size: object.bytes.length, httpMetadata: { contentType: object.type } }
  }
  async delete(keys: string | string[]) {
    for (const key of [keys].flat()) this.objects.delete(key)
  }
}

const pdf = (size = 128) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
  return bytes
}
const webp = (size = 64) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  return bytes
}

const code = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error instanceof ClubError ? { code: error.code, status: error.status } : error
  }
  return 'no error'
}
const tokenOf = (url: string) => url.split('/').pop()!.split('?')[0]
const reviewer = { id: 'r1', username: 'reviewer', admin: false, permissions: ['bookEdit', 'bookReview'] } as unknown as Me

describe('e-books', () => {
  let now: number
  let store: MemoryStore
  let bucket: MemoryBucket
  let files: FileService
  let ebooks: EbookService
  let told: number[]

  beforeEach(() => {
    now = Date.parse('2026-10-29T04:00:00Z')
    store = new MemoryStore()
    bucket = new MemoryBucket()
    told = []
    files = new FileService(store, bucket, () => now, async (bytes) => void told.push(bytes))
    ebooks = new EbookService(
      store,
      { sign: (k) => files.urls(k), meta: (k) => files.meta(k), remove: (u, k, a) => files.remove(u, k, a), usage: () => files.usage() },
      () => now,
    )
  })

  const uploadPdf = async (size = 128) => {
    const ticket = await files.createEbookTicket('r1', { size })
    await files.upload(tokenOf(ticket.uploadUrl), 'file', pdf(size))
    return ticket.key
  }
  const record = (fileKey: string, extra: Record<string, unknown> = {}) => ({
    title: ' 主打技巧 ',
    authors: ['學長'],
    series: '主打',
    license: 'own',
    fileKey,
    ...extra,
  })

  it('takes a PDF on a pass of its own, with no thumbnail, and serves it by a short-lived address', async () => {
    const ticket = await files.createEbookTicket('r1', { size: 128 })
    expect(ticket.key).toMatch(EBOOK_KEY)
    const token = tokenOf(ticket.uploadUrl)
    expect(await files.uploadMax(token, 'file')).toBe(EBOOK_LIMITS.maxBytes)
    const file = await files.upload(token, 'file', pdf())
    expect(file).toMatchObject({ key: ticket.key, type: 'application/pdf', size: 128 })
    // Used up at once: no thumbnail for a PDF
    expect(await store.get(`file:ticket:${token}`)).toBeUndefined()
    const url = new URL(file.url, 'https://example.org')
    expect(Number(url.searchParams.get('e')) - now).toBeLessThanOrEqual(EBOOK_LIMITS.urlMs + 5 * 60_000)
    const response = await files.serve(ticket.key, url)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    now += EBOOK_LIMITS.urlMs + 5 * 60_000
    expect(await code(files.serve(ticket.key, url))).toEqual({ code: 'fileGone', status: 404 })
  })

  it('refuses a PDF too large, a file that is not a PDF, and a picture on a PDF pass', async () => {
    expect(await code(files.createEbookTicket('r1', { size: EBOOK_LIMITS.maxBytes + 1 }))).toEqual({ code: 'ebookTooLarge', status: 413 })
    const ticket = await files.createEbookTicket('r1', { size: 64 })
    const token = tokenOf(ticket.uploadUrl)
    expect(await code(files.upload(token, 'file', webp()))).toEqual({ code: 'ebookBadFormat', status: 400 })
    expect(await code(files.upload(token, 'thumb', webp()))).toEqual({ code: 'badMessage', status: 400 })
    // A picture's pass still takes only a picture, with a picture's limit
    const picture = await files.createTicket('r1', { purpose: 'article', type: 'image/webp', size: 64 })
    expect(await files.uploadMax(tokenOf(picture.uploadUrl), 'file')).toBe(2 * 1024 * 1024)
    expect(await code(files.upload(tokenOf(picture.uploadUrl), 'file', pdf()))).toEqual({ code: 'fileBadFormat', status: 400 })
  })

  it('needs a license, a title, a series, an author and an uploaded PDF', async () => {
    const key = await uploadPdf()
    for (const bad of [
      record(key, { license: undefined }),
      record(key, { license: 'commercial' }),
      record(key, { title: '  ' }),
      record(key, { series: '' }),
      record(key, { authors: [] }),
      record(key, { year: 1850 }),
      record(key, { pages: 0 }),
      record(key, { cover: 'https://example.org/x.jpg' }),
      record('ebook/000000000000000000000000.pdf'),
      record('article/000000000000000000000000.webp'),
    ])
      expect(await code(ebooks.create(reviewer, bad))).toEqual({ code: 'badContent', status: 400 })

    const book = await ebooks.create(reviewer, record(key, { year: 2024 }))
    expect(book).toMatchObject({ title: '主打技巧', authors: ['學長'], year: 2024, size: 128, uploadedBy: 'reviewer' })
    // One PDF is one book
    expect(await code(ebooks.create(reviewer, record(key)))).toEqual({ code: 'badContent', status: 400 })
  })

  it('leaves members-only books out for someone signed out, and never signs their PDF for them (AC-5.6)', async () => {
    const open = await ebooks.create(reviewer, record(await uploadPdf()))
    const closed = await ebooks.create(reviewer, record(await uploadPdf(), { license: 'members-only', title: '社課講義' }))

    const anyone = await ebooks.list('anyone')
    expect(anyone.ebooks.map((b) => b.id)).toEqual([open.id])
    expect(anyone.usage).toBeUndefined()
    expect(await code(ebooks.get('anyone', closed.id))).toEqual({ code: 'ebookGone', status: 404 })

    expect((await ebooks.list('member')).ebooks.map((b) => b.id)).toEqual([open.id, closed.id])
    const read = await ebooks.get('member', closed.id)
    expect(read.files[closed.fileKey].url).toContain(closed.fileKey)
    expect((await ebooks.list('editor')).usage).toEqual({ bytes: 256, warnBytes: STORAGE_LIMITS.warnBytes, maxBytes: STORAGE_LIMITS.maxBytes })
  })

  it('changes a book, replacing its PDF, and takes one down with its PDF', async () => {
    const first = await uploadPdf(128)
    const book = await ebooks.create(reviewer, record(first))
    const second = await uploadPdf(200)
    const changed = await ebooks.update(reviewer, book.id, record(second, { title: '主打技巧（修訂）' }))
    expect(changed).toMatchObject({ id: book.id, size: 200, title: '主打技巧（修訂）', createdAt: book.createdAt })
    expect(bucket.objects.has(first)).toBe(false)

    await ebooks.remove(reviewer, book.id)
    expect(bucket.objects.has(second)).toBe(false)
    expect((await ebooks.list('editor')).ebooks).toEqual([])
    expect((await files.usage()).bytes).toBe(0)
    expect(await code(ebooks.remove(reviewer, book.id))).toEqual({ code: 'ebookGone', status: 404 })
  })

  it('lists books without the bucket, with no addresses (filesOff)', async () => {
    const key = await uploadPdf()
    await ebooks.create(reviewer, record(key))
    const off = new EbookService(store, {
      sign: () => new FileService(store, undefined).urls([]),
      meta: (k) => files.meta(k),
      remove: (u, k, a) => files.remove(u, k, a),
      usage: () => files.usage(),
    })
    const list = await off.list('anyone')
    expect(list.ebooks).toHaveLength(1)
    expect(list.files).toEqual({})
  })

  it('tells the admins once when the files pass 8 GB, and stops uploads past 10 GB (e5-t15)', async () => {
    await store.put('file:usage', { bytes: STORAGE_LIMITS.warnBytes - 100, warned: false })
    await uploadPdf(64)
    expect(told).toEqual([])
    await uploadPdf(64)
    expect(told).toEqual([STORAGE_LIMITS.warnBytes + 28])
    await uploadPdf(64)
    expect(told).toHaveLength(1)

    await store.put('file:usage', { bytes: STORAGE_LIMITS.maxBytes - 100, warned: true })
    expect(await code(files.createEbookTicket('r1', { size: 101 }))).toEqual({ code: 'fileStorageFull', status: 507 })
    expect(await code(files.createTicket('r1', { purpose: 'post', type: 'image/webp', size: 101 }))).toEqual({ code: 'fileStorageFull', status: 507 })
  })

  it('counts the usage from the files the first time', async () => {
    await uploadPdf(100)
    await store.delete('file:usage')
    expect((await files.usage()).bytes).toBe(100)
  })

  it('keeps uploading and changing books for reviewers; reading needs no sign-in', () => {
    expect(bookRouteNeed('POST', '/ebooks/ticket')).toBe('bookReview')
    expect(bookRouteNeed('POST', '/ebooks')).toBe('bookReview')
    expect(bookRouteNeed('PUT', '/ebooks/abc')).toBe('bookReview')
    expect(bookRouteNeed('DELETE', '/ebooks/abc')).toBe('bookReview')
    expect(bookRouteNeed('GET', '/ebooks/ticket')).toBeNull()
    expect(bookRouteNeed('PATCH', '/ebooks/abc')).toBeNull()
    expect(ebookReadRoute('GET', '/api/book/ebooks')).toEqual({})
    expect(ebookReadRoute('GET', '/api/book/ebooks/abc')).toEqual({ id: 'abc' })
    expect(ebookReadRoute('POST', '/api/book/ebooks')).toBeNull()
  })
})
