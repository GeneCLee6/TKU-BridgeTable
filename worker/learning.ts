import type { Me } from '../shared/protocol.ts'
import {
  LEARNING_LIMITS,
  type LearningPath,
  type Lesson,
  type LessonReading,
  type PathProgress,
  type SavedLearningPath,
} from '../shared/learning.ts'
import { isObject, isSectionId, isSlug, isString } from './book.ts'
import { ClubError } from './errors.ts'
import { isQuizId } from './quiz.ts'
import type { Store } from './store.ts'

/**
 * 淡江橋館's learning paths (BridgeHall e4-t08, e4-t11, e4-t12):
 *
 * - **Paths**: an editor's version of a path at `book:path:<id>` (so in the daily backup with the
 *   rest of the book). Anyone reads them (the path pages need no sign-in); editors save them, and
 *   remove one to go back to the handbook's bundled path. Only the shape is checked: what a lesson
 *   says is the club's (CLAUDE.md rule 1 in the handbook).
 * - **Progress**: the lessons a member marked done, at `pathprogress:<userId>:<pathId>`. Only the
 *   member reads or changes their own; deleted with the account; not in the daily backup.
 */

const PATH_PREFIX = 'book:path:'
const progressPrefix = (userId: string) => `pathprogress:${userId}:`

/** Lower-case words joined by hyphens, like a slug */
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** `edit` is the path editor's address (/learn/:pathId/edit) */
export const isPathId = (value: unknown): value is string =>
  isString(value) && value.length <= LEARNING_LIMITS.idMax && ID.test(value) && value !== 'edit'

const bad = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

const isText = (value: unknown, max: number): value is string => isString(value) && value.length <= max
const isFilled = (value: unknown, max: number): value is string => isText(value, max) && value.trim() !== ''

function checkReadings(value: unknown): LessonReading[] {
  if (!Array.isArray(value) || value.length > LEARNING_LIMITS.readingsMax) return bad(`每課最多讀 ${LEARNING_LIMITS.readingsMax} 處`)
  return value.map((r) => {
    if (!isObject(r) || !isSlug(r.slug) || (r.sectionId !== undefined && !isSectionId(r.sectionId))) return bad('閱讀的特約或段落格式不正確')
    return r.sectionId === undefined ? { slug: r.slug } : { slug: r.slug, sectionId: r.sectionId }
  })
}

function checkLesson(value: unknown): Lesson {
  if (!isObject(value)) return bad('課次格式不正確')
  if (!isPathId(value.id)) bad('課次 id 格式不正確')
  if (!isFilled(value.title, LEARNING_LIMITS.titleMax)) bad(`課次標題不能空白，最多 ${LEARNING_LIMITS.titleMax} 字`)
  if (!isText(value.goal, LEARNING_LIMITS.textMax)) bad(`目標最多 ${LEARNING_LIMITS.textMax} 字`)
  const checklist = value.checklist
  if (!Array.isArray(checklist) || checklist.length > LEARNING_LIMITS.checklistMax || !checklist.every((c) => isFilled(c, LEARNING_LIMITS.textMax)))
    bad(`檢核清單最多 ${LEARNING_LIMITS.checklistMax} 項、每項不能空白`)
  const lesson: Lesson = {
    id: value.id as string,
    title: value.title as string,
    goal: value.goal as string,
    readings: checkReadings(value.readings),
    checklist: checklist as string[],
  }
  if (value.quizIds !== undefined) {
    const ids = value.quizIds
    if (!Array.isArray(ids) || ids.length > LEARNING_LIMITS.quizzesMax || !ids.every(isQuizId)) bad('題目 id 格式不正確')
    lesson.quizIds = ids as string[]
  }
  return lesson
}

/** Checks a path's shape; returns it with only the known fields */
export function checkLearningPath(value: unknown): LearningPath {
  if (!isObject(value)) return bad('缺少學習路徑')
  if (!isPathId(value.id)) bad('路徑 id 格式不正確')
  if (!isFilled(value.name, LEARNING_LIMITS.nameMax)) bad(`路徑名稱不能空白，最多 ${LEARNING_LIMITS.nameMax} 字`)
  const lessons = value.lessons
  if (!Array.isArray(lessons) || !lessons.length || lessons.length > LEARNING_LIMITS.lessonsMax)
    return bad(`一條路徑要有 1–${LEARNING_LIMITS.lessonsMax} 課`)
  const checked = lessons.map(checkLesson)
  if (new Set(checked.map((l) => l.id)).size !== checked.length) bad('課次 id 不能重複')
  return { id: value.id as string, name: value.name as string, lessons: checked }
}

export class LearningStore {
  private readonly store: Store
  private readonly now: () => number

  constructor(store: Store, now: () => number) {
    this.store = store
    this.now = now
  }

  // ── Paths (e4-t08, e4-t12) ────────────────────────────────────────────────────────────────

  async paths(): Promise<SavedLearningPath[]> {
    return [...(await this.store.list<SavedLearningPath>(PATH_PREFIX)).values()]
  }

  async savePath(actor: Me, body: unknown): Promise<SavedLearningPath> {
    const input = checkLearningPath(isObject(body) ? body.path : undefined)
    const key = PATH_PREFIX + input.id
    if (!(await this.store.get(key)) && (await this.store.list(PATH_PREFIX)).size >= LEARNING_LIMITS.pathsMax)
      bad(`學習路徑最多 ${LEARNING_LIMITS.pathsMax} 條`)
    const path: SavedLearningPath = { ...input, by: actor.username, at: this.now() }
    await this.store.put(key, path)
    return path
  }

  /** Removes the saved path: the handbook goes back to its bundled one, if it has one */
  async removePath(body: unknown): Promise<string> {
    const id = isObject(body) ? body.id : undefined
    if (!isPathId(id)) return bad('路徑 id 格式不正確')
    await this.store.delete(PATH_PREFIX + id)
    return id
  }

  // ── Progress (e4-t11) ─────────────────────────────────────────────────────────────────────

  async progress(userId: string): Promise<PathProgress[]> {
    return [...(await this.store.list<PathProgress>(progressPrefix(userId))).values()]
  }

  /** Marks one lesson done or not; a path with nothing done is not kept */
  async markLesson(userId: string, body: unknown): Promise<PathProgress> {
    const input = isObject(body) ? body.progress : undefined
    if (!isObject(input) || !isPathId(input.pathId) || !isPathId(input.lessonId) || typeof input.done !== 'boolean')
      return bad('進度格式不正確')
    const key = progressPrefix(userId) + input.pathId
    const before = (await this.store.get<PathProgress>(key))?.done ?? []
    const others = before.filter((id) => id !== input.lessonId)
    const done = input.done ? [...others, input.lessonId as string] : others
    if (done.length > LEARNING_LIMITS.lessonsMax) bad(`一條路徑最多 ${LEARNING_LIMITS.lessonsMax} 課`)
    const progress: PathProgress = { pathId: input.pathId as string, done, at: this.now() }
    if (done.length) await this.store.put(key, progress)
    else await this.store.delete(key)
    return progress
  }
}

/** When an account is deleted */
export async function forgetPathProgress(store: Store, userId: string) {
  for (const key of (await store.list(progressPrefix(userId))).keys()) await store.delete(key)
}
