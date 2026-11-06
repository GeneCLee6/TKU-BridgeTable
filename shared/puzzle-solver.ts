import { nextSeat, rankOf, rankValue, sameSide, SEATS, type Card, type Seat } from './cards.ts'
import { applyPlay, legalPlays, puzzleNeed, puzzleProblem, puzzleState, type PuzzleSolution, type PuzzleSource, type PuzzleState } from './puzzles.ts'
import { canTake } from './robot/dd.ts'

/**
 * Solves a puzzle with `shared/robot/dd.ts`, once, when it is written (`npm run puzzles`); no Worker
 * request ever comes here. From the position shown it asks of every legal card of declarer's side
 * whether the contract can still be made against best play, and for the defenders picks the card
 * that leaves declarer the fewest tricks (of equals, the one that leaves the most wrong cards to
 * avoid, then the lowest). It stores only the decisions reachable by right cards and stops where no
 * wrong card is left. If `dd.ts` gives up on any question, or the data would be too big for a
 * request, the puzzle is refused: never half solved.
 */

export interface SolveLimits {
  /** Positions `canTake` may search for one question */
  budget: number
  /** Decisions a puzzle may store */
  maxNodes: number
  /** Characters of stored decisions a puzzle may have: they are split once per request */
  maxChars: number
}

export const SOLVE_LIMITS: SolveLimits = { budget: 20_000_000, maxNodes: 2000, maxChars: 48 * 1024 }

export interface SolveReport {
  /** The decisions on the stored line with a wrong card to avoid */
  critical: { card: Card; seat: Seat; legal: number; wrong: Card[] }[]
  /** `canTake` questions asked */
  questions: number
}

export type SolveResult = { solution: PuzzleSolution; report: SolveReport } | { refused: string }

class Refused extends Error {}

const positionKey = (state: PuzzleState) => {
  const last = state.tricks.at(-1)
  const trick = last && !last.winner ? `${last.leader}${last.cards.join('')}` : ''
  return `${SEATS.map((seat) => state.hands[seat].join('')).join('/')}|${trick}|${state.turn}`
}

const ours = (seat: Seat) => sameSide(seat, 'N')

/** The defender's cards worth trying: the lowest of each run with no other live card between, the same card to double dummy */
function distinctCards(state: PuzzleState): Card[] {
  const last = state.tricks.at(-1)
  const live = [...SEATS.flatMap((seat) => (seat === state.turn ? [] : state.hands[seat])), ...(last && !last.winner ? last.cards : [])]
  return legalPlays(state).filter((card, _, legal) => {
    const lower = legal
      .filter((other) => other[0] === card[0] && rankValue(rankOf(other)) < rankValue(rankOf(card)))
      .sort((a, b) => rankValue(rankOf(b)) - rankValue(rankOf(a)))[0]
    return !lower || live.some((other) => other[0] === card[0] && rankValue(rankOf(other)) < rankValue(rankOf(card)) && rankValue(rankOf(other)) > rankValue(rankOf(lower)))
  })
}

/** FNV-1a: only tells two versions of a text apart */
export function hashText(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193)
  return (hash >>> 0).toString(36)
}

/** Changes whenever a member would see something else, or the answer could differ */
export const puzzleRevision = (source: PuzzleSource) =>
  hashText(JSON.stringify([source.level, source.title, source.contract, source.deal, source.won, source.leader, source.opening, source.story, source.hints, source.explanation]))

interface Decision {
  /** Right cards, each with the defence's answers and what follows */
  edges: { card: Card; replies: Card[]; next: Decision | null }[]
  legal: Card[]
  seat: Seat
  /** The most decisions with a wrong card on any line from here */
  hardness: number
}

export function solvePuzzle(source: PuzzleSource, limits: SolveLimits = SOLVE_LIMITS): SolveResult {
  const problem = puzzleProblem(source)
  if (problem) return { refused: problem }
  const need = puzzleNeed(source)
  const memo = new Map<string, Decision | null>()
  const defences = new Map<string, { replies: Card[]; next: Decision | null }>()
  const answers = new Map<string, boolean>()
  let questions = 0

  /** Whether declarer's side can take this many more tricks from here, the current trick's included */
  const canStillTake = (state: PuzzleState, tricks: number) => {
    if (tricks <= 0) return true
    const asked = `${positionKey(state)}|${tricks}`
    const known = answers.get(asked)
    if (known !== undefined) return known
    const last = state.tricks.at(-1)
    const open = last && !last.winner
    questions++
    const answer = canTake(
      {
        hands: state.hands,
        trick: open ? last.cards.map((card, i) => ({ seat: nextSeat(last.leader, i), card })) : [],
        leader: open ? last.leader : state.turn,
        trump: state.trump,
      },
      'NS',
      tricks,
      limits.budget,
    )
    if (answer === null) throw new Refused(`dd.ts gave up within ${limits.budget} positions`)
    answers.set(asked, answer)
    return answer
  }

  /** The most tricks declarer's side can still take from here */
  const mostFrom = (state: PuzzleState) => {
    const left = Math.max(...SEATS.map((seat) => state.hands[seat].length))
    let most = 0
    while (most < left && canStillTake(state, most + 1)) most++
    return most + state.won
  }

  const finished = (state: PuzzleState) => state.won >= need

  /** Plays the defence from here to declarer's side's next decision */
  const defend = (state: PuzzleState): { replies: Card[]; next: Decision | null } => {
    if (finished(state) || ours(state.turn)) return { replies: [], next: decide(state) }
    const key = `${positionKey(state)}|${state.won}`
    const known = defences.get(key)
    if (known) return known
    let chosen: { card: Card; replies: Card[]; next: Decision | null; most: number } | null = null
    for (const card of distinctCards(state)) {
      const after = applyPlay(state, card)
      const most = mostFrom(after)
      if (chosen && most > chosen.most) continue
      const rest = defend(after)
      const hard = rest.next?.hardness ?? 0
      const chosenHard = chosen?.next?.hardness ?? 0
      if (
        !chosen ||
        most < chosen.most ||
        hard > chosenHard ||
        (hard === chosenHard && rankValue(rankOf(card)) < rankValue(rankOf(chosen.card)))
      )
        chosen = { card, replies: [card, ...rest.replies], next: rest.next, most }
    }
    if (!chosen) throw new Refused('a defender has no card')
    const answer = { replies: chosen.replies, next: chosen.next }
    defences.set(key, answer)
    return answer
  }

  /** The decision here; null once nothing can go wrong any more */
  const decide = (state: PuzzleState): Decision | null => {
    if (finished(state) || state.hands[state.turn].length === 0) return null
    const key = `${positionKey(state)}|${state.won}`
    const known = memo.get(key)
    if (known !== undefined) return known
    const legal = legalPlays(state)
    const edges: Decision['edges'] = []
    for (const card of legal) {
      const after = applyPlay(state, card)
      if (!finished(after) && !canStillTake(after, need - after.won)) continue
      edges.push({ card, ...defend(after) })
    }
    if (edges.length === 0) throw new Refused(`no right card where the contract should still make: ${key}`)
    const below = Math.max(...edges.map((edge) => edge.next?.hardness ?? 0))
    const wrong = legal.length > edges.length
    const decision = !wrong && below === 0 ? null : { edges, legal, seat: state.turn, hardness: (wrong ? 1 : 0) + below }
    memo.set(key, decision)
    return decision
  }

  try {
    const shown = puzzleState(source, source.opening)
    if (!canStillTake(shown, need)) return { refused: 'the contract cannot be made against best defence' }
    const { replies: start, next: root } = defend(shown)
    if (!root) return { refused: 'no decision: every card makes the contract' }

    // Number the decisions reachable from the first, the first one first
    const numbers = new Map<Decision, number>()
    const order: Decision[] = []
    const visit = (decision: Decision) => {
      if (numbers.has(decision)) return
      numbers.set(decision, order.length)
      order.push(decision)
      for (const edge of decision.edges) if (edge.next) visit(edge.next)
    }
    visit(root)
    if (order.length > limits.maxNodes) return { refused: `${order.length} decisions, more than ${limits.maxNodes}` }
    const nodes = order
      .map((decision) => decision.edges.map((edge) => `${edge.card}:${edge.replies.join('')}:${edge.next ? numbers.get(edge.next) : -1}`).join(','))
      .join(';')
    if (nodes.length > limits.maxChars) return { refused: `${nodes.length} characters of decisions, more than ${limits.maxChars}` }

    // The line through the most wrong cards, for the admin to read
    const line: Card[] = [...source.opening, ...start]
    const critical: SolveReport['critical'] = []
    for (let decision: Decision | null = root; decision; ) {
      const current: Decision = decision
      const edge = current.edges.reduce((a, b) => ((b.next?.hardness ?? 0) > (a.next?.hardness ?? 0) ? b : a))
      const wrong = current.legal.filter((card) => !current.edges.some((e) => e.card === card))
      if (wrong.length > 0) critical.push({ card: edge.card, seat: current.seat, legal: current.legal.length, wrong })
      line.push(edge.card, ...edge.replies)
      decision = edge.next
    }
    return {
      solution: { id: source.id, revision: puzzleRevision(source), start: start.join(''), nodes, line: line.join(''), size: order.length },
      report: { critical, questions },
    }
  } catch (error) {
    if (error instanceof Refused) return { refused: error.message }
    throw error
  }
}
