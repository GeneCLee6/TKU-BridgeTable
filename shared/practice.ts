import type { RandomInt } from './board.ts'
import { isCard, isSeat, SEATS, sortHand, SUITS, type Card, type Seat } from './cards.ts'
import { DEAL_PRESET_IDS, DEAL_PRESETS, type DealPreset } from './deal-presets.ts'
import { conditionsProblem, isShape, type DealConditions, type Range, type SeatConditions } from './dealer.ts'
import { isRobotKind, type RobotKind } from './protocol.ts'

/**
 * The practice table (E10, `e10-t03`–`e10-t05`, ARCHITECTURE.md §5.11): one member in the South
 * seat with three TKB robots, boards dealt to conditions, a new deal whenever they like and no
 * limit on undo. Pure: the browser builds the settings, the club checks them with
 * `parsePracticeSettings` before it opens the table.
 */

/**
 * Where the boards come from: any deal, one of the club's presets (`deal-presets.ts`), the member's
 * own conditions, or a deal set (`set`, `e10-t16`)
 */
export type PracticeDeal = 'random' | DealPreset | 'custom' | 'set'
export const PRACTICE_DEALS: readonly PracticeDeal[] = ['random', ...DEAL_PRESET_IDS, 'custom', 'set']

/**
 * A deal set to practise (`e10-t16`), its boards one after the other: one of the club's practice
 * sets (`shared/practice-sets/`, by id), or boards of the member's favourites or of the featured
 * boards, by record id. The server deals them (only boards the member may see that are already
 * public, §4) and keeps the hands to itself
 */
export type PracticeSetChoice =
  | { source: 'practice'; id: string }
  | { source: 'favorites' | 'featured'; ids: string[] }

export const PRACTICE_SET_SOURCES = ['practice', 'favorites', 'featured'] as const
/** Boards a set of favourites or featured boards may have */
export const PRACTICE_SET_BOARDS_MAX = 50

export interface PracticeSettings {
  deal: PracticeDeal
  /** The member's own conditions, with `deal: 'custom'` only */
  conditions?: DealConditions
  /** The robots' system: TKB in the club's system or in 2/1 */
  robotKind: RobotKind
  /** Just Declare (`e10-t05`): the robots bid every board and only those North-South declares are kept */
  justDeclare: boolean
  /**
   * The bidding practice (`e10-t15`): the end of the auction ends the board. The four hands are laid
   * open with the final contract, nothing is played and nothing is recorded; the member deals the
   * next board or bids this one again (`rebid`). Old tables have none: false
   */
  biddingOnly?: boolean
  /**
   * The seats the member bids for (`e10-t15`): South, where they sit, and any others they chose;
   * TKB bids the rest. Seats besides South only with `biddingOnly` (nobody plays several hands yet).
   * Kept on the table as `Table.controllers` (`worker/views.ts`), the general seat control. Old
   * tables have none: South alone
   */
  seats?: Seat[]
  /** The deal set, with `deal: 'set'` only (`e10-t16`) */
  set?: PracticeSetChoice
  /**
   * 顯示四家 (`e10-t16`): the member sees all four hands while bidding and playing; they can turn it
   * on and off at the table (`showHands`). Only them: a watcher sees what any watcher does. Old
   * tables have none: hidden
   */
  showHands?: boolean
}

/** A member's saved practice settings (存成我的設定, `e10-t16`), named, at most PRACTICE_PRESETS_MAX */
export interface SavedPractice {
  id: string
  name: string
  settings: PracticeSettings
  savedAt: number
}

export const PRACTICE_PRESETS_MAX = 20
export const PRACTICE_PRESET_NAME_MAX = 30

/** A new practice table's settings; the dialog starts the robots in the member's system (`defaultRobotKind`) */
export const DEFAULT_PRACTICE_SETTINGS: PracticeSettings = { deal: 'random', robotKind: 'gib', justDeclare: false }

/** Where the member sits at a practice table */
export const PRACTICE_SEAT: Seat = 'S'

/** The seats besides South the member bids for at a practice table: TKB sits there, but the member bids for it */
export const controlledSeats = (settings: Pick<PracticeSettings, 'seats'>): Seat[] =>
  (settings.seats ?? []).filter((seat) => seat !== PRACTICE_SEAT)

/**
 * How many tries a practice deal gets (`dealer.ts` attempts), so a deal never takes long on the
 * server: about 10 µs each with `quickRandom`. The presets need a few on average; slam hands, the
 * hardest, about 350 (2,300 at most in 300 deals)
 */
export const PRACTICE_MAX_ATTEMPTS = 5_000

/**
 * A fast generator (mulberry32) seeded from `random` once per deal. The platform CSPRNG costs about
 * 1 ms per attempt of the dealer, too slow for conditions; practice deals need to be unpredictable,
 * not cryptographic
 */
export function quickRandom(random: RandomInt): RandomInt {
  let state = (random(0x10000) * 0x10000 + random(0x10000)) >>> 0
  return (n) => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000) * n)
  }
}

/** The conditions the boards are dealt to, as a list of alternatives; null for any deal */
export function practiceConditions(settings: Pick<PracticeSettings, 'deal' | 'conditions'>): readonly DealConditions[] | null {
  // A deal set's boards are its own (`worker/modes.ts`)
  if (settings.deal === 'random' || settings.deal === 'set') return null
  if (settings.deal === 'custom') return settings.conditions ? [settings.conditions] : null
  return DEAL_PRESETS[settings.deal]
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const onlyKeys = (value: Record<string, unknown>, keys: readonly string[]) => Object.keys(value).every((k) => keys.includes(k))

function parseRange(value: unknown): Range | null {
  if (!Array.isArray(value) || value.length !== 2 || !value.every((n) => Number.isInteger(n))) return null
  return [value[0] as number, value[1] as number]
}

function parseSeat(value: unknown): SeatConditions | null {
  if (!isObject(value) || !onlyKeys(value, ['hcp', 'lengths', 'balanced', 'shapes', 'longest', 'shortest', 'hand'])) return null
  const seat: { -readonly [K in keyof SeatConditions]: SeatConditions[K] } = {}
  for (const key of ['hcp', 'longest', 'shortest'] as const) {
    if (value[key] === undefined) continue
    const range = parseRange(value[key])
    if (!range) return null
    seat[key] = range
  }
  if (value.shapes !== undefined) {
    const shapes = value.shapes
    if (!Array.isArray(shapes) || !shapes.length || shapes.length > 39 || !shapes.every(isShape)) return null
    seat.shapes = [...new Set(shapes)]
  }
  if (value.hand !== undefined) {
    const hand = value.hand
    if (!Array.isArray(hand) || hand.length !== 13 || !hand.every(isCard) || new Set(hand).size !== 13) return null
    seat.hand = sortHand(hand as Card[])
  }
  if (value.lengths !== undefined) {
    const lengths = value.lengths
    if (!isObject(lengths) || !onlyKeys(lengths, SUITS)) return null
    const parsed: Partial<Record<(typeof SUITS)[number], Range>> = {}
    for (const suit of SUITS) {
      if (lengths[suit] === undefined) continue
      const range = parseRange(lengths[suit])
      if (!range) return null
      parsed[suit] = range
    }
    seat.lengths = parsed
  }
  if (value.balanced !== undefined) {
    if (typeof value.balanced !== 'boolean') return null
    seat.balanced = value.balanced
  }
  return seat
}

/**
 * A member's own deal conditions as sent from the browser: the conditions, or `problem` when they
 * are well formed but cannot be met (`conditionsProblem`: where they contradict each other), or
 * null when they are not well formed
 */
export function parseConditions(value: unknown): { conditions: DealConditions } | { problem: string } | null {
  if (!isObject(value) || !onlyKeys(value, ['seats', 'sides'])) return null
  const conditions: { seats?: DealConditions['seats']; sides?: DealConditions['sides'] } = {}
  if (value.seats !== undefined) {
    const seats = value.seats
    if (!isObject(seats) || !onlyKeys(seats, SEATS)) return null
    const parsed: NonNullable<DealConditions['seats']> = {}
    for (const seat of SEATS) {
      if (seats[seat] === undefined) continue
      const c = parseSeat(seats[seat])
      if (!c) return null
      parsed[seat] = c
    }
    conditions.seats = parsed
  }
  if (value.sides !== undefined) {
    const sides = value.sides
    if (!isObject(sides) || !onlyKeys(sides, ['NS', 'EW'])) return null
    const parsed: NonNullable<DealConditions['sides']> = {}
    for (const side of ['NS', 'EW'] as const) {
      const s = sides[side]
      if (s === undefined) continue
      if (!isObject(s) || !onlyKeys(s, ['hcp'])) return null
      const hcp = s.hcp === undefined ? undefined : parseRange(s.hcp)
      if (hcp === null) return null
      parsed[side] = hcp ? { hcp } : {}
    }
    conditions.sides = parsed
  }
  const problem = conditionsProblem(conditions)
  return problem === null ? { conditions } : { problem }
}

const SET_ID = /^[\w-]{1,40}$/

/** A deal set as sent from the browser, or null; whether the set or the boards exist is the server's to check */
function parseSetChoice(value: unknown): PracticeSetChoice | null {
  if (!isObject(value)) return null
  if (value.source === 'practice') {
    if (!onlyKeys(value, ['source', 'id']) || typeof value.id !== 'string' || !SET_ID.test(value.id)) return null
    return { source: 'practice', id: value.id }
  }
  if (value.source !== 'favorites' && value.source !== 'featured') return null
  const ids = value.ids
  if (!onlyKeys(value, ['source', 'ids']) || !Array.isArray(ids) || ids.length === 0 || ids.length > PRACTICE_SET_BOARDS_MAX)
    return null
  if (!ids.every((id) => typeof id === 'string' && SET_ID.test(id)) || new Set(ids).size !== ids.length) return null
  return { source: value.source, ids: [...(ids as string[])] }
}

/**
 * The settings of a new practice table, or the field that is wrong (with `problem`, where the
 * conditions contradict each other); `robotKind` defaults to `kind` (the member's,
 * `defaultRobotKind`: the club's system only with `tkuSystem`)
 */
export function parsePracticeSettings(
  value: unknown,
  kind: RobotKind = 'gib',
): { settings: PracticeSettings } | { field: string; problem?: string } {
  const keys = ['deal', 'conditions', 'robotKind', 'justDeclare', 'biddingOnly', 'seats', 'set', 'showHands']
  if (!isObject(value) || !onlyKeys(value, keys)) return { field: 'settings' }
  const deal = value.deal ?? 'random'
  if (!PRACTICE_DEALS.includes(deal as PracticeDeal)) return { field: 'deal' }
  const robotKind = value.robotKind ?? kind
  if (!isRobotKind(robotKind)) return { field: 'robotKind' }
  const justDeclare = value.justDeclare ?? false
  // A deal set's boards are dealt as they are: none could be dealt again for North-South to declare
  if (typeof justDeclare !== 'boolean' || (justDeclare && deal === 'set')) return { field: 'justDeclare' }
  // The robots bid a Just Declare board for everyone: a bidding practice would have nothing left to bid
  const biddingOnly = value.biddingOnly ?? false
  if (typeof biddingOnly !== 'boolean' || (biddingOnly && justDeclare)) return { field: 'biddingOnly' }
  const seats = parseSeats(value.seats, biddingOnly)
  if (!seats) return { field: 'seats' }
  const showHands = value.showHands ?? false
  if (typeof showHands !== 'boolean') return { field: 'showHands' }
  // Only what was chosen is kept, so a plain practice table's settings stay as they were
  const extra = { ...(biddingOnly && { biddingOnly }), ...(seats.length > 1 && { seats }), ...(showHands && { showHands }) }
  if (deal !== 'custom' && value.conditions !== undefined) return { field: 'conditions' }
  if (deal !== 'set' && value.set !== undefined) return { field: 'set' }
  if (deal === 'set') {
    const set = parseSetChoice(value.set)
    if (!set) return { field: 'set' }
    return { settings: { deal, set, robotKind, justDeclare, ...extra } }
  }
  if (deal !== 'custom') return { settings: { deal: deal as PracticeDeal, robotKind, justDeclare, ...extra } }
  const parsed = parseConditions(value.conditions)
  if (!parsed) return { field: 'conditions' }
  if ('problem' in parsed) return { field: 'conditions', problem: parsed.problem }
  return { settings: { deal, conditions: parsed.conditions, robotKind, justDeclare, ...extra } }
}

/** A name for saved settings (存成我的設定): trimmed, 1–PRACTICE_PRESET_NAME_MAX characters; null if not */
export function parsePresetName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim().replace(/\s+/g, ' ')
  return name.length > 0 && [...name].length <= PRACTICE_PRESET_NAME_MAX ? name : null
}

/**
 * The seats the member bids for, in table order, or null: each seat once, South among them, and
 * others only at a bidding practice
 */
function parseSeats(value: unknown, biddingOnly: boolean): Seat[] | null {
  if (value === undefined) return [PRACTICE_SEAT]
  if (!Array.isArray(value) || !value.every(isSeat) || new Set(value).size !== value.length) return null
  if (!value.includes(PRACTICE_SEAT) || (value.length > 1 && !biddingOnly)) return null
  return SEATS.filter((seat) => value.includes(seat))
}

/**
 * The number of the practice table's n-th board (0-based). Boards dealt to conditions are all
 * South's to deal, since the conditions are written from South's seat (an opening hand opens):
 * boards 3, 7, 11, 15, … which go round the four vulnerabilities. Any deal goes round the table
 */
export const practiceBoardNo = (settings: Pick<PracticeSettings, 'deal'>, dealt: number) =>
  settings.deal === 'random' ? dealt + 1 : dealt * 4 + 3
