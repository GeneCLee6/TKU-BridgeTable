import type { RandomInt } from './board.ts'
import { SEATS, SUITS } from './cards.ts'
import { DEAL_PRESET_IDS, DEAL_PRESETS, type DealPreset } from './deal-presets.ts'
import { conditionsProblem, type DealConditions, type Range, type SeatConditions } from './dealer.ts'
import { isRobotKind, type RobotKind } from './protocol.ts'

/**
 * The practice table (E10, `e10-t03`–`e10-t05`, ARCHITECTURE.md §5.11): one member in the South
 * seat with three TKB robots, boards dealt to conditions, a new deal whenever they like and no
 * limit on undo. Pure: the browser builds the settings, the club checks them with
 * `parsePracticeSettings` before it opens the table.
 */

/** Where the boards come from: any deal, one of the club's presets (`deal-presets.ts`), or the member's own conditions */
export type PracticeDeal = 'random' | DealPreset | 'custom'
export const PRACTICE_DEALS: readonly PracticeDeal[] = ['random', ...DEAL_PRESET_IDS, 'custom']

export interface PracticeSettings {
  deal: PracticeDeal
  /** The member's own conditions, with `deal: 'custom'` only */
  conditions?: DealConditions
  /** The robots' system: TKB in the club's system or in 2/1 */
  robotKind: RobotKind
  /** Just Declare (`e10-t05`): the robots bid every board and only those North-South declares are kept */
  justDeclare: boolean
}

export const DEFAULT_PRACTICE_SETTINGS: PracticeSettings = { deal: 'random', robotKind: 'tku', justDeclare: false }

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
  if (settings.deal === 'random') return null
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
  if (!isObject(value) || !onlyKeys(value, ['hcp', 'lengths', 'balanced'])) return null
  const seat: { hcp?: Range; lengths?: SeatConditions['lengths']; balanced?: boolean } = {}
  if (value.hcp !== undefined) {
    const hcp = parseRange(value.hcp)
    if (!hcp) return null
    seat.hcp = hcp
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

/** A member's own deal conditions as sent from the browser, or null when they are not well formed or cannot be met */
export function parseConditions(value: unknown): DealConditions | null {
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
  return conditionsProblem(conditions) === null ? conditions : null
}

/** The settings of a new practice table, or the field that is wrong */
export function parsePracticeSettings(value: unknown): { settings: PracticeSettings } | { field: string } {
  if (!isObject(value) || !onlyKeys(value, ['deal', 'conditions', 'robotKind', 'justDeclare'])) return { field: 'settings' }
  const deal = value.deal ?? 'random'
  if (!PRACTICE_DEALS.includes(deal as PracticeDeal)) return { field: 'deal' }
  const robotKind = value.robotKind ?? 'tku'
  if (!isRobotKind(robotKind)) return { field: 'robotKind' }
  const justDeclare = value.justDeclare ?? false
  if (typeof justDeclare !== 'boolean') return { field: 'justDeclare' }
  if (deal !== 'custom') {
    if (value.conditions !== undefined) return { field: 'conditions' }
    return { settings: { deal: deal as PracticeDeal, robotKind, justDeclare } }
  }
  const conditions = parseConditions(value.conditions)
  if (!conditions) return { field: 'conditions' }
  return { settings: { deal, conditions, robotKind, justDeclare } }
}

/**
 * The number of the practice table's n-th board (0-based). Boards dealt to conditions are all
 * South's to deal, since the conditions are written from South's seat (an opening hand opens):
 * boards 3, 7, 11, 15, … which go round the four vulnerabilities. Any deal goes round the table
 */
export const practiceBoardNo = (settings: Pick<PracticeSettings, 'deal'>, dealt: number) =>
  settings.deal === 'random' ? dealt + 1 : dealt * 4 + 3
