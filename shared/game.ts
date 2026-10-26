import {
  contractOf,
  isAuctionComplete,
  legalCalls,
  seatToCall,
  type AuctionCall,
  type Call,
  type Contract,
} from './auction.ts'
import { dealerOf, isVulnerable, vulnerabilityOf, type Vulnerability } from './board.ts'
import {
  nextSeat,
  partnerOf,
  rankOf,
  rankValue,
  sameSide,
  SEATS,
  sideOf,
  suitOf,
  type Card,
  type Hands,
  type Seat,
  type Side,
} from './cards.ts'
import { AppError } from './messages.ts'
import { duplicateScore } from './scoring.ts'

/**
 * The state of one board from the deal to the result. Transitions are pure: each returns a new
 * state or throws a GameError, so the Worker can validate every action and the browser can
 * replay a finished board.
 */
export interface PlayedCard {
  seat: Seat
  card: Card
}

export interface Trick {
  leader: Seat
  cards: PlayedCard[]
  /** Set once four cards are on the table */
  winner?: Seat
}

export interface Claim {
  seat: Seat
  /** Tricks the claimer's side takes from the remaining ones */
  tricks: number
  accepted: Seat[]
}

export interface BoardResult {
  declarerTricks: number
  /** From North-South's point of view; 0 for a passed-out board */
  scoreNS: number
  claimed: boolean
}

export type Phase = 'auction' | 'play' | 'finished'

export interface BoardState {
  boardNo: number
  dealer: Seat
  vul: Vulnerability
  /** The original deal; cards played are tracked in `play` */
  hands: Hands
  auction: AuctionCall[]
  contract: Contract | null
  play: PlayedCard[]
  phase: Phase
  claim?: Claim
  /**
   * Seats that have claimed on this board. A claim lays the hand face up, and it stays face up
   * even if the claim is rejected and play goes on.
   */
  claimed?: Seat[]
  result?: BoardResult
}

/** A rule was broken; the code says which (shared/messages.ts) */
export class GameError extends AppError {}

export function newBoard(boardNo: number, hands: Hands): BoardState {
  return {
    boardNo,
    dealer: dealerOf(boardNo),
    vul: vulnerabilityOf(boardNo),
    hands,
    auction: [],
    contract: null,
    play: [],
    phase: 'auction',
  }
}

export const dummyOf = (state: BoardState): Seat | null =>
  state.contract ? partnerOf(state.contract.declarer) : null

/** Who clicks for a hand: the declarer plays dummy's cards */
export function controllerOf(state: BoardState, seat: Seat): Seat {
  return state.phase === 'play' && seat === dummyOf(state) ? state.contract!.declarer : seat
}

export function tricksOf(state: BoardState): Trick[] {
  if (!state.contract) return []
  const strain = state.contract.strain
  const tricks: Trick[] = []
  let leader = nextSeat(state.contract.declarer)
  for (let i = 0; i < state.play.length; i += 4) {
    const cards = state.play.slice(i, i + 4)
    const trick: Trick = { leader, cards }
    if (cards.length === 4) {
      trick.winner = trickWinner(cards, strain === 'N' ? null : strain)
      leader = trick.winner
    }
    tricks.push(trick)
  }
  return tricks
}

/** Highest trump wins, otherwise the highest card of the suit led (`best` starts as the lead) */
export function trickWinner(cards: readonly PlayedCard[], trump: string | null): Seat {
  let best = cards[0]
  for (const played of cards.slice(1)) {
    const suit = suitOf(played.card)
    const bestSuit = suitOf(best.card)
    const beats =
      suit === bestSuit
        ? rankValue(rankOf(played.card)) > rankValue(rankOf(best.card))
        : suit === trump && bestSuit !== trump
    if (beats) best = played
  }
  return best.seat
}

export function tricksWon(state: BoardState): Record<Side, number> {
  const won = { NS: 0, EW: 0 }
  for (const trick of tricksOf(state)) if (trick.winner) won[sideOf(trick.winner)]++
  return won
}

/** Cards a seat still holds */
export function remainingCards(state: BoardState, seat: Seat): Card[] {
  const played = new Set(state.play.filter((p) => p.seat === seat).map((p) => p.card))
  return state.hands[seat].filter((card) => !played.has(card))
}

/** Whose turn it is (the hand, not the controller), or null when the board is over */
export function turnOf(state: BoardState): Seat | null {
  if (state.phase === 'auction') return seatToCall(state.dealer, state.auction.length)
  if (state.phase === 'finished') return null
  const tricks = tricksOf(state)
  const current = tricks.at(-1)
  if (!current) return nextSeat(state.contract!.declarer)
  if (current.winner) return current.winner
  return nextSeat(current.cards.at(-1)!.seat)
}

export function legalCards(state: BoardState, seat: Seat): Card[] {
  if (state.phase !== 'play' || turnOf(state) !== seat) return []
  const hand = remainingCards(state, seat)
  const current = tricksOf(state).at(-1)
  if (!current || current.winner) return hand
  const led = suitOf(current.cards[0].card)
  const following = hand.filter((card) => suitOf(card) === led)
  return following.length ? following : hand
}

export function makeCall(state: BoardState, seat: Seat, call: Call, alert?: string): BoardState {
  if (state.phase !== 'auction') throw new GameError('auctionOver')
  if (turnOf(state) !== seat) throw new GameError('notYourCall')
  if (!legalCalls(state.auction, state.dealer).has(call)) throw new GameError('illegalCall')
  const entry: AuctionCall = { seat, call }
  if (alert !== undefined) entry.alert = alert.slice(0, 200)
  const auction = [...state.auction, entry]
  const next: BoardState = { ...state, auction }
  if (isAuctionComplete(auction)) {
    next.contract = contractOf(auction)
    if (next.contract) next.phase = 'play'
    else return finish(next, 0, false)
  }
  return next
}

/**
 * A board that is only bid (a bidding practice, `e10-t15`): once the auction is over the board is
 * finished with its contract and no result, as nothing is played. A board passed out keeps its
 * result (0); one still being bid is left as it is
 */
export function endBidding(state: BoardState): BoardState {
  if (state.phase !== 'play' || state.play.length > 0) return state
  return { ...state, phase: 'finished' }
}

/** Whether a finished board ended at the auction (`endBidding`): it has a contract and no result */
export const biddingEnded = (state: Pick<BoardState, 'phase' | 'contract' | 'result'>) =>
  state.phase === 'finished' && !!state.contract && !state.result

export function playCard(state: BoardState, seat: Seat, card: Card): BoardState {
  if (state.phase !== 'play') throw new GameError('cannotPlayNow')
  if (state.claim) throw new GameError('claimPending')
  if (turnOf(state) !== seat) throw new GameError('notThisHandsTurn')
  if (!remainingCards(state, seat).includes(card)) throw new GameError('cardNotHeld')
  if (!legalCards(state, seat).includes(card)) throw new GameError('mustFollowSuit')
  const next: BoardState = { ...state, play: [...state.play, { seat, card }] }
  if (next.play.length === 52) {
    const declarer = next.contract!.declarer
    return finish(next, tricksWon(next)[sideOf(declarer)], false)
  }
  return next
}

export const remainingTricks = (state: BoardState) => 13 - Math.floor(state.play.length / 4)

/** Seats that must accept a claim: the two players other than the claimer who are not dummy */
export function claimApprovers(state: BoardState, claimer: Seat): Seat[] {
  const dummy = dummyOf(state)
  return SEATS.filter((s) => s !== claimer && s !== dummy)
}

export function makeClaim(state: BoardState, seat: Seat, tricks: number): BoardState {
  if (state.phase !== 'play') throw new GameError('cannotClaimNow')
  if (seat === dummyOf(state)) throw new GameError('dummyCannotClaim')
  if (state.claim) throw new GameError('alreadyClaimed')
  if (!Number.isInteger(tricks) || tricks < 0 || tricks > remainingTricks(state))
    throw new GameError('badClaim')
  const claimed = state.claimed?.includes(seat) ? state.claimed : [...(state.claimed ?? []), seat]
  return { ...state, claim: { seat, tricks, accepted: [] }, claimed }
}

export function respondToClaim(state: BoardState, seat: Seat, accept: boolean): BoardState {
  const claim = state.claim
  if (!claim) throw new GameError('noClaim')
  if (!claimApprovers(state, claim.seat).includes(seat)) throw new GameError('notClaimApprover')
  if (!accept) return { ...state, claim: undefined }
  const accepted = claim.accepted.includes(seat) ? claim.accepted : [...claim.accepted, seat]
  if (accepted.length < claimApprovers(state, claim.seat).length)
    return { ...state, claim: { ...claim, accepted } }

  const declarer = state.contract!.declarer
  const remaining = remainingTricks(state)
  const declarerShare = sameSide(claim.seat, declarer) ? claim.tricks : remaining - claim.tricks
  const settled = { ...state, claim: { ...claim, accepted } }
  return finish(settled, tricksWon(state)[sideOf(declarer)] + declarerShare, true)
}

/**
 * BBO's undo: takes back the seat's most recent call or card and everything after it. During the
 * play a seat's cards include dummy's for the declarer, and only cards can be taken back once the
 * opening lead is made; before it, the auction reopens at the seat's last call. `auctionSeat` is
 * the seat it bid from, when that is not where it sits now (a person moved into a robot partner's
 * declaring seat).
 */
export function undoFor(state: BoardState, seat: Seat, auctionSeat: Seat = seat): BoardState {
  if (state.phase === 'finished') throw new GameError('boardOver')
  if (state.claim) throw new GameError('claimPending')
  if (state.play.length) {
    const from = state.play.findLastIndex((p) => controllerOf(state, p.seat) === seat)
    if (from < 0) throw new GameError('nothingToUndo')
    return { ...state, play: state.play.slice(0, from) }
  }
  const from = state.auction.findLastIndex((c) => c.seat === auctionSeat)
  if (from < 0) throw new GameError('nothingToUndo')
  if (state.phase === 'auction') return { ...state, auction: state.auction.slice(0, from) }
  // The auction reopens: there is no contract, and a claim made before the lead no longer counts
  const { claimed: _gone, ...rest } = state
  return { ...rest, phase: 'auction', contract: null, auction: state.auction.slice(0, from) }
}

/** Whether `undoFor` has something to take back for the seat */
export function canUndoFor(state: BoardState, seat: Seat, auctionSeat: Seat = seat): boolean {
  try {
    undoFor(state, seat, auctionSeat)
    return true
  } catch (error) {
    if (error instanceof GameError) return false
    throw error
  }
}

function finish(state: BoardState, declarerTricks: number, claimed: boolean): BoardState {
  const contract = state.contract
  let scoreNS = 0
  if (contract) {
    const score = duplicateScore(contract, declarerTricks, isVulnerable(state.vul, contract.declarer))
    scoreNS = sideOf(contract.declarer) === 'NS' ? score : -score
  }
  return { ...state, phase: 'finished', result: { declarerTricks, scoreNS, claimed } }
}
