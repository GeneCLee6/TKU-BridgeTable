// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { legalCards, turnOf } from '../../shared/game.ts'
import { ruleBrain } from '../../shared/robot/brain.ts'
import { loadPlayBank, playBankProblems, playQuestionProblems, playQuizMisses, playState, runPlayQuiz, scorePlayQuiz, systemsOf, type PlayQuestion } from '../../eval/play-quiz.ts'
import { quizRegressions } from '../../eval/quiz.ts'

const question = (overrides: Partial<PlayQuestion> = {}): PlayQuestion => ({
  id: 'test-001',
  system: 'both',
  board: 3,
  hands: { N: 'A32.753.QJT9.K43', E: 'Q876.QT9.A32.872', S: 'KJ5.A62.K87.AQJ6', W: 'T94.KJ84.654.T95' },
  auction: ['1N', 'P', '3N', 'P', 'P', 'P'],
  play: ['H4', 'H3'],
  answer: 'HQ',
  source: 'test',
  reviewer: null,
  status: 'pending',
  ...overrides,
})

describe('card-play question bank: the format', () => {
  it('builds the position and asks the seat to play', () => {
    const state = playState(question())
    expect(turnOf(state)).toBe('E')
    expect(state.contract).toMatchObject({ level: 3, strain: 'N', declarer: 'S' })
    expect(legalCards(state, 'E')).toEqual(['HQ', 'HT', 'H9'])
    expect(systemsOf(question())).toEqual(['tku', 'gib'])
    expect(systemsOf(question({ system: 'gib' }))).toEqual(['gib'])
  })

  it('finds what is wrong with a question', () => {
    expect(playQuestionProblems(question())).toEqual([])
    expect(playQuestionProblems(question({ hands: { ...question().hands, W: 'T94.KJ84.654.T96' } })).join()).toMatch(/repeat/)
    expect(playQuestionProblems(question({ auction: ['1N', 'P', '3N', 'P'] })).join()).toMatch(/not over/)
    expect(playQuestionProblems(question({ play: ['H4', 'H2'] })).join()).toMatch(/not a legal card/)
    expect(playQuestionProblems(question({ answer: 'SQ' })).join()).toMatch(/not a legal card here/)
    expect(playQuestionProblems(question({ accepted: ['HQ'] })).join()).toMatch(/repeated/)
    const singleton = { N: 'A32.753.QJT9.K43', E: 'Q8764.Q.A32.8762', S: 'KJ5.A962.K87.AQJ', W: 'T9.KJT84.654.T95' }
    expect(playQuestionProblems(question({ hands: singleton })).join()).toMatch(/only one card/)
    expect(playQuestionProblems(question({ status: 'reviewed' })).join()).toMatch(/names its reviewer/)
    expect(playQuestionProblems(question({ system: 'ben' as never })).join()).toMatch(/unknown system/)
    expect(playBankProblems([{ category: 'x', title: 'x', questions: [question(), question()] }]).join()).toMatch(/used twice/)
  })
})

describe('card-play question bank: the bank', () => {
  const files = loadPlayBank()

  it('is well formed', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(playBankProblems(files)).toEqual([])
  })

  it('TKB answers every position with a legal card, and scores by system and category', async () => {
    const results = await runPlayQuiz(ruleBrain, files)
    expect(results.length).toBeGreaterThan(0)
    for (const r of results) expect(legalCards(playState(r.question), r.seat)).toContain(r.card)
    const scores = scorePlayQuiz(results)
    expect(scores.map((s) => s.system)).toContain('tku')
    expect(scores.map((s) => s.system)).toContain('gib')
    expect(quizRegressions(scores, scores)).toEqual([])
    expect(typeof playQuizMisses(results)).toBe('string')
  })

  it('TKB answers the positions reported by the club (second hand, third hand)', async () => {
    const results = await runPlayQuiz(ruleBrain, files.filter((f) => f.category === 'second-hand' || f.category === 'third-hand'))
    expect(results.filter((r) => r.grade === 'wrong').map((r) => `${r.system} ${r.question.id}: ${r.card}`)).toEqual([])
  })
})
