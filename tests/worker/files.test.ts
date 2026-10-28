// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { FILE_KEY, FILE_LIMITS, thumbKey } from '../../shared/files.ts'
import { ClubError } from '../../worker/errors.ts'
import { type FileBucket, FileService, readFileUpload } from '../../worker/files.ts'
import { MemoryStore } from '../../worker/store.ts'

/** An R2 bucket in memory */
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

const webp = (size = 64) => {
  const bytes = new Uint8Array(size)
  bytes.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
  return bytes
}
const jpeg = (size = 64) => {
  const bytes = new Uint8Array(size)
  bytes.set([0xff, 0xd8, 0xff])
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

describe('FileService', () => {
  let now: number
  let store: MemoryStore
  let bucket: MemoryBucket
  let files: FileService

  beforeEach(() => {
    now = Date.parse('2026-10-28T04:00:00Z')
    store = new MemoryStore()
    bucket = new MemoryBucket()
    files = new FileService(store, bucket, () => now)
  })

  it('takes a pass, the picture and its thumbnail, and serves them by signed address', async () => {
    const ticket = await files.createTicket('u1', { purpose: 'post', type: 'image/webp', size: 64 })
    expect(ticket.key).toMatch(FILE_KEY)
    expect(ticket.key.startsWith('post/')).toBe(true)
    expect(ticket.uploadUrl).toMatch(/^\/api\/files\/upload\/[0-9a-f]{48}$/)
    expect(ticket.thumbUrl).toBe(`${ticket.uploadUrl}?part=thumb`)
    const token = tokenOf(ticket.uploadUrl)

    const file = await files.upload(token, 'file', webp())
    expect(file).toMatchObject({ key: ticket.key, type: 'image/webp', size: 64 })
    expect(file.thumbUrl).toBeUndefined()
    expect(bucket.objects.get(ticket.key)?.type).toBe('image/webp')

    const withThumb = await files.upload(token, 'thumb', jpeg(32))
    expect(withThumb.thumbUrl).toContain(thumbKey(ticket.key))
    expect(bucket.objects.get(thumbKey(ticket.key))?.type).toBe('image/jpeg')
    // Both parts in: the pass is used up
    expect(await store.get(`file:ticket:${token}`)).toBeUndefined()

    const url = new URL(withThumb.url, 'https://example.org')
    const response = await files.serve(url.pathname.slice('/api/files/'.length), url)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/webp')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(webp())
  })

  it('refuses a wrong, forged or expired address', async () => {
    const ticket = await files.createTicket('u1', { purpose: 'post', type: 'image/webp', size: 64 })
    const { url } = await files.upload(tokenOf(ticket.uploadUrl), 'file', webp())
    const signed = new URL(url, 'https://example.org')
    const key = signed.pathname.slice('/api/files/'.length)

    const forged = new URL(signed)
    forged.searchParams.set('s', 'x'.repeat(32))
    expect(await code(files.serve(key, forged))).toEqual({ code: 'fileGone', status: 404 })
    const later = new URL(signed)
    later.searchParams.set('e', String(Number(signed.searchParams.get('e')) + 1000))
    expect(await code(files.serve(key, later))).toEqual({ code: 'fileGone', status: 404 })

    now += FILE_LIMITS.urlMs + 3600_000
    expect(await code(files.serve(key, signed))).toEqual({ code: 'fileGone', status: 404 })
    // A fresh address works again
    const { urls } = await files.urls([key, 'post/000000000000000000000000.webp', '../secret'])
    expect(Object.keys(urls)).toEqual([key])
    const fresh = new URL(urls[key].url, 'https://example.org')
    expect((await files.serve(key, fresh)).status).toBe(200)
  })

  it('checks the type, the size and the pass', async () => {
    expect(await code(files.createTicket('u1', { purpose: 'post', type: 'image/gif', size: 64 }))).toEqual({ code: 'fileBadFormat', status: 400 })
    expect(await code(files.createTicket('u1', { purpose: 'avatar', type: 'image/webp', size: 64 }))).toEqual({ code: 'badMessage', status: 400 })
    expect(await code(files.createTicket('u1', { purpose: 'post', type: 'image/webp', size: FILE_LIMITS.maxBytes + 1 }))).toEqual({
      code: 'fileTooLarge',
      status: 413,
    })

    const ticket = await files.createTicket('u1', { purpose: 'article', type: 'image/webp', size: 64 })
    const token = tokenOf(ticket.uploadUrl)
    // A thumbnail before the picture, a JPEG on a WebP pass, a thumbnail that is too large
    expect(await code(files.upload(token, 'thumb', jpeg()))).toEqual({ code: 'badMessage', status: 400 })
    expect(await code(files.upload(token, 'file', jpeg()))).toEqual({ code: 'fileBadFormat', status: 400 })
    expect(await code(files.upload(token, 'file', new Uint8Array(64)))).toEqual({ code: 'fileBadFormat', status: 400 })
    await files.upload(token, 'file', webp())
    expect(await code(files.upload(token, 'file', webp()))).toEqual({ code: 'fileTicketExpired', status: 401 })
    expect(await code(files.upload(token, 'thumb', webp(FILE_LIMITS.thumbMaxBytes + 1)))).toEqual({ code: 'fileTooLarge', status: 413 })

    const late = await files.createTicket('u1', { purpose: 'post', type: 'image/webp', size: 64 })
    now += FILE_LIMITS.ticketMs + 1
    expect(await code(files.upload(tokenOf(late.uploadUrl), 'file', webp()))).toEqual({ code: 'fileTicketExpired', status: 401 })
    expect(await code(files.upload('nope', 'file', webp()))).toEqual({ code: 'fileTicketExpired', status: 401 })
  })

  it('allows 30 uploads a day per member, starting over the next day in Taiwan', async () => {
    for (let i = 0; i < FILE_LIMITS.perDay; i++) await files.createTicket('u1', { purpose: 'post', type: 'image/png', size: 10 })
    expect(await code(files.createTicket('u1', { purpose: 'post', type: 'image/png', size: 10 }))).toEqual({ code: 'fileDailyLimit', status: 429 })
    // Someone else still may
    await files.createTicket('u2', { purpose: 'post', type: 'image/png', size: 10 })
    // 16:00 UTC is midnight in Taiwan
    now = Date.parse('2026-10-28T16:00:00Z')
    await files.createTicket('u1', { purpose: 'post', type: 'image/png', size: 10 })
  })

  it('lets the uploader or an admin remove a file and its thumbnail', async () => {
    const ticket = await files.createTicket('u1', { purpose: 'post', type: 'image/webp', size: 64 })
    const token = tokenOf(ticket.uploadUrl)
    await files.upload(token, 'file', webp())
    await files.upload(token, 'thumb', webp())
    expect(await code(files.remove('u2', ticket.key, false))).toEqual({ code: 'noPermission', status: 403 })
    await files.remove('u2', ticket.key, true)
    expect(bucket.objects.size).toBe(0)
    expect(await code(files.remove('u1', ticket.key, false))).toEqual({ code: 'fileGone', status: 404 })
  })

  it('answers 503 without a bucket, so the Worker runs before it is created', async () => {
    const off = new FileService(store, undefined, () => now)
    expect(await code(off.createTicket('u1', { purpose: 'post', type: 'image/webp', size: 64 }))).toEqual({ code: 'filesOff', status: 503 })
    expect(await code(off.urls([]))).toEqual({ code: 'filesOff', status: 503 })
  })

  it('refuses an upload over the limit before reading it', async () => {
    const request = new Request('https://example.org/x', { method: 'PUT', body: new Uint8Array(10), headers: { 'Content-Length': '999999999' } })
    expect(await code(readFileUpload(request, 1000))).toEqual({ code: 'fileTooLarge', status: 413 })
    const small = new Request('https://example.org/x', { method: 'PUT', body: new Uint8Array(10) })
    expect((await readFileUpload(small, 1000)).length).toBe(10)
  })
})
