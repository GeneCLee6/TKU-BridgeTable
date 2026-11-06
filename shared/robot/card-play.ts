import { fullDeck, rankOf, RANKS, SEATS, suitOf, type Card, type Hands, type Seat, type Suit } from '../cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../game.ts'
import { clubLeadCard } from './lead-card.ts'
import { chooseCard } from './play.ts'
import type { RobotKind } from '../protocol.ts'

/**
 * The leads and signals on a system card (e5-t52, ROBOT.md §3): not written out but asked of the
 * code that plays. Each lead is `clubLeadCard` on a sample holding; each signal is `chooseCard` in
 * a small position, so the card shows the card TKB plays. The words for each row are in `strings.ts`
 * (`systemCard.signals`); `tests/engine/system-card.test.ts` checks each row still does what they say.
 */

export interface LeadRow {
  /** The holding, highest first, as ranks (`AKJ2`) */
  holding: string
  /** The rank led against a suit contract */
  suit: string
  /** The rank led against notrump */
  notrump: string
}

/** Holdings that tell the methods apart: every line of ROBOT.md §3's table */
export const LEAD_HOLDINGS = [
  '9', '84', 'AK5', 'AK52', 'AKQ2', 'AKJ2', 'A852', 'AQJ2', 'AJT2', 'KQJ2', 'KQT2', 'KQ52', 'QJT2', 'QJ52', 'JT92', 'JT52',
  'T982', 'T952', 'KJT2', 'KT92', 'QT92', 'K852', 'Q85', 'J852', '9752', '975',
] as const

export function leadRows(): LeadRow[] {
  return LEAD_HOLDINGS.map((holding) => {
    const cards = [...holding].map((rank) => `H${rank}`)
    return { holding, suit: rankOf(clubLeadCard(cards, 'S')), notrump: rankOf(clubLeadCard(cards, null)) }
  })
}

export const SIGNAL_IDS = [
  'attitudeLike',
  'attitudeDislike',
  'countAfterKingEven',
  'countAfterKingOdd',
  'countEven',
  'countOdd',
  'smithLike',
  'smithDislike',
  'discardOdd',
  'discardEven',
  'discardTransferHigh',
  'discardTransferLow',
] as const
export type SignalId = (typeof SIGNAL_IDS)[number]

export interface SignalRow {
  id: SignalId
  /** The suit of the card played */
  suit: Suit
  /** The signaller's cards of that suit before playing, as ranks, highest first */
  holding: string
  /** The rank played */
  plays: string
}

/** A hand from text like 'AKQ2 KJ3 Q54 32' (♠ ♥ ♦ ♣; '-' for a void) */
function hand(text: string): Card[] {
  return text.split(' ').flatMap((ranks, i) => [...ranks.replace('-', '')].map((r) => 'SHDC'[i] + r))
}

/** The given hands, the other seats filled with the rest of the deck */
function layout(given: Partial<Record<Seat, string>>): Hands {
  const hands = {} as Hands
  for (const seat of SEATS) if (given[seat]) hands[seat] = hand(given[seat])
  const rest = fullDeck().filter((c) => !SEATS.some((s) => hands[s]?.includes(c)))
  for (const seat of SEATS) if (!hands[seat]) hands[seat] = rest.splice(0, 13)
  return hands
}

const NOTRUMP = '1N P 3N P P P'
const SPADES = '1S P 4S P P P'

/** Board 3 (South deals) after the given calls and cards; South declares, West leads */
function position(hands: Hands, calls: string, cards: readonly string[]): BoardState {
  let state = newBoard(3, hands)
  for (const call of calls.split(' ')) state = makeCall(state, turnOf(state)!, call)
  for (const card of cards) {
    const seat = turnOf(state)!
    if (!legalCards(state, seat).includes(card)) throw new Error(`system card: ${card} is not legal for ${seat}`)
    state = playCard(state, seat, card)
  }
  return state
}

interface Fixture {
  id: SignalId
  hands: Partial<Record<Seat, string>>
  calls: string
  cards: readonly string[]
}

const FIXTURES: readonly Fixture[] = [
  { id: 'attitudeLike', hands: { N: 'A32 753 QJT9 K43', E: 'Q876 K92 A32 872', W: 'T94 QJT4 654 T95' }, calls: NOTRUMP, cards: ['HQ', 'H3'] },
  { id: 'attitudeDislike', hands: { N: 'A32 753 QJT9 K43', E: 'Q876 962 A32 K72', W: 'T94 QJT4 654 T95' }, calls: NOTRUMP, cards: ['HQ', 'H3'] },
  { id: 'countAfterKingEven', hands: { N: 'A32 753 QJT9 K43', E: '9876 96 A32 9876', W: '4 KQJT82 654 T52' }, calls: SPADES, cards: ['HK', 'H3'] },
  { id: 'countAfterKingOdd', hands: { N: 'A32 753 QJT9 K43', E: '9876 964 A32 987', W: '4 KQJT82 654 T52' }, calls: SPADES, cards: ['HK', 'H3'] },
  // West follows second to declarer's first side suit (♣ here, in a trump contract: plain count)
  { id: 'countEven', hands: { N: 'A32 K75 QJT9 K43', S: 'KQJT5 A96 K82 A2', W: '4 QJT82 76543 97' }, calls: SPADES, cards: ['HQ', 'H5', 'H3', 'HA', 'C2'] },
  { id: 'countOdd', hands: { N: 'A32 K75 QJT9 K43', S: 'KQJT5 A96 K82 A2', W: '4 QJT82 7654 976' }, calls: SPADES, cards: ['HQ', 'H5', 'H3', 'HA', 'C2'] },
  // West follows to declarer's first suit in notrump: Smith Echo about West's own lead
  { id: 'smithLike', hands: { N: 'A32 73 QJT9 K432', S: 'KQ5 AJ4 K82 A765', W: '984 KQT82 543 T9' }, calls: NOTRUMP, cards: ['H8', 'H3', 'H6', 'HJ', 'D2'] },
  { id: 'smithDislike', hands: { N: 'A32 KQ QJT9 K432', S: 'KQ5 AJ4 K82 A765', W: '984 98752 543 T9' }, calls: NOTRUMP, cards: ['H7', 'HQ', 'H3', 'HA', 'D2'] },
  // East has no trumps left when declarer leads them
  { id: 'discardOdd', hands: { N: '9876 K75 JT9 K47', S: 'AKQJT5 A96 82 A2', E: '- 43 KQ753 QT9653' }, calls: SPADES, cards: ['HQ', 'H5', 'H3', 'HA', 'SA', 'S4', 'S6'] },
  { id: 'discardEven', hands: { N: '9876 K75 AKQ K72', S: 'AKQJT5 A96 82 AQ', E: '- 43 97653 T96543' }, calls: SPADES, cards: ['HQ', 'H5', 'H3', 'HA', 'SA', 'S4', 'S6'] },
  // East has no heart on West's lead against notrump
  { id: 'discardTransferHigh', hands: { N: 'A32 K75 QJT K432', E: 'T9876 - AK4 T9876', W: 'J54 QJT98 987 AJ' }, calls: NOTRUMP, cards: ['HQ', 'H5'] },
  { id: 'discardTransferLow', hands: { N: 'A32 K75 QJ2 Q543', E: 'T9876 - T9876 AK4', W: 'J54 QJT98 A53 J2' }, calls: NOTRUMP, cards: ['HQ', 'H5'] },
]

/** The cards `seat` holds of a suit in this position, as ranks */
function holdingOf(state: BoardState, seat: Seat, suit: Suit): string {
  const played = new Set(state.play.map((p) => p.card))
  return state.hands[seat]
    .filter((c) => suitOf(c) === suit && !played.has(c))
    .map(rankOf)
    .sort((a, b) => RANKS.indexOf(a) - RANKS.indexOf(b))
    .join('')
}

/** What TKB plays in each sample position; `kind` is there only because the two share these methods (ROBOT.md §3.2) */
export function signalRows(kind: RobotKind): SignalRow[] {
  return FIXTURES.map(({ id, hands, calls, cards }) => {
    const state = position(layout(hands), calls, cards)
    const seat = turnOf(state)!
    const card = chooseCard(state, seat, kind)
    return { id, suit: suitOf(card), holding: holdingOf(state, seat, suitOf(card)), plays: rankOf(card) }
  })
}
