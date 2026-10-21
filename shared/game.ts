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
  result?: BoardResult
}

export class GameError extends Error {}

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
  if (state.phase !== 'auction') throw new GameError('叫牌已經結束')
  if (turnOf(state) !== seat) throw new GameError('還沒輪到你叫牌')
  if (!legalCalls(state.auction, state.dealer).has(call)) throw new GameError('不合法的叫品')
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

export function playCard(state: BoardState, seat: Seat, card: Card): BoardState {
  if (state.phase !== 'play') throw new GameError('現在不能出牌')
  if (state.claim) throw new GameError('請先處理攤牌')
  if (turnOf(state) !== seat) throw new GameError('還沒輪到這家出牌')
  if (!remainingCards(state, seat).includes(card)) throw new GameError('手上沒有這張牌')
  if (!legalCards(state, seat).includes(card)) throw new GameError('必須跟出同花色')
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
  if (state.phase !== 'play') throw new GameError('現在不能攤牌')
  if (seat === dummyOf(state)) throw new GameError('夢家不能攤牌')
  if (state.claim) throw new GameError('已經有人攤牌')
  if (state.play.length % 4 !== 0) throw new GameError('請在一墩結束後再攤牌')
  if (!Number.isInteger(tricks) || tricks < 0 || tricks > remainingTricks(state))
    throw new GameError('墩數不合理')
  return { ...state, claim: { seat, tricks, accepted: [] } }
}

export function respondToClaim(state: BoardState, seat: Seat, accept: boolean): BoardState {
  const claim = state.claim
  if (!claim) throw new GameError('沒有待處理的攤牌')
  if (!claimApprovers(state, claim.seat).includes(seat)) throw new GameError('你不需要回應這次攤牌')
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

/** Removes the most recent call or card */
export function undoLast(state: BoardState): BoardState {
  if (state.phase === 'finished') throw new GameError('這副牌已經結束')
  if (state.claim) throw new GameError('請先處理攤牌')
  if (state.phase === 'play' && state.play.length > 0)
    return { ...state, play: state.play.slice(0, -1) }
  if (state.phase === 'play')
    // Undoing the final pass reopens the auction
    return { ...state, phase: 'auction', contract: null, auction: state.auction.slice(0, -1) }
  if (state.auction.length === 0) throw new GameError('沒有可以撤回的動作')
  return { ...state, auction: state.auction.slice(0, -1) }
}

/** The seat that made the most recent call or played the most recent card */
export function lastActor(state: BoardState): Seat | null {
  if (state.phase === 'finished') return null
  if (state.play.length) return state.play.at(-1)!.seat
  return state.auction.at(-1)?.seat ?? null
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
