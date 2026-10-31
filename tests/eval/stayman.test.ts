// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { seatToCall, type AuctionCall } from '../../shared/auction.ts'
import { SEATS, type Card } from '../../shared/cards.ts'
import { newBoard } from '../../shared/game.ts'
import { ROBOT_SYSTEMS } from '../../shared/robot/robots.ts'
import { choose } from '../../shared/robot/system/engine.ts'
import { evaluate } from '../../shared/robot/system/evaluate.ts'
import { bidOut } from '../../eval/consistency.ts'
import { evalBoards } from '../../eval/deals.ts'
import { HEAVY_MS } from '../engine/heavy.ts'

/**
 * Z2: Stayman always holds a four-card major (社長 2026-10-31), and opener answers a major only with
 * four or more of it. The one exception is 2/1's inviting Stayman over 1NT without a major
 * (docs/BBO GIB/gib-2over1.md §4: 2NT is a minor transfer there), which must be 8–9 HCP and bid 2NT
 * next. Every hand of a fixed sample of eval deals is put in each Stayman spot, and the deals are
 * bid out by four TKBs.
 */

const SYSTEMS = ['tku', 'gib'] as const
const boards = evalBoards(150)
const hands: Card[][] = boards.flatMap((b) => SEATS.map((s) => [...b.hands[s]]))

/** The auction as calls from the dealer, North */
const auction = (calls: string): AuctionCall[] => calls.split(' ').map((call, i) => ({ seat: seatToCall('N', i), call }))
const callFor = (system: (typeof SYSTEMS)[number], cards: readonly Card[], calls: string) => {
  const before = auction(calls)
  return choose(ROBOT_SYSTEMS[system], cards, seatToCall('N', before.length), before, 'N', 'None').call
}
const fourMajor = (cards: readonly Card[]) => {
  const h = evaluate(cards)
  return h.len.H >= 4 || h.len.S >= 4
}

/** Where a 2♣ (3♣ over 2NT, a double over a 2♣ overcall) is Stayman, in either system */
const SPOTS: Record<(typeof SYSTEMS)[number], [string, string][]> = {
  tku: [
    ['1N P', '2C'],
    ['P 1N P', '2C'],
  ],
  gib: [
    ['1N P', '2C'],
    ['P 1N P', '2C'],
    ['1N X', '2C'],
    ['1N 2C', 'X'],
    ['2N P', '3C'],
  ],
}

describe('Stayman (Z2)', () => {
  for (const system of SYSTEMS)
    it(`${system}: only with a four-card major (2/1: or inviting 3NT over 1NT, then 2NT)`, () => {
      let asked = 0
      for (const [before, stayman] of SPOTS[system])
        for (const cards of hands) {
          if (callFor(system, cards, before) !== stayman) continue
          asked++
          if (fourMajor(cards)) continue
          const h = evaluate(cards)
          const where = `${before} ${stayman} with ${h.shape.join('')} ${h.hcp} HCP`
          // 2/1's one exception: an invitation over 1NT (also over a double, or doubling a 2♣ overcall)
          expect(system === 'gib' && before.includes('1N'), where).toBe(true)
          expect(h.hcp >= 8 && h.hcp <= 9, where).toBe(true)
          for (const answer of ['2D', '2H', '2S']) expect(callFor(system, cards, `${before} ${stayman} P ${answer} P`), `${where}, after ${answer}`).toBe('2N')
        }
      expect(asked).toBeGreaterThan(30)
    }, HEAVY_MS)

  for (const system of SYSTEMS)
    it(`${system}: opener answers a major only with four or more`, () => {
      const answers: (readonly [string, number, number])[] = [['1N P 2C P', 15, 17], ...(system === 'gib' ? ([['2N P 3C P', 20, 21], ['1N 2C X P', 15, 17], ['1N X 2C P', 15, 17]] as const) : [])]
      let named = 0
      for (const [before, low, high] of answers)
        for (const cards of hands) {
          const h = evaluate(cards)
          // A notrump opening: balanced, in the opening's range
          if (!h.balanced || h.hcp < low || h.hcp > high) continue
          const call = callFor(system, cards, before)
          const major = call.match(/^[23]([HS])$/)?.[1] as 'H' | 'S' | undefined
          if (!major) {
            expect(fourMajor(cards) && /^[23]D$/.test(call), `${before} ${call} with ${h.shape.join('')}`).toBe(false)
            continue
          }
          named++
          expect(h.len[major], `${before} ${call} with ${h.shape.join('')}`).toBeGreaterThanOrEqual(4)
        }
      expect(named).toBeGreaterThan(10)
    }, HEAVY_MS)

  it('bids out a sample of deals with no Stayman or major answer that breaks the rule', () => {
    for (const system of SYSTEMS)
      for (const board of boards) {
        const { dealer, vul } = newBoard(board.boardNo, board.hands)
        const { auction: calls, alerts } = bidOut(system, board.hands, dealer, vul)
        let asked = -9
        calls.forEach(({ seat, call }, i) => {
          const h = evaluate(board.hands[seat])
          const shows = alerts.get(i)
          const where = `${system} board ${board.boardNo}: ${calls.slice(0, i + 1).map((c) => c.call).join(' ')}`
          // Opener's answer, the next call of the Stayman bidder's partner
          if (i === asked + 2 && calls[i - 1].call === 'P' && /^[23][HS]$/.test(call)) expect(h.len[call[1] as 'H' | 'S'], where).toBeGreaterThanOrEqual(4)
          if (shows?.name !== 'stayman' || !shows.notes?.some((n) => n.key === 'asksMajor')) return
          asked = i
          if (!fourMajor(board.hands[seat])) expect(system === 'gib' && shows.hcp?.[0] === 8 && shows.hcp[1] === 9, where).toBe(true)
        })
      }
  }, HEAVY_MS)
})
