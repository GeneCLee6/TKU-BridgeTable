import { READING_KINDS, READING_LIMITS, type ReadingInput, type ReadingKind, type ReadingPlace } from '../shared/reading.ts'
import { isObject, isString } from './book.ts'
import { ClubError } from './errors.ts'
import type { Store } from './store.ts'

/**
 * 閱讀進度 (BridgeHall e5-t14, AC-5.8): each member's places in articles and e-books, newest first,
 * at `reading:<userId>` (one small list, at most READING_LIMITS.kept). Only the member reads or
 * changes their own; deleted with the account; not in the daily backup (like path progress).
 */

const key = (userId: string) => `reading:${userId}`
const ID = /^[\w-]+$/

const bad = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

const isPlaceNumber = (value: unknown, min: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= READING_LIMITS.placeMax

const isKind = (value: unknown): value is ReadingKind => READING_KINDS.includes(value as ReadingKind)
const isId = (value: unknown): value is string => isString(value) && value.length <= READING_LIMITS.idMax && ID.test(value)

/** The place a reader sent, or `badContent` */
export function checkReading(value: unknown): ReadingInput {
  if (!isObject(value) || !isKind(value.kind) || !isId(value.id)) return bad('閱讀進度格式不正確')
  if (!isString(value.title) || !value.title.trim() || value.title.length > READING_LIMITS.titleMax) return bad('標題不正確')
  // Articles count blocks from 0, books pages from 1
  const first = value.kind === 'article' ? 0 : 1
  if (!isPlaceNumber(value.of, 1) || !isPlaceNumber(value.place, first) || value.place > value.of - 1 + first)
    return bad('位置不正確')
  return { kind: value.kind, id: value.id, title: value.title.trim(), place: value.place, of: value.of }
}

export class ReadingStore {
  private readonly store: Store
  private readonly now: () => number

  constructor(store: Store, now: () => number) {
    this.store = store
    this.now = now
  }

  /** Newest first */
  async places(userId: string): Promise<ReadingPlace[]> {
    return (await this.store.get<ReadingPlace[]>(key(userId))) ?? []
  }

  /** Keeps where the member is; the same article or book moves to the top */
  async mark(userId: string, body: unknown): Promise<ReadingPlace> {
    const input = checkReading(isObject(body) ? body.reading : undefined)
    const place: ReadingPlace = { ...input, at: this.now() }
    const others = (await this.places(userId)).filter((p) => p.kind !== input.kind || p.id !== input.id)
    await this.store.put(key(userId), [place, ...others].slice(0, READING_LIMITS.kept))
    return place
  }

  /** Takes one article or book off the list */
  async forget(userId: string, body: unknown) {
    const kind = isObject(body) ? body.kind : undefined
    const id = isObject(body) ? body.id : undefined
    if (!isKind(kind) || !isId(id)) return bad('閱讀進度格式不正確')
    const before = await this.places(userId)
    const after = before.filter((p) => p.kind !== kind || p.id !== id)
    if (!after.length) await this.store.delete(key(userId))
    else if (after.length !== before.length) await this.store.put(key(userId), after)
  }
}

/** When an account is deleted */
export async function forgetReading(store: Store, userId: string) {
  await store.delete(key(userId))
}
