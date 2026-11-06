import type { PuzzleSolution, PuzzleSource } from '../puzzles.ts'
import { FIRST_SET } from './first-set.ts'
import { SOLUTIONS } from './solutions.generated.ts'

/**
 * The puzzles (`e10-t13`, ARCHITECTURE.md §5.11). Only the Worker and the script import this folder,
 * so a puzzle's hands stay out of the browser's bundle (a test checks that). Everything here is a
 * draft: a club's admin publishes each one (`worker/puzzles.ts`). To add a puzzle, write it in a set
 * and run `npm run puzzles`, which solves it with `shared/robot/dd.ts`, refuses it if it cannot solve
 * it completely, and writes `solutions.generated.ts`.
 */

export interface Puzzle {
  source: PuzzleSource
  solution: PuzzleSolution
}

export const PUZZLE_SOURCES: readonly PuzzleSource[] = FIRST_SET

const byId = new Map(SOLUTIONS.map((solution) => [solution.id, solution]))

/** A puzzle without a solution is left out; the test on the generated file keeps that from happening */
export const PUZZLES: readonly Puzzle[] = PUZZLE_SOURCES.flatMap((source) => {
  const solution = byId.get(source.id)
  return solution ? [{ source, solution }] : []
})
