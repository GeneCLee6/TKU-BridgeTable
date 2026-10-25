import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isCall, legalCalls, seatToCall, type AuctionCall, type Call } from '../shared/auction.ts'
import { fullDeck, isSeat, RANKS, SEATS, SUITS, type Card, type Hands, type Seat } from '../shared/cards.ts'
import type { Vulnerability } from '../shared/board.ts'
import type { BoardState } from '../shared/game.ts'
import { isRobotKind, type RobotKind } from '../shared/protocol.ts'
import type { RobotBrain } from '../shared/robot/brain.ts'

/**
 * The bidding question bank (e5-t23, eval/README.md): "this hand, this auction, what do you
 * call?" with the book's answer. `tests/bidding-quiz/*.json` holds the questions, one file per
 * category; the robot answers each one and the CI ratchet (`quiz-gate.ts`) fails a pull request
 * whose robot answers fewer questions of any category correctly than main's.
 */

export const QUIZ_DIR = 'tests/bidding-quiz'

/** Written by someone (such as the AI) and waiting for a club officer to check it, or checked */
export type QuizStatus = 'pending' | 'reviewed'

export interface QuizQuestion {
  /** Unique across the bank, such as `tku-open-001` */
  id: string
  /** The system the answer is in: `tku` (the club's) or `gib` (2/1) */
  system: RobotKind
  dealer: Seat
  vul: Vulnerability
  /** The hand of the seat to call, `S.H.D.C` high to low, such as `AKQ32.K54.32.J43` (a void is empty) */
  hand: string
  /** The calls so far from the dealer: `1C`…`7N`, `P`, `X`, `XX` */
  auction: Call[]
  /** The book's call */
  answer: Call
  /** Other calls that are also right (counted as correct) */
  accepted?: Call[]
  /** Where the answer comes from, such as a page of the club's book */
  source: string
  /** Who checked the question; null while pending */
  reviewer: string | null
  status: QuizStatus
  /** Why, in a sentence: points, shape and the rule */
  note?: string
}

export interface QuizFile {
  /** Such as `opening`; the report groups by it */
  category: string
  /** For people, such as 開叫 */
  title: string
  questions: QuizQuestion[]
}

const VULS: readonly Vulnerability[] = ['None', 'NS', 'EW', 'Both']

/** `AKQ32.K54.32.J43` as cards (`SA`, `SK`, …); throws when it is not 13 distinct cards */
export function parseHand(text: string): Card[] {
  const suits = text.split('.')
  if (suits.length !== 4) throw new Error(`hand "${text}" needs four suits S.H.D.C`)
  const cards = suits.flatMap((ranks, i) => [...ranks].map((rank) => {
    if (!RANKS.includes(rank)) throw new Error(`hand "${text}" has an unknown rank "${rank}"`)
    return SUITS[i] + rank
  }))
  if (cards.length !== 13) throw new Error(`hand "${text}" has ${cards.length} cards, not 13`)
  if (new Set(cards).size !== 13) throw new Error(`hand "${text}" repeats a card`)
  return cards
}

/** The seat whose call the question asks for */
export const seatOf = (q: QuizQuestion): Seat => seatToCall(q.dealer, q.auction.length)

/** The auction as the engine keeps it */
export const auctionOf = (q: QuizQuestion): AuctionCall[] => q.auction.map((call, i) => ({ seat: seatToCall(q.dealer, i), call }))

/** Everything wrong with a question (empty when it is fine) */
export function questionProblems(q: QuizQuestion): string[] {
  const problems: string[] = []
  const fail = (message: string) => problems.push(`${q.id}: ${message}`)
  if (!/^[a-z0-9-]+$/.test(q.id ?? '')) fail('id must be lowercase letters, digits and dashes')
  if (!isRobotKind(q.system)) fail(`unknown system "${q.system}"`)
  if (!isSeat(q.dealer)) fail(`unknown dealer "${q.dealer}"`)
  if (!VULS.includes(q.vul)) fail(`unknown vulnerability "${q.vul}"`)
  try {
    parseHand(q.hand)
  } catch (error) {
    fail((error as Error).message)
  }
  if (!Array.isArray(q.auction)) fail('auction must be a list of calls')
  else {
    for (let i = 0; i < q.auction.length; i++) {
      const legal = legalCalls(auctionOf({ ...q, auction: q.auction.slice(0, i) }), q.dealer)
      if (!legal.has(q.auction[i])) {
        fail(`call ${i + 1} "${q.auction[i]}" is not legal`)
        break
      }
    }
    if (!problems.length) {
      const legal = legalCalls(auctionOf(q), q.dealer)
      if (!legal.size) fail('the auction is already over')
      for (const call of [q.answer, ...(q.accepted ?? [])]) {
        if (!isCall(call) || !legal.has(call)) fail(`"${call}" is not a legal call here`)
      }
      if (q.accepted?.includes(q.answer)) fail('the answer is repeated in accepted')
    }
  }
  if (typeof q.source !== 'string' || !q.source.trim()) fail('source is required')
  if (q.status === 'pending' && q.reviewer !== null) fail('a pending question has no reviewer yet (null)')
  else if (q.status === 'reviewed' && !(typeof q.reviewer === 'string' && q.reviewer.trim())) fail('a reviewed question names its reviewer')
  else if (q.status !== 'pending' && q.status !== 'reviewed') fail(`status is pending or reviewed, not "${q.status}"`)
  return problems
}

/**
 * Every file of the bank in `dir`, by file name. A category may span several files: the file
 * names its category (`competitive.json`, `competitive.more.json`), so new questions can go in a
 * new file without touching anyone else's.
 */
export function loadBank(dir = QUIZ_DIR): QuizFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as QuizFile)
}

/** Everything wrong with the bank: each question, and ids used twice */
export function bankProblems(files: readonly QuizFile[]): string[] {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const file of files) {
    if (!file.category || !file.title || !Array.isArray(file.questions)) {
      problems.push('a file needs category, title and questions')
      continue
    }
    for (const q of file.questions) {
      if (ids.has(q.id)) problems.push(`${q.id}: the id is used twice`)
      ids.add(q.id)
      problems.push(...questionProblems(q))
    }
  }
  return problems
}

/**
 * The state the brain is asked in. Only the seat to call has the question's hand; the other 39
 * cards are dealt to the others in a fixed order (a robot may only look at its own hand when
 * bidding, ROBOT.md §1, so they do not matter).
 */
export function quizState(q: QuizQuestion): BoardState {
  const seat = seatOf(q)
  const own = parseHand(q.hand)
  const rest = fullDeck().filter((card) => !own.includes(card))
  const others = SEATS.filter((s) => s !== seat)
  const hands = { [seat]: own } as Partial<Hands>
  others.forEach((s, i) => (hands[s] = rest.slice(i * 13, i * 13 + 13)))
  return {
    boardNo: 1,
    dealer: q.dealer,
    vul: q.vul,
    hands: hands as Hands,
    auction: auctionOf(q),
    contract: null,
    play: [],
    phase: 'auction',
  }
}

export type Grade = 'answer' | 'accepted' | 'wrong'

export interface QuizResult {
  question: QuizQuestion
  category: string
  call: Call
  grade: Grade
}

export function grade(q: QuizQuestion, call: Call): Grade {
  if (call === q.answer) return 'answer'
  return q.accepted?.includes(call) ? 'accepted' : 'wrong'
}

/** The brain's call on every question, each in the question's system */
export async function runQuiz(brain: RobotBrain, files: readonly QuizFile[]): Promise<QuizResult[]> {
  const results: QuizResult[] = []
  for (const file of files) {
    for (const question of file.questions) {
      const { call } = await brain.bid(question.system, quizState(question), seatOf(question))
      results.push({ question, category: file.category, call, grade: grade(question, call) })
    }
  }
  return results
}

/** One row of the report: a system's category */
export interface QuizScore {
  system: RobotKind
  category: string
  questions: number
  /** The book's call */
  answer: number
  /** The book's call or an accepted one: what the ratchet counts */
  correct: number
  /** Questions still waiting for review */
  pending: number
}

/** Scores by system and category, in the order the questions came */
export function scoreQuiz(results: readonly QuizResult[]): QuizScore[] {
  const rows = new Map<string, QuizScore>()
  for (const { question, category, grade } of results) {
    const key = `${question.system}/${category}`
    let row = rows.get(key)
    if (!row) rows.set(key, (row = { system: question.system, category, questions: 0, answer: 0, correct: 0, pending: 0 }))
    row.questions++
    if (grade === 'answer') row.answer++
    if (grade !== 'wrong') row.correct++
    if (question.status === 'pending') row.pending++
  }
  return [...rows.values()]
}

const percent = (n: number, of: number) => (of ? `${((100 * n) / of).toFixed(1)}%` : '—')

/**
 * Rows of this branch's scores that are worse than the base's on the same questions: the ratchet.
 * A row the base does not have (a new category) never fails.
 */
export function quizRegressions(branch: readonly QuizScore[], base: readonly QuizScore[]): QuizScore[] {
  return branch.filter((row) => {
    const before = base.find((b) => b.system === row.system && b.category === row.category)
    return before !== undefined && row.correct < before.correct
  })
}

/** The report in Markdown; `base` adds the base's column */
export function quizReport(branch: readonly QuizScore[], base?: readonly QuizScore[]): string {
  const head = base
    ? ['| System | Category | Questions | Pending review | This branch | Base | |', '| --- | --- | --- | --- | --- | --- | --- |']
    : ['| System | Category | Questions | Pending review | Correct | Book\'s call |', '| --- | --- | --- | --- | --- | --- |']
  const fraction = (row: QuizScore) => `${row.correct}/${row.questions} (${percent(row.correct, row.questions)})`
  const line = (row: QuizScore, before: QuizScore | undefined, label: string) => {
    if (!base) return `| ${label} | ${row.questions} | ${row.pending} | ${fraction(row)} | ${row.answer}/${row.questions} |`
    const mark = !before ? 'new' : row.correct < before.correct ? '❌' : row.correct > before.correct ? '⬆️' : '✅'
    return `| ${label} | ${row.questions} | ${row.pending} | ${fraction(row)} | ${before ? fraction(before) : '—'} | ${mark} |`
  }
  const rows = branch.map((row) =>
    line(row, base?.find((b) => b.system === row.system && b.category === row.category), `${row.system} | ${row.category}`),
  )
  rows.push(line(totalOf(branch), base && totalOf(base), '**all** |'))
  return [...head, ...rows].join('\n')
}

function totalOf(rows: readonly QuizScore[]): QuizScore {
  const total: QuizScore = { system: 'tku', category: 'all', questions: 0, answer: 0, correct: 0, pending: 0 }
  for (const r of rows) {
    total.questions += r.questions
    total.answer += r.answer
    total.correct += r.correct
    total.pending += r.pending
  }
  return total
}

/** The questions the brain got wrong, for the report */
export function quizMisses(results: readonly QuizResult[]): string {
  const wrong = results.filter((r) => r.grade === 'wrong')
  if (!wrong.length) return 'No misses.'
  return [
    '| Question | Auction | Hand | Book | Robot |',
    '| --- | --- | --- | --- | --- |',
    ...wrong.map(({ question: q, call }) => `| ${q.id} | ${q.auction.join(' ') || '(opens)'} | ${q.hand} | ${[q.answer, ...(q.accepted ?? [])].join(' / ')} | ${call} |`),
  ].join('\n')
}
