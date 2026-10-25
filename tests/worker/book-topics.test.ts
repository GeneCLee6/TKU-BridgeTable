// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { makeCall, newBoard } from '../../shared/game.ts'
import { boardView } from '../../worker/views.ts'

/** The bidding hint card's pages (e10-t06, AC-10.4) come from the server, worked out from the auction alone */

describe('the hint card in the table view', () => {
  // North dealt and opened 1NT, East passed: South to call
  const board = {
    ...newBoard(1, deal()),
    dealer: 'N' as const,
    auction: [
      { seat: 'N' as const, call: '1N' },
      { seat: 'E' as const, call: 'P' },
    ],
  }

  it('names the opening’s page and the conventions to come, from the viewer’s side', () => {
    const view = boardView(board, 'S')
    expect(view.bookTopics!.soFar).toEqual([{ slug: 'system-notrump', kind: 'opening', call: '1N' }])
    const next = view.bookTopics!.next.find((t) => t.slug === 'notrump-responses')
    expect(next?.kind === 'convention' && next.conventions).toEqual(expect.arrayContaining(['stayman', 'transfer']))
    // The opponents see the competition page; a watcher sees North-South's
    expect(boardView(board, 'E').bookTopics!.soFar).toEqual([{ slug: 'system-competition', kind: 'competition' }])
    expect(boardView(board, null).bookTopics!.soFar).toEqual(view.bookTopics!.soFar)
  })

  it('is the same whatever the hands, and absent when the viewer’s partner is TKB playing 2/1', () => {
    const other = { ...board, hands: newBoard(1, deal()).hands }
    expect(boardView(other, 'S').bookTopics).toEqual(boardView(board, 'S').bookTopics)
    expect(boardView(board, 'S', { robots: { N: 'gib' } }).bookTopics).toBeUndefined()
    expect(boardView(board, 'S', { robots: { N: 'tku', E: 'gib' } }).bookTopics).toBeDefined()
  })

  it('lists nothing to come once the auction is over', () => {
    // Board 1: North deals; 1NT and three passes
    let over = newBoard(1, deal())
    for (const [seat, call] of [['N', '1N'], ['E', 'P'], ['S', 'P'], ['W', 'P']] as const) over = makeCall(over, seat, call)
    expect(over.phase).toBe('play')
    expect(boardView(over, 'S').bookTopics!.next).toEqual([])
  })
})
