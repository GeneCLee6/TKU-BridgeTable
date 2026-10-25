/** Whether the viewer asked their system for less motion; the table then skips its animations */
export function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * The pace of the table's animations, in one place. Tuned 1.3x faster at the club president's
 * request (was glide 1300, collect 1300, deal 520, deal hold 450, last-trick step 450, card sound
 * 0.95 s), matching the server's robot delays in worker/table-service.ts: a card's glide must end
 * before a robot plays the next one (ROBOT_DELAY.card).
 */
export const PACE = {
  /** A played card takes this long to reach the middle */
  glideMs: 1000,
  /** A finished trick takes this long to go to its winner */
  collectMs: 1000,
  /** The cards of a new deal slide out to the hands */
  dealMs: 400,
  /** The hands stay hidden this much longer after the deal slides out */
  dealHoldMs: 350,
  /** Pause between the cards when the last trick is played again */
  lastTrickStepMs: 350,
  /** Seconds after a card leaves the hand that its sound lands */
  landsAfterS: 0.73,
} as const
