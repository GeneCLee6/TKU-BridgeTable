// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { READING_LIMITS } from '../../shared/reading.ts'
import { checkReading, forgetReading, ReadingStore } from '../../worker/reading.ts'
import { bookRouteNeed } from '../../worker/roles.ts'
import { MemoryStore } from '../../worker/store.ts'

/** 閱讀進度 (BridgeHall e5-t14, AC-5.8) */

const article = { kind: 'article', id: 'leads-intro', title: '首攻入門', place: 3, of: 12 }
const book = { kind: 'ebook', id: '0123456789ab', title: '橋牌基礎', place: 40, of: 210 }

describe('ReadingStore', () => {
  let store: MemoryStore
  let time: number
  let reading: ReadingStore

  beforeEach(() => {
    store = new MemoryStore()
    time = 1000
    reading = new ReadingStore(store, () => time)
  })

  it('keeps each member’s places newest first, one per article or book', async () => {
    await reading.mark('u1', { reading: article })
    time = 2000
    await reading.mark('u1', { reading: book })
    time = 3000
    const moved = await reading.mark('u1', { reading: { ...article, place: 7, extra: 1 } })
    expect(moved).toEqual({ ...article, place: 7, at: 3000 })
    expect((await reading.places('u1')).map((p) => [p.id, p.place])).toEqual([
      ['leads-intro', 7],
      ['0123456789ab', 40],
    ])
    expect(await reading.places('u2')).toEqual([])
  })

  it('keeps only the newest few', async () => {
    for (let i = 0; i < READING_LIMITS.kept + 5; i++) await reading.mark('u1', { reading: { ...article, id: `a-${i}` } })
    const places = await reading.places('u1')
    expect(places).toHaveLength(READING_LIMITS.kept)
    expect(places[0].id).toBe(`a-${READING_LIMITS.kept + 4}`)
  })

  it('takes one off the list, and forgets them all with the account', async () => {
    await reading.mark('u1', { reading: article })
    await reading.mark('u1', { reading: book })
    await reading.forget('u1', { kind: 'article', id: 'leads-intro' })
    expect((await reading.places('u1')).map((p) => p.id)).toEqual(['0123456789ab'])
    await reading.forget('u1', { kind: 'ebook', id: '0123456789ab' })
    expect(await reading.places('u1')).toEqual([])
    await reading.mark('u1', { reading: book })
    await forgetReading(store, 'u1')
    expect(await reading.places('u1')).toEqual([])
    await expect(reading.forget('u1', { kind: 'video', id: 'x' })).rejects.toThrow()
  })

  it('refuses places that are not', () => {
    for (const bad of [
      undefined,
      { ...article, kind: 'video' },
      { ...article, id: 'no spaces' },
      { ...article, title: ' ' },
      { ...article, place: 12 },
      { ...article, place: -1 },
      { ...article, of: 0 },
      { ...book, place: 0 },
      { ...book, place: 211 },
      { ...book, place: 1.5 },
    ])
      expect(() => checkReading(bad)).toThrow()
    expect(checkReading({ ...book, place: 210 }).place).toBe(210)
    expect(checkReading({ ...article, place: 0, title: ' 首攻 ' }).title).toBe('首攻')
  })

  it('lets only members keep their own', () => {
    for (const method of ['GET', 'PUT', 'DELETE']) expect(bookRouteNeed(method, '/reading')).toBe('member')
    expect(bookRouteNeed('POST', '/reading')).toBeNull()
  })
})
