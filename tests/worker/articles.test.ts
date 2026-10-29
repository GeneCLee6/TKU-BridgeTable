// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Me } from '../../shared/protocol.ts'
import { ArticleService, checkArticle, pictureKeys, searchText } from '../../worker/articles.ts'
import { AuditLog } from '../../worker/audit.ts'
import { BACKUP_PREFIXES } from '../../worker/backup.ts'
import { ClubError } from '../../worker/errors.ts'
import { articleReadRoute, bookRouteNeed } from '../../worker/roles.ts'
import { MemoryStore } from '../../worker/store.ts'

const rita: Me = { id: 'u1', username: 'rita', admin: false, permissions: ['bookEdit', 'bookReview'] }
const PICTURE = 'article/0123456789abcdef01234567.webp'
const COVER = 'article/fedcba9876543210fedcba98.jpg'

/** Test data only: the shape of an article, not real library content */
function article(slug = 'test-article', extra: Record<string, unknown> = {}) {
  return {
    slug,
    title: '測試文章',
    authors: ['測試作者'],
    series: 'test-series',
    level: 'basic',
    summary: '測試摘要',
    cover: COVER,
    published: '2026-10-28',
    updated: '2026-10-28',
    license: 'own',
    blocks: [
      { kind: 'heading', level: 2, text: '測試小標題' },
      { kind: 'paragraph', text: '測試段落' },
      { kind: 'quote', text: '測試引文', cite: '測試出處' },
      { kind: 'image', src: PICTURE, alt: '測試圖片', caption: '測試圖說' },
      { kind: 'hand', hand: { spades: 'AK2', hearts: 'QJ3', diamonds: 'T98', clubs: '7654' } },
    ],
    ...extra,
  }
}

let store: MemoryStore
let signed: string[][]
let filesOn: boolean
let articles: ArticleService
let time: number

beforeEach(() => {
  store = new MemoryStore()
  signed = []
  filesOn = true
  time = 1_000
  const now = () => time++
  articles = new ArticleService(
    store,
    async (keys) => {
      if (!filesOn) throw new ClubError('filesOff', {}, 503)
      signed.push(keys)
      return { urls: Object.fromEntries(keys.map((k) => [k, { url: `/api/files/${k}?e=1&s=x` }])) }
    },
    now,
    new AuditLog(store, now),
  )
})

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return (error as ClubError).code
  }
  return 'ok'
}

describe('checkArticle', () => {
  it('takes an article with every block kind', () => {
    expect(() => checkArticle(article(), 'test-article')).not.toThrow()
  })

  it.each([
    ['a slug that does not match', article('other')],
    ['an empty title', article('test-article', { title: ' ' })],
    ['authors that are not a list', article('test-article', { authors: '測試作者' })],
    ['an unknown license', article('test-article', { license: 'public' })],
    ['an unknown level', article('test-article', { level: 'expert' })],
    ['a cover that is an address', article('test-article', { cover: 'https://example.com/a.jpg' })],
    ['a thumbnail as the cover', article('test-article', { cover: 'article/0123456789abcdef01234567-thumb.webp' })],
    ['a heading of level 1', article('test-article', { blocks: [{ kind: 'heading', level: 1, text: 'x' }] })],
    ['a quote without text', article('test-article', { blocks: [{ kind: 'quote' }] })],
    ['a picture without a description', article('test-article', { blocks: [{ kind: 'image', src: PICTURE }] })],
    ['a picture from elsewhere', article('test-article', { blocks: [{ kind: 'image', src: 'https://example.com/a.jpg', alt: 'x' }] })],
    ['a block the handbook does not know', article('test-article', { blocks: [{ kind: 'video' }] })],
    ['a broken handbook block', article('test-article', { blocks: [{ kind: 'paragraph' }] })],
  ])('refuses %s', (_, value) => {
    expect(() => checkArticle(value, 'test-article')).toThrow(ClubError)
  })

  it('finds the pictures an article names', () => {
    expect(pictureKeys(article())).toEqual([COVER, PICTURE])
    expect(pictureKeys(null)).toEqual([])
  })
})

describe('ArticleService', () => {
  it('publishes, keeps versions and refuses a stale base version', async () => {
    const first = await articles.save(rita, 'test-article', { article: article(), baseVersion: 0, note: '新增' })
    expect(first).toMatchObject({ version: 1, status: 'published', reviewedBy: 'rita', updatedBy: 'rita' })
    expect(await codeOf(articles.save(rita, 'test-article', { article: article(), baseVersion: 0 }))).toBe('articleConflict')
    await articles.save(rita, 'test-article', { article: article('test-article', { title: '改過' }), baseVersion: 1 })

    const revisions = await articles.revisions('test-article')
    expect(revisions.map((r) => [r.version, r.action])).toEqual([
      [2, 'save'],
      [1, 'save'],
    ])
    expect(revisions[1].note).toBe('新增')
    expect(revisions[0]).not.toHaveProperty('article')
    expect((await articles.revision('test-article', revisions[1].id)).article).toMatchObject({ title: '測試文章' })
  })

  it('stores under article: and bookpart:, which the daily backup covers', async () => {
    await articles.save(rita, 'test-article', { article: article(), baseVersion: 0 })
    const keys = [...(await store.list('')).keys()].filter((k) => !k.startsWith('audit:'))
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) expect(BACKUP_PREFIXES.some((p) => key.startsWith(p))).toBe(true)
    expect(keys).toContain('article:entry:test-article')
    expect(keys).toContain('article:version')
  })

  it('reads back after a restart', async () => {
    await articles.save(rita, 'test-article', { article: article(), baseVersion: 0 })
    const again = new ArticleService(store, async () => ({ urls: {} }))
    expect((await again.get('anyone', 'test-article')).entry.article).toMatchObject({ title: '測試文章' })
    expect((await again.list('anyone')).version).toBe(1)
  })

  it('lists without blocks and signs the covers and pictures', async () => {
    await articles.save(rita, 'test-article', { article: article(), baseVersion: 0 })
    const list = await articles.list('anyone')
    expect(list.entries).toHaveLength(1)
    expect(list.entries[0].meta).toMatchObject({ title: '測試文章', cover: COVER })
    expect(list.entries[0].meta).not.toHaveProperty('blocks')
    expect(Object.keys(list.files)).toEqual([COVER])
    const one = await articles.get('anyone', 'test-article')
    expect(Object.keys(one.files)).toEqual([COVER, PICTURE])
  })

  it('still reads without the R2 bucket, with no addresses', async () => {
    filesOn = false
    await articles.save(rita, 'test-article', { article: article(), baseVersion: 0 })
    expect((await articles.list('anyone')).files).toEqual({})
    expect((await articles.get('anyone', 'test-article')).files).toEqual({})
  })

  it('keeps members-only articles from readers who are not signed in', async () => {
    await articles.save(rita, 'club-only', { article: article('club-only', { license: 'members-only' }), baseVersion: 0 })
    expect((await articles.list('anyone')).entries).toEqual([])
    expect(await codeOf(articles.get('anyone', 'club-only'))).toBe('articleGone')
    expect((await articles.list('member')).entries).toHaveLength(1)
    expect((await articles.get('member', 'club-only')).entry.slug).toBe('club-only')
  })

  it('hides an article from everyone but the editors', async () => {
    await articles.save(rita, 'test-article', { article: article(), baseVersion: 0 })
    const hidden = await articles.hide(rita, 'test-article', { baseVersion: 1 })
    expect(hidden).toMatchObject({ version: 2, article: null })
    expect((await articles.list('member')).entries).toEqual([])
    expect(await codeOf(articles.get('member', 'test-article'))).toBe('articleGone')
    expect((await articles.list('editor')).entries[0].meta).toBeNull()
    expect((await articles.revisions('test-article'))[0].action).toBe('hide')
    expect(await codeOf(articles.hide(rita, 'missing', { baseVersion: 0 }))).toBe('articleGone')
  })

  it('records publishing and hiding in the audit log', async () => {
    const audit = new AuditLog(store)
    await articles.save(rita, 'test-article', { article: article(), baseVersion: 0 })
    await articles.hide(rita, 'test-article', { baseVersion: 1 })
    expect((await audit.list()).map((e) => [e.action, e.target])).toEqual([
      ['article:hide', 'test-article'],
      ['article:publish', 'test-article'],
    ])
  })

  it('refuses a bad slug and a broken article', async () => {
    expect(await codeOf(articles.save(rita, 'Bad Slug', { article: article(), baseVersion: 0 }))).toBe('badContent')
    expect(await codeOf(articles.save(rita, 'test-article', { article: { slug: 'test-article' }, baseVersion: 0 }))).toBe('badContent')
  })
})

describe('article routes', () => {
  it('lets anyone read the list and one article', () => {
    expect(articleReadRoute('GET', '/api/book/articles')).toEqual({})
    expect(articleReadRoute('GET', '/api/book/articles/test-article')).toEqual({ slug: 'test-article' })
    expect(articleReadRoute('PUT', '/api/book/articles/test-article')).toBeNull()
    expect(articleReadRoute('GET', '/api/book/articles/test-article/revisions')).toBeNull()
  })

  it('leaves publishing and hiding to reviewers and the versions to editors', () => {
    expect(bookRouteNeed('PUT', '/articles/test-article')).toBe('bookReview')
    expect(bookRouteNeed('POST', '/articles/test-article/hide')).toBe('bookReview')
    expect(bookRouteNeed('GET', '/articles/test-article/revisions')).toBe('bookEdit')
    expect(bookRouteNeed('GET', '/articles/test-article/revisions/abc')).toBe('bookEdit')
    expect(bookRouteNeed('POST', '/articles/test-article/hide/abc')).toBeNull()
    expect(bookRouteNeed('DELETE', '/articles/test-article')).toBeNull()
  })
})

describe('series (BridgeHall e5-t06)', () => {
  const shelf = (id: string, label = id) => ({ id, label, description: '' })

  it('starts empty, so the handbook shows its built-in series, and comes with the list', async () => {
    expect(await articles.series()).toEqual({ version: 0, series: [] })
    expect((await articles.list('anyone')).series).toEqual({ version: 0, series: [] })
  })

  it('saves the whole list in order, keeps it after a restart and logs it', async () => {
    const saved = await articles.saveSeries(rita, { series: [shelf('test-a', ' 測試甲 '), shelf('test-b')], baseVersion: 0 })
    expect(saved).toMatchObject({ version: 1, updatedBy: 'rita' })
    expect(saved.series).toEqual([
      { id: 'test-a', label: '測試甲', description: '', order: 0 },
      { id: 'test-b', label: 'test-b', description: '', order: 1 },
    ])
    expect(await codeOf(articles.saveSeries(rita, { series: [shelf('test-a')], baseVersion: 0 }))).toBe('seriesConflict')
    const again = new ArticleService(store, async () => ({ urls: {} }))
    expect((await again.series()).series.map((s) => s.id)).toEqual(['test-a', 'test-b'])
    expect((await new AuditLog(store).list())[0]).toMatchObject({ action: 'article:series', target: 'series', version: 1 })
    expect(BACKUP_PREFIXES.some((p) => 'article:series'.startsWith(p))).toBe(true)
  })

  it('refuses bad lists', async () => {
    for (const series of [[], [shelf('Bad Id')], [shelf('test-a'), shelf('test-a')], [shelf('test-a', ' ')]])
      expect(await codeOf(articles.saveSeries(rita, { series, baseVersion: 0 }))).toBe('badContent')
  })

  it('will not remove a series an article is in', async () => {
    await articles.saveSeries(rita, { series: [shelf('test-series'), shelf('test-b')], baseVersion: 0 })
    await articles.save(rita, 'test-article', { article: article(), baseVersion: 0 })
    expect(await codeOf(articles.saveSeries(rita, { series: [shelf('test-b')], baseVersion: 1 }))).toBe('seriesInUse')
    expect((await articles.saveSeries(rita, { series: [shelf('test-series')], baseVersion: 1 })).version).toBe(2)
  })

  it('is the editors’ to change', () => {
    expect(bookRouteNeed('PUT', '/series')).toBe('bookEdit')
    expect(bookRouteNeed('GET', '/series')).toBeNull()
  })
})

describe('search text (BridgeHall e5-t13)', () => {
  it('sends every article’s words only when asked', async () => {
    await articles.save(rita, 'test-article', { article: article(), baseVersion: 0 })
    expect(await articles.list('anyone')).not.toHaveProperty('text')
    const { text } = await articles.list('anyone', true)
    expect(Object.keys(text!)).toEqual(['test-article'])
    expect(text!['test-article']).toContain('測試摘要')
    expect(text!['test-article']).toContain('測試段落')
    expect(text!['test-article']).toContain('測試出處')
    expect(text!['test-article']).toContain('測試圖說')
    expect(text!['test-article']).not.toContain(PICTURE)
    expect(text!['test-article']).not.toContain('heading')
  })

  it('leaves out what the reader may not see and cuts long articles', async () => {
    await articles.save(rita, 'club-only', { article: article('club-only', { license: 'members-only' }), baseVersion: 0 })
    expect((await articles.list('anyone', true)).text).toEqual({})
    const long = article('test-article', { blocks: [{ kind: 'paragraph', text: '測'.repeat(30_000) }] })
    expect(searchText(long).length).toBe(20_000)
  })
})
