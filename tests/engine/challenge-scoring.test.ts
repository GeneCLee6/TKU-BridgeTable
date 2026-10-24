import { describe, expect, it } from 'vitest'
import { scoreChallenge, type ChallengeScores } from '../../shared/challenge-scoring.ts'

const score = (
  scoring: ChallengeScores['scoring'],
  scores: ChallengeScores['scores'],
  unfinished: ChallengeScores['unfinished'] = 'avgMinus',
) => scoreChallenge({ scoring, unfinished, scores })
const brief = (standings: ReturnType<typeof scoreChallenge>) => standings.map((s) => [s.player, s.total, s.rank])
const boardsOf = (standings: ReturnType<typeof scoreChallenge>, player: string) =>
  standings.find((s) => s.player === player)!.boards

describe('challenge scoring', () => {
  it('IMPs head to head, board by board', () => {
    // 420 v 170: +6; 100 v 600: −11; −50 v −50: 0
    const result = score('imp', { amy: [420, 100, -50], ben: [170, 600, -50] })
    expect(brief(result)).toEqual([
      ['ben', 5, 1],
      ['amy', -5, 2],
    ])
    expect(boardsOf(result, 'amy')).toEqual([6, -11, 0])
  })

  it('adds up total points', () => {
    expect(brief(score('total', { amy: [420, -100], ben: [170, 110] }))).toEqual([
      ['amy', 320, 1],
      ['ben', 280, 2],
    ])
  })

  it('gives matchpoints as a percentage of what could be won, averaged over the boards', () => {
    // Board 1: 420 beats both (4 of 4 = 100%), 170 and 170 tie (1 of 4 = 25% each)
    // Board 2: 50 > 0 > −100: 100%, 50%, 0%
    const result = score('mp', { amy: [420, 0], ben: [170, 50], cat: [170, -100] })
    expect(result.map((s) => [s.player, s.boards])).toEqual([
      ['amy', [100, 50]],
      ['ben', [25, 100]],
      ['cat', [25, 0]],
    ])
    expect(brief(result)).toEqual([
      ['amy', 75, 1],
      ['ben', 62.5, 2],
      ['cat', 12.5, 3],
    ])
  })

  it('averages Cross-IMPs on each board and adds the boards up', () => {
    // amy 620: v 170 +10, v −100 +12 → 11; ben 170: −10, +7 → −1.5; cat −100: −12, −7 → −9.5
    expect(brief(score('crossImp', { amy: [620], ben: [170], cat: [-100] }))).toEqual([
      ['amy', 11, 1],
      ['ben', -1.5, 2],
      ['cat', -9.5, 3],
    ])
  })

  it('gives Avg- (40% or −3 IMPs) for a board not played, and compares the others among themselves', () => {
    const mp = score('mp', { amy: [420, 100], ben: [170, null], cat: [100, 50] })
    // Board 1: 420 > 170 > 100; board 2 between amy and cat only: 100% and 0%
    expect(mp.map((s) => [s.player, s.boards])).toEqual([
      ['amy', [100, 100]],
      ['ben', [50, 40]],
      ['cat', [0, 0]],
    ])
    const imp = score('imp', { amy: [420, null], ben: [170, 100] })
    expect(boardsOf(imp, 'amy')).toEqual([6, -3])
    expect(boardsOf(imp, 'ben')).toEqual([-6, 0])
  })

  it('can give the worst result instead: 0%, or the lowest score made on the board', () => {
    expect(boardsOf(score('mp', { amy: [null], ben: [170], cat: [100] }, 'worst'), 'amy')).toEqual([0])
    // amy takes −100, the lowest: v 600 −12, v −100 0 → −6
    expect(boardsOf(score('crossImp', { amy: [null], ben: [600], cat: [-100] }, 'worst'), 'amy')).toEqual([-6])
    // Totals always take the lowest score
    expect(score('total', { amy: [null, 50], ben: [-200, 10] }).find((s) => s.player === 'amy')!.total).toBe(-150)
  })

  it('scores a player alone on a board as average, and a board nobody played as Avg-', () => {
    expect(score('mp', { amy: [420, null], ben: [null, null] }).map((s) => s.boards)).toEqual([
      [50, 40],
      [40, 40],
    ])
    expect(boardsOf(score('imp', { amy: [420], ben: [null] }), 'amy')).toEqual([0])
  })

  it('shares places on equal totals and skips the next one', () => {
    expect(brief(score('total', { amy: [100], ben: [400], cat: [400], dan: [-50] }))).toEqual([
      ['ben', 400, 1],
      ['cat', 400, 1],
      ['amy', 100, 3],
      ['dan', -50, 4],
    ])
    // Averages that are equal in principle count as equal
    expect(score('mp', { a: [1, 0, 0], b: [0, 1, 0], c: [0, 0, 1] }).map((s) => s.rank)).toEqual([1, 1, 1])
  })

  it('counts the boards each player has played', () => {
    expect(score('mp', { amy: [1, null, 3], ben: [null, null, null] }).map((s) => s.played)).toEqual([2, 0])
  })
})
