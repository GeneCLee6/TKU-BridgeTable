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
  /**
   * The PRD's area (E5 AC-5.4), only where `topicOf` would guess it wrong; most questions leave it
   * out and get it from the auction
   */
  topic?: QuizTopic
}

/**
 * The nine areas of the full 5542 natural system that AC-5.4 asks for (docs/PRD/e5, the table from
 * 開叫 to 滿貫): a question's area is what the call is about, whatever file it sits in.
 */
export const QUIZ_TOPICS = [
  'opening',
  'response',
  'opener-rebid',
  'responder-rebid',
  'overcall',
  'advance',
  'double',
  'competition',
  'slam',
] as const
export type QuizTopic = (typeof QUIZ_TOPICS)[number]

/** The PRD's names for the areas */
export const TOPIC_TITLES: Record<QuizTopic, string> = {
  opening: '開叫',
  response: '答叫',
  'opener-rebid': '開叫者再叫',
  'responder-rebid': '答叫者再叫',
  overcall: '蓋叫',
  advance: '蓋叫的答叫',
  double: '賭倍',
  competition: '競叫',
  slam: '滿貫',
}

export const isQuizTopic = (value: unknown): value is QuizTopic => QUIZ_TOPICS.includes(value as QuizTopic)

const isDouble = (call: Call) => call === 'X' || call === 'XX'
const levelOf = (call: Call) => (/^[1-7]/.test(call) ? Number(call[0]) : 0)

/**
 * The question's area (eval/README.md, 「九類」): its `topic` when it has one, otherwise from the
 * auction, the first rule that fits:
 *
 * 1. 滿貫: the file is a slam file, the answer is a six or seven level contract, or our side has
 *    bid 4NT or 5NT (Blackwood, RKCB, quantitative, the grand slam force) or Gerber (4♣ right after
 *    partner's 1NT/2NT) — unless the opponents have bid at the four level (then 4NT is not asking)
 * 2. 開叫: nobody has bid yet
 * 3. They opened:
 *    - not one of a suit (1NT, weak twos, preempts): 競叫 (the PRD puts 對抗敵方 1NT and 對抗弱二與
 *      三線阻擊 there)
 *    - our side's first action was a double, and this is the advancer's first call or the doubler's
 *      second: 賭倍 (迫伴賭倍與回答、賭倍者再叫); so is any double or redouble of ours
 *    - our side has not acted: 蓋叫; partner overcalled and this is our first action: 蓋叫的答叫
 *    - later (the overcaller's rebid and on): 競叫
 * 4. We opened:
 *    - a double or redouble (negative, support, responsive, penalty), or opener answering partner's
 *      negative double: 賭倍
 *    - the opponents have bid or doubled: 競叫
 *    - otherwise by who calls: the responder's first call 答叫, opener's later calls 開叫者再叫,
 *      the responder's later calls 答叫者再叫
 */
export function topicOf(q: QuizQuestion, category: string): QuizTopic {
  if (q.topic) return q.topic
  const calls = [...q.auction, q.answer]
  const n = q.auction.length
  const ours = (i: number) => (n - i) % 2 === 0
  const mine = (i: number) => (n - i) % 4 === 0
  const ourBids = calls.flatMap((call, i) => (ours(i) && call !== 'P' ? [{ call, i }] : []))
  const theirTop = Math.max(0, ...calls.map((call, i) => (ours(i) ? 0 : levelOf(call))))
  const gerber = ourBids.some(({ call }, k) => call === '4C' && k > 0 && ['1N', '2N'].includes(ourBids[k - 1].call))
  const asking = theirTop < 4 && (ourBids.some(({ call }) => call === '4N' || call === '5N') || gerber)
  if (category === 'slam' || levelOf(q.answer) >= 6 || asking) return 'slam'

  const first = calls.findIndex((call, i) => i < n && call !== 'P')
  if (first < 0) return 'opening'
  const before = ourBids.filter(({ i }) => i < n)
  if (!ours(first)) {
    if (levelOf(calls[first]) !== 1 || calls[first] === '1N') return 'competition'
    if (before.length && before[0].call === 'X') {
      const advancing = before.length === 1 && !mine(before[0].i)
      const doublerAgain = before.length <= 2 && mine(before[0].i)
      if (advancing || doublerAgain) return 'double'
    }
    if (isDouble(q.answer)) return 'double'
    if (!before.length) return 'overcall'
    if (before.length === 1 && !mine(before[0].i)) return 'advance'
    return 'competition'
  }
  if (isDouble(q.answer)) return 'double'
  const theyActed = calls.some((call, i) => i < n && !ours(i) && call !== 'P')
  if (theyActed) {
    const partners = before.filter(({ i }) => !mine(i))
    const openerAnswering = mine(first) && partners.length === 1 && partners[0].call === 'X'
    return openerAnswering ? 'double' : 'competition'
  }
  if (mine(first)) return 'opener-rebid'
  return before.some(({ i }) => mine(i)) ? 'responder-rebid' : 'response'
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
  if (q.topic !== undefined && !isQuizTopic(q.topic)) fail(`topic is one of ${QUIZ_TOPICS.join(', ')}, not "${q.topic}"`)
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
  /** The PRD's area (`topicOf`) */
  topic: QuizTopic
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
      results.push({ question, category: file.category, topic: topicOf(question, file.category), call, grade: grade(question, call) })
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

/** AC-5.4 asks each of the nine areas for at least this many questions, all answered right */
export const TOPIC_MINIMUM = 30

/** Scores by system and the PRD's nine areas (`topicOf`), the areas in the PRD's order */
export function scoreTopics(results: readonly QuizResult[]): QuizScore[] {
  const rows = scoreQuiz(results.map((r) => ({ ...r, category: r.topic })))
  const order = (row: QuizScore) => QUIZ_TOPICS.indexOf(row.category as QuizTopic)
  const systems = [...new Set(rows.map((r) => r.system))]
  return [...rows].sort((a, b) => systems.indexOf(a.system) - systems.indexOf(b.system) || order(a) - order(b))
}

/**
 * The nine areas in Markdown: questions, pending review, correct, and whether the area meets
 * AC-5.4 (at least `TOPIC_MINIMUM` questions, every one right). Areas without a question show 0.
 */
export function topicReport(rows: readonly QuizScore[]): string {
  const lines = ['| System | Area | Questions | Pending review | Correct | AC-5.4 |', '| --- | --- | --- | --- | --- | --- |']
  for (const system of [...new Set(rows.map((r) => r.system))]) {
    for (const topic of QUIZ_TOPICS) {
      const row = rows.find((r) => r.system === system && r.category === topic)
      const questions = row?.questions ?? 0
      const correct = row?.correct ?? 0
      const mark = questions < TOPIC_MINIMUM ? `${TOPIC_MINIMUM - questions} short` : correct < questions ? `${questions - correct} wrong` : '✅'
      lines.push(`| ${system} | ${TOPIC_TITLES[topic]} (${topic}) | ${questions} | ${row?.pending ?? 0} | ${correct}/${questions} (${percent(correct, questions)}) | ${mark} |`)
    }
  }
  return lines.join('\n')
}

/** The questions the brain got wrong, for the report */
export function quizMisses(results: readonly QuizResult[]): string {
  const wrong = results.filter((r) => r.grade === 'wrong')
  if (!wrong.length) return 'No misses.'
  return [
    '| Question | Area | Auction | Hand | Book | Robot |',
    '| --- | --- | --- | --- | --- | --- |',
    ...wrong.map(({ question: q, topic, call }) =>
      `| ${q.id} | ${topic} | ${q.auction.join(' ') || '(opens)'} | ${q.hand} | ${[q.answer, ...(q.accepted ?? [])].join(' / ')} | ${call} |`,
    ),
  ].join('\n')
}
