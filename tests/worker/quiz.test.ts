// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest'
import type { Me } from '../../shared/protocol.ts'
import { QUIZ_LIMITS, type QuizFixInput } from '../../shared/quiz.ts'
import { checkQuizFix, forgetQuizRounds, QuizStore } from '../../worker/quiz.ts'
import { bookRouteNeed } from '../../worker/roles.ts'
import { MemoryStore } from '../../worker/store.ts'

/** 淡江橋館's practice results (e6-t04) and the editors' question fixes (e6-t06) */

const editor = { id: 'ed1', username: 'ed' } as Me
const answers = [
  { id: 'stayman/basic/0/1', slug: 'stayman', right: true },
  { id: 'stayman/basic/0/2', slug: 'stayman', right: false },
]

describe('QuizStore', () => {
  let store: MemoryStore
  let time: number
  let n: number
  let quiz: QuizStore

  beforeEach(() => {
    store = new MemoryStore()
    time = 1000
    n = 0
    quiz = new QuizStore(store, () => time, () => `r${++n}`)
  })

  it('keeps a member’s rounds, newest first, only their own', async () => {
    await quiz.addRound('u1', { round: { profileId: 'club', answers } })
    time = 2000
    const second = await quiz.addRound('u1', { round: { profileId: 'club', answers: answers.slice(0, 1) } })
    await quiz.addRound('u2', { round: { profileId: 'club', answers } })
    expect(second).toEqual({ id: 'r2', at: 2000, profileId: 'club', answers: answers.slice(0, 1) })
    expect((await quiz.rounds('u1')).map((r) => r.id)).toEqual(['r2', 'r1'])
    expect((await quiz.rounds('u2')).map((r) => r.id)).toEqual(['r3'])
  })

  it('keeps only the newest rounds', async () => {
    for (let i = 0; i < QUIZ_LIMITS.roundsKept + 3; i++) {
      time = 1000 + i
      await quiz.addRound('u1', { round: { profileId: 'club', answers } })
    }
    const rounds = await quiz.rounds('u1')
    expect(rounds).toHaveLength(QUIZ_LIMITS.roundsKept)
    expect(rounds.at(-1)!.at).toBe(1003)
  })

  it('clears a member’s rounds, and forgets them with the account', async () => {
    await quiz.addRound('u1', { round: { profileId: 'club', answers } })
    await quiz.addRound('u2', { round: { profileId: 'club', answers } })
    await quiz.clearRounds('u1')
    expect(await quiz.rounds('u1')).toEqual([])
    await forgetQuizRounds(store, 'u2')
    expect(store.data.size).toBe(0)
  })

  it('refuses a round that is not one', async () => {
    const bad = [
      undefined,
      { round: { profileId: 'club', answers: [] } },
      { round: { profileId: 'club', answers: [{ id: 'nope', slug: 'x', right: true }] } },
      { round: { profileId: 'club', answers: [{ ...answers[0], slug: 'other' }] } },
      { round: { profileId: 'club', answers: [{ ...answers[0], right: 'yes' }] } },
      { round: { profileId: 'club', answers: Array(QUIZ_LIMITS.answersMax + 1).fill(answers[0]) } },
      { round: { profileId: '../x', answers } },
    ]
    for (const body of bad) await expect(quiz.addRound('u1', body)).rejects.toMatchObject({ code: 'badContent' })
  })

  it('keeps the editors’ fixes in the book, for the backup', async () => {
    const fix: QuizFixInput = { source: 'auto', id: 'stayman/basic/0/1', basis: { call: '2C', answer: '問高花' }, disabled: true }
    expect(await quiz.saveFix(editor, { fix })).toEqual({ ...fix, by: 'ed', at: 1000 })
    expect([...store.data.keys()]).toEqual(['book:quizfix:stayman/basic/0/1'])
    time = 2000
    await quiz.saveFix(editor, { fix: { ...fix, disabled: false, answer: '問高花，8 點以上' } })
    expect(await quiz.fixes()).toEqual([
      { source: 'auto', id: fix.id, basis: fix.basis, answer: '問高花，8 點以上', by: 'ed', at: 2000 },
    ])
    expect(await quiz.removeFix({ id: fix.id })).toBe(fix.id)
    expect(await quiz.fixes()).toEqual([])
  })
})

describe('checkQuizFix', () => {
  const auto = { source: 'auto', id: 'stayman/basic/0/1', basis: { call: '2C', answer: '問高花' } }
  const manual = {
    source: 'manual',
    id: 'stayman/basic/m-ab12cd',
    quiz: {
      kind: 'call',
      profileId: 'club',
      slug: 'stayman',
      sectionId: 'basic',
      auction: { seats: ['北', '東', '南', '西'], calls: ['1NT', { call: 'P', note: '不叫' }] },
      hand: { spades: 'KQ43', hearts: 'J54', diamonds: 'A32', clubs: '432' },
      answer: '2C',
      choices: ['2C', '2NT', '3NT'],
      level: 'basic',
    },
  }

  it('keeps a change to a made question: taken out, the answer, the choices', () => {
    expect(checkQuizFix({ ...auto, disabled: true, note: '題目不清楚', extra: 1 })).toEqual({ ...auto, disabled: true, note: '題目不清楚' })
    expect(checkQuizFix({ ...auto, answer: 'A', choices: ['A', 'B', 'C', 'D'] })).toEqual({ ...auto, answer: 'A', choices: ['A', 'B', 'C', 'D'] })
    // The original answer is among the choices when only the choices change
    expect(() => checkQuizFix({ ...auto, choices: ['A', 'B'] })).toThrow()
    // Nothing to change, a manual id, no basis
    expect(() => checkQuizFix(auto)).toThrow()
    expect(() => checkQuizFix({ ...auto, disabled: true, id: 'stayman/basic/m-ab12cd' })).toThrow()
    expect(() => checkQuizFix({ source: 'auto', id: auto.id, disabled: true })).toThrow()
  })

  it('keeps a hand-made question, a hand included', () => {
    const checked = checkQuizFix(manual)
    expect(checked).toMatchObject({ source: 'manual', id: manual.id, quiz: { kind: 'call', answer: '2C', hand: manual.quiz.hand } })
    expect(() => checkQuizFix({ ...manual, quiz: { ...manual.quiz, slug: 'other' } })).toThrow()
    expect(() => checkQuizFix({ ...manual, quiz: { ...manual.quiz, hand: undefined } })).toThrow()
    expect(() => checkQuizFix({ ...manual, quiz: { ...manual.quiz, choices: ['2C', '2C'] } })).toThrow()
    expect(() => checkQuizFix({ ...manual, quiz: { ...manual.quiz, answer: '4C' } })).toThrow()
    expect(() => checkQuizFix({ ...manual, quiz: { ...manual.quiz, kind: 'meaning', hand: undefined } })).toThrow()
    expect(checkQuizFix({ ...manual, quiz: { ...manual.quiz, kind: 'meaning', hand: undefined, call: '2C', answer: 'A', choices: ['A', 'B'] } })).toMatchObject({
      quiz: { kind: 'meaning', call: '2C' },
    })
  })
})

describe('routes', () => {
  it('lets members keep their own results and editors fix the questions', () => {
    for (const method of ['GET', 'POST', 'DELETE']) expect(bookRouteNeed(method, '/quiz/rounds')).toBe('member')
    for (const method of ['PUT', 'DELETE']) expect(bookRouteNeed(method, '/quiz/fixes')).toBe('bookEdit')
    expect(bookRouteNeed('PUT', '/quiz/rounds')).toBeNull()
    // Reading the fixes needs no sign-in (club.ts, before bookApi)
    expect(bookRouteNeed('GET', '/quiz/fixes')).toBeNull()
  })
})
