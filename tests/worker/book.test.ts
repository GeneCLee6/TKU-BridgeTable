// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Me } from '../../shared/protocol.ts'
import { BOOK_LIMITS, BookService, checkConvention, importRequestFrom } from '../../worker/book.ts'
import { importSchema } from '../../worker/importer.ts'
import { MemoryStore } from '../../worker/store.ts'

const amy: Me = { id: 'u1', username: 'amy', admin: false, permissions: ['bookEdit'] }
const ben: Me = { id: 'u2', username: 'ben', admin: false, permissions: ['bookEdit', 'bookImport'] }

/** A small convention in TKU BridgeBook's content model */
function convention(slug = 'lebensohl', extra: Record<string, unknown> = {}) {
  return {
    slug,
    nameZh: '雷本索',
    nameEn: 'Lebensohl',
    category: 'competitive',
    tags: ['2NT'],
    summary: '敵方插叫後的 2NT 接力。',
    source: { title: 'Lebensohl' },
    updated: '2026-10-23',
    sections: [
      {
        id: 'rules',
        title: '答叫原則',
        blocks: [
          { kind: 'paragraph', text: '原文。' },
          { kind: 'rules', items: [{ text: '第一條', children: [{ text: '子項' }] }] },
          {
            kind: 'responses',
            auction: { seats: ['開叫者', '敵方', '答叫者', '敵方'], calls: ['1NT', '2H', { call: '2NT', note: '接力' }] },
            rows: [{ call: '3C', meaning: '弱牌', pending: '待確認' }],
          },
          { kind: 'note', tone: 'info', text: 'P.S.' },
          { kind: 'hand', hand: { spades: 'AK2', hearts: 'QJ3', diamonds: 'T98', clubs: '7654' } },
        ],
        children: [{ id: 'more', title: '更多' }],
      },
    ],
    ...extra,
  }
}

let store: MemoryStore
let book: BookService
let time: number

beforeEach(() => {
  store = new MemoryStore()
  time = 1_000_000
  book = new BookService(store, () => time)
})

const entries = async (service = book) => JSON.parse((await service.content()).json).entries

describe('content edited online', () => {
  it('saves a convention, records each version and refuses a save made from an old one', async () => {
    expect(await book.content()).toEqual({ json: '{"version":0,"entries":[]}', version: 0 })
    const first = await book.save(amy, 'lebensohl', { convention: convention(), baseVersion: 0, bundledUpdated: '2026-10-21', note: '修正錯字' })
    expect(first).toMatchObject({ slug: 'lebensohl', version: 1, updatedBy: 'amy', bundledUpdated: '2026-10-21' })
    expect((await book.content()).version).toBe(1)

    time += 1000
    const changed = convention('lebensohl', { summary: '改過的摘要' })
    await expect(book.save(ben, 'lebensohl', { convention: changed, baseVersion: 0 })).rejects.toThrow('amy 剛剛修改了這個特約')
    const second = await book.save(ben, 'lebensohl', { convention: changed, baseVersion: 1 })
    expect(second).toMatchObject({ version: 2, updatedBy: 'ben', createdAt: first.createdAt, bundledUpdated: '2026-10-21' })

    const [entry] = await entries()
    expect(entry.convention.summary).toBe('改過的摘要')
    const revisions = await book.revisions('lebensohl')
    expect(revisions.map((r) => [r.version, r.by, r.action, r.note])).toEqual([
      [2, 'ben', 'save', ''],
      [1, 'amy', 'save', '修正錯字'],
    ])
    expect(revisions[0]).not.toHaveProperty('convention')
    expect((await book.revision('lebensohl', revisions[1].id)).convention).toMatchObject({ summary: '敵方插叫後的 2NT 接力。' })
  })

  it('keeps large conventions in parts and reads them back after a reload', async () => {
    const long = '很長的說明。'.repeat(20_000)
    await book.save(amy, 'long-one', { convention: convention('long-one', { summary: long }), baseVersion: 0 })
    const parts = [...store.data.keys()].filter((k) => k.startsWith('bookpart:book:entry:long-one:'))
    expect(parts.length).toBeGreaterThan(2)
    for (const key of store.data.keys()) expect(JSON.stringify(store.data.get(key)).length).toBeLessThan(128 * 1024 / 2)

    const reloaded = new BookService(store, () => time)
    const [entry] = await entries(reloaded)
    expect(entry.convention.summary).toBe(long)
    expect((await reloaded.content()).version).toBe(1)
    // Shrinking it drops the parts it no longer needs
    await reloaded.save(amy, 'long-one', { convention: convention('long-one'), baseVersion: 1 })
    expect([...store.data.keys()].filter((k) => k.startsWith('bookpart:book:entry:long-one:'))).toHaveLength(1)
  })

  it('hides a convention, or drops the online entry to show the bundled one again', async () => {
    await book.save(amy, 'lebensohl', { convention: convention(), baseVersion: 0 })
    await book.hide(ben, 'lebensohl', { baseVersion: 1 })
    expect((await entries())[0]).toMatchObject({ slug: 'lebensohl', version: 2, convention: null })
    // A bundled convention can be hidden without being edited first
    await book.hide(ben, 'jacoby-2nt', { baseVersion: 0 })
    await expect(book.reset(amy, 'lebensohl', { baseVersion: 1 })).rejects.toThrow('剛剛修改了')
    await book.reset(amy, 'lebensohl', { baseVersion: 2 })
    expect((await entries()).map((e: { slug: string }) => e.slug)).toEqual(['jacoby-2nt'])
    expect([...store.data.keys()].some((k) => k.includes('entry:lebensohl'))).toBe(false)
    expect((await book.revisions('lebensohl')).map((r) => r.action)).toEqual(['reset', 'hide', 'save'])
    await expect(book.reset(amy, 'lebensohl', { baseVersion: 0 })).rejects.toThrow('找不到這個特約')
    expect((await book.content()).version).toBe(4)
  })

  it('accepts only the shape of a convention', async () => {
    const save = (value: unknown, slug = 'lebensohl') => book.save(amy, slug, { convention: value, baseVersion: 0 })
    await expect(save(convention(), 'Bad Slug')).rejects.toThrow('小寫英數')
    await expect(save(convention('other'))).rejects.toThrow('slug')
    await expect(save({ ...convention(), nameZh: ' ' })).rejects.toThrow('中文名稱')
    await expect(save({ ...convention(), tags: 'x' })).rejects.toThrow('tags')
    const twice = convention('lebensohl', { sections: [{ id: 'a', title: 'A' }, { id: 'a', title: 'B' }] })
    await expect(save(twice)).rejects.toThrow('段落 id 重複：a')
    const badBlock = convention('lebensohl', { sections: [{ id: 'a', title: 'A', blocks: [{ kind: 'video' }] }] })
    await expect(save(badBlock)).rejects.toThrow('不明的內容區塊')
    const badAuction = convention('lebensohl', {
      sections: [{ id: 'a', title: 'A', blocks: [{ kind: 'responses', auction: { seats: ['N'], calls: [] }, rows: [] }] }],
    })
    await expect(save(badAuction)).rejects.toThrow('四個座位')
    let deep: Record<string, unknown> = { id: 'd9', title: 'deep' }
    for (let i = 8; i > 0; i--) deep = { id: `d${i}`, title: 'deep', children: [deep] }
    await expect(save(convention('lebensohl', { sections: [deep] }))).rejects.toThrow('層數太多')
    await expect(save(convention('lebensohl', { summary: 'x'.repeat(BOOK_LIMITS.conventionMax) }))).rejects.toThrow('內容太大')
    expect(checkConvention(convention(), 'lebensohl')).toBeTruthy()
    expect(await book.revisions('lebensohl')).toEqual([])
  })
})

describe('AI import', () => {
  it('gives single-use passes that expire', async () => {
    const ticket = await book.createTicket(ben)
    expect(await book.useTicket(ticket)).toBe('u2')
    await expect(book.useTicket(ticket)).rejects.toThrow('匯入憑證已失效')
    const late = await book.createTicket(ben)
    time += BOOK_LIMITS.ticketMs + 1
    await expect(book.useTicket(late)).rejects.toThrow('匯入憑證已失效')
    await expect(book.useTicket('../../user:u1')).rejects.toThrow('匯入憑證已失效')
  })

  it('keeps drafts newest first, and only the newest ones', async () => {
    const result = { conventions: [convention()], reviewNotes: '' }
    const first = await book.saveDraft(ben, { fileName: 'Lebensohl.doc', result })
    expect(first).toMatchObject({ fileName: 'Lebensohl.doc', createdBy: 'ben', conventions: 1 })
    expect((await book.draft(first.id)).result).toEqual(result)
    for (let i = 0; i < BOOK_LIMITS.draftsKept; i++) {
      time += 1000
      await book.saveDraft(ben, { fileName: `f${i}.pdf`, result })
    }
    const drafts = await book.drafts()
    expect(drafts).toHaveLength(BOOK_LIMITS.draftsKept)
    expect(drafts[0].fileName).toBe(`f${BOOK_LIMITS.draftsKept - 1}.pdf`)
    await expect(book.draft(first.id)).rejects.toThrow('找不到這份匯入草稿')
    await book.deleteDraft(drafts[0].id)
    expect(await book.drafts()).toHaveLength(BOOK_LIMITS.draftsKept - 1)
    await expect(book.saveDraft(ben, { result: { nothing: true } })).rejects.toThrow('匯入結果格式不正確')
  })

  it('reads the upload form: a pass, what to tell the AI, and the text or the PDF', async () => {
    const meta = {
      fileName: 'NMF.doc',
      instructions: '以特約為準',
      catalogue: 'lebensohl | 雷本索',
      categories: [{ id: 'notrump', label: '無王開叫後續', description: '1NT 之後' }, { id: 'Bad Id', label: 'x' }],
    }
    const form = new FormData()
    form.set('ticket', 'abc')
    form.set('meta', JSON.stringify(meta))
    form.set('text', '新低花迫叫\n1C 1H 1NT 2D')
    const { ticket, request } = importRequestFrom(form)
    expect(ticket).toBe('abc')
    expect(request).toMatchObject({ fileName: 'NMF.doc', instructions: '以特約為準', catalogue: 'lebensohl | 雷本索' })
    expect(request.categories.map((c) => c.id)).toEqual(['notrump'])
    expect(request.source).toEqual({ kind: 'text', text: '新低花迫叫\n1C 1H 1NT 2D' })

    const pdf = new FormData()
    pdf.set('meta', JSON.stringify(meta))
    pdf.set('file', new Blob(['%PDF-1.7'], { type: 'application/pdf' }), 'NMF.pdf')
    expect(importRequestFrom(pdf).request.source.kind).toBe('pdf')

    const empty = new FormData()
    empty.set('meta', JSON.stringify(meta))
    expect(() => importRequestFrom(empty)).toThrow('PDF')
    expect(() => importRequestFrom(null)).toThrow('PDF')
    const noCategories = new FormData()
    noCategories.set('text', 'x')
    expect(() => importRequestFrom(noCategories)).toThrow('缺少分類')
  })

  it('asks for a flat reply that structured outputs can describe', () => {
    const schema = importSchema(['notrump', 'system'])
    const text = JSON.stringify(schema)
    expect(text).not.toContain('$ref')
    const section = (schema.properties.conventions as { items: { properties: Record<string, { items?: unknown; enum?: string[] }> } }).items
    expect(section.properties.category.enum).toEqual(['notrump', 'system'])
    expect(text.match(/"const":"(\w+)"/g)).toEqual([
      '"const":"paragraph"',
      '"const":"rules"',
      '"const":"responses"',
      '"const":"note"',
      '"const":"hand"',
    ])
    // Every object lists all its properties as required and allows nothing else
    const objects = (value: unknown): Record<string, unknown>[] =>
      typeof value !== 'object' || value === null
        ? []
        : [...((value as { type?: string }).type === 'object' ? [value as Record<string, unknown>] : []), ...Object.values(value).flatMap(objects)]
    for (const object of objects(schema)) {
      expect(object.additionalProperties).toBe(false)
      expect(object.required).toEqual(Object.keys(object.properties as object))
    }
  })
})
