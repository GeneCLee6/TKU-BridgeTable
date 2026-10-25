import { appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ruleBrain } from '../shared/robot/brain.ts'
import { brainFrom, readArgs } from './config.ts'
import { bankProblems, loadBank, QUIZ_DIR, quizMisses, quizRegressions, quizReport, runQuiz, scoreQuiz } from './quiz.ts'

/**
 * The bidding question bank on the command line (e5-t23, eval/README.md):
 *
 *   npm run quiz                     this checkout's TKB on every question, with its misses
 *   npm run quiz -- --base base      the CI ratchet: the base checkout's TKB on the same questions;
 *                                    exit 1 when any category has fewer correct answers than the base's
 *
 * The questions are always this checkout's (`tests/bidding-quiz`), so adding questions never fails.
 * In GitHub Actions the report also goes to the job summary.
 */

async function main() {
  const args = readArgs(process.argv.slice(2))
  const files = loadBank(QUIZ_DIR)
  const problems = bankProblems(files)
  if (problems.length) throw new Error(`the question bank has problems:\n${problems.join('\n')}`)

  const mine = await runQuiz(ruleBrain, files)
  const scores = scoreQuiz(mine)
  const baseDir = args.get('base')
  let report: string
  let failed = false
  if (baseDir) {
    if (!existsSync(resolve(baseDir, 'shared/robot/brain.ts'))) throw new Error('--base must be a checkout with shared/robot/brain.ts')
    const baseScores = scoreQuiz(await runQuiz(await brainFrom(baseDir), files))
    const worse = quizRegressions(scores, baseScores)
    failed = worse.length > 0
    report = [
      `### Bidding question bank: ${failed ? `❌ ${worse.map((r) => `${r.system}/${r.category}`).join(', ')} answered worse than base` : '✅ no category worse than base'}`,
      '',
      `This branch's TKB and the base's answer the same ${mine.length} questions (\`${QUIZ_DIR}\`). Correct means the book's call or an accepted one; a category fails when this branch gets fewer right than the base (eval/README.md).`,
      '',
      quizReport(scores, baseScores),
    ].join('\n')
  } else report = `### Bidding question bank\n\n${quizReport(scores)}`
  report += `\n\n<details><summary>This branch's misses</summary>\n\n${quizMisses(mine)}\n\n</details>\n`
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  if (failed) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
})
