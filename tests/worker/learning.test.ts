// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Me } from '../../shared/protocol.ts'
import { LEARNING_LIMITS, type LearningPath } from '../../shared/learning.ts'
import { checkLearningPath, forgetPathProgress, LearningStore } from '../../worker/learning.ts'
import { bookRouteNeed } from '../../worker/roles.ts'
import { MemoryStore } from '../../worker/store.ts'

/** 淡江橋館's learning paths (e4-t08, e4-t12) and members' progress (e4-t11) */

const editor = { id: 'ed1', username: 'ed' } as Me
const path: LearningPath = {
  id: 'from-zero',
  name: '從零開始',
  lessons: [
    { id: 'lesson-1', title: '第一課', goal: '', readings: [{ slug: 'system-overview' }], checklist: [] },
    {
      id: 'lesson-2',
      title: '第二課',
      goal: '目標',
      readings: [{ slug: 'system-one-club', sectionId: 'responses' }],
      quizIds: ['system-one-club/responses/0/1'],
      checklist: ['會了'],
    },
  ],
}

describe('LearningStore', () => {
  let store: MemoryStore
  let time: number
  let learning: LearningStore

  beforeEach(() => {
    store = new MemoryStore()
    time = 1000
    learning = new LearningStore(store, () => time)
  })

  it('saves an editor’s path, and removes it to go back to the bundled one', async () => {
    const saved = await learning.savePath(editor, { path: { ...path, extra: 1 } })
    expect(saved).toEqual({ ...path, by: 'ed', at: 1000 })
    expect(await learning.paths()).toEqual([saved])
    expect(store.data.has('book:path:from-zero')).toBe(true)
    expect(await learning.removePath({ id: 'from-zero' })).toBe('from-zero')
    expect(await learning.paths()).toEqual([])
  })

  it('keeps at most LEARNING_LIMITS.pathsMax paths', async () => {
    for (let i = 0; i < LEARNING_LIMITS.pathsMax; i++) await learning.savePath(editor, { path: { ...path, id: `p${i}` } })
    await expect(learning.savePath(editor, { path: { ...path, id: 'one-more' } })).rejects.toThrow()
    // Saving one that is there is still fine
    await learning.savePath(editor, { path: { ...path, id: 'p0', name: '改名' } })
  })

  it('keeps a member’s progress, only their own, and forgets it with the account', async () => {
    await learning.markLesson('u1', { progress: { pathId: 'from-zero', lessonId: 'lesson-1', done: true } })
    time = 2000
    const p = await learning.markLesson('u1', { progress: { pathId: 'from-zero', lessonId: 'lesson-2', done: true } })
    expect(p).toEqual({ pathId: 'from-zero', done: ['lesson-1', 'lesson-2'], at: 2000 })
    // Marking it again does not count it twice
    await learning.markLesson('u1', { progress: { pathId: 'from-zero', lessonId: 'lesson-2', done: true } })
    await learning.markLesson('u2', { progress: { pathId: 'from-zero', lessonId: 'lesson-2', done: true } })
    expect((await learning.progress('u1'))[0].done).toEqual(['lesson-1', 'lesson-2'])
    const undone = await learning.markLesson('u1', { progress: { pathId: 'from-zero', lessonId: 'lesson-1', done: false } })
    expect(undone.done).toEqual(['lesson-2'])
    await learning.markLesson('u1', { progress: { pathId: 'from-zero', lessonId: 'lesson-2', done: false } })
    // Nothing done: nothing kept
    expect(await learning.progress('u1')).toEqual([])
    await forgetPathProgress(store, 'u2')
    expect(store.data.size).toBe(0)
  })

  it('refuses progress that is not', async () => {
    for (const progress of [undefined, { pathId: 'from-zero', lessonId: 'lesson-1' }, { pathId: 'Bad Id', lessonId: 'l', done: true }])
      await expect(learning.markLesson('u1', { progress })).rejects.toThrow()
  })
})

describe('checkLearningPath', () => {
  it('keeps only the known fields', () => {
    expect(checkLearningPath({ ...path, by: 'x', lessons: path.lessons.map((l) => ({ ...l, x: 1 })) })).toEqual(path)
  })

  it('refuses a path that is not one', () => {
    const lesson = path.lessons[0]
    const bad = [
      undefined,
      { ...path, id: 'edit' },
      { ...path, id: 'Has Space' },
      { ...path, name: ' ' },
      { ...path, lessons: [] },
      { ...path, lessons: [lesson, lesson] },
      { ...path, lessons: [{ ...lesson, title: '' }] },
      { ...path, lessons: [{ ...lesson, goal: undefined }] },
      { ...path, lessons: [{ ...lesson, readings: [{ slug: '../x' }] }] },
      { ...path, lessons: [{ ...lesson, readings: [{ slug: 'a', sectionId: 3 }] }] },
      { ...path, lessons: [{ ...lesson, checklist: [''] }] },
      { ...path, lessons: [{ ...lesson, quizIds: ['nope'] }] },
      { ...path, lessons: Array.from({ length: LEARNING_LIMITS.lessonsMax + 1 }, (_, i) => ({ ...lesson, id: `l${i}` })) },
    ]
    for (const value of bad) expect(() => checkLearningPath(value)).toThrow()
  })
})

describe('routes', () => {
  it('lets members keep their own progress and editors edit the paths', () => {
    for (const method of ['GET', 'PUT']) expect(bookRouteNeed(method, '/paths/progress')).toBe('member')
    for (const method of ['PUT', 'DELETE']) expect(bookRouteNeed(method, '/paths')).toBe('bookEdit')
    expect(bookRouteNeed('DELETE', '/paths/progress')).toBeNull()
    // Reading the paths needs no sign-in (club.ts, before bookApi)
    expect(bookRouteNeed('GET', '/paths')).toBeNull()
  })
})
