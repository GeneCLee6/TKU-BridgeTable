import { describe, expect, it } from 'vitest'
import { fullDeck, type Hands } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import { handviewerUrl, toLin } from '../../shared/lin.ts'
import type { BoardRecord } from '../../shared/protocol.ts'

const hands: Hands = {
  N: fullDeck().filter((c) => c[0] === 'S'),
  E: fullDeck().filter((c) => c[0] === 'H'),
  S: fullDeck().filter((c) => c[0] === 'D'),
  W: fullDeck().filter((c) => c[0] === 'C'),
}

function finishedRecord(): BoardRecord {
  let board: BoardState = newBoard(2, hands)
  board = makeCall(board, 'E', '1H', '5+ hearts')
  for (const call of ['X', 'XX', '7S', 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  for (let i = 0; i < 52; i++) {
    const seat = turnOf(board)!
    board = playCard(board, seat, legalCards(board, seat)[0])
  }
  const player = (username: string) => ({ id: username, username })
  return {
    id: 'r1',
    tableNumber: 1,
    finishedAt: 0,
    players: { N: player('north'), E: player('east'), S: player('south'), W: player('west') },
    board,
  }
}

describe('toLin', () => {
  it('writes players, deal, vulnerability, alerts and play in BBO order', () => {
    const lin = toLin(finishedRecord())
    // Board 2: East deals (4), North-South vulnerable (n)
    expect(lin).toContain('pn|south,west,north,east|')
    expect(lin).toContain('|md|4SHDAKQJT98765432C,SHDCAKQJT98765432,SAKQJT98765432HDC,SHAKQJT98765432DC|')
    expect(lin).toContain('|sv|n|')
    expect(lin).toContain('|mb|1H!|an|5+ hearts|mb|d|mb|r|mb|7S|mb|p|mb|p|mb|p|')
    expect(lin.match(/\|pc\|/g)).toHaveLength(52)
    expect(lin.match(/\|pg\|/g)).toHaveLength(13)
    expect(lin.endsWith('|')).toBe(true)
  })

  it('builds a Handviewer link', () => {
    expect(handviewerUrl(finishedRecord())).toMatch(
      /^https:\/\/www\.bridgebase\.com\/tools\/handviewer\.html\?lin=pn%7C/,
    )
  })
})
