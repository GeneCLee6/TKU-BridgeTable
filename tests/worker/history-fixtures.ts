import { STRAINS, type Contract } from '../../shared/auction.ts'
import type { Vulnerability } from '../../shared/board.ts'
import { SEATS, type Seat } from '../../shared/cards.ts'
import type { BoardState } from '../../shared/game.ts'
import { VULNERABILITIES, taiwanDayStart } from '../../shared/history-query.ts'
import type { BoardRecord } from '../../shared/protocol.ts'

/**
 * Ten thousand repeatable boards for the history performance tests (`history-perf.test.ts`, AC-4.8)
 * and the edge's cost measurements (`edge-cost.test.ts`, §5.12)
 */

export const BOARDS = 10_000
export const MEMBERS = Array.from({ length: 40 }, (_, i) => `m${i}`)
export const START = taiwanDayStart('2025-01-01')
export const HOUR = 3600_000

/** A small, repeatable random sequence, so every run searches the same boards */
function random(seed: number) {
  let s = seed
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2 ** 31
    return s / 2 ** 31
  }
}

export function fixtures(): BoardRecord[] {
  const next = random(42)
  const pick = <T,>(list: readonly T[]) => list[Math.floor(next() * list.length)]
  return Array.from({ length: BOARDS }, (_, i) => {
    const seats = [...MEMBERS].sort(() => next() - 0.5).slice(0, 4)
    // About one seat in five is a robot
    const players = Object.fromEntries(
      SEATS.map((seat, k) => {
        const id = next() < 0.2 ? `robot:gib:${seat}` : seats[k]
        return [seat, { id, username: id }]
      }),
    ) as BoardRecord['players']
    const passed = next() < 0.05
    const level = 1 + Math.floor(next() * 7)
    const contract: Contract | null = passed
      ? null
      : { level, strain: pick(STRAINS), declarer: pick(SEATS) as Seat, doubled: pick(['', '', '', '', 'X', 'XX'] as const) }
    const tricks = passed ? 0 : Math.max(0, Math.min(13, level + 6 + Math.floor(next() * 5) - 2))
    const board = {
      boardNo: 1 + (i % 32),
      dealer: pick(SEATS),
      vul: pick(VULNERABILITIES) as Vulnerability,
      contract,
      result: { declarerTricks: tricks, scoreNS: Math.round((next() - 0.5) * 2000), claimed: false },
    } as unknown as BoardState
    const challenge = i % 10 === 0
    return {
      id: `b${String(i).padStart(5, '0')}`,
      tableNumber: 1 + (i % 12),
      finishedAt: START + i * HOUR,
      players,
      board,
      ...(challenge && { mode: 'challenge' as const, eventId: `ch${Math.floor(i / 100)}` }),
      // The newest challenge boards are still kept back (AC-4.9)
      ...(challenge && i > BOARDS - 200 && { revealAt: START + (BOARDS + 100) * HOUR }),
    }
  })
}
