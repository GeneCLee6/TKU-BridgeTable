import type { Me } from '../shared/protocol.ts'
import {
  QUIZ_LIMITS,
  type ManualQuiz,
  type QuizAnswer,
  type QuizAuction,
  type QuizFix,
  type QuizFixInput,
  type QuizRound,
} from '../shared/quiz.ts'
import { isObject, isSectionId, isSlug, isString } from './book.ts'
import { ClubError } from './errors.ts'
import type { Store } from './store.ts'

/**
 * 淡江橋館's practice records (BridgeHall E6, ARCHITECTURE.md §5.5):
 *
 * - **Results** (e6-t04): every round a member finishes, at `quizlog:<userId>:<time>-<id>`, the
 *   newest QUIZ_LIMITS.roundsKept kept. Only the member reads, adds or clears their own; deleted
 *   with the account; not in the daily backup (like practice presets).
 * - **Fixes** (e6-t06): an editor's change to a question, at `book:quizfix:<id>` (so in the daily
 *   backup with the rest of the book). Anyone reads them (the practice page needs no sign-in);
 *   editors save and remove them. The Worker checks only their shape: what a question says is the
 *   editors' (CLAUDE.md rule 1 in the handbook).
 */

const logPrefix = (userId: string) => `quizlog:${userId}:`
const FIX_PREFIX = 'book:quizfix:'

const MADE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9][a-z0-9-]*\/\d{1,4}\/\d{1,4}$/
const MANUAL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9][a-z0-9-]*\/m-[a-z0-9]{4,16}$/
const PROFILE_ID = /^[\w-]{1,40}$/
const LEVELS = ['basic', 'intermediate', 'advanced']

const bad = (reason: string): never => {
  throw new ClubError('badContent', { reason })
}

const isText = (value: unknown, max: number = QUIZ_LIMITS.textMax): value is string =>
  isString(value) && value.trim() !== '' && value.length <= max

export const isQuizId = (value: unknown): value is string =>
  isString(value) && value.length <= QUIZ_LIMITS.idMax && (MADE_ID.test(value) || MANUAL_ID.test(value))

/** The slug and section a question id names */
const placeOf = (id: string) => {
  const [slug, sectionId] = id.split('/')
  return { slug, sectionId }
}

function checkAnswers(value: unknown): QuizAnswer[] {
  if (!Array.isArray(value) || !value.length || value.length > QUIZ_LIMITS.answersMax)
    return bad(`一次練習要有 1–${QUIZ_LIMITS.answersMax} 題`)
  return value.map((a) => {
    if (!isObject(a) || !isQuizId(a.id) || typeof a.right !== 'boolean' || a.slug !== placeOf(a.id).slug) return bad('作答紀錄格式不正確')
    return { id: a.id, slug: a.slug as string, right: a.right }
  })
}

function checkChoices(value: unknown, answer: string): string[] {
  if (!Array.isArray(value) || value.length < QUIZ_LIMITS.choicesMin || value.length > QUIZ_LIMITS.choicesMax)
    return bad(`選項要有 ${QUIZ_LIMITS.choicesMin}–${QUIZ_LIMITS.choicesMax} 個`)
  if (!value.every((c) => isText(c))) bad('選項不能空白')
  const choices = value as string[]
  if (new Set(choices.map((c) => c.trim())).size !== choices.length) bad('選項不能重複')
  if (!choices.includes(answer)) bad('正解要在選項裡')
  return choices
}

const isCallText = (value: unknown): value is string => isString(value) && value.length <= 40

function checkAuction(value: unknown): QuizAuction {
  if (!isObject(value) || !Array.isArray(value.seats) || value.seats.length !== 4 || !value.seats.every((s) => isCallText(s)))
    return bad('叫牌過程格式不正確')
  if (!Array.isArray(value.calls) || value.calls.length > QUIZ_LIMITS.callsMax) return bad('叫牌過程格式不正確')
  const calls = value.calls.map((c) => {
    if (isCallText(c)) return c
    if (isObject(c) && isCallText(c.call) && (c.note === undefined || isText(c.note, QUIZ_LIMITS.noteMax)))
      return c.note === undefined ? { call: c.call } : { call: c.call, note: c.note }
    return bad('叫牌過程格式不正確')
  })
  return { seats: value.seats as QuizAuction['seats'], calls }
}

function checkManual(value: unknown, id: string): ManualQuiz {
  if (!isObject(value)) return bad('缺少題目')
  const { slug, sectionId } = placeOf(id)
  if (value.slug !== slug || value.sectionId !== sectionId || !isSlug(value.slug) || !isSectionId(value.sectionId))
    bad('題目的特約或段落與 id 不同')
  if (value.kind !== 'meaning' && value.kind !== 'call') bad('題目的種類不正確')
  if (!isString(value.profileId) || !PROFILE_ID.test(value.profileId)) bad('題目的制度集不正確')
  if (!isText(value.answer)) bad('正解不能空白')
  const answer = value.answer as string
  const quiz: ManualQuiz = {
    kind: value.kind as ManualQuiz['kind'],
    profileId: value.profileId as string,
    slug,
    sectionId,
    answer,
    choices: checkChoices(value.choices, answer),
  }
  if (value.auction !== undefined) quiz.auction = checkAuction(value.auction)
  if (value.kind === 'meaning') {
    if (!isText(value.call, 40)) bad('意義題要有叫品')
    quiz.call = value.call as string
  } else {
    const hand = value.hand
    if (!isObject(hand) || !['spades', 'hearts', 'diamonds', 'clubs'].every((suit) => isString(hand[suit]) && (hand[suit] as string).length <= 20))
      return bad('叫品題要有牌')
    quiz.hand = { spades: hand.spades as string, hearts: hand.hearts as string, diamonds: hand.diamonds as string, clubs: hand.clubs as string }
    if (value.call !== undefined) bad('叫品題的正解寫在 answer')
  }
  if (value.level !== undefined) {
    if (!LEVELS.includes(value.level as string)) bad('程度不正確')
    quiz.level = value.level as ManualQuiz['level']
  }
  if (value.caption !== undefined) {
    if (!isText(value.caption)) bad('說明格式不正確')
    quiz.caption = value.caption as string
  }
  return quiz
}

/** Checks a fix's shape; returns it with only the known fields */
export function checkQuizFix(value: unknown): QuizFixInput {
  if (!isObject(value)) return bad('缺少修正內容')
  const { id } = value
  if (!isQuizId(id)) return bad('題目 id 格式不正確')
  if (value.disabled !== undefined && typeof value.disabled !== 'boolean') bad('停用格式不正確')
  if (value.note !== undefined && !isText(value.note, QUIZ_LIMITS.noteMax)) bad(`備註最多 ${QUIZ_LIMITS.noteMax} 字`)
  const common = {
    ...(value.disabled === true && { disabled: true }),
    ...(value.note !== undefined && { note: value.note as string }),
  }
  if (value.source === 'manual') {
    if (!MANUAL_ID.test(id)) bad('手動出題的 id 格式不正確')
    return { source: 'manual', id, quiz: checkManual(value.quiz, id), ...common }
  }
  if (value.source !== 'auto' || !MADE_ID.test(id)) return bad('題目來源不正確')
  const basis = value.basis
  if (!isObject(basis) || !isText(basis.call, 40) || !isText(basis.answer)) return bad('缺少原本的題目')
  const fix: QuizFixInput = { source: 'auto', id, basis: { call: basis.call as string, answer: basis.answer as string }, ...common }
  if (value.answer !== undefined) {
    if (!isText(value.answer)) bad('正解不能空白')
    fix.answer = value.answer as string
  }
  if (value.choices !== undefined) fix.choices = checkChoices(value.choices, fix.answer ?? fix.basis.answer)
  if (!fix.disabled && fix.answer === undefined && fix.choices === undefined) bad('沒有要修正的地方')
  return fix
}

export class QuizStore {
  private readonly store: Store
  private readonly now: () => number
  private readonly newId: () => string

  constructor(store: Store, now: () => number, newId: () => string) {
    this.store = store
    this.now = now
    this.newId = newId
  }

  // ── Results (e6-t04) ──────────────────────────────────────────────────────────────────────

  /** The member's rounds, newest first */
  async rounds(userId: string): Promise<QuizRound[]> {
    return [...(await this.store.list<QuizRound>(logPrefix(userId), { reverse: true })).values()]
  }

  /** Keeps a finished round; the oldest go past QUIZ_LIMITS.roundsKept */
  async addRound(userId: string, body: unknown): Promise<QuizRound> {
    const input = isObject(body) ? body.round : undefined
    if (!isObject(input)) return bad('缺少作答紀錄')
    if (!isString(input.profileId) || !PROFILE_ID.test(input.profileId)) bad('制度集格式不正確')
    const at = this.now()
    const round: QuizRound = { id: this.newId(), at, profileId: input.profileId as string, answers: checkAnswers(input.answers) }
    await this.store.put(`${logPrefix(userId)}${String(at).padStart(14, '0')}-${round.id}`, round)
    const keys = [...(await this.store.list(logPrefix(userId), { reverse: true })).keys()]
    for (const key of keys.slice(QUIZ_LIMITS.roundsKept)) await this.store.delete(key)
    return round
  }

  /** Clears the member's results (their own button, and when the account is deleted) */
  async clearRounds(userId: string) {
    await forgetQuizRounds(this.store, userId)
  }

  // ── Fixes (e6-t06) ────────────────────────────────────────────────────────────────────────

  async fixes(): Promise<QuizFix[]> {
    return [...(await this.store.list<QuizFix>(FIX_PREFIX)).values()]
  }

  async saveFix(actor: Me, body: unknown): Promise<QuizFix> {
    const input = checkQuizFix(isObject(body) ? body.fix : undefined)
    const key = FIX_PREFIX + input.id
    if (!(await this.store.get(key)) && (await this.store.list(FIX_PREFIX)).size >= QUIZ_LIMITS.fixesMax)
      bad(`修題最多 ${QUIZ_LIMITS.fixesMax} 筆`)
    const fix: QuizFix = { ...input, by: actor.username, at: this.now() }
    await this.store.put(key, fix)
    return fix
  }

  /** Removes a fix (the question goes back to how it is made) or a hand-made question */
  async removeFix(body: unknown): Promise<string> {
    const id = isObject(body) ? body.id : undefined
    if (!isQuizId(id)) return bad('題目 id 格式不正確')
    await this.store.delete(FIX_PREFIX + id)
    return id
  }
}

/** When an account is deleted */
export async function forgetQuizRounds(store: Store, userId: string) {
  for (const key of (await store.list(logPrefix(userId))).keys()) await store.delete(key)
}
