import { DEFAULT_ROBOT_LEVEL, type RobotLevel } from '../protocol.ts'

/**
 * What each robot level does (e6-t18, ROBOT.md §7, docs/PRD/e6-robot-play-levels-evaluation.md
 * 「等級設計」). Pure data: the system engine reads `system`, the card play `inference` and
 * `signals`, the rule brain `errorRate` (`mistakes.ts`); `play` and `thinkMs` are kept for the
 * stronger brains after the paid plan (DDS endgames, simulations; the service's think limit is 2 s).
 */

/** How much of the system a robot bids: rules with a `minLevel` above it are left out */
export const SYSTEM_DEPTHS = ['beginner', 'college', 'open', 'master'] as const
export type SystemDepth = (typeof SYSTEM_DEPTHS)[number]

/** How the robot chooses its cards: rules; rules with a double-dummy endgame; single-dummy simulations */
export type PlayStyle = 'rules' | 'rulesEndgame' | 'simulation'

export interface RobotParams {
  /** The rules the robot bids with: those with no `minLevel` or one at most this */
  system: SystemDepth
  /** Reads the auction and counts the cards during the play (`reading.ts`); off, it plays from its own cards only */
  inference: boolean
  /** Gives and reads the defensive signals (attitude, count, suit preference); off, it follows low and discards from length */
  signals: boolean
  play: PlayStyle
  /** How often it picks a worse action on purpose, 0–1 (`e6-t21`) */
  errorRate: number
  /** The most it may think per action, in milliseconds (`e6-t11`) */
  thinkMs: number
}

/**
 * The four levels. 大專 is the rule robot as it was before levels: every rule, reading and signals.
 * 公開組 plays the same until the valuation and endgame work lands (e6-t41, e6-t42, `dd.ts`);
 * 橋士組 needs DDS on the server (ARCHITECTURE.md §5.1.1), so it is not offered yet.
 */
export const LEVEL_PARAMS: Record<Exclude<RobotLevel, 'custom'>, RobotParams> = {
  beginner: { system: 'beginner', inference: false, signals: false, play: 'rules', errorRate: 0.15, thinkMs: 0 },
  // 大專 and 公開組 make no deliberate mistakes until the calibration (e6-t22) says how many they
  // need: 大專 stays the robot it was, and 公開組 must not err more than 大專
  college: { system: 'college', inference: true, signals: true, play: 'rules', errorRate: 0, thinkMs: 0 },
  open: { system: 'open', inference: true, signals: true, play: 'rulesEndgame', errorRate: 0, thinkMs: 1000 },
  master: { system: 'master', inference: true, signals: true, play: 'simulation', errorRate: 0, thinkMs: 2000 },
}

/** A level's parameters; 自訂 starts from 大專 with the teacher's changes */
export function paramsOf(level: RobotLevel = DEFAULT_ROBOT_LEVEL, custom: Partial<RobotParams> = {}): RobotParams {
  return level === 'custom' ? { ...LEVEL_PARAMS.college, ...custom } : LEVEL_PARAMS[level]
}

/** Whether a robot bidding at `depth` uses a rule marked `minLevel` */
export const usesRule = (depth: SystemDepth, minLevel: SystemDepth | undefined) =>
  !minLevel || SYSTEM_DEPTHS.indexOf(minLevel) <= SYSTEM_DEPTHS.indexOf(depth)
