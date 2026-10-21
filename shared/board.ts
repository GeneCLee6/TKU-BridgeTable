import { fullDeck, SEATS, sideOf, sortHand, type Hands, type Seat } from './cards.ts'

export type Vulnerability = 'None' | 'NS' | 'EW' | 'Both'

/** Board 1 is dealt by North, 2 by East, 3 by South, 4 by West, and so on */
export function dealerOf(boardNo: number): Seat {
  return SEATS[(boardNo - 1) % 4]
}

/** The standard 16-board vulnerability cycle used by duplicate bridge */
const VUL_CYCLE: Vulnerability[] = [
  'None', 'NS', 'EW', 'Both',
  'NS', 'EW', 'Both', 'None',
  'EW', 'Both', 'None', 'NS',
  'Both', 'None', 'NS', 'EW',
]

export function vulnerabilityOf(boardNo: number): Vulnerability {
  return VUL_CYCLE[(boardNo - 1) % 16]
}

export function isVulnerable(vul: Vulnerability, seat: Seat): boolean {
  return vul === 'Both' || vul === sideOf(seat)
}

/** Returns a uniformly random integer in [0, n) */
export type RandomInt = (n: number) => number

/** Uniform random integer from the platform CSPRNG (available in browsers, Workers and Node) */
export const secureRandomInt: RandomInt = (n) => {
  // Rejection sampling avoids modulo bias
  const limit = Math.floor(0x1_0000_0000 / n) * n
  const buffer = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buffer)
    if (buffer[0] < limit) return buffer[0] % n
  }
}

/** Fisher-Yates shuffle of a full deck, 13 cards to each seat, each hand sorted */
export function deal(randomInt: RandomInt = secureRandomInt): Hands {
  const deck = fullDeck()
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1)
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return {
    N: sortHand(deck.slice(0, 13)),
    E: sortHand(deck.slice(13, 26)),
    S: sortHand(deck.slice(26, 39)),
    W: sortHand(deck.slice(39, 52)),
  }
}
