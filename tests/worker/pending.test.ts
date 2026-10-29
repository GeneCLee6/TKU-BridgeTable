// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import { AuditLog } from '../../worker/audit.ts'
import { PendingService } from '../../worker/pending.ts'
import { bookRouteNeed } from '../../worker/roles.ts'
import type { ClubError } from '../../worker/service.ts'
import { MemoryStore } from '../../worker/store.ts'

const amy = { username: 'amy' }
const ben = { username: 'ben' }

let store: MemoryStore
let audit: AuditLog
let pending: PendingService
let time: number

beforeEach(() => {
  store = new MemoryStore()
  time = 1_000_000
  audit = new AuditLog(store, () => time)
  pending = new PendingService(store, audit, () => time)
})

/** A convention whose section `a` has the given notes on its paragraphs, and section `b` one more */
const convention = (aNotes: string[], bNote?: string) => ({
  slug: 'demo',
  sections: [
    { id: 'a', title: 'A', blocks: aNotes.map((n) => ({ kind: 'paragraph', text: 'x', pending: n })) },
    { id: 'b', title: 'B', ...(bNote && { pending: bNote }), blocks: [] },
  ],
})

const failure = async (work: Promise<unknown>) => {
  try {
    await work
  } catch (e) {
    return (e as ClubError).code
  }
  return undefined
}

describe('the 待確認 panel', () => {
  it('saves a note’s status, assignee, remark and grounds, and lists it', async () => {
    const meta = await pending.save(amy, 'demo', 'a', 1, {
      text: ' 問題二 ',
      status: 'working',
      assignee: 'ben',
      note: ' 問過社長 ',
      resolution: '',
    })
    expect(meta).toEqual({
      slug: 'demo',
      sectionId: 'a',
      index: 1,
      text: '問題二',
      status: 'working',
      assignee: 'ben',
      note: '問過社長',
      updatedAt: time,
      updatedBy: 'amy',
    })
    expect(await pending.list()).toEqual({ open: [meta], closed: [] })
    expect(store.data.has('pendingmeta:demo/a/1')).toBe(true)
    const [entry] = await audit.list()
    expect(entry).toMatchObject({ by: 'amy', action: 'book:pending', target: 'demo/a/1', note: 'working → ben' })
  })

  it('does not close a note by hand, and checks the place and text', async () => {
    expect(await failure(pending.save(amy, 'demo', 'a', 0, { text: 'q', status: 'confirmed' }))).toBe('badContent')
    expect(await failure(pending.save(amy, 'demo', 'a', 0, { text: 'q', status: 'done' }))).toBe('badContent')
    expect(await failure(pending.save(amy, 'Demo!', 'a', 0, { text: 'q', status: 'open' }))).toBe('badContent')
    expect(await failure(pending.save(amy, 'demo', 'a', -1, { text: 'q', status: 'open' }))).toBe('badContent')
    expect(await failure(pending.save(amy, 'demo', 'a', 0, { text: ' ', status: 'open' }))).toBe('badContent')
  })

  it('closes the notes a published version no longer has and moves the others along', async () => {
    await pending.save(amy, 'demo', 'a', 0, { text: '問題一', status: 'working', resolution: '社長 10/28 確認' })
    await pending.save(amy, 'demo', 'a', 1, { text: '問題二', status: 'parked', note: '等比賽後' })
    await pending.save(amy, 'demo', 'b', 0, { text: '問題三', status: 'open', assignee: 'amy' })
    time += 1000
    // 問題一 is gone, so 問題二 is now the first note of A; 問題三 was reworded
    await pending.published(ben, 'demo', convention(['問題二'], '問題三（改寫）'), 4, '依社長確認修改')

    const { open, closed } = await pending.list()
    expect(open).toEqual([expect.objectContaining({ sectionId: 'a', index: 0, text: '問題二', status: 'parked', note: '等比賽後' })])
    expect(closed).toEqual([
      expect.objectContaining({ text: '問題三', status: 'confirmed', closedBy: 'ben', closedVersion: 4, resolution: '依社長確認修改' }),
      expect.objectContaining({ text: '問題一', status: 'confirmed', closedAt: time, closedBy: 'ben', closedVersion: 4, resolution: '社長 10/28 確認' }),
    ])
    expect(store.data.has('pendingmeta:demo/a/1')).toBe(false)
  })

  it('keeps each of two notes with the same text with its own record', async () => {
    await pending.save(amy, 'demo', 'a', 0, { text: '同', status: 'working' })
    await pending.save(amy, 'demo', 'a', 1, { text: '同', status: 'parked' })
    await pending.published(ben, 'demo', convention(['同', '同']), 2, '')
    const { open, closed } = await pending.list()
    expect(open.map((m) => [m.index, m.status])).toEqual([
      [0, 'working'],
      [1, 'parked'],
    ])
    expect(closed).toEqual([])
  })

  it('leaves the records alone when the convention is hidden, or has none', async () => {
    await pending.save(amy, 'demo', 'a', 0, { text: '問題一', status: 'open' })
    await pending.published(ben, 'demo', null, 2, '')
    await pending.published(ben, 'other', convention([]), 1, '')
    expect((await pending.list()).open).toHaveLength(1)
  })

  it('is read by every member and changed by editors', () => {
    expect(bookRouteNeed('GET', '/pending')).toBe('member')
    expect(bookRouteNeed('PUT', '/pending')).toBeNull()
    expect(bookRouteNeed('PUT', '/pending/demo/a/0')).toBe('bookEdit')
    expect(bookRouteNeed('GET', '/pending/demo/a/0')).toBeNull()
    expect(bookRouteNeed('PUT', '/pending/demo/a/x')).toBeNull()
  })
})
