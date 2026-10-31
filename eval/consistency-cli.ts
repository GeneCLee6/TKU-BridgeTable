import { writeFileSync } from 'node:fs'
import { readArgs } from './config.ts'
import { consistencyCheck, consistencyReport } from './consistency.ts'
import type { RobotKind } from '../shared/protocol.ts'

/**
 * The consistency check (X2, eval/README.md): calls explained as something the player's earlier
 * calls ruled out, and explanations wider than what the player had shown (Y2).
 *
 *   npm run consistency -- [--system tku|gib] [--deals 2000] [--seed s] [--top 30] [--json out.json]
 */

const args = readArgs(process.argv.slice(2))
const system = args.get('system') as RobotKind | undefined
const started = performance.now()
const result = consistencyCheck({
  systems: system ? [system] : undefined,
  deals: Number(args.get('deals') ?? 2000),
  seed: args.get('seed'),
})
console.log(consistencyReport(result, Number(args.get('top') ?? 30)))
console.log(`\n${((performance.now() - started) / 1000).toFixed(1)} s`)
const json = args.get('json')
if (json) writeFileSync(json, JSON.stringify({ conflicts: result.conflicts, wide: result.wide }, null, 1))
