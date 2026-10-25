// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { hcp } from '../../shared/cards.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import {
  bankProblems,
  grade,
  loadBank,
  parseHand,
  questionProblems,
  quizRegressions,
  quizReport,
  quizState,
  runQuiz,
  scoreQuiz,
  seatOf,
  type QuizQuestion,
  type QuizScore,
} from '../../eval/quiz.ts'

const question = (overrides: Partial<QuizQuestion> = {}): QuizQuestion => ({
  id: 'test-001',
  system: 'tku',
  dealer: 'N',
  vul: 'None',
  hand: 'AK32.KQ4.J52.Q43',
  auction: [],
  answer: '1N',
  source: 'test',
  reviewer: null,
  status: 'pending',
  ...overrides,
})

describe('bidding question bank: the format', () => {
  it('reads a hand S.H.D.C, a void as an empty suit', () => {
    expect(parseHand('AK32.KQ4.J52.Q43')).toEqual(['SA', 'SK', 'S3', 'S2', 'HK', 'HQ', 'H4', 'DJ', 'D5', 'D2', 'CQ', 'C4', 'C3'])
    expect(parseHand('AKQJT98765432...')).toHaveLength(13)
    expect(hcp(parseHand('AK32.KQ4.J52.Q43'))).toBe(15)
    expect(() => parseHand('AK32.KQ4.J52.Q4')).toThrow(/12 cards/)
    expect(() => parseHand('AK32.KQ4.J52.QQ43')).toThrow()
    expect(() => parseHand('AK32.KQ4.J52')).toThrow(/four suits/)
  })

  it('asks the seat whose turn it is, with only its own hand from the question', () => {
    const q = question({ dealer: 'E', auction: ['1N', 'P'], answer: '2C', hand: 'KJ84.Q72.A63.952' })
    expect(seatOf(q)).toBe('W')
    const state = quizState(q)
    expect(state.hands.W).toEqual(parseHand(q.hand))
    expect(Object.values(state.hands).flat().sort()).toHaveLength(52)
    expect(new Set(Object.values(state.hands).flat()).size).toBe(52)
    expect(state.auction.map((c) => c.seat)).toEqual(['E', 'S'])
  })

  it('finds what is wrong with a question', () => {
    expect(questionProblems(question())).toEqual([])
    expect(questionProblems(question({ auction: ['1N', '1C'] })).join()).toMatch(/not legal/)
    expect(questionProblems(question({ auction: ['1N'], answer: '1S' })).join()).toMatch(/"1S" is not a legal call/)
    expect(questionProblems(question({ accepted: ['1N'] })).join()).toMatch(/repeated/)
    expect(questionProblems(question({ auction: ['P', 'P', 'P', 'P'] })).join()).toMatch(/already over/)
    expect(questionProblems(question({ source: ' ' })).join()).toMatch(/source/)
    expect(questionProblems(question({ reviewer: '社長' })).join()).toMatch(/pending/)
    expect(questionProblems(question({ status: 'reviewed' })).join()).toMatch(/reviewer/)
    expect(questionProblems(question({ status: 'reviewed', reviewer: '社長' }))).toEqual([])
  })

  it('grades the book\'s call, an accepted call and anything else', () => {
    const q = question({ accepted: ['1C'] })
    expect([grade(q, '1N'), grade(q, '1C'), grade(q, '1D')]).toEqual(['answer', 'accepted', 'wrong'])
  })
})

describe('bidding question bank: the ratchet', () => {
  const row = (category: string, correct: number): QuizScore => ({ system: 'tku', category, questions: 10, answer: correct, correct, pending: 10 })

  it('fails a category with fewer correct answers than the base, never a new one', () => {
    expect(quizRegressions([row('opening', 8), row('rebid', 5)], [row('opening', 8), row('rebid', 6)]).map((r) => r.category)).toEqual(['rebid'])
    expect(quizRegressions([row('opening', 9)], [row('opening', 8)])).toEqual([])
    expect(quizRegressions([row('response', 0)], [row('opening', 8)])).toEqual([])
  })

  it('reports each category and the total', () => {
    const report = quizReport([row('opening', 8), row('rebid', 5)], [row('opening', 8), row('rebid', 6)])
    expect(report).toContain('| tku | opening | 10 | 10 | 8/10 (80.0%) | 8/10 (80.0%) | ✅ |')
    expect(report).toContain('| tku | rebid | 10 | 10 | 5/10 (50.0%) | 6/10 (60.0%) | ❌ |')
    expect(report).toContain('| **all** | | 20 | 20 | 13/20 (65.0%) | 14/20 (70.0%) | ❌ |')
  })
})

describe('bidding question bank: tests/bidding-quiz', () => {
  const files = loadBank()

  it('has no problems: legal auctions and answers, unique ids, sources, review status', () => {
    expect(bankProblems(files)).toEqual([])
    expect([...new Set(files.map((f) => f.category))]).toEqual(expect.arrayContaining(['competitive', 'opening', 'rebid', 'response', 'slam']))
    expect(files.flatMap((f) => f.questions).length).toBeGreaterThanOrEqual(50)
  })

  it('TKB answers every question with a legal call', async () => {
    const results = await runQuiz(ruleBrain, files)
    for (const { question: q, call } of results) expect(questionProblems({ ...q, answer: call, accepted: [] })).toEqual([])
    const scores = scoreQuiz(results)
    expect(scores.map((s) => s.category)).toEqual(expect.arrayContaining(['competitive', 'opening', 'rebid', 'response', 'slam']))
  })
})
