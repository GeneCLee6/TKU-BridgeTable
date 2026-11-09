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
  scoreTopics,
  seatOf,
  TOPIC_MINIMUM,
  topicOf,
  topicReport,
  QUIZ_TOPICS,
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
    expect(questionProblems(question({ topic: 'competition' }))).toEqual([])
    expect(questionProblems(question({ topic: 'preempt' as never })).join()).toMatch(/topic/)
  })

  it('grades the book\'s call, an accepted call and anything else', () => {
    const q = question({ accepted: ['1C'] })
    expect([grade(q, '1N'), grade(q, '1C'), grade(q, '1D')]).toEqual(['answer', 'accepted', 'wrong'])
  })
})

describe("bidding question bank: the PRD's nine areas (AC-5.4)", () => {
  const area = (auction: string[], answer: string, category = 'competitive') => topicOf(question({ auction, answer }), category)

  it('opens, responds and rebids when the opponents stay out', () => {
    expect(area([], '1S')).toBe('opening')
    expect(area(['P', 'P'], '3C')).toBe('opening')
    expect(area(['1H', 'P'], '2C')).toBe('response')
    expect(area(['P', 'P', '1S', 'P'], '2S')).toBe('response')
    expect(area(['1C', 'P', '1H', 'P'], '1N')).toBe('opener-rebid')
    expect(area(['1C', 'P', '1H', 'P', '1S', 'P'], '2D')).toBe('responder-rebid')
    expect(area(['1N', 'P', '2C', 'P', '2D', 'P'], '2S')).toBe('responder-rebid')
  })

  it('overcalls, advances and doubles over their one of a suit', () => {
    expect(area(['1D'], '1S')).toBe('overcall')
    expect(area(['1H', 'P', 'P'], '1N')).toBe('overcall')
    expect(area(['1D'], 'X')).toBe('double')
    expect(area(['1D', '1S', 'P'], '2S')).toBe('advance')
    expect(area(['1C', '1H', '1S'], '2H')).toBe('advance')
    expect(area(['1D', '1S', '2D'], 'X')).toBe('double')
    expect(area(['1D', 'X', 'P'], '1H')).toBe('double')
    expect(area(['1D', 'X', 'P', '1H', 'P'], '2H')).toBe('double')
    expect(area(['1D', '1S', 'P', '2S', 'P'], '3S')).toBe('competition')
  })

  it("puts their 1NT, weak twos and preempts, and our side's bidding over interference, under competition", () => {
    expect(area(['1N'], '2D')).toBe('competition')
    expect(area(['2S'], 'X')).toBe('competition')
    expect(area(['3H', 'X', 'P'], '4S')).toBe('competition')
    expect(area(['1H', '2C'], '3H')).toBe('competition')
    expect(area(['1H', '1S', '2H', '2S'], '3H')).toBe('competition')
    expect(area(['1H', '1S'], 'X')).toBe('double')
    expect(area(['1C', '1H', 'X', 'P'], '1S')).toBe('double')
  })

  it('puts slam bidding under slam, but not a 4NT over their four-level bid', () => {
    expect(area(['1S', 'P', '3S', 'P'], '4N')).toBe('slam')
    expect(area(['1S', 'P', '3S', 'P', '4N', 'P'], '5D')).toBe('slam')
    expect(area(['1N', 'P'], '4C')).toBe('slam')
    expect(area(['1N', 'P', '4C', 'P'], '4H')).toBe('slam')
    expect(area(['1H', 'P', '2S', 'P'], '3H', 'slam')).toBe('slam')
    expect(area(['1S', 'P', '4N', 'P', '5H', 'P'], '6S')).toBe('slam')
    expect(area(['4S'], '4N')).toBe('competition')
    expect(topicOf(question({ auction: ['1S', '2H', '4S'], answer: '5H', topic: 'competition' }), 'competitive')).toBe('competition')
  })

  it('reports each area against AC-5.4: short, wrong or done', () => {
    const row = (category: string, questions: number, correct: number): QuizScore => ({ system: 'tku', category, questions, answer: correct, correct, pending: questions })
    const report = topicReport([row('opening', 40, 40), row('advance', 21, 21), row('double', 35, 33)])
    expect(report).toContain('| tku | 開叫 (opening) | 40 | 40 | 40/40 (100.0%) | ✅ |')
    expect(report).toContain(`| tku | 蓋叫的答叫 (advance) | 21 | 21 | 21/21 (100.0%) | ${TOPIC_MINIMUM - 21} short |`)
    expect(report).toContain('| tku | 賭倍 (double) | 35 | 35 | 33/35 (94.3%) | 2 wrong |')
    expect(report).toContain('| tku | 滿貫 (slam) | 0 | 0 | 0/0 (—) | 30 short |')
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
    // AC-5.4: each of the nine areas has at least 30 of the club's questions (whether TKB gets them all right is the report's)
    const club = scoreTopics(results).filter((s) => s.system === 'tku')
    for (const row of club) expect([row.category, row.questions >= TOPIC_MINIMUM]).toEqual([row.category, true])
    expect(club.map((s) => s.category)).toEqual([...QUIZ_TOPICS])
  })
})
