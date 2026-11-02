/**
 * The club's playing strength (實力評分, `e9-t07`, AC-9.3, ARCHITECTURE.md §5.20): Glicko-2 as Mark
 * Glickman describes it ("Example of the Glicko-2 system", 2013), one rating per member. Each
 * finished event is one rating period: every member in it plays one game against every other side
 * (another player, pair or team), won, drawn or lost by their places. Pure functions only.
 */

export interface Rating {
  /** On the Glicko scale (1500 is the start) */
  rating: number
  /** Rating deviation: how unsure the rating is, also on the Glicko scale */
  rd: number
  /** Volatility (σ) */
  vol: number
}

/** Glickman's suggested start: 1500, RD 350, σ 0.06 */
export const INITIAL_RATING: Rating = { rating: 1500, rd: 350, vol: 0.06 }

/** τ, how much the volatility may change; Glickman suggests 0.3–1.2, the paper's example uses 0.5 */
export const TAU = 0.5

/** A rating with an RD above this is shown as provisional (暫定) */
export const PROVISIONAL_RD = 110

/** RD never grows past the start's */
export const MAX_RD = INITIAL_RATING.rd

/**
 * The robot's fixed strength (AC-9.3: 機器人等級為固定對手強度). There is one robot, TKB
 * (社長 2026-10-24); it counts as an established 1500 player wherever it fills a seat of a side (a
 * team match or a pair). Its rating never changes. TKB Adv gets its own when it comes
 */
export const ROBOT_RATINGS = { tkb: { rating: 1500, rd: 50, vol: 0.06 } } as const satisfies Record<string, Rating>

export interface Game {
  opponent: { rating: number; rd: number }
  /** 1 a win, 0.5 a draw, 0 a loss */
  score: number
  /** How much the game counts, 1 by default (an event's many pairings share a weight, `eventGames`) */
  weight?: number
}

const SCALE = 173.7178
const EPSILON = 0.000001

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI))
const expected = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)))

/** The new volatility (step 5 of the paper, the Illinois algorithm) */
function newVolatility(phi: number, vol: number, delta: number, v: number, tau: number): number {
  const a = Math.log(vol * vol)
  const f = (x: number) => {
    const ex = Math.exp(x)
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (tau * tau)
  }
  let A = a
  let B: number
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v)
  else {
    let k = 1
    while (f(a - k * tau) < 0) k++
    B = a - k * tau
  }
  let fA = f(A)
  let fB = f(B)
  for (let i = 0; Math.abs(B - A) > EPSILON && i < 100; i++) {
    const C = A + ((A - B) * fA) / (fB - fA)
    const fC = f(C)
    if (fC * fB <= 0) {
      A = B
      fA = fB
    } else fA /= 2
    B = C
    fB = fC
  }
  return Math.exp(A / 2)
}

/**
 * One rating period: the player's rating after `games` (all played against the opponents' ratings
 * as they were before the period). No games: only the RD grows, as for a period sat out
 */
export function glicko2(player: Rating, games: readonly Game[], tau = TAU): Rating {
  const mu = (player.rating - 1500) / SCALE
  const phi = player.rd / SCALE
  if (!games.length) return { ...player, rd: Math.min(MAX_RD, Math.sqrt(phi * phi + player.vol * player.vol) * SCALE) }
  let vInverse = 0
  let sum = 0
  for (const game of games) {
    const w = game.weight ?? 1
    const muJ = (game.opponent.rating - 1500) / SCALE
    const phiJ = game.opponent.rd / SCALE
    const e = expected(mu, muJ, phiJ)
    vInverse += w * g(phiJ) ** 2 * e * (1 - e)
    sum += w * g(phiJ) * (game.score - e)
  }
  if (vInverse <= 0) return player
  const v = 1 / vInverse
  const delta = v * sum
  const vol = newVolatility(phi, player.vol, delta, v, tau)
  const phiStar = Math.sqrt(phi * phi + vol * vol)
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v)
  const muNew = mu + phiNew * phiNew * sum
  return { rating: muNew * SCALE + 1500, rd: Math.min(MAX_RD, phiNew * SCALE), vol }
}

/** Days without an event that count as one period sat out: the RD grows once for each */
export const IDLE_PERIOD_DAYS = 30

/** A rating after `periods` periods sat out (Glicko-2's step 6 with no games, repeated) */
export function idle(player: Rating, periods: number): Rating {
  let rd = player.rd
  for (let i = 0; i < periods && rd < MAX_RD; i++) rd = Math.min(MAX_RD, Math.sqrt(rd * rd + (player.vol * SCALE) ** 2))
  return { ...player, rd }
}

/** One side of an event: a player, a pair or a team, with its members and robots, and its place */
export interface RatedSide {
  /** The members (robots left out) */
  userIds: readonly string[]
  /** Seats robots filled; they count at the robot's fixed rating */
  robots: number
  /** 1 is first; equal places draw */
  rank: number
}

/**
 * An event's games share at most this many games' weight per member: a daily event of 30 players
 * would otherwise count as 29 games and settle a new member's rating in one day
 */
export const EVENT_WEIGHT = 3

/** A side's strength: its members' and robots' ratings averaged, the RDs as a root mean square */
export function sideRating(side: RatedSide, ratingOf: (userId: string) => Rating): { rating: number; rd: number } {
  const all: { rating: number; rd: number }[] = [
    ...side.userIds.map(ratingOf),
    ...Array.from({ length: side.robots }, () => ROBOT_RATINGS.tkb),
  ]
  if (!all.length) return { rating: ROBOT_RATINGS.tkb.rating, rd: ROBOT_RATINGS.tkb.rd }
  const rating = all.reduce((s, r) => s + r.rating, 0) / all.length
  const rd = Math.sqrt(all.reduce((s, r) => s + r.rd * r.rd, 0) / all.length)
  return { rating, rd }
}

/**
 * Each member's games in an event: one against every other side, scored by the places, the weight
 * shared so that one event counts as at most `EVENT_WEIGHT` games. Fewer than two sides: no games
 */
export function eventGames(sides: readonly RatedSide[], ratingOf: (userId: string) => Rating): Map<string, Game[]> {
  const games = new Map<string, Game[]>()
  if (sides.length < 2) return games
  const strength = sides.map((s) => sideRating(s, ratingOf))
  const weight = Math.min(1, EVENT_WEIGHT / (sides.length - 1))
  for (const [i, side] of sides.entries()) {
    const list: Game[] = []
    for (const [j, other] of sides.entries()) {
      if (i === j) continue
      const score = side.rank < other.rank ? 1 : side.rank === other.rank ? 0.5 : 0
      list.push({ opponent: strength[j], score, weight })
    }
    for (const userId of side.userIds) games.set(userId, list)
  }
  return games
}

/** Whether a rating is still provisional (暫定) */
export const isProvisional = (r: Pick<Rating, 'rd'>) => r.rd > PROVISIONAL_RD

/** One point of a member's rating history, as the profile's trend shows it */
export interface RatingPoint {
  at: number
  rating: number
  rd: number
  eventId: string
  kind: string
}

/** A member's rating as `GET /api/ratings/:userId` sends it */
export interface RatingView {
  userId: string
  /** Null before their first rated event */
  rating: number | null
  rd: number | null
  provisional: boolean
  events: number
  /** The member chose not to show it (only they get it then) */
  hidden: boolean
  /** Oldest first, at most `RATING_HISTORY` */
  history: RatingPoint[]
}

export const RATING_HISTORY = 200
