import { DEFAULT_ROBOT_SPEED, type RobotSpeed } from '../../shared/protocol.ts'

/** Whether the viewer asked their system for less motion; the table then skips its animations */
export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/** The pace of the table's animations */
export interface Pace {
  /** A played card takes this long to reach the middle */
  glideMs: number
  /** A finished trick takes this long to go to its winner */
  collectMs: number
  /** The cards of a new deal slide out to the hands */
  dealMs: number
  /** The hands stay hidden this much longer after the deal slides out */
  dealHoldMs: number
  /** Pause between the cards when the last trick is played again */
  lastTrickStepMs: number
  /** Seconds after a card leaves the hand that its sound lands (about three quarters of the glide) */
  landsAfterS: number
}

const STILL = { dealMs: 400, dealHoldMs: 350, lastTrickStepMs: 350 } as const

/**
 * The table's animations at each robot speed (出牌速度; the table's own, `TableView.robotSpeed`),
 * matching the server's robot delays (`ROBOT_PACE` in shared/protocol.ts): a card's glide must end
 * before a robot plays the next one (`ROBOT_PACE[speed].card`). 較慢 is the pace before (#110)
 */
export const PACES: Record<RobotSpeed, Pace> = {
  veryFast: { glideMs: 300, collectMs: 350, landsAfterS: 0.22, ...STILL },
  fast: { glideMs: 550, collectMs: 600, landsAfterS: 0.4, ...STILL },
  slower: { glideMs: 1000, collectMs: 1000, landsAfterS: 0.73, ...STILL },
}

/** The animations for a table's robot speed; the default speed's when it is not known */
export const paceOf = (speed: RobotSpeed | undefined): Pace => PACES[speed ?? DEFAULT_ROBOT_SPEED]

/** The animations at the default speed, for what is not at a table (record replays, the last trick again) */
export const PACE: Pace = PACES[DEFAULT_ROBOT_SPEED]
