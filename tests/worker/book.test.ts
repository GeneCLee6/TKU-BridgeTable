// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Me } from '../../shared/protocol.ts'
import { BOOK_LIMITS, BookService, CATEGORY_LIMITS, checkCategories, checkConvention, importRequestFrom, publicBookResponse } from '../../worker/book.ts'
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

  it('tells the robot’s sync which articles changed online, and which are hidden (e5-t45)', async () => {
    await book.save(amy, 'lebensohl', { convention: convention(), baseVersion: 0 })
    await book.hide(ben, 'jacoby-2nt', { baseVersion: 0 })
    const online = await book.onlineArticles()
    expect(online.get('lebensohl')).toEqual({ version: 1, updatedAt: time, updatedBy: 'amy', hidden: false })
    expect(online.get('jacoby-2nt')).toMatchObject({ updatedBy: 'ben', hidden: true })
    expect(online.has('bergen-raises')).toBe(false)
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
    await expect(save(convention('lebensohl', { kind: 'gadget' }))).rejects.toThrow('種類（kind）不存在')
    await expect(save(convention('lebensohl', { level: 'expert' }))).rejects.toThrow('程度（level）不存在')
    await expect(save(convention('lebensohl', { prerequisites: 'jacoby-2nt' }))).rejects.toThrow('前置特約')
    await expect(save(convention('lebensohl', { sections: [{ id: 'a', title: 'A', level: 'hard' }] }))).rejects.toThrow('段落的程度')
    expect(checkConvention(convention(), 'lebensohl')).toBeTruthy()
    expect(checkConvention(convention('lebensohl', { kind: 'defense', level: 'basic', prerequisites: ['jacoby-2nt'], cardSlots: [] }), 'lebensohl')).toBeTruthy()
    expect(await book.revisions('lebensohl')).toEqual([])
  })

  it('checks an editor’s hand conditions on a response row (BridgeHall e7-t08)', () => {
    const withConditions = (conditions: unknown) =>
      convention('lebensohl', {
        sections: [{ id: 'a', title: 'A', blocks: [{ kind: 'responses', rows: [{ call: '2C', meaning: '邀請', conditions }] }] }],
      })
    expect(checkConvention(withConditions({ hcp: [8, 9], len: { H: [5, 40] }, forcing: 'oneRound' }), 'lebensohl')).toBeTruthy()
    expect(() => checkConvention(withConditions({ forcing: 'game' }), 'lebensohl')).toThrow('叫品「2C」的手牌條件：手牌條件要有點力或張數')
    expect(() => checkConvention(withConditions({ hcp: [9, 8] }), 'lebensohl')).toThrow('點力範圍不正確')
  })
})

/** A convention with 待確認 notes in every place the handbook looks for them */
function pendingConvention() {
  return convention('lebensohl', {
    aliases: ['Lebensohl 2NT'],
    kind: 'convention',
    level: 'intermediate',
    prerequisites: ['notrump-responses'],
    sections: [
      {
        id: 'a',
        title: '甲',
        pending: 'a0',
        blocks: [
          { kind: 'rules', items: [{ text: '1', pending: 'a2', children: [{ text: '1.1', pending: 'a3' }] }, { text: '2', pending: 'a4' }] },
          { kind: 'note', tone: 'info', text: '不算' },
          { kind: 'responses', rows: [{ call: '2C', meaning: 'x', pending: 'a5' }, { call: '2D', meaning: 'y' }, { call: '2H', meaning: 'z', pending: 'a6' }] },
          { kind: 'paragraph', text: 'p', pending: 'a7' },
        ],
        children: [
          { id: 'a-1', title: '甲一', blocks: [{ kind: 'paragraph', text: 'q', pending: 'b0' }], children: [] },
          { id: 'a-2', title: '甲二', children: [{ id: 'a-2-x', title: '甲二X', pending: 'c0' }] },
        ],
      },
      { id: 'b', title: '乙', blocks: [{ kind: 'paragraph', text: 'r', pending: '' }] },
    ],
  })
}

const get = (path: string, etag?: string) =>
  publicBookResponse(book, new Request(`https://table.example${path}`, { headers: etag ? { 'If-None-Match': etag } : {} }), path)

describe('reading the handbook one convention at a time', () => {
  it('lists every entry without its content, with the outline and 待確認 notes in page order', async () => {
    expect(JSON.parse((await book.manifest()).json)).toEqual({ version: 0, entries: [], categories: [] })
    await book.save(amy, 'lebensohl', { convention: pendingConvention(), baseVersion: 0, bundledUpdated: '2026-10-21' })
    const manifest = JSON.parse((await book.manifest()).json)
    expect(manifest.version).toBe(1)
    const [entry] = manifest.entries
    expect(entry).not.toHaveProperty('convention')
    expect(entry).toMatchObject({ slug: 'lebensohl', version: 1, updatedBy: 'amy', bundledUpdated: '2026-10-21' })
    expect(entry.meta).not.toHaveProperty('sections')
    expect(entry.meta).toMatchObject({
      slug: 'lebensohl',
      nameZh: '雷本索',
      nameEn: 'Lebensohl',
      aliases: ['Lebensohl 2NT'],
      category: 'competitive',
      kind: 'convention',
      level: 'intermediate',
      prerequisites: ['notrump-responses'],
      tags: ['2NT'],
      summary: '敵方插叫後的 2NT 接力。',
      source: { title: 'Lebensohl' },
      updated: '2026-10-23',
    })
    expect(entry.meta.outline).toEqual([
      {
        id: 'a',
        title: '甲',
        children: [
          { id: 'a-1', title: '甲一' },
          { id: 'a-2', title: '甲二', children: [{ id: 'a-2-x', title: '甲二X' }] },
        ],
      },
      { id: 'b', title: '乙' },
    ])
    expect(entry.meta.pending).toEqual([
      { sectionId: 'a', index: 0, trail: ['甲'], text: 'a0' },
      { sectionId: 'a', index: 1, trail: ['甲'], text: 'a2' },
      { sectionId: 'a', index: 2, trail: ['甲'], text: 'a3' },
      { sectionId: 'a', index: 3, trail: ['甲'], text: 'a4' },
      { sectionId: 'a', index: 4, trail: ['甲'], text: 'a5' },
      { sectionId: 'a', index: 5, trail: ['甲'], text: 'a6' },
      { sectionId: 'a', index: 6, trail: ['甲'], text: 'a7' },
      { sectionId: 'a-1', index: 0, trail: ['甲', '甲一'], text: 'b0' },
      { sectionId: 'a-2-x', index: 0, trail: ['甲', '甲二', '甲二X'], text: 'c0' },
    ])
  })

  it('gives a hidden convention no meta, and refreshes the manifest after every change', async () => {
    const first = await book.manifest()
    await book.save(amy, 'lebensohl', { convention: convention(), baseVersion: 0 })
    const saved = await book.manifest()
    expect(saved.json).not.toBe(first.json)
    expect(JSON.parse(saved.json).entries[0].meta.summary).toBe('敵方插叫後的 2NT 接力。')
    await book.save(amy, 'lebensohl', { convention: convention('lebensohl', { summary: '新摘要' }), baseVersion: 1 })
    expect(JSON.parse((await book.manifest()).json).entries[0].meta.summary).toBe('新摘要')
    await book.hide(ben, 'lebensohl', { baseVersion: 2 })
    const hidden = JSON.parse((await book.manifest()).json)
    expect(hidden.version).toBe(3)
    expect(hidden.entries[0]).toMatchObject({ slug: 'lebensohl', version: 3, meta: null })
    await book.reset(amy, 'lebensohl', { baseVersion: 3 })
    expect(JSON.parse((await book.manifest()).json)).toEqual({ version: 4, entries: [], categories: [] })
  })

  it('answers the manifest and one convention with ETags, and 404 when there is no online entry', async () => {
    await book.save(amy, 'lebensohl', { convention: convention(), baseVersion: 0 })

    const manifest = (await get('/api/book/manifest'))!
    expect(manifest.status).toBe(200)
    expect(manifest.headers.get('ETag')).toBe('W/"book-manifest-1"')
    expect(manifest.headers.get('Content-Type')).toContain('application/json')
    expect((await manifest.json()).entries[0].slug).toBe('lebensohl')
    expect((await get('/api/book/manifest', 'W/"book-manifest-1"'))!.status).toBe(304)
    expect((await get('/api/book/manifest', 'W/"book-manifest-0"'))!.status).toBe(200)

    const one = (await get('/api/book/content/lebensohl'))!
    expect(one.status).toBe(200)
    expect(one.headers.get('ETag')).toBe('W/"book-lebensohl-1"')
    const { entry } = await one.json()
    expect(entry).toMatchObject({ slug: 'lebensohl', version: 1, convention: { summary: '敵方插叫後的 2NT 接力。' } })
    expect(entry.convention.sections[0].blocks).toHaveLength(5)
    expect((await get('/api/book/content/lebensohl', 'W/"book-lebensohl-1"'))!.status).toBe(304)

    await book.hide(ben, 'lebensohl', { baseVersion: 1 })
    expect((await get('/api/book/content/lebensohl', 'W/"book-lebensohl-1"'))!.status).toBe(200)
    expect((await (await get('/api/book/content/lebensohl'))!.json()).entry).toMatchObject({ version: 2, convention: null })
    expect((await get('/api/book/manifest', 'W/"book-manifest-1"'))!.status).toBe(200)

    await expect(get('/api/book/content/jacoby-2nt')).rejects.toThrow('找不到這個特約')
    await expect(get('/api/book/content/Bad_Slug')).rejects.toMatchObject({ status: 404 })

    // The whole-content route is unchanged
    const all = (await get('/api/book/content'))!
    expect(all.headers.get('ETag')).toBe('W/"book-2"')
    expect((await all.json()).entries[0].convention).toBeNull()
    expect((await get('/api/book/content', 'W/"book-2"'))!.status).toBe(304)
    expect(await get('/api/book/other')).toBeNull()
    const post = new Request('https://table.example/api/book/manifest', { method: 'POST' })
    expect(await publicBookResponse(book, post, '/api/book/manifest')).toBeNull()
  })
})

describe('categories edited online', () => {
  const bundled = [
    { id: 'notrump', label: '無王開叫後續', description: '1NT 之後' },
    { id: 'competitive', label: '競叫與防守', description: '' },
  ]

  it('starts empty, so the handbook keeps its own, and saves the whole list in order', async () => {
    expect(await book.categories()).toEqual({ version: 0, categories: [] })
    const first = await book.saveCategories(amy, { categories: bundled, baseVersion: 0 })
    expect(first).toMatchObject({ version: 1, updatedBy: 'amy', updatedAt: time })
    expect(first.categories).toEqual([
      { id: 'notrump', label: '無王開叫後續', description: '1NT 之後', order: 0 },
      { id: 'competitive', label: '競叫與防守', description: '', order: 1 },
    ])
    expect(store.data.get('book:category:notrump')).toMatchObject({ label: '無王開叫後續', order: 0 })

    // Rename, reorder and add in one save; the manifest carries the same list and a new version
    time += 1000
    const next = await book.saveCategories(ben, {
      baseVersion: 1,
      categories: [{ id: 'competitive', label: '競叫', description: ' 敵方插叫 ' }, bundled[0], { id: 'slam', label: '滿貫' }],
    })
    expect(next.categories.map((c) => [c.id, c.label, c.order])).toEqual([
      ['competitive', '競叫', 0],
      ['notrump', '無王開叫後續', 1],
      ['slam', '滿貫', 2],
    ])
    expect(next.categories[0].description).toBe('敵方插叫')
    const manifest = JSON.parse((await book.manifest()).json)
    expect(manifest).toMatchObject({ version: 2, categories: next.categories })

    // Loaded again from storage, in order
    const again = new BookService(store, () => time)
    expect(await again.categories()).toEqual(next)
  })

  it('refuses a save made from an old version and removing a category an online convention is in', async () => {
    await book.saveCategories(amy, { categories: bundled, baseVersion: 0 })
    await expect(book.saveCategories(ben, { categories: bundled, baseVersion: 0 })).rejects.toMatchObject({
      code: 'categoryConflict',
      status: 409,
      params: { name: 'amy' },
    })

    await book.save(amy, 'lebensohl', { convention: convention(), baseVersion: 0 })
    await expect(book.saveCategories(amy, { categories: [bundled[0]], baseVersion: 1 })).rejects.toMatchObject({
      code: 'categoryInUse',
      status: 409,
      params: { name: '競叫與防守', convention: '雷本索' },
    })
    expect((await book.categories()).categories).toHaveLength(2)

    // A hidden convention is in no category, so it does not keep one alive; removed keys go
    await book.hide(amy, 'lebensohl', { baseVersion: 1 })
    const saved = await book.saveCategories(amy, { categories: [bundled[0]], baseVersion: 1 })
    expect(saved.categories.map((c) => c.id)).toEqual(['notrump'])
    expect(store.data.has('book:category:competitive')).toBe(false)
  })

  it('checks the shape of the list', () => {
    const reason = (value: unknown) => {
      try {
        checkCategories(value)
        return ''
      } catch (error) {
        return (error as { params: { reason: string } }).params.reason
      }
    }
    expect(reason([])).toBe('至少要有一個分類')
    expect(reason('notrump')).toBe('至少要有一個分類')
    expect(reason([{ id: 'Bad Id', label: 'x' }])).toBe('分類代號只能用小寫英數與連字號')
    expect(reason([{ id: 'a', label: 'x' }, { id: 'a', label: 'y' }])).toBe('分類代號重複：a')
    expect(reason([{ id: 'a', label: '  ' }])).toMatch(/分類名稱/)
    expect(reason([{ id: 'a', label: 'x'.repeat(CATEGORY_LIMITS.labelMax + 1) }])).toMatch(/分類名稱/)
    expect(reason([{ id: 'a', label: 'x', description: 3 }])).toBe('分類說明要是文字')
    expect(reason(Array.from({ length: CATEGORY_LIMITS.max + 1 }, (_, i) => ({ id: `c${i}`, label: 'x' })))).toMatch(/最多/)
    expect(checkCategories([{ id: 'a', label: ' 甲 ', extra: true }])).toEqual([{ id: 'a', label: '甲', description: '', order: 0 }])
  })

  it('lets anyone read them, with an ETag', async () => {
    const empty = (await get('/api/book/categories'))!
    expect(empty.headers.get('ETag')).toBe('W/"book-categories-0"')
    expect(await empty.json()).toEqual({ version: 0, categories: [] })
    await book.saveCategories(amy, { categories: bundled, baseVersion: 0 })
    expect((await get('/api/book/categories', 'W/"book-categories-0"'))!.status).toBe(200)
    expect((await get('/api/book/categories', 'W/"book-categories-1"'))!.status).toBe(304)
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

describe('drafts and review (BridgeHall e8-t01, e8-t02, e8-t09)', () => {
  const rita: Me = { id: 'u3', username: 'rita', admin: false, permissions: ['bookEdit', 'bookReview'] }

  it('keeps a draft out of the handbook until a reviewer publishes it', async () => {
    const draft = await book.saveBookDraft(amy, 'lebensohl', { convention: convention(), baseVersion: 0, bundledUpdated: '2026-10-21', note: '新增' })
    expect(draft).toMatchObject({ slug: 'lebensohl', status: 'draft', baseVersion: 0, revision: 1, note: '新增', createdBy: 'amy', bundledUpdated: '2026-10-21' })
    expect(await entries()).toEqual([])
    expect(JSON.parse((await book.manifest()).json).entries).toEqual([])
    expect(await book.entry('lebensohl')).toBeUndefined()

    // Sent for review; a save from an older revision of the draft is refused
    time += 10
    const sent = await book.saveBookDraft(ben, 'lebensohl', { convention: convention(), draftRevision: 1, submit: true })
    expect(sent).toMatchObject({ status: 'in-review', revision: 2, reviewRequestedBy: 'ben', reviewRequestedAt: time, note: '新增', createdBy: 'amy', updatedBy: 'ben' })
    await expect(book.saveBookDraft(amy, 'lebensohl', { convention: convention(), draftRevision: 1 })).rejects.toMatchObject({ code: 'bookDraftConflict', status: 409 })
    expect(await book.bookDrafts()).toEqual([expect.objectContaining({ slug: 'lebensohl', nameZh: '雷本索', status: 'in-review' })])

    // Published from the draft: the draft is used up, and the request goes with the version
    time += 10
    await expect(book.save(rita, 'lebensohl', { convention: convention(), baseVersion: 0, draftRevision: 1 })).rejects.toMatchObject({ code: 'bookDraftConflict' })
    const entry = await book.save(rita, 'lebensohl', { convention: convention(), baseVersion: 0, draftRevision: 2 })
    expect(entry).toMatchObject({ version: 1, status: 'published', reviewRequestedBy: 'ben', reviewedBy: 'rita', reviewedAt: time, bundledUpdated: '2026-10-21' })
    expect(await book.draftOf('lebensohl')).toBeNull()
    expect((await book.revisions('lebensohl'))[0]).toMatchObject({ version: 1, by: 'rita', note: '新增' })
    expect(await entries()).toHaveLength(1)
  })

  it('sends a draft back with why, which stays until it goes for review again', async () => {
    await book.saveBookDraft(amy, 'lebensohl', { convention: convention(), baseVersion: 0 })
    await expect(book.reject(rita, 'lebensohl', { draftRevision: 1, note: '?' })).rejects.toMatchObject({ code: 'notInReview' })
    await book.saveBookDraft(amy, 'lebensohl', { convention: convention(), draftRevision: 1, submit: true })
    const back = await book.reject(rita, 'lebensohl', { draftRevision: 2, note: '  點力範圍與原文不符  ' })
    expect(back).toMatchObject({ status: 'draft', revision: 3, reviewedBy: 'rita', reviewNote: '點力範圍與原文不符' })
    expect(back.reviewRequestedBy).toBeUndefined()
    expect(await book.saveBookDraft(amy, 'lebensohl', { convention: convention(), draftRevision: 3 })).toMatchObject({ reviewNote: '點力範圍與原文不符' })
    const again = await book.saveBookDraft(amy, 'lebensohl', { convention: convention(), draftRevision: 4, submit: true })
    expect(again.reviewNote).toBeUndefined()
    expect(again.status).toBe('in-review')
    await expect(book.reject(rita, 'nothing', {})).rejects.toMatchObject({ code: 'bookDraftGone', status: 404 })
  })

  it('starts a draft from the published version, keeps it apart from it and throws it away', async () => {
    await book.save(rita, 'lebensohl', { convention: convention(), baseVersion: 0 })
    await expect(book.saveBookDraft(amy, 'lebensohl', { convention: convention(), baseVersion: 0 })).rejects.toMatchObject({ code: 'bookConflict' })
    await book.saveBookDraft(amy, 'lebensohl', { convention: convention('lebensohl', { summary: '改過' }), baseVersion: 1 })
    expect((await book.entry('lebensohl'))?.convention?.summary).toBe('敵方插叫後的 2NT 接力。')
    // Publishing without the draft leaves it for its editor
    await book.save(rita, 'lebensohl', { convention: convention(), baseVersion: 1 })
    expect(await book.draftOf('lebensohl')).toMatchObject({ baseVersion: 1, revision: 1 })
    await expect(book.discardDraft(amy, 'lebensohl', { draftRevision: 0 })).rejects.toMatchObject({ code: 'bookDraftConflict' })
    await book.discardDraft(amy, 'lebensohl', { draftRevision: 1 })
    expect(await book.draftOf('lebensohl')).toBeNull()
    expect(await store.list('book:wip:')).toEqual(new Map())
  })

  it('reads drafts back after a reload, large ones in parts', async () => {
    const long = [{ id: 'long', title: '長', blocks: [{ kind: 'paragraph', text: '字'.repeat(100_000) }] }]
    await book.saveBookDraft(amy, 'lebensohl', { convention: convention('lebensohl', { sections: long }), baseVersion: 0 })
    const again = new BookService(store, () => time)
    expect(JSON.stringify((await again.draftOf('lebensohl'))?.convention)).toContain('字'.repeat(1000))
  })

  it('treats entries saved before review existed as published', async () => {
    await store.put('book:entry:stayman', { slug: 'stayman', version: 3, createdAt: 1, updatedAt: 2, updatedBy: 'amy', parts: 1 })
    await store.put('bookpart:book:entry:stayman:0', JSON.stringify(convention('stayman')))
    const fresh = new BookService(store, () => time)
    expect(JSON.parse((await fresh.manifest()).json).entries).toEqual([expect.objectContaining({ slug: 'stayman', version: 3 })])
    expect(await fresh.entry('stayman')).toMatchObject({ version: 3, convention: expect.objectContaining({ slug: 'stayman' }) })
    await fresh.saveBookDraft(amy, 'stayman', { convention: convention('stayman'), baseVersion: 3 })
    expect(await fresh.entry('stayman')).toMatchObject({ version: 3 })
  })

  it('records who changed what, newest first, with the version it made', async () => {
    await book.saveBookDraft(amy, 'lebensohl', { convention: convention(), baseVersion: 0, note: '新增' })
    await book.saveBookDraft(amy, 'lebensohl', { convention: convention(), draftRevision: 1, submit: true })
    await book.save(rita, 'lebensohl', { convention: convention(), baseVersion: 0, draftRevision: 2 })
    await book.hide(rita, 'lebensohl', { baseVersion: 1 })
    await book.reset(rita, 'lebensohl', { baseVersion: 2 })
    await book.saveCategories(rita, { categories: [{ id: 'basic', label: '基本' }], baseVersion: 0 })
    const log = await book.auditLog()
    expect(log.map((e) => [e.by, e.action, e.target, e.version])).toEqual([
      ['rita', 'book:categories', 'categories', 1],
      ['rita', 'book:reset', 'lebensohl', 0],
      ['rita', 'book:hide', 'lebensohl', 2],
      ['rita', 'book:publish', 'lebensohl', 1],
      ['amy', 'book:submit', 'lebensohl', undefined],
      ['amy', 'book:draft', 'lebensohl', undefined],
    ])
    const published = log[3]
    expect(published.note).toBe('新增')
    expect((await book.revision('lebensohl', published.revisionId!)).version).toBe(1)
    expect([...(await store.list('audit:')).keys()].every((k) => /^audit:\d{14}-\w+$/.test(k))).toBe(true)
  })
})
