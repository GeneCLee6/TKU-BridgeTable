import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRobotKind } from '../shared/protocol.ts'
import type { RobotBrain } from '../shared/robot/brain.ts'
import { FULL_SET_SIZE, QUICK_SET_SIZE } from './deals.ts'
import type { RobotConfig } from './match.ts'

/**
 * Reading the command line's robot configurations (Node only). A configuration is the system TKB
 * bids, `tku` or `gib`; `@dir` takes the rule robot from another checkout's `shared/robot` (such
 * as main's, checked out in `base/`), and `,play=dir` only its card play:
 *
 *   tku            this checkout's TKB in the club's system
 *   gib@base       TKB in 2/1 from the checkout in ./base
 *   tku,play=base  this checkout's auction, the play of ./base (same contracts, only the play differs)
 */

const brains = new Map<string, Promise<RobotBrain>>()

/** The rule robot of the checkout in `dir` (its `shared/robot/brain.ts`) */
export function brainFrom(dir: string): Promise<RobotBrain> {
  const file = resolve(dir, 'shared/robot/brain.ts')
  let brain = brains.get(file)
  if (!brain) {
    brain = import(pathToFileURL(file).href).then((module: { ruleBrain?: RobotBrain }) => {
      if (!module.ruleBrain) throw new Error(`${file} has no ruleBrain`)
      return module.ruleBrain
    })
    brains.set(file, brain)
  }
  return brain
}

export async function parseConfig(spec: string): Promise<RobotConfig> {
  const [main, ...options] = spec.split(',')
  const [robot, dir] = main.split('@')
  if (!isRobotKind(robot)) throw new Error(`unknown robot "${robot}" in "${spec}" (tku or gib)`)
  const config: RobotConfig = { name: spec, kind: robot }
  if (dir) config.brain = await brainFrom(dir)
  for (const option of options) {
    const [key, value] = option.split('=')
    if (key !== 'play' || !value) throw new Error(`unknown option "${option}" in "${spec}" (play=dir)`)
    config.play = await brainFrom(value)
  }
  return config
}

/** How many boards `quick`, `full` or a number means */
export function setSize(name: string): number {
  if (name === 'quick') return QUICK_SET_SIZE
  if (name === 'full') return FULL_SET_SIZE
  const n = Number(name)
  if (!Number.isInteger(n) || n < 1) throw new Error(`--set is quick, full or a number of boards, not "${name}"`)
  return n
}

/** `--name value` pairs from the command line */
export function readArgs(argv: readonly string[]): Map<string, string> {
  const args = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args.set(arg.slice(2), 'true')
    else {
      args.set(arg.slice(2), next)
      i++
    }
  }
  return args
}
