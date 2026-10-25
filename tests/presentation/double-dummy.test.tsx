import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { deal } from '../../shared/board.ts'
import { newBoard } from '../../shared/game.ts'
import { DoubleDummyPanel } from '../../src/components/DoubleDummyPanel.tsx'
import { toAnalysis } from '../../src/lib/doubleDummy.ts'
import type { DoubleDummyState } from '../../src/lib/useDoubleDummy.ts'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

let state: DoubleDummyState = { status: 'loading' }
vi.mock('../../src/lib/useDoubleDummy.ts', () => ({ useDoubleDummy: () => state }))

const board = { ...newBoard(1, deal()), phase: 'finished' as const }
const show = () =>
  render(
    <PreferencesProvider>
      <DoubleDummyPanel board={board} />
    </PreferencesProvider>,
  )

describe('DoubleDummyPanel (e4-t34)', () => {
  it('says it is working while DDS runs', () => {
    state = { status: 'loading' }
    show()
    expect(screen.getByRole('status')).toHaveTextContent('正在計算雙明手分析')
  })

  it('shows tricks for each declarer and strain, and the par', () => {
    // DDS order: strains ♠ ♥ ♦ ♣ NT, seats N E S W
    const resTable = [
      [9, 4, 9, 4],
      [8, 5, 8, 5],
      [6, 7, 6, 7],
      [5, 8, 5, 8],
      [7, 6, 7, 6],
    ]
    state = { status: 'done', analysis: toAnalysis({ resTable, par: { score: 140, contracts: ['3S-NS'] } }) }
    show()
    const table = screen.getByRole('table', { name: /DD 表/ })
    const rows = within(table).getAllByRole('row')
    // Header, then N S E W; columns NT ♠ ♥ ♦ ♣
    expect(rows.map((row) => row.textContent)).toEqual(['NT♠♥♦♣', 'N79865', 'S79865', 'E64578', 'W64578'])
    expect(screen.getByText(/NS \+140/)).toBeInTheDocument()
  })

  it('says when the board passes out at par', () => {
    state = { status: 'done', analysis: toAnalysis({ resTable: [[6, 6, 6, 6], [6, 6, 6, 6], [6, 6, 6, 6], [6, 6, 6, 6], [6, 6, 6, 6]], par: { score: 0, contracts: [] } }) }
    show()
    expect(screen.getByText(/All pass/)).toBeInTheDocument()
  })
})
