import { bySuit, nextSeat, RANKS, rankOf, SEATS, sortHand, SUITS, type Card, type Hands, type Seat } from './cards.ts'
import { tricksOf } from './game.ts'
import { TAIWAN_OFFSET_MS } from './history-query.ts'
import type { BoardRecord } from './protocol.ts'

/**
 * Hands written as text, the way PBN and most bridge tools write them: one hand is its four suits
 * in the order ♠.♥.♦.♣, high to low, `AKQ2.K73.9.AJ852` (a void is an empty suit, `AKQ2.K73..AJ8652`);
 * a deal is `N:` and the four hands from that seat round the table. Ten is `T` (`10` is read too).
 * Pure: the practice dialog reads what the member types with it, the server checks deal sets with it.
 */

/** One hand as `♠.♥.♦.♣` text */
export function formatHand(cards: readonly Card[]): string {
  const groups = bySuit(cards)
  return SUITS.map((suit) => groups[suit].map(rankOf).join('')).join('.')
}

/**
 * The cards of one hand written as text, or null: four suits, known ranks, no card twice. `size`
 * is how many cards it must have (13; null for any number, while it is being typed)
 */
export function parseHand(text: string, size: number | null = 13): Card[] | null {
  const suits = String(text ?? '')
    .trim()
    .toUpperCase()
    .replace(/10/g, 'T')
    .split('.')
  if (suits.length !== 4) return null
  const cards: Card[] = []
  for (const [i, ranks] of suits.entries()) {
    for (const rank of ranks.replace(/\s/g, '')) {
      if (!RANKS.includes(rank)) return null
      cards.push(SUITS[i] + rank)
    }
  }
  if (new Set(cards).size !== cards.length) return null
  if (size !== null && cards.length !== size) return null
  return sortHand(cards)
}

/** A whole deal in PBN, `N:<north> <east> <south> <west>` (or starting from any seat), or null: 52 different cards */
export function parseDeal(text: string): Hands | null {
  const match = /^\s*([NESW]):\s*(\S*)\s+(\S*)\s+(\S*)\s+(\S*)\s*$/i.exec(String(text ?? ''))
  if (!match) return null
  const first = match[1].toUpperCase() as Seat
  const hands = {} as Hands
  for (let i = 0; i < 4; i++) {
    const hand = parseHand(match[i + 2])
    if (!hand) return null
    hands[nextSeat(first, i)] = hand
  }
  const all = SEATS.flatMap((seat) => hands[seat])
  return new Set(all).size === 52 ? hands : null
}

/** A deal as PBN, from North */
export const formatDeal = (hands: Hands) => `N:${SEATS.map((seat) => formatHand(hands[seat])).join(' ')}`

// ── Export (e4-t36) ───────────────────────────────────────────────────────────────────────────

/** PBN's names for the vulnerability */
const PBN_VUL = { None: 'None', NS: 'NS', EW: 'EW', Both: 'All' } as const

/** A tag value: PBN escapes `"` and `\` with a backslash, and a value is one line */
const tagValue = (text: string) => text.replace(/\s*\n\s*/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
const tag = (name: string, value: string) => `[${name} "${tagValue(value)}"]`

/** A call as PBN writes it: `1NT`, `Pass`, `X`, `XX` */
const pbnCall = (call: string) => (call === 'P' ? 'Pass' : call === 'X' || call === 'XX' ? call : call.replace(/N$/, 'NT'))

/** The record's Taiwan date, `YYYY.MM.DD` */
const pbnDate = (at: number) => new Date(at + TAIWAN_OFFSET_MS).toISOString().slice(0, 10).replace(/-/g, '.')

/**
 * One finished board as a PBN game (PBN 2.1's export format): the mandatory tags, the deal, the
 * auction (four calls a line, an alert as a note `=n=` with its explanation in `[Note]`) and the
 * play (one trick a line, in the seats' order from the opening leader; `*` when the rest was
 * claimed). The players are named by their usernames, as in LIN
 */
export function toPbn(record: BoardRecord): string {
  const { board, players } = record
  const contract = board.contract
  const result = board.result
  const name = (seat: Seat) => players[seat]?.username ?? ''
  const lines = [
    tag('Event', 'TKU BridgeTable'),
    tag('Site', record.mode === 'practice' ? 'Practice' : `Table ${record.tableNumber}`),
    tag('Date', pbnDate(record.finishedAt)),
    tag('Round', ''),
    tag('Board', String(board.boardNo)),
    tag('West', name('W')),
    tag('North', name('N')),
    tag('East', name('E')),
    tag('South', name('S')),
    tag('Dealer', board.dealer),
    tag('Vulnerable', PBN_VUL[board.vul]),
    tag('Deal', formatDeal(board.hands)),
    tag('Scoring', record.mode === 'team' ? 'IMP' : record.mode === 'pairs' ? 'MP' : ''),
    tag('Declarer', contract?.declarer ?? ''),
    tag('Contract', contract ? `${contract.level}${contract.strain === 'N' ? 'NT' : contract.strain}${contract.doubled}` : 'Pass'),
    tag('Result', contract && result ? String(result.declarerTricks) : ''),
  ]
  if (result) lines.push(tag('Score', `NS ${result.scoreNS}`))
  lines.push(tag('Auction', board.dealer))
  const notes: string[] = []
  const calls = board.auction.map(({ call, alert }) => {
    if (alert === undefined) return pbnCall(call)
    notes.push(tag('Note', `${notes.length + 1}:${alert || 'Alert'}`))
    return `${pbnCall(call)} =${notes.length}=`
  })
  for (let i = 0; i < calls.length; i += 4) lines.push(calls.slice(i, i + 4).join(' '))
  lines.push(...notes)
  const tricks = tricksOf(board)
  if (contract && tricks.length > 0) {
    const leader = tricks[0].leader
    lines.push(tag('Play', leader))
    for (const trick of tricks) {
      lines.push(
        [0, 1, 2, 3]
          .map((i) => {
            const seat = nextSeat(leader, i)
            return trick.cards.find((c) => c.seat === seat)?.card ?? '-'
          })
          .join(' '),
      )
    }
    if (board.play.length < 52) lines.push('*')
  }
  return lines.join('\n')
}

/** Boards as one PBN file, in the order given; games are separated by an empty line */
export function toPbnFile(records: readonly BoardRecord[]): string {
  return ['% PBN 2.1', '% EXPORT', '% TKU BridgeTable', '', ...records.map((r) => `${toPbn(r)}\n`)].join('\n')
}
