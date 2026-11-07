import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isRobotKind, ROBOT_KINDS, type RobotKind } from '../shared/protocol.ts'
import { ruleBrain } from '../shared/robot/brain.ts'
import { compareFiles, compareReport, GIB_NAMES, linFiles, summarize, type DecisionFilter, type PlayRole } from './bbo-compare.ts'
import { readArgs } from './config.ts'
import { loadSolver } from './sim/dds.ts'

/**
 * The BBO comparison on the command line (`e6-t29`, eval/README.md):
 *
 *   npm run bbo-compare -- my-boards.lin --system 2over1
 *   npm run bbo-compare -- lin-folder --gib --side defence --top 50
 *
 * Runs on the developer's computer only. The report goes to eval/sim/data/, which is not committed:
 * it holds the names and the deals of the boards in the files.
 */

const USAGE = 'usage: npm run bbo-compare -- <file or folder>... [--system 2over1|tku|sayc|precision] [--player a,b] [--gib] [--gib-pattern regex] [--side declarer|defence] [--only bidding|play] [--top n] [--no-dd] [--report file] [--json file]'
const KNOWN = new Set(['system', 'player', 'gib', 'gib-pattern', 'side', 'only', 'top', 'no-dd', 'report', 'json'])
const SYSTEM_NAMES: Record<string, RobotKind> = { '2over1': 'gib', '2/1': 'gib' }

function systemOf(name: string): RobotKind {
  const kind = SYSTEM_NAMES[name] ?? name
  if (!isRobotKind(kind)) throw new Error(`--system is 2over1 or one of ${ROBOT_KINDS.join(', ')}, not "${name}"`)
  return kind
}

function filterOf(args: Map<string, string>): DecisionFilter {
  const filter: DecisionFilter = {}
  const player = args.get('player')
  if (player) filter.players = new Set(player.split(',').map((name) => name.trim().toLowerCase()))
  const pattern = args.get('gib-pattern')
  if (pattern) filter.names = new RegExp(pattern, 'i')
  else if (args.has('gib')) filter.names = GIB_NAMES
  const side = args.get('side')
  if (side) {
    if (side !== 'declarer' && side !== 'defence') throw new Error(`--side is declarer or defence, not "${side}"`)
    filter.side = side as PlayRole
  }
  const only = args.get('only')
  if (only) {
    if (only !== 'bidding' && only !== 'play') throw new Error(`--only is bidding or play, not "${only}"`)
    if (only === 'bidding' && side) throw new Error('--side is about the cards: it does not go with --only bidding')
    filter.only = only
  }
  return filter
}

async function main() {
  const argv = process.argv.slice(2)
  const first = argv.findIndex((arg) => arg.startsWith('--'))
  const paths = first < 0 ? argv : argv.slice(0, first)
  const args = readArgs(first < 0 ? [] : argv.slice(first))
  for (const name of args.keys()) if (!KNOWN.has(name)) throw new Error(`unknown option --${name}\n${USAGE}`)
  if (!paths.length) throw new Error(USAGE)
  const kind = systemOf(args.get('system') ?? '2over1')
  const filter = filterOf(args)
  const top = Number(args.get('top') ?? 25)
  if (!Number.isInteger(top) || top < 1) throw new Error(`--top is a positive number, not "${args.get('top')}"`)
  const files = linFiles(paths)
  if (!files.length) throw new Error(`no LIN files under ${paths.join(', ')}`)

  const dd = !args.has('no-dd')
  const run = await compareFiles(files, { kind, brain: ruleBrain, solver: dd ? await loadSolver() : null, filter }, (boards) => {
    if (boards % 20 === 0) process.stderr.write(`${boards} boards…\n`)
  })

  if (run.unreadable.length === files.length) throw new Error(`could not read any file: ${run.unreadable[0].error}`)

  const filterText = args.size ? [...args].filter(([name]) => name !== 'report' && name !== 'json' && name !== 'top').map(([name, value]) => (value === 'true' ? `--${name}` : `--${name} ${value}`)).join(' ') || '全部決策' : '全部決策'
  const report = compareReport(run, { top, filterText, dd })
  const reportFile = args.get('report') ?? `eval/sim/data/bbo-compare-${kind}.md`
  mkdirSync(dirname(reportFile), { recursive: true })
  writeFileSync(reportFile, report)
  const jsonFile = args.get('json')
  if (jsonFile) {
    mkdirSync(dirname(jsonFile), { recursive: true })
    writeFileSync(jsonFile, JSON.stringify({ ...run, summary: summarize(run) }, null, 2))
  }

  const { bidding, play, boards } = summarize(run)
  console.log(`${boards} boards compared, ${run.skipped.length} skipped, ${run.duplicates} repeated, ${run.unreadable.length} files unreadable.`)
  console.log(`Calls: ${bidding.different} of ${bidding.decisions} differ. Cards: ${play.different} of ${play.decisions} differ, ${play.tricks} DD tricks (TKB minus played).`)
  console.log(`Report: ${reportFile}${jsonFile ? `, ${jsonFile}` : ''}`)
  if ((filter.names || filter.players) && bidding.decisions + play.decisions === 0) {
    console.log('No decision matched the player filter: the report lists no players. Try --gib-pattern, or run without a filter to see the names in the files.')
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(2)
})
