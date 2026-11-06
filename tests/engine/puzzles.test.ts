import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { nextSeat, SEATS, type Card } from '../../shared/cards.ts'
import { puzzleRevision, solvePuzzle, SOLVE_LIMITS } from '../../shared/puzzle-solver.ts'
import { PUZZLE_SOURCES, PUZZLES, type Puzzle } from '../../shared/puzzle-sets/index.ts'
import { SOLUTIONS } from '../../shared/puzzle-sets/solutions.generated.ts'
import {
  applyPlay,
  legalPlays,
  parsePuzzleDeal,
  puzzleEdges,
  puzzleNeed,
  puzzleProblem,
  puzzleState,
  splitCards,
  type PuzzleSource,
  type PuzzleState,
} from '../../shared/puzzles.ts'
import { canTake } from '../../shared/robot/dd.ts'

/** 謎題 (`e10-t13`): the format, the solver's refusals, and the stored data checked again by the solver */

/** Tied to the end of a trick; asks `dd.ts` from the state as the solver would */
function canMake(state: PuzzleState, tricks: number) {
  if (tricks <= 0) return true
  const last = state.tricks.at(-1)
  const open = last && !last.winner
  return canTake(
    {
      hands: state.hands,
      trick: open ? last.cards.map((card, i) => ({ seat: nextSeat(last.leader, i), card })) : [],
      leader: open ? last.leader : state.turn,
      trump: state.trump,
    },
    'NS',
    tricks,
    SOLVE_LIMITS.budget,
  )
}

const WORDS = { title: 't', story: 's', hints: ['h'], explanation: 'e' }

const unblock: PuzzleSource = {
  id: 'x',
  status: 'draft',
  level: 1,
  contract: { level: 3, strain: 'N' },
  deal: 'N:AJT98.2.. 76.KQ.K.K KQ.A.A.32 54.J.Q.JT',
  won: 3,
  leader: 'S',
  opening: [],
  ...WORDS,
}

describe('the format', () => {
  it('parses a deal: hands in PBN order, no card twice', () => {
    expect(parsePuzzleDeal('N:A.K.. .Q.J. 2.3.. K..2.')?.E).toEqual(['HQ', 'DJ'])
    expect(parsePuzzleDeal('N:A.K.. A.Q.J. 2.3.. K..2.')).toBeNull()
    expect(parsePuzzleDeal('N:A.K. .Q.J. 2.3.. K..2.')).toBeNull()
    expect(parsePuzzleDeal('N:X.K.. .Q.J. 2.3.. K..2.')).toBeNull()
  })

  it('says what is wrong with a puzzle', () => {
    expect(puzzleProblem(unblock)).toBeNull()
    expect(puzzleProblem({ ...unblock, status: 'published' as 'draft' })).toMatch(/status/)
    expect(puzzleProblem({ ...unblock, level: 4 as 1 })).toBe('level')
    expect(puzzleProblem({ ...unblock, contract: { level: 8, strain: 'N' } })).toBe('contract')
    expect(puzzleProblem({ ...unblock, deal: 'N:A... ... ... ...' })).toMatch(/same length/)
    expect(puzzleProblem({ ...unblock, won: 9 })).toMatch(/^won/)
    expect(puzzleProblem({ ...unblock, won: 0 })).toMatch(/^won/)
    expect(puzzleProblem({ ...unblock, opening: ['SA'] })).toMatch(/^opening/)
    expect(puzzleProblem({ ...unblock, hints: [] })).toBe('words')
  })

  it('counts tricks: South and North win for declarer, and a card follows suit', () => {
    let state = puzzleState(unblock, [])
    expect(state.turn).toBe('S')
    state = applyPlay(state, 'SK')
    expect(legalPlays(state)).toEqual(['S5', 'S4'])
    for (const card of ['S4', 'S8', 'S6']) state = applyPlay(state, card)
    expect(state.tricks[0].winner).toBe('S')
    expect(state.won).toBe(1)
    expect(state.turn).toBe('S')
  })
})

describe('the solver refuses what it cannot solve completely (e10-t13)', () => {
  it('a contract that cannot be made', () => {
        expect(solvePuzzle({ ...unblock, contract: { level: 1, strain: 'N' }, deal: 'N:2... 3... 4... A...', won: 6 })).toEqual({ refused: 'the contract cannot be made against best defence' })
  })

  it('a puzzle with no decision to make', () => {
    expect(solvePuzzle({ ...unblock, contract: { level: 1, strain: 'N' }, deal: 'N:A... K... Q... J...', won: 6 })).toEqual({ refused: 'no decision: every card makes the contract' })
  })

  it('when dd.ts gives up, nothing is half stored', () => {
    expect(solvePuzzle(unblock, { ...SOLVE_LIMITS, budget: 1 })).toMatchObject({ refused: expect.stringContaining('dd.ts gave up') })
  })

  it('data too big for a request', () => {
    expect(solvePuzzle(unblock, { ...SOLVE_LIMITS, maxNodes: 3 })).toMatchObject({ refused: expect.stringContaining('more than 3') })
    expect(solvePuzzle(unblock, { ...SOLVE_LIMITS, maxChars: 10 })).toMatchObject({ refused: expect.stringContaining('more than 10') })
  })

  it('anything not well formed', () => {
    expect(solvePuzzle({ ...unblock, deal: 'nonsense' })).toEqual({ refused: 'deal' })
  })
})

describe('the first set', () => {
  it('ten puzzles, every one a draft, with all three levels and unique ids', () => {
    expect(PUZZLE_SOURCES).toHaveLength(10)
    expect(PUZZLES).toHaveLength(10)
    expect(new Set(PUZZLE_SOURCES.map((p) => p.id)).size).toBe(10)
    expect(new Set(PUZZLE_SOURCES.map((p) => p.level))).toEqual(new Set([1, 2, 3]))
    for (const source of PUZZLE_SOURCES) {
      expect(source.status).toBe('draft')
      expect(puzzleProblem(source)).toBeNull()
    }
  })

  it('the generated file is the solver\'s answer for today\'s text', () => {
    expect(SOLUTIONS.map((s) => s.id)).toEqual(PUZZLE_SOURCES.map((p) => p.id))
    for (const { source, solution } of PUZZLES) expect(solution.revision, source.id).toBe(puzzleRevision(source))
  })

  it('every puzzle is small enough to look up in a request', () => {
    for (const { source, solution } of PUZZLES) {
      expect(solution.nodes.length, source.id).toBeLessThanOrEqual(SOLVE_LIMITS.maxChars)
      expect(solution.size, source.id).toBeLessThanOrEqual(SOLVE_LIMITS.maxNodes)
      expect(solution.nodes.split(';'), source.id).toHaveLength(solution.size)
    }
  })

  /** Every stored decision, walked, and asked of `dd.ts` afresh */
  function check(puzzle: Puzzle) {
    const { source, solution } = puzzle
    const need = puzzleNeed(source)
    const seen = new Set<number>()
    const replay = (start: PuzzleState, cards: readonly Card[]) => {
      let state = start
      for (const card of cards) {
        expect(legalPlays(state), `${source.id} ${card}`).toContain(card)
        expect(state.turn === 'E' || state.turn === 'W', `${source.id} ${card} from a defender`).toBe(true)
        // The defence the stored data plays is the best there is: no other card leaves declarer fewer
        const most = (s: PuzzleState) => {
          const left = Math.max(...SEATS.map((seat) => s.hands[seat].length))
          let n = 0
          while (n < left && canMake(s, n + 1)) n++
          return n + s.won
        }
        const here = most(applyPlay(state, card))
        for (const other of legalPlays(state)) expect(most(applyPlay(state, other)), `${source.id} defends ${card}, not ${other}`).toBeGreaterThanOrEqual(here)
        state = applyPlay(state, card)
      }
      return state
    }
    const walk = (node: number, state: PuzzleState) => {
      if (seen.has(node)) return
      seen.add(node)
      expect(state.turn === 'N' || state.turn === 'S', `${source.id} node ${node}: declarer's turn`).toBe(true)
      const edges = puzzleEdges(solution, node)
      for (const card of legalPlays(state)) {
        const after = applyPlay(state, card)
        const right = after.won >= need || canMake(after, need - after.won) === true
        expect(edges.some((e) => e.card === card), `${source.id} node ${node} ${card}`).toBe(right)
      }
      for (const edge of edges) {
        const next = replay(applyPlay(state, edge.card), edge.replies)
        if (edge.next >= 0) walk(edge.next, next)
      }
    }
    const shown = replay(puzzleState(source, source.opening), splitCards(solution.start))
    walk(0, shown)
    expect(seen.size, source.id).toBe(solution.size)
  }

  it.each(PUZZLES.map((p) => [p.source.id, p] as const))('%s: every stored decision agrees with dd.ts', (_id, puzzle) => check(puzzle), 120_000)

  /** What each puzzle teaches, in the cards: before these, this one is right and that one wrong */
  const LESSONS: { id: string; line: Card[]; right?: Card; wrong: Card }[] = [
    { id: 'p01', line: ['SK'], wrong: 'SA' }, // the ♠A on the ♠K leaves the ♠Q blocking the ♠J
    { id: 'p01', line: ['SK', 'SJ', 'SQ'], right: 'SA', wrong: 'ST' }, // overtake the second round
    { id: 'p02', line: ['SA', 'S3'], right: 'HA', wrong: 'SK' }, // two rounds of trumps leave dummy none
    { id: 'p03', line: [], right: 'HA', wrong: 'S5' }, // pitch before touching trumps
    { id: 'p04', line: ['H7'], right: 'SK', wrong: 'S3' }, // ruff high
    { id: 'p05', line: ['H7'], right: 'H8', wrong: 'HA' }, // hold up
    { id: 'p07', line: ['H3', 'HA'], right: 'DJ', wrong: 'DA' }, // run the ♦J from dummy
    { id: 'p07', line: ['D2'], wrong: 'DJ' }, // the finesse the other way loses to the danger hand
    { id: 'p08', line: [], right: 'H3', wrong: 'D7' }, // strip first, no finesse
    { id: 'p10', line: [], right: 'D3', wrong: 'SA' }, // to dummy, not trumps
  ]

  /** The state after these right cards with the stored answers; fails if one is not right */
  function follow(puzzle: Puzzle, cards: readonly Card[]) {
    let state = puzzleState(puzzle.source, [...puzzle.source.opening, ...splitCards(puzzle.solution.start)])
    let node = 0
    for (const card of cards) {
      const edge = puzzleEdges(puzzle.solution, node).find((e) => e.card === card)
      if (!edge) throw new Error(`${puzzle.source.id}: ${card} is not right here`)
      state = applyPlay(state, card)
      for (const reply of edge.replies) state = applyPlay(state, reply)
      node = edge.next
    }
    return { state, node }
  }

  it.each(LESSONS.map((l) => [l.id, l.line.join(' '), l] as const))('%s after [%s]: the lesson holds', (_id, _line, lesson) => {
    const puzzle = PUZZLES.find((p) => p.source.id === lesson.id)!
    const { state, node } = follow(puzzle, lesson.line)
    const right = puzzleEdges(puzzle.solution, node).map((e) => e.card)
    if (lesson.right) expect(right).toContain(lesson.right)
    expect(legalPlays(state)).toContain(lesson.wrong)
    expect(right).not.toContain(lesson.wrong)
  })

  it('p09: one winner short, and the squeeze works however West discards', () => {
    const puzzle = PUZZLES.find((p) => p.source.id === 'p09')!
    const need = puzzleNeed(puzzle.source)
    let state = puzzleState(puzzle.source, [])
    for (const card of ['SA', 'S7', 'S2', 'S8', 'SK']) state = applyPlay(state, card)
    expect(legalPlays(state)).toEqual(['HK', 'HQ', 'DK', 'DQ'])
    for (const west of legalPlays(state)) {
      // West has to let go of a heart or a diamond, and each is a trick for declarer
      let after = applyPlay(state, west)
      after = applyPlay(after, 'S3')
      after = applyPlay(after, 'S9')
      expect(canMake(after, need - after.won), `West ${west}`).toBe(true)
    }
    // Leading a heart at once, finesse or not, loses the contract: dummy's entry is needed last
    const right = puzzleEdges(puzzle.solution, 0).map((edge) => edge.card)
    expect(right).toContain('SA')
    expect(right).not.toContain('H3')
    const start = puzzleState(puzzle.source, [])
    expect(canMake(start, need)).toBe(true)
    const topTricks = ['SA', 'SK', 'HA', 'DA']
    expect(topTricks.every((card) => [...start.hands.S, ...start.hands.N].includes(card))).toBe(true)
    expect(need).toBe(topTricks.length + 1)
  })

  it('no hand reaches the browser\'s bundle: nothing in src/ imports the puzzles', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name)
        return statSync(path).isDirectory() ? files(path) : [path]
      })
    for (const file of files('src')) {
      const text = readFileSync(file, 'utf8')
      expect(/puzzle-sets|puzzle-solver/.test(text), file).toBe(false)
    }
    for (const file of files('worker')) expect(/puzzle-solver/.test(readFileSync(file, 'utf8')), file).toBe(false)
  })
})
