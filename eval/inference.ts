import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { legalCalls, seatToCall, type AuctionCall, type Call } from '../shared/auction.ts'
import type { Vulnerability } from '../shared/board.ts'
import { isSeat, SUITS, type Seat, type Suit } from '../shared/cards.ts'
import { isRobotKind, type RobotKind } from '../shared/protocol.ts'
import { ROBOT_SYSTEMS } from '../shared/robot/robots.ts'
import { read } from '../shared/robot/system/infer.ts'
import type { Range, Spec } from '../shared/robot/system/spec.ts'
import type { QuizStatus } from './quiz.ts'

/**
 * The inference question bank (e5-t21, AC-5.6, eval/README.md): "after this auction, what has
 * each player shown?" with the book's answer, as ranges of high-card points and suit lengths,
 * and whether the hand is balanced. `tests/inference-quiz/*.json` holds the questions; the engine
 * reads the auction (`infer.ts` `read`, the same reading the robots bid with) and every feature a
 * question names must come out exactly as the book says. A question the engine gets wrong today
 * names why in `miss`: the test then expects the miss, so fixing the engine flags the question
 * to have its `miss` removed.
 */

export const INFERENCE_DIR = 'tests/inference-quiz'

/** What a question checks for one seat: only the features it names */
export interface Shown {
  hcp?: Range
  len?: Partial<Record<Suit, Range>>
  balanced?: boolean
}

export interface InferenceQuestion {
  /** Unique across the bank, such as `tku-inf-001` */
  id: string
  /** The system both sides play: `tku` (the club's) or `gib` (2/1) */
  system: RobotKind
  dealer: Seat
  vul: Vulnerability
  /** Every call so far from the dealer: `1C`…`7N`, `P`, `X`, `XX` */
  auction: Call[]
  /** What each seat named has shown by the end of the auction */
  expect: Partial<Record<Seat, Shown>>
  /** Where the answer comes from, such as a page of the club's book */
  source: string
  /** Who checked the question; null while pending */
  reviewer: string | null
  status: QuizStatus
  note?: string
  /** Set when the engine reads this auction differently from the book today: why */
  miss?: string
}

export interface InferenceFile {
  title: string
  questions: InferenceQuestion[]
}

const VULS: readonly Vulnerability[] = ['None', 'NS', 'EW', 'Both']

export const inferenceAuction = (q: InferenceQuestion): AuctionCall[] =>
  q.auction.map((call, i) => ({ seat: seatToCall(q.dealer, i), call }))

const isRange = (value: unknown): value is Range =>
  Array.isArray(value) && value.length === 2 && value.every(Number.isInteger) && value[0] <= value[1] && value[0] >= 0

/** Everything wrong with a question's format (empty when it is fine) */
export function inferenceProblems(q: InferenceQuestion): string[] {
  const problems: string[] = []
  const fail = (message: string) => problems.push(`${q.id}: ${message}`)
  if (!/^[a-z0-9-]+$/.test(q.id ?? '')) fail('id must be lowercase letters, digits and dashes')
  if (!isRobotKind(q.system)) fail(`unknown system "${q.system}"`)
  if (!isSeat(q.dealer)) fail(`unknown dealer "${q.dealer}"`)
  if (!VULS.includes(q.vul)) fail(`unknown vulnerability "${q.vul}"`)
  if (!Array.isArray(q.auction) || !q.auction.length) fail('auction must be a list of calls')
  else
    for (let i = 0; i < q.auction.length; i++) {
      const legal = legalCalls(inferenceAuction({ ...q, auction: q.auction.slice(0, i) }), q.dealer)
      if (!legal.has(q.auction[i])) {
        fail(`call ${i + 1} "${q.auction[i]}" is not legal`)
        break
      }
    }
  const seats = Object.entries(q.expect ?? {})
  if (!seats.length) fail('expect names no seat')
  for (const [seat, shown] of seats) {
    if (!isSeat(seat)) fail(`unknown seat "${seat}" in expect`)
    if (shown.hcp !== undefined && !isRange(shown.hcp)) fail(`${seat}: hcp must be [low, high]`)
    for (const [suit, range] of Object.entries(shown.len ?? {}))
      if (!SUITS.includes(suit as Suit) || !isRange(range) || range[1] > 13) fail(`${seat}: bad length for ${suit}`)
    if (shown.balanced !== undefined && typeof shown.balanced !== 'boolean') fail(`${seat}: balanced must be true or false`)
    if (shown.hcp === undefined && shown.len === undefined && shown.balanced === undefined) fail(`${seat}: nothing to check`)
  }
  if (typeof q.source !== 'string' || !q.source.trim()) fail('source is required')
  if (q.status === 'pending' && q.reviewer !== null) fail('a pending question has no reviewer yet (null)')
  else if (q.status === 'reviewed' && !(typeof q.reviewer === 'string' && q.reviewer.trim())) fail('a reviewed question names its reviewer')
  else if (q.status !== 'pending' && q.status !== 'reviewed') fail(`status is pending or reviewed, not "${q.status}"`)
  if (q.miss !== undefined && !(typeof q.miss === 'string' && q.miss.trim())) fail('miss says why the engine differs')
  return problems
}

export function loadInferenceBank(dir = INFERENCE_DIR): InferenceFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as InferenceFile)
}

/** Format problems and ids used twice */
export function inferenceBankProblems(files: readonly InferenceFile[]): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const file of files) {
    if (!file.title || !Array.isArray(file.questions)) {
      problems.push('a file needs title and questions')
      continue
    }
    for (const q of file.questions) {
      if (ids.has(q.id)) problems.push(`${q.id}: the id is used twice`)
      ids.add(q.id)
      problems.push(...inferenceProblems(q))
    }
  }
  return problems
}

const sameRange = (a: Range | undefined, b: Range | undefined) => a?.[0] === b?.[0] && a?.[1] === b?.[1]
const show = (range: Range | undefined) => (range ? `${range[0]}–${range[1]}` : 'nothing')

/**
 * Where the engine's reading differs from the book's, one line per feature (empty when it agrees).
 * A length the engine says nothing about reads as 0–13, an hcp range as 0–40.
 */
export function inferenceDiff(q: InferenceQuestion, shown: Record<Seat, Spec> = read(ROBOT_SYSTEMS[q.system], inferenceAuction(q), q.dealer, q.vul).shown): string[] {
  const diff: string[] = []
  for (const [seat, want] of Object.entries(q.expect) as [Seat, Shown][]) {
    const got = shown[seat]
    if (want.hcp && !sameRange(want.hcp, got.hcp ?? [0, 40])) diff.push(`${seat} hcp: book ${show(want.hcp)}, engine ${show(got.hcp)}`)
    for (const [suit, range] of Object.entries(want.len ?? {}) as [Suit, Range][])
      if (!sameRange(range, got.len?.[suit] ?? [0, 13])) diff.push(`${seat} ${suit}: book ${show(range)}, engine ${show(got.len?.[suit])}`)
    if (want.balanced !== undefined && want.balanced !== got.balanced)
      diff.push(`${seat} balanced: book ${want.balanced}, engine ${got.balanced ?? 'nothing'}`)
  }
  return diff
}
