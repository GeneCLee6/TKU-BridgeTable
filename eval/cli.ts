import { writeFileSync } from 'node:fs'
import { parseConfig, readArgs, setSize } from './config.ts'
import { EVAL_SEED, evalBoards } from './deals.ts'
import { playMatch } from './match.ts'
import { matchReport } from './report.ts'
import { summarize } from './stats.ts'

/**
 * The evaluation command line (e6-t15, eval/README.md):
 *
 *   npm run eval -- --a tku --b gib [--set quick|full|N] [--from 1] [--seed s] [--json out.json]
 */

const USAGE = 'usage: npm run eval -- --a <tku|gib[@dir][,play=dir]> --b <…> [--set quick|full|N] [--from N] [--seed s] [--json file]'

async function main() {
  const args = readArgs(process.argv.slice(2))
  if (args.has('help')) {
    console.log(USAGE)
    return
  }
  const a = await parseConfig(args.get('a') ?? 'tku')
  const b = await parseConfig(args.get('b') ?? 'tku')
  const seed = args.get('seed') ?? EVAL_SEED
  const from = Number(args.get('from') ?? 1)
  const count = setSize(args.get('set') ?? 'quick')
  const boards = evalBoards(count, seed, from)

  const started = performance.now()
  const outcomes = await playMatch({
    a,
    b,
    boards,
    onBoard: (_, done) => {
      if (process.stderr.isTTY && done % 50 === 0) process.stderr.write(`\r${done}/${count} boards`)
    },
  })
  if (process.stderr.isTTY) process.stderr.write('\r')
  const seconds = (performance.now() - started) / 1000
  const summary = summarize(outcomes)
  console.log(matchReport({ a: a.name, b: b.name, boards: `boards ${from}–${from + count - 1} of ${seed}`, seconds }, summary))
  const json = args.get('json')
  if (json) writeFileSync(json, JSON.stringify({ a: a.name, b: b.name, seed, from, summary, outcomes }, null, 2))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  console.error(USAGE)
  process.exit(2)
})
