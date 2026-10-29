// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Me } from '../../shared/protocol.ts'
import { checkGlossary, GLOSSARY_LIMITS, GlossaryService, publicGlossaryResponse } from '../../worker/glossary.ts'
import { bookRouteNeed } from '../../worker/roles.ts'
import { ClubError } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'

const amy: Me = { id: 'u1', username: 'amy', admin: false, permissions: ['bookEdit'] }
const ben: Me = { id: 'u2', username: 'ben', admin: false, permissions: ['bookEdit'] }

let store: MemoryStore
let glossary: GlossaryService
let time: number

beforeEach(() => {
  store = new MemoryStore()
  time = 1_000_000
  glossary = new GlossaryService(store, () => time)
})

const reason = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as ClubError).params?.reason
  }
  return undefined
}

describe('the glossary', () => {
  it('starts empty, saves the whole list and reads it back', async () => {
    expect(await glossary.get()).toEqual({ version: 0, terms: [] })
    const saved = await glossary.save(amy, {
      baseVersion: 0,
      terms: [{ term: ' 測試詞 ', aliases: ['Alias', ' ', 'Alias'], definition: ' 說明 ', see: 'lebensohl' }],
    })
    expect(saved).toEqual({
      version: 1,
      updatedAt: time,
      updatedBy: 'amy',
      terms: [{ term: '測試詞', aliases: ['Alias'], definition: '說明', see: 'lebensohl' }],
    })
    expect(await new GlossaryService(store).get()).toEqual(saved)
    expect([...store.data.keys()].filter((k) => k.startsWith('audit:'))).toHaveLength(1)
  })

  it('refuses a save that started from an older version', async () => {
    await glossary.save(amy, { baseVersion: 0, terms: [] })
    await expect(glossary.save(ben, { baseVersion: 0, terms: [] })).rejects.toMatchObject({ code: 'glossaryConflict', status: 409 })
    expect((await glossary.save(ben, { baseVersion: 1, terms: [] })).version).toBe(2)
  })

  it('keeps a long list in parts', async () => {
    const terms = Array.from({ length: GLOSSARY_LIMITS.max }, (_, i) => ({ term: `詞${i}`, aliases: [], definition: '長'.repeat(900) }))
    const saved = await glossary.save(amy, { baseVersion: 0, terms })
    expect(saved.terms).toHaveLength(GLOSSARY_LIMITS.max)
    expect(store.data.get('book:glossary')).toMatchObject({ parts: expect.any(Number) })
    expect((store.data.get('book:glossary') as { parts: number }).parts).toBeGreaterThan(1)
  })

  it('checks the shape', () => {
    expect(reason(() => checkGlossary('x'))).toBe('名詞表格式不正確')
    expect(reason(() => checkGlossary([{ term: '', definition: 'x' }]))).toMatch(/名詞要有/)
    expect(reason(() => checkGlossary([{ term: 'a', definition: '' }]))).toMatch(/解釋要有/)
    expect(reason(() => checkGlossary([{ term: 'GF', definition: 'x' }, { term: 'b', aliases: ['gf'], definition: 'y' }]))).toBe('名詞重複：gf')
    expect(reason(() => checkGlossary([{ term: 'a', definition: 'x', see: 'Bad Slug' }]))).toMatch(/特約代號/)
    expect(checkGlossary([{ term: 'a', definition: 'x', see: '' }])).toEqual([{ term: 'a', aliases: [], definition: 'x' }])
  })

  it('is read without signing in and saved by editors', async () => {
    const res = await publicGlossaryResponse(glossary, new Request('https://t/api/book/glossary'), '/api/book/glossary')
    expect(res?.headers.get('ETag')).toBe('W/"book-glossary-0"')
    expect(await res?.json()).toEqual({ version: 0, terms: [] })
    const again = await publicGlossaryResponse(
      glossary,
      new Request('https://t/api/book/glossary', { headers: { 'If-None-Match': 'W/"book-glossary-0"' } }),
      '/api/book/glossary',
    )
    expect(again?.status).toBe(304)
    expect(await publicGlossaryResponse(glossary, new Request('https://t/api/book/glossary', { method: 'PUT' }), '/api/book/glossary')).toBeNull()
    expect(bookRouteNeed('PUT', '/glossary')).toBe('bookEdit')
    expect(bookRouteNeed('POST', '/glossary')).toBeNull()
  })
})
