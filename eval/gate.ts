import { appendFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseConfig, readArgs, setSize } from './config.ts'
import { EVAL_SEED, evalBoards } from './deals.ts'
import { playMatch } from './match.ts'
import { matchReport } from './report.ts'
import { GATE_ERRORS, GATE_FLOOR, regressed, summarize } from './stats.ts'

/**
 * The CI gate (e6-t17, eval/README.md): this checkout's robots (A) against the robots of the
 * checkout in `--base` (B, main in CI) on the quick set, for both kinds at 大專 and 初學者. Fails
 * (exit 1) when any match regressed (`regressed` in stats.ts). The report goes to stdout and, in
 * GitHub Actions, to the job summary.
 *
 *   npm run eval:gate -- --base base [--set quick|full|N]
 */

const MATCHES = ['tku:college', 'gib:college', 'tku:beginner', 'gib:beginner']

async function main() {
  const args = readArgs(process.argv.slice(2))
  const base = args.get('base')
  if (!base || !existsSync(resolve(base, 'shared/robot/brain.ts'))) throw new Error('--base must be a checkout with shared/robot/brain.ts')
  const count = setSize(args.get('set') ?? 'quick')
  const boards = evalBoards(count, EVAL_SEED)

  const started = performance.now()
  const sections: string[] = []
  let failed = 0
  for (const robot of MATCHES) {
    const a = await parseConfig(robot)
    const b = await parseConfig(`${robot}@${base}`)
    const t = performance.now()
    const summary = summarize(await playMatch({ a, b, boards }))
    const bad = regressed(summary)
    if (bad) failed++
    const heading = { a: `${robot} (this branch)`, b: `${robot} (base)`, boards: `boards 1–${count} of ${EVAL_SEED}`, seconds: (performance.now() - t) / 1000 }
    sections.push(matchReport(heading, summary, bad ? '❌ worse than base' : '✅ pass'))
  }
  const seconds = (performance.now() - started) / 1000
  const report = [
    `### Robot evaluation gate: ${failed ? `❌ ${failed} of ${MATCHES.length} matches regressed` : '✅ no regression'}`,
    '',
    `This branch's robots against the base's on the quick set, ${seconds.toFixed(1)} s. A match fails when this branch is worse by more than ${GATE_ERRORS} standard errors **and** by more than ${GATE_FLOOR} IMP/board (eval/README.md).`,
    '',
    ...sections,
  ].join('\n')
  console.log(report)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`)
  if (failed) process.exitCode = 1
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
})
