import { fullDeck, nextSeat, sameSide, SEATS, sideOf, type Card, type Seat } from '../cards.ts'
import { dummyOf, remainingCards, tricksOf, type BoardState } from '../game.ts'
import { canTake } from './dd.ts'

/**
 * Whether a robot asked to approve the pending claim accepts it, as GIB does on BBO. A robot on
 * the claimer's side goes along with its partner. An opponent accepts only when the claimer's side
 * can take the tricks it claims against any defence, worked out double dummy from what the robot
 * may see: a claim lays the claimer's hand face up, so with the robot's own hand and dummy only one
 * hand is unseen, and that hand is simply the cards nobody has seen or played. When it cannot work
 * the position out (a claim before the opening lead, or one too long to read in time) it accepts
 * only a claim of no tricks.
 */
export function acceptsClaim(state: BoardState, seat: Seat, budget?: number): boolean {
  const claim = state.claim
  if (!claim || !state.contract) return false
  if (sameSide(seat, claim.seat)) return true
  if (claim.tricks === 0) return true

  const hands = visibleHands(state, seat)
  const unseen = SEATS.filter((s) => !hands[s])
  if (unseen.length > 1) return false
  if (unseen.length === 1) {
    const known = new Set([...state.play.map((p) => p.card), ...SEATS.flatMap((s) => hands[s] ?? [])])
    hands[unseen[0]] = fullDeck().filter((card) => !known.has(card))
  }

  const current = tricksOf(state).at(-1)
  const open = current && !current.winner ? current : null
  const strain = state.contract.strain
  const answer = canTake(
    {
      hands: hands as Record<Seat, Card[]>,
      trick: open?.cards ?? [],
      leader: open ? open.leader : (current?.winner ?? nextSeat(state.contract.declarer)),
      trump: strain === 'N' ? null : strain,
    },
    sideOf(claim.seat),
    claim.tricks,
    budget,
  )
  return answer === true
}

/**
 * The remaining cards of each hand this seat may see, by the table's rules (worker/views.ts): its
 * own, dummy after the opening lead, every claimed hand (a declarer's claim only to the defenders),
 * and all four once the declarer has claimed, for a defender
 */
function visibleHands(state: BoardState, seat: Seat): Partial<Record<Seat, Card[]>> {
  const declarer = state.contract!.declarer
  const dummy = dummyOf(state)
  const claimed = state.claimed ?? []
  const defender = seat !== declarer && seat !== dummy
  const exposed = state.play.length > 0
  const hands: Partial<Record<Seat, Card[]>> = {}
  for (const s of SEATS) {
    const sees =
      s === seat ||
      (exposed && s === dummy) ||
      (exposed && seat === dummy && s === declarer) ||
      (claimed.includes(s) && (s !== declarer || defender)) ||
      (defender && claimed.includes(declarer))
    if (sees) hands[s] = remainingCards(state, s)
  }
  return hands
}
