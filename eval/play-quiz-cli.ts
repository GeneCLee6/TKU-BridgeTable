import { appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ruleBrain } from '../shared/robot/brain.ts'
import { brainFrom, readArgs } from './config.ts'
import { loadPlayBank, PLAY_QUIZ_DIR, playBankProblems, playQuizMisses, runPlayQuiz, scorePlayQuiz } from './play-quiz.ts'
import { quizRegressions, quizReport } from './quiz.ts'

/**
 * The card-play question bank on the command line (eval/README.md):
 *
 *   npm run quiz:play                 this checkout's TKB on every position, with its misses
 *   npm run quiz:play -- --base base  the CI ratchet: the base checkout's TKB on the same positions;
 *                                     exit 1 when any category has fewer correct answers than the base's
 */

async function main() {
  const args = readArgs(process.argv.slice(2))
  const files = loadPlayBank(PLAY_QUIZ_DIR)
  const problems = playBankProblems(files)
  if (problems.length) throw new Error(`the play question bank has problems:\n${problems.join('\n')}`)

  const mine = await runPlayQuiz(ruleBrain, files)
  const scores = scorePlayQuiz(mine)
  const baseDir = args.get('base')
  let report: string
  let failed = false
  if (baseDir) {
    if (!existsSync(resolve(baseDir, 'shared/robot/brain.ts'))) throw new Error('--base must be a checkout with shared/robot/brain.ts')
    const baseScores = scorePlayQuiz(await runPlayQuiz(await brainFrom(baseDir), files))
    const worse = quizRegressions(scores, baseScores)
    failed = worse.length > 0
    report = [
      `### Card-play question bank: ${failed ? `❌ ${worse.map((r) => `${r.system}/${r.category}`).join(', ')} answered worse than base` : '✅ no category worse than base'}`,
      '',
      `This branch's TKB and the base's play the same ${mine.length} positions (\`${PLAY_QUIZ_DIR}\`). Correct means the book's card or an accepted one; a category fails when this branch gets fewer right than the base (eval/README.md).`,
      '',
      quizReport(scores, baseScores),
    ].join('\n')
  } else report = `### Card-play question bank\n\n${quizReport(scores)}`
  report += `\n\n<details><summary>This branch's misses</summary>\n\n${playQuizMisses(mine)}\n\n</details>\n`
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  if (failed) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
})
