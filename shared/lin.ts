import { isBid } from './auction.ts'
import { bySuit, rankOf, SUITS, type Seat } from './cards.ts'
import { tricksOf } from './game.ts'
import type { BoardRecord } from './protocol.ts'

/**
 * BBO's LIN format, so a finished board can be opened in the BBO Handviewer or imported into
 * other tools. Hands are listed South, West, North, East; the dealer digit is 1 S, 2 W, 3 N, 4 E.
 */
const LIN_ORDER: Seat[] = ['S', 'W', 'N', 'E']
const VUL_CODE = { None: 'o', NS: 'n', EW: 'e', Both: 'b' } as const

const escape = (text: string) => text.replace(/\|/g, '/')

export function toLin(record: BoardRecord): string {
  const { board, players } = record
  const hands = LIN_ORDER.map((seat) => {
    const groups = bySuit(board.hands[seat])
    return SUITS.map((suit) => suit + groups[suit].map(rankOf).join('')).join('')
  })
  const parts = [
    `pn|${LIN_ORDER.map((seat) => escape(players[seat].username)).join(',')}`,
    `st|`,
    `md|${LIN_ORDER.indexOf(board.dealer) + 1}${hands.join(',')}`,
    `rh|`,
    `ah|Board ${board.boardNo}`,
    `sv|${VUL_CODE[board.vul]}`,
  ]
  for (const { call, alert } of board.auction) {
    const code = isBid(call) ? call : call === 'P' ? 'p' : call === 'X' ? 'd' : 'r'
    parts.push(`mb|${code}${alert !== undefined ? '!' : ''}`)
    if (alert) parts.push(`an|${escape(alert)}`)
  }
  for (const trick of tricksOf(board)) {
    for (const played of trick.cards) parts.push(`pc|${played.card}`)
    if (trick.winner) parts.push('pg|')
  }
  if (board.result?.claimed) parts.push(`mc|${board.result.declarerTricks}`)
  return parts.join('|') + '|'
}

export function handviewerUrl(record: BoardRecord): string {
  return `https://www.bridgebase.com/tools/handviewer.html?lin=${encodeURIComponent(toLin(record))}`
}
