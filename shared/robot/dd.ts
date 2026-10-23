import { rankOf, rankValue, SEATS, SUITS, suitOf, type Card, type Seat, type Side, type Suit } from '../cards.ts'

/**
 * A double-dummy solver, for a robot asked to accept a claim: with every remaining card known,
 * can one side take a number of the remaining tricks against best play? It searches card by card
 * on that yes/no question (alpha-beta), tries only one card of a run of equal cards, remembers
 * positions already settled at the start of a trick, and stops early when the side on lead can
 * cash enough top winners (or the other side can). After `budget` positions it gives up and
 * returns null, so a hard position never holds up the table.
 */

export interface DoubleDummyPosition {
  /** The cards each seat still holds */
  hands: Record<Seat, readonly Card[]>
  /** Cards already played to the current trick, in order (empty at the start of a trick) */
  trick: readonly { seat: Seat; card: Card }[]
  /** Who led, or leads, the current trick */
  leader: Seat
  trump: Suit | null
}

/** Positions searched before giving up (a few milliseconds); seven tricks from the end it is rarely reached */
export const DD_BUDGET = 30000

const ABORT = new Error('double-dummy budget exceeded')

const bits = (mask: number) => {
  let n = 0
  for (let m = mask; m; m &= m - 1) n++
  return n
}
const highest = (mask: number) => 31 - Math.clz32(mask)

/** Whether `side` can take at least `tricks` of the remaining tricks, or null if it gave up */
export function canTake(position: DoubleDummyPosition, side: Side, tricks: number, budget = DD_BUDGET): boolean | null {
  // Seats 0–3 are N E S W (clockwise), suits 0–3 are ♠ ♥ ♦ ♣, ranks 0–12 are 2 to A
  const hand = new Int32Array(16)
  for (const seat of SEATS)
    for (const card of position.hands[seat]) hand[SEATS.indexOf(seat) * 4 + SUITS.indexOf(suitOf(card))] |= 1 << (rankValue(rankOf(card)) - 2)
  const trump = position.trump ? SUITS.indexOf(position.trump) : -1
  const us = side === 'NS' ? 0 : 1
  // Every card played during the search, so a finished trick can be put back
  const playedSeat = new Int32Array(56)
  const playedSuit = new Int32Array(56)
  const playedRank = new Int32Array(56)
  let depth = 0
  let count = 0
  for (const { seat, card } of position.trick) {
    playedSeat[depth] = SEATS.indexOf(seat)
    playedSuit[depth] = SUITS.indexOf(suitOf(card))
    playedRank[depth] = rankValue(rankOf(card)) - 2
    depth++
    count++
  }
  let leader = SEATS.indexOf(position.leader)
  let nodes = 0
  /** Tricks `us` takes from a position at the start of a trick: at least lo, at most hi (lo + 16 hi) */
  const settled = new Map<string, number>()

  /** The card winning the current trick so far: its index in the played arrays */
  const winning = () => {
    const first = depth - count
    let best = first
    for (let i = first + 1; i < depth; i++) {
      const same = playedSuit[i] === playedSuit[best]
      if (same ? playedRank[i] > playedRank[best] : playedSuit[i] === trump && playedSuit[best] !== trump) best = i
    }
    return best
  }

  /** Top winners the leader can cash one after another: a safe lower bound for the leader's side */
  const quick = (seat: number) => {
    const lho = (seat + 1) & 3
    const rho = (seat + 3) & 3
    const ruffA = trump >= 0 && hand[lho * 4 + trump] !== 0
    const ruffB = trump >= 0 && hand[rho * 4 + trump] !== 0
    let total = 0
    for (let s = 0; s < 4; s++) {
      const mine = hand[seat * 4 + s]
      if (!mine) continue
      const a = hand[lho * 4 + s]
      const b = hand[rho * 4 + s]
      const theirs = a | b
      const tops = theirs ? bits(mine >>> (highest(theirs) + 1)) : bits(mine)
      // Once both opponents are out of the suit, the rest of it wins too
      let cash = tops >= Math.max(bits(a), bits(b)) ? bits(mine) : tops
      if (s !== trump) {
        if (ruffA) cash = Math.min(cash, bits(a))
        if (ruffB) cash = Math.min(cash, bits(b))
      }
      total += cash
    }
    return total
  }

  /** The cards worth trying for a seat, one per run of equal cards, most promising first */
  const moves = (seat: number): number[] => {
    const led = count ? playedSuit[depth - count] : -1
    const follow = led >= 0 && hand[seat * 4 + led] !== 0
    const best = count ? winning() : -1
    const partnerWinning = best >= 0 && (playedSeat[best] & 1) === (seat & 1)
    const list: { move: number; score: number }[] = []
    for (let s = 0; s < 4; s++) {
      if (follow && s !== led) continue
      const mine = hand[seat * 4 + s]
      if (!mine) continue
      let live = hand[s] | hand[4 + s] | hand[8 + s] | hand[12 + s]
      for (let i = depth - count; i < depth; i++) if (playedSuit[i] === s) live |= 1 << playedRank[i]
      const others = live & ~mine
      const top = others ? highest(others) : -1
      let previous = -1
      for (let r = 12; r >= 0; r--) {
        if (!(mine & (1 << r))) continue
        // A card is the same as the one above it when no other card in play lies between them
        const between = previous < 0 ? -1 : others & (((1 << previous) - 1) & ~((1 << (r + 1)) - 1))
        if (previous >= 0 && between === 0) {
          list[list.length - 1].move = s * 16 + r
          previous = r
          continue
        }
        previous = r
        let score: number
        if (!count) score = r > top ? 60 + r : bits(mine) - r / 16
        else {
          const beats = playedSuit[best] === s ? r > playedRank[best] : s === trump && playedSuit[best] !== trump
          score = partnerWinning || !beats ? -r : 40 - r
        }
        list.push({ move: s * 16 + r, score })
      }
    }
    list.sort((x, y) => y.score - x.score)
    return list.map((x) => x.move)
  }

  const search = (need: number): boolean => {
    if (++nodes > budget) throw ABORT
    let key = ''
    let lo = 0
    let hi = 0
    if (count === 0) {
      const left = bits(hand[leader * 4]) + bits(hand[leader * 4 + 1]) + bits(hand[leader * 4 + 2]) + bits(hand[leader * 4 + 3])
      if (need <= 0) return true
      if (need > left) return false
      const fast = quick(leader)
      if ((leader & 1) === us ? fast >= need : left - fast < need) return (leader & 1) === us
      key = String.fromCharCode(...hand, leader)
      const known = settled.get(key)
      lo = known === undefined ? 0 : known & 15
      hi = known === undefined ? left : known >> 4
      if (lo >= need) return true
      if (hi < need) return false
    }
    const seat = (leader + count) & 3
    const ours = (seat & 1) === us
    let result = !ours
    for (const move of moves(seat)) {
      const s = move >> 4
      const r = move & 15
      hand[seat * 4 + s] &= ~(1 << r)
      playedSeat[depth] = seat
      playedSuit[depth] = s
      playedRank[depth] = r
      depth++
      count++
      let ok: boolean
      if (count === 4) {
        const winner = playedSeat[winning()]
        const before = leader
        leader = winner
        count = 0
        ok = search(need - ((winner & 1) === us ? 1 : 0))
        leader = before
        count = 4
      } else ok = search(need)
      depth--
      count--
      hand[seat * 4 + s] |= 1 << r
      if (ok === ours) {
        result = ours
        break
      }
    }
    if (key) settled.set(key, result ? Math.max(lo, need) + 16 * hi : lo + 16 * Math.min(hi, need - 1))
    return result
  }

  try {
    return search(tricks)
  } catch (error) {
    if (error === ABORT) return null
    throw error
  }
}
