import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { isCall, type Call } from '../shared/auction.ts'
import { isCard, SEATS, type Card, type Hands, type Seat } from '../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../shared/game.ts'
import { isRobotKind, type RobotKind } from '../shared/protocol.ts'
import type { RobotBrain } from '../shared/robot/brain.ts'
import { parseHand, type QuizScore, type QuizStatus } from './quiz.ts'

/**
 * The card-play question bank (eval/README.md): "this deal, this auction, these cards played:
 * what do you play now?" with the textbook's answer. `tests/play-quiz/*.json` holds the
 * questions, one file per category (opening leads, second hand, third hand, signals, the
 * declarer's plan…); the robot answers each one from what it may see, and the CI ratchet fails a
 * pull request whose robot answers fewer questions of any category correctly than main's.
 */

export const PLAY_QUIZ_DIR = 'tests/play-quiz'

export interface PlayQuestion {
  /** Unique across the bank, such as `play-third-001` */
  id: string
  /** Which robot answers: `tku`, `gib` or `both` (the answer is the same in either system) */
  system: RobotKind | 'both'
  /** The board number: dealer and vulnerability follow it (1 = North, none) */
  board: number
  /** Every hand, `S.H.D.C` high to low; the robot sees only what the rules allow (ROBOT.md §1) */
  hands: Record<Seat, string>
  /** The calls from the dealer; the auction must be over */
  auction: Call[]
  /** The cards played so far, in order */
  play: Card[]
  /** The book's card */
  answer: Card
  /** Other cards that are also right */
  accepted?: Card[]
  /** Where the answer comes from: a textbook rule, or the club's reported hand */
  source: string
  reviewer: string | null
  status: QuizStatus
  /** Why, in a sentence */
  note?: string
}

export interface PlayQuizFile {
  category: string
  title: string
  questions: PlayQuestion[]
}

/** The systems a question asks */
export const systemsOf = (q: PlayQuestion): RobotKind[] => (q.system === 'both' ? ['tku', 'gib'] : [q.system])

/** The position the robot is asked in; throws when the deal, auction or play is not legal */
export function playState(q: PlayQuestion): BoardState {
  const hands = {} as Hands
  for (const seat of SEATS) hands[seat] = parseHand(q.hands[seat])
  const all = new Set(SEATS.flatMap((s) => hands[s]))
  if (all.size !== 52) throw new Error('the four hands repeat a card')
  let state = newBoard(q.board, hands)
  for (const call of q.auction) {
    if (state.phase !== 'auction') throw new Error('the auction is already over')
    state = makeCall(state, turnOf(state)!, call)
  }
  if (state.phase !== 'play') throw new Error('the auction is not over')
  for (const card of q.play) {
    const seat = turnOf(state)
    if (!seat || state.phase !== 'play') throw new Error('the play is already over')
    if (!legalCards(state, seat).includes(card)) throw new Error(`${card} is not a legal card for ${seat}`)
    state = playCard(state, seat, card)
  }
  if (state.phase !== 'play') throw new Error('the play is already over')
  return state
}

/** Everything wrong with a question (empty when it is fine) */
export function playQuestionProblems(q: PlayQuestion): string[] {
  const problems: string[] = []
  const fail = (message: string) => problems.push(`${q.id}: ${message}`)
  if (!/^[a-z0-9-]+$/.test(q.id ?? '')) fail('id must be lowercase letters, digits and dashes')
  if (q.system !== 'both' && !isRobotKind(q.system)) fail(`unknown system "${q.system}"`)
  if (!Number.isInteger(q.board) || q.board < 1) fail('board must be a positive number')
  if (!q.hands || !SEATS.every((s) => typeof q.hands[s] === 'string')) fail('hands must give N, E, S and W')
  if (!Array.isArray(q.auction) || !q.auction.every(isCall)) fail('auction must be a list of calls')
  if (!Array.isArray(q.play) || !q.play.every(isCard)) fail('play must be a list of cards')
  if (problems.length) return problems
  let state: BoardState
  try {
    state = playState(q)
  } catch (error) {
    fail((error as Error).message)
    return problems
  }
  const legal = legalCards(state, turnOf(state)!)
  for (const card of [q.answer, ...(q.accepted ?? [])]) if (!isCard(card) || !legal.includes(card)) fail(`"${card}" is not a legal card here`)
  if (q.accepted?.includes(q.answer)) fail('the answer is repeated in accepted')
  if (legal.length < 2) fail('only one card is legal: nothing to decide')
  if (typeof q.source !== 'string' || !q.source.trim()) fail('source is required')
  if (q.status === 'pending' && q.reviewer !== null) fail('a pending question has no reviewer yet (null)')
  else if (q.status === 'reviewed' && !(typeof q.reviewer === 'string' && q.reviewer.trim())) fail('a reviewed question names its reviewer')
  else if (q.status !== 'pending' && q.status !== 'reviewed') fail(`status is pending or reviewed, not "${q.status}"`)
  return problems
}

export function loadPlayBank(dir = PLAY_QUIZ_DIR): PlayQuizFile[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(dir, name), 'utf8')) as PlayQuizFile)
}

export function playBankProblems(files: readonly PlayQuizFile[]): string[] {
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
      problems.push(...playQuestionProblems(q))
    }
  }
  return problems
}

export interface PlayResult {
  question: PlayQuestion
  system: RobotKind
  category: string
  seat: Seat
  card: Card
  grade: 'answer' | 'accepted' | 'wrong'
}

/** The brain's card on every question, once per system the question asks */
export async function runPlayQuiz(brain: RobotBrain, files: readonly PlayQuizFile[]): Promise<PlayResult[]> {
  const results: PlayResult[] = []
  for (const file of files) {
    for (const question of file.questions) {
      const state = playState(question)
      const seat = turnOf(state)!
      for (const system of systemsOf(question)) {
        const card = await brain.play(system, state, seat)
        const grade = card === question.answer ? 'answer' : question.accepted?.includes(card) ? 'accepted' : 'wrong'
        results.push({ question, system, category: file.category, seat, card, grade })
      }
    }
  }
  return results
}

/** Scores by system and category, in the shape of the bidding quiz's rows (its ratchet and report apply) */
export function scorePlayQuiz(results: readonly PlayResult[]): QuizScore[] {
  const rows = new Map<string, QuizScore>()
  for (const { question, system, category, grade } of results) {
    const key = `${system}/${category}`
    let row = rows.get(key)
    if (!row) rows.set(key, (row = { system, category, questions: 0, answer: 0, correct: 0, pending: 0 }))
    row.questions++
    if (grade === 'answer') row.answer++
    if (grade !== 'wrong') row.correct++
    if (question.status === 'pending') row.pending++
  }
  return [...rows.values()]
}

/** The questions the brain got wrong, for the report */
export function playQuizMisses(results: readonly PlayResult[]): string {
  const wrong = results.filter((r) => r.grade === 'wrong')
  if (!wrong.length) return 'No misses.'
  return [
    '| Question | System | Seat | Book | Robot |',
    '| --- | --- | --- | --- | --- |',
    ...wrong.map(({ question: q, system, seat, card }) => `| ${q.id} | ${system} | ${seat} | ${[q.answer, ...(q.accepted ?? [])].join(' / ')} | ${card} |`),
  ].join('\n')
}
