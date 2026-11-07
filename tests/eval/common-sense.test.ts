// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { turnOf, type BoardState } from '../../shared/game.ts'
import { evalBoards } from '../../eval/deals.ts'
import { loadPlayBank, playState } from '../../eval/play-quiz.ts'
import { commonSenseBoard, commonSenseFlags, commonSenseReport, commonSenseStudy, type CommonSenseRecord } from '../../eval/sim/common-sense.ts'
import { loadSolver } from '../../eval/sim/dds.ts'

const questions = loadPlayBank().flatMap((file) => file.questions)

function at(id: string): BoardState {
  return playState(questions.find((q) => q.id === id)!)
}

const flagsOf = (id: string, card: string) => {
  const state = at(id)
  return commonSenseFlags(state, turnOf(state)!, card, 'tku')
}

describe('common sense: what counts as wrong (e6-t28)', () => {
  it('flags a ten thrown under a higher card', () => {
    expect(flagsOf('play-fourth-003', 'CT')).toContainEqual({ category: 'wasteHonour', sub: 'losing', alt: 'C2' })
    expect(flagsOf('play-second-013', 'ST')).toContainEqual({ category: 'secondHigh', sub: 'under', alt: 'S6' })
  })

  it('flags a low lead from touching honours', () => {
    expect(flagsOf('play-lead-common-001', 'D4')).toContainEqual({ category: 'equalsLead', sub: 'below', alt: 'DA' })
    expect(flagsOf('play-lead-common-001', 'DA')).toEqual([])
  })

  it('flags a first discard that reads as another suit than the one held', () => {
    expect(flagsOf('play-discard-common-001', 'S4')).toContainEqual({ category: 'signalDiscard', sub: 'againstWant', alt: 'C3' })
    expect(flagsOf('play-discard-common-001', 'C3')).toEqual([])
  })

  it('flags the king from a doubleton KQ, not the queen', () => {
    expect(flagsOf('play-third-common-001', 'CK')).toContainEqual({ category: 'equalsFollow', sub: 'win', alt: 'CQ' })
    expect(flagsOf('play-third-common-001', 'CQ').filter((f) => f.category === 'equalsFollow')).toEqual([])
  })
})

describe('common sense: the study', () => {
  it('solves the flagged decisions of real boards and adds them up', async () => {
    const solver = await loadSolver()
    const records: CommonSenseRecord[] = []
    for (const board of evalBoards(6)) {
      const record = await commonSenseBoard(board, 'tku', solver, { samples: 2, seed: 'test' })
      if (record) records.push(record)
    }
    const flags = records.flatMap((r) => r.flags)
    expect(flags.length).toBeGreaterThan(0)
    for (const f of flags) if (f.equal) expect([f.actual, f.mean]).toEqual([0, 0])
    const study = commonSenseStudy(records)
    expect(study.boards).toBe(records.length)
    expect(study.rows.reduce((n, r) => n + r.flagged, 0)).toBe(flags.length)
    for (const r of study.rows) expect(r.equal + r.altBetter + r.altWorse).toBeLessThanOrEqual(r.flagged)
    expect(commonSenseReport(study, 'test')).toContain('雙明手無差別')
  }, 60_000)

  it('counts a flag by the outcome of its alternative', () => {
    const flag = { category: 'wasteHonour' as const, sub: 'losing', alt: 'C2', at: 8, seat: 'W' as const, declaring: false, trick: 3, card: 'CT' }
    const records: CommonSenseRecord[] = [
      {
        board: 1,
        contract: '3N',
        decisions: { declaring: 3, defending: 4 },
        flags: [
          { ...flag, actual: 0, mean: 0, equal: true },
          { ...flag, actual: 1, mean: 0.5, equal: false },
          { ...flag, actual: -1, mean: -0.25, equal: false },
        ],
      },
    ]
    const study = commonSenseStudy(records)
    expect(study.decisions).toEqual({ declaring: 3, defending: 4 })
    expect(study.rows).toEqual([{ category: 'wasteHonour', sub: 'losing', declaring: false, flagged: 3, equal: 1, altBetter: 1, altWorse: 1, gain: 0.25 }])
  })
})
