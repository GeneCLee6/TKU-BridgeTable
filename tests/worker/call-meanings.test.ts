// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { newBoard } from '../../shared/game.ts'
import { inferredMeaning } from '../../shared/robot/robots.ts'
import { bookKey } from '../../shared/robot/system/book-spec.ts'
import { boardView } from '../../worker/views.ts'

/** What a person's call means (e5-t22, AC-5.7): the engine's reading, and who sees it */

describe('a person’s call', () => {
  it('reads as the side’s system says', () => {
    const auction = [{ seat: 'N' as const, call: '1N' }]
    expect(inferredMeaning('tku', auction, 'N', 'None')).toMatchObject({ hcp: [15, 17], balanced: true })
    // Stayman after 1NT is artificial in both systems
    const stayman = [...auction, { seat: 'E' as const, call: 'P' }, { seat: 'S' as const, call: '2C' }]
    expect(inferredMeaning('tku', stayman, 'N', 'None')).toMatchObject({ artificial: true })
    expect(inferredMeaning('gib', stayman, 'N', 'None')).toMatchObject({ artificial: true })
    expect(inferredMeaning('tku', [], 'N', 'None')).toBeUndefined()
  })

  it('shows its inferred meaning to everyone, partner too, while the alert stays hidden from partner', () => {
    const board = {
      ...newBoard(1, deal()),
      auction: [{ seat: 'N' as const, call: '1N', alert: '強無王', meaning: { hcp: [15, 17] as [number, number] }, inferred: 'tku' as const }],
    }
    const partner = boardView(board, 'S').auction[0]
    expect(partner.alert).toBeUndefined()
    expect(partner).toMatchObject({ meaning: { hcp: [15, 17] }, inferred: 'tku' })
    expect(boardView(board, 'E').auction[0]).toMatchObject({ alert: '強無王', inferred: 'tku' })
  })
})

describe('the bidding box hints', () => {
  // North dealt and opened 1NT, East passed: South to call
  const board = {
    ...newBoard(1, deal()),
    dealer: 'N' as const,
    auction: [
      { seat: 'N' as const, call: '1N' },
      { seat: 'E' as const, call: 'P' },
    ],
  }

  it('come on the viewer’s turn, in the robot partner’s system before an opponent’s', () => {
    const view = boardView(board, 'S', { robots: { N: 'gib', E: 'tku' } })
    expect(view.callMeanings).toMatchObject({ robot: 'N', kind: 'gib' })
    expect(view.callMeanings!.meanings['2C']).toMatchObject({ artificial: true })
    // Only the calls the viewer may make
    for (const call of Object.keys(view.callMeanings!.meanings)) expect(view.legalCalls).toContain(call)
    // No robot partner: an opponent's system
    expect(boardView(board, 'S', { robots: { W: 'tku' } }).callMeanings).toMatchObject({ robot: 'W', kind: 'tku' })
  })

  it('are only the auction’s: the same whatever the hands, and none without robots or off turn', () => {
    const other = { ...board, hands: newBoard(1, deal()).hands }
    expect(boardView(other, 'S', { robots: { N: 'gib' } }).callMeanings).toEqual(boardView(board, 'S', { robots: { N: 'gib' } }).callMeanings)
    expect(boardView(board, 'S').callMeanings).toBeUndefined()
    expect(boardView(board, 'W', { robots: { N: 'gib' } }).callMeanings).toBeUndefined()
    expect(boardView(board, null, { robots: { N: 'gib' } }).callMeanings).toBeUndefined()
  })

  it('name 淡江橋館’s words for TKB’s calls and where they are, not 2/1’s (BridgeHall e7-t05)', () => {
    const note = { text: 'Stayman', slug: 'notrump-responses', sectionId: 'a', profile: 'team1' }
    const notes = { key: 'k', notes: { [bookKey('1N (P)', '2C')]: note } }
    const view = boardView(board, 'S', { robots: { N: 'tku' }, bookNotes: notes })
    expect(view.callMeanings!.book).toEqual({ '2C': note })
    expect(boardView(board, 'S', { robots: { N: 'gib' }, bookNotes: notes }).callMeanings!.book).toBeUndefined()
    expect(boardView(board, 'S', { robots: { N: 'tku' } }).callMeanings!.book).toBeUndefined()
  })
})
