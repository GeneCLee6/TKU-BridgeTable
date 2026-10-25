// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { inferenceBankProblems, inferenceDiff, inferenceProblems, loadInferenceBank, type InferenceQuestion } from '../../eval/inference.ts'

const question = (over: Partial<InferenceQuestion>): InferenceQuestion => ({
  id: 'tku-inf-test',
  system: 'tku',
  dealer: 'N',
  vul: 'None',
  auction: ['1N'],
  expect: { N: { hcp: [15, 17], balanced: true } },
  source: 'test',
  reviewer: null,
  status: 'pending',
  ...over,
})

describe('inference questions', () => {
  it('checks the format', () => {
    expect(inferenceProblems(question({}))).toEqual([])
    expect(inferenceProblems(question({ auction: ['1N', '1C'] }))).toEqual(['tku-inf-test: call 2 "1C" is not legal'])
    expect(inferenceProblems(question({ expect: { N: { hcp: [17, 15] } } }))).toEqual(['tku-inf-test: N: hcp must be [low, high]'])
    expect(inferenceProblems(question({ expect: {} }))).toEqual(['tku-inf-test: expect names no seat'])
    expect(inferenceProblems(question({ reviewer: 'someone' }))).toEqual(['tku-inf-test: a pending question has no reviewer yet (null)'])
  })

  it('compares only the features a question names', () => {
    expect(inferenceDiff(question({}))).toEqual([])
    expect(inferenceDiff(question({ expect: { N: { hcp: [15, 18] } } }))).toEqual(['N hcp: book 15–18, engine 15–17'])
    // What the engine does not say is no limit at all
    expect(inferenceDiff(question({ expect: { E: { hcp: [0, 40], len: { S: [0, 13] } } } }))).toEqual([])
  })
})

describe('inference question bank: tests/inference-quiz', () => {
  const files = loadInferenceBank()
  const questions = files.flatMap((f) => f.questions)

  it('has no problems and at least 50 questions (AC-5.6)', () => {
    expect(inferenceBankProblems(files)).toEqual([])
    expect(questions.length).toBeGreaterThanOrEqual(50)
  })

  it.each(questions.map((q) => [q.id, q] as const))('%s: the engine reads the auction as the book does', (_id, q) => {
    const diff = inferenceDiff(q)
    // A known miss stays a miss until the engine is fixed; then the question drops its `miss`
    if (q.miss) expect(diff, `${q.id} now agrees with the book: remove its "miss"`).not.toEqual([])
    else expect(diff).toEqual([])
  })
})
