import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { solvePuzzle } from '../shared/puzzle-solver.ts'
import { FIRST_SET } from '../shared/puzzle-sets/first-set.ts'
import type { PuzzleSolution } from '../shared/puzzles.ts'

/**
 * `npm run puzzles` (`e10-t13`): solves every puzzle in `shared/puzzle-sets/` with `shared/robot/dd.ts`
 * and writes `solutions.generated.ts`. It runs when a puzzle is written, never in a Worker request.
 * One puzzle it cannot solve completely, or that would store too much, and it writes nothing and
 * exits with an error. `npm run puzzles -- --check` only says whether the file is up to date.
 */

const OUTPUT = fileURLToPath(new URL('../shared/puzzle-sets/solutions.generated.ts', import.meta.url))
const check = process.argv.includes('--check')

const solutions: PuzzleSolution[] = []
let refused = 0
for (const source of FIRST_SET) {
  const started = Date.now()
  const result = solvePuzzle(source)
  if ('refused' in result) {
    console.error(`${source.id}: REFUSED: ${result.refused}`)
    refused++
    continue
  }
  const { solution, report } = result
  solutions.push(solution)
  console.log(`${source.id}  level ${source.level}  ${solution.size} decisions, ${solution.nodes.length} characters, ${report.questions} questions, ${Date.now() - started} ms`)
  console.log(`  line ${solution.line}`)
  for (const { seat, card, wrong } of report.critical) console.log(`  ${seat} ${card}, not ${wrong.join(' ')}`)
}
if (refused > 0) {
  console.error(`${refused} refused; nothing written`)
  process.exit(1)
}

const text = `import type { PuzzleSolution } from '../puzzles.ts'

/** Written by \`npm run puzzles\` from the sets in this folder (shared/puzzle-solver.ts); do not edit. */
export const SOLUTIONS: readonly PuzzleSolution[] = ${JSON.stringify(solutions, null, 2)}
`
if (check) {
  if (readFileSync(OUTPUT, 'utf8').replace(/\r\n/g, '\n') !== text) {
    console.error('solutions.generated.ts is out of date: run npm run puzzles')
    process.exit(1)
  }
  console.log('up to date')
} else {
  writeFileSync(OUTPUT, text)
  console.log(`wrote ${solutions.length} solutions`)
}
