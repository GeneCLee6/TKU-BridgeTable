// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { deal } from '../../shared/board.ts'
import { newBoard } from '../../shared/game.ts'
import { inferredMeaning } from '../../shared/robot/robots.ts'
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
