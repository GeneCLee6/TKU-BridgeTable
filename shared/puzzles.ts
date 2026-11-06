import { nextSeat, rankOf, rankValue, RANKS, sameSide, SEATS, SUITS, suitOf, type Card, type Seat, type Strain, type Suit } from './cards.ts'

/**
 * 謎題 (`e10-t13`, `e10-t14`, AC-10.9, ARCHITECTURE.md §5.11): declarer-play problems for one member
 * alone. South declares, North is dummy; the member plays both against the double-dummy best
 * defence. A puzzle stores a deal (usually an ending: the earlier tricks are gone) and a contract.
 * `npm run puzzles` solves it once, at authoring time (`shared/puzzle-solver.ts`), and the Worker
 * only looks each card up in the stored data (`PuzzleSolution`), for the free plan's 10 ms.
 *
 * Pure, like the rest of `shared/`. This file has no puzzle in it, so the browser may import it; the
 * puzzles themselves are in `shared/puzzle-sets/`, which only the Worker and the script import.
 */

/** How hard a puzzle is */
export const PUZZLE_LEVELS = [1, 2, 3] as const
export type PuzzleLevel = (typeof PUZZLE_LEVELS)[number]

/**
 * Every puzzle in the code is a draft: a club's admin publishes it for that club from the admin page
 * (`puzzle_publications` in the club's object), and only then do its members see it
 */
export type PuzzleStatus = 'draft' | 'published'

/** Declarer is always South */
export interface PuzzleContract {
  level: number
  strain: Strain
}

/** A puzzle as written: what the script solves */
export interface PuzzleSource {
  id: string
  status: 'draft'
  level: PuzzleLevel
  /** What it teaches, 繁中 */
  title: string
  contract: PuzzleContract
  /** `N:<north> <east> <south> <west>`, as in PBN: each hand `♠.♥.♦.♣`. Equal lengths; the cards left out were played earlier */
  deal: string
  /** Tricks declarer's side already won among those played earlier */
  won: number
  /** Who leads the first card shown */
  leader: Seat
  /** The first cards of the current trick, already on the table (usually the lead) */
  opening: Card[]
  /** The situation, 繁中: what has happened so far */
  story: string
  /** Given one at a time when asked for, 繁中; about the technique, never where a card is */
  hints: string[]
  /** Shown once solved, 繁中 */
  explanation: string
}

/** What the script stores for a puzzle; it refuses a puzzle it cannot solve completely */
export interface PuzzleSolution {
  id: string
  /** Stands for the deal, contract and words: a club's approval is for this very text */
  revision: string
  /** The defenders' cards played before the first decision, joined */
  start: string
  /**
   * The decisions, `;` between them, the first one first. A decision is its right cards, `,` between
   * them, each `card:replies:next`: the defenders' answers, joined, and the next decision, or -1 once
   * no wrong card is left to play. A legal card not listed loses the contract against best defence.
   */
  nodes: string
  /** One winning line from the position shown, for the admin who reviews it and the solved page: every card played, joined */
  line: string
  /** Decisions stored */
  size: number
}

export interface PuzzleEdge {
  card: Card
  replies: Card[]
  next: number
}

export const splitCards = (joined: string): Card[] => joined.match(/../g) ?? []

/** The right cards at a decision */
export function puzzleEdges(solution: Pick<PuzzleSolution, 'nodes'>, node: number): PuzzleEdge[] {
  const text = solution.nodes.split(';')[node]
  if (!text) return []
  return text.split(',').map((edge) => {
    const [card, replies, next] = edge.split(':')
    return { card, replies: splitCards(replies), next: Number(next) }
  })
}

/** Parses `N:<north> <east> <south> <west>`; null unless it is well formed with no card twice */
export function parsePuzzleDeal(text: string): Record<Seat, Card[]> | null {
  const match = /^N:(\S+) (\S+) (\S+) (\S+)$/.exec(text)
  if (!match) return null
  const hands: Record<Seat, Card[]> = { N: [], E: [], S: [], W: [] }
  const seen = new Set<Card>()
  for (const [i, seat] of SEATS.entries()) {
    const suits = match[i + 1].split('.')
    if (suits.length !== 4) return null
    for (const [s, ranks] of suits.entries())
      for (const rank of ranks) {
        const card = SUITS[s] + rank
        if (!RANKS.includes(rank) || seen.has(card)) return null
        seen.add(card)
        hands[seat].push(card)
      }
  }
  return hands
}

/** The tricks declarer still has to win from the position shown */
export const puzzleNeed = (source: Pick<PuzzleSource, 'contract' | 'won'>) => source.contract.level + 6 - source.won

export interface PuzzleTrick {
  leader: Seat
  cards: Card[]
  /** Who took it; none while it is being played */
  winner?: Seat
}

/** The table after some cards. `hands` holds all four: only `worker/views.ts` decides who sees what */
export interface PuzzleState {
  hands: Record<Seat, Card[]>
  trump: Suit | null
  /** The tricks played from the position shown, the last one perhaps unfinished */
  tricks: PuzzleTrick[]
  /** Who plays next */
  turn: Seat
  /** Tricks declarer's side won from the position shown */
  won: number
}

export function trickWinner(leader: Seat, cards: readonly Card[], trump: Suit | null): Seat {
  let best = 0
  for (let i = 1; i < cards.length; i++) {
    const same = suitOf(cards[i]) === suitOf(cards[best])
    if (same ? rankValue(rankOf(cards[i])) > rankValue(rankOf(cards[best])) : suitOf(cards[i]) === trump && suitOf(cards[best]) !== trump) best = i
  }
  return nextSeat(leader, best)
}

/** The cards the seat to play may play */
export function legalPlays(state: PuzzleState): Card[] {
  const hand = state.hands[state.turn]
  const trick = state.tricks.at(-1)
  if (!trick || trick.winner) return hand
  const led = suitOf(trick.cards[0])
  const follow = hand.filter((card) => suitOf(card) === led)
  return follow.length > 0 ? follow : hand
}

/** The state after the seat to play plays a card; never changes the one it is given */
export function applyPlay(state: PuzzleState, card: Card): PuzzleState {
  const seat = state.turn
  const hands = { ...state.hands, [seat]: state.hands[seat].filter((c) => c !== card) }
  const last = state.tricks.at(-1)
  const open = last && !last.winner
  const trick: PuzzleTrick = open ? { leader: last.leader, cards: [...last.cards, card] } : { leader: seat, cards: [card] }
  const tricks = open ? [...state.tricks.slice(0, -1), trick] : [...state.tricks, trick]
  if (trick.cards.length < 4) return { ...state, hands, tricks, turn: nextSeat(seat) }
  trick.winner = trickWinner(trick.leader, trick.cards, state.trump)
  return { ...state, hands, tricks, turn: trick.winner, won: state.won + (sameSide(trick.winner, 'N') ? 1 : 0) }
}

/** The table after these cards, counted from the position shown, the opening's cards first */
export function puzzleState(source: Pick<PuzzleSource, 'deal' | 'contract' | 'leader'>, played: readonly Card[]): PuzzleState {
  let state: PuzzleState = {
    hands: parsePuzzleDeal(source.deal) ?? { N: [], E: [], S: [], W: [] },
    trump: source.contract.strain === 'N' ? null : source.contract.strain,
    tricks: [],
    turn: source.leader,
    won: 0,
  }
  for (const card of played) state = applyPlay(state, card)
  return state
}

/** What is wrong with a puzzle as written, or null */
export function puzzleProblem(source: PuzzleSource): string | null {
  if (!/^[a-z0-9-]{1,40}$/.test(source.id)) return 'id'
  if (source.status !== 'draft') return 'status: the code holds drafts only; an admin publishes'
  if (!PUZZLE_LEVELS.includes(source.level)) return 'level'
  const { level, strain } = source.contract
  if (!Number.isInteger(level) || level < 1 || level > 7 || !['S', 'H', 'D', 'C', 'N'].includes(strain)) return 'contract'
  const hands = parsePuzzleDeal(source.deal)
  if (!hands) return 'deal'
  const size = hands.N.length
  if (size < 1 || SEATS.some((seat) => hands[seat].length !== size)) return 'deal: hands must be the same length'
  if (!Number.isInteger(source.won) || source.won < 0 || source.won > 13 - size) return 'won'
  const need = puzzleNeed(source)
  if (need < 1 || need > size) return 'won: the contract is already made, or cannot be'
  if (!SEATS.includes(source.leader)) return 'leader'
  if (source.opening.length > 3) return 'opening'
  let state = puzzleState(source, [])
  for (const card of source.opening) {
    if (!legalPlays(state).includes(card)) return `opening: ${card}`
    state = applyPlay(state, card)
  }
  if (!source.title.trim() || !source.story.trim() || !source.explanation.trim() || source.hints.length === 0) return 'words'
  return null
}

// ── What the browser gets (`worker/views.ts` makes these) ───────────────────────────────────────

/** Where a member's attempt stands: `new` before the first card, `failed` after a wrong card (nothing applied), `solved` once no wrong card is left */
export type PuzzleAttemptStatus = 'new' | 'playing' | 'failed' | 'solved'

/** How a member's progress is stored, one row per puzzle */
export interface PuzzleProgress {
  puzzleId: string
  /** The version of the puzzle they played; another version starts over */
  revision: string
  status: Exclude<PuzzleAttemptStatus, 'new'>
  /** Every card played in this attempt after the opening, the defenders' too */
  played: Card[]
  /** The decision the attempt is at: an index into `PuzzleSolution.nodes` */
  node: number
  /** The card that lost the contract, while `failed` */
  wrong: Card | null
  /** Hints asked for on this puzzle */
  hints: number
  /** Times started from the beginning */
  attempts: number
  /** Wrong cards played, ever */
  failures: number
  /** The first time it was solved */
  solvedAt: number | null
  /** The first solve had no wrong card and no hint */
  clean: boolean
  updatedAt: number
}

/** A puzzle in the list: no cards */
export interface PuzzleSummary {
  id: string
  level: PuzzleLevel
  title: string
  contract: PuzzleContract
  status: PuzzleAttemptStatus
  solved: boolean
  /** The first solve had no wrong card and no hint */
  clean: boolean
}

/** One puzzle as the member sees it. East's and West's cards come only when `status` is `solved` */
export interface PuzzleView extends PuzzleSummary {
  story: string
  /** Tricks won before the position shown */
  wonBefore: number
  /** Tricks still to win from the position shown */
  need: number
  /** Tricks won from the position shown */
  won: number
  /** The cards each seat holds now: North and South always, East and West once solved */
  hands: Partial<Record<Seat, Card[]>>
  /** How many cards each seat holds now */
  counts: Record<Seat, number>
  /** All four hands at the position shown, once solved */
  startHands?: Record<Seat, Card[]>
  /** The cards played before the position shown: public, as they would be at a table */
  gone: Card[]
  tricks: PuzzleTrick[]
  /** Whose card it is, until solved */
  turn: Seat | null
  /** What may be played now; only the server works it out */
  legalCards: Card[]
  /** The card that lost the contract, while `failed` */
  wrong: Card | null
  /** The hints asked for so far */
  hints: string[]
  hintsLeft: number
  attempts: number
  failures: number
  /** Shown once solved */
  explanation?: string
}

/** A puzzle as an admin reviews it before publishing: everything */
export interface AdminPuzzle {
  id: string
  level: PuzzleLevel
  status: PuzzleStatus
  title: string
  contract: PuzzleContract
  wonBefore: number
  need: number
  leader: Seat
  opening: Card[]
  story: string
  hints: string[]
  explanation: string
  hands: Record<Seat, Card[]>
  /** One winning line the solver found, against its best defence */
  line: Card[]
  /** Decisions the solver stored */
  size: number
  publishedBy: string | null
  publishedAt: number | null
}
