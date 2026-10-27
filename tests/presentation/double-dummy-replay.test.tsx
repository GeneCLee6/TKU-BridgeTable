import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fullDeck, type Hands } from '../../shared/cards.ts'
import { legalCards, makeCall, newBoard, playCard, turnOf, type BoardState } from '../../shared/game.ts'
import type { BoardRecord } from '../../shared/protocol.ts'
import { DdReplayBar } from '../../src/components/DoubleDummyReplay.tsx'
import { RecordDiagram } from '../../src/components/RecordDiagram.tsx'
import { ReplayControls } from '../../src/components/ReplayControls.tsx'
import type { DdPositionRaw, DdPositionRequest } from '../../src/lib/doubleDummy.ts'
import { useDoubleDummyReplay } from '../../src/lib/useDoubleDummyReplay.ts'
import { useTrickReplay } from '../../src/lib/useTrickReplay.ts'
import { ComparePage } from '../../src/pages/ComparePage.tsx'
import type { CardStyle } from '../../src/state/PreferencesContext.tsx'
import { PreferencesProvider } from '../../src/state/PreferencesContext.tsx'

/** Double-dummy mode in a replay: the switch, the marks on the cards, trying a card out. DDS is mocked. */

const mocks = vi.hoisted(() => ({
  solve: vi.fn(),
  api: { record: vi.fn() },
}))
vi.mock('../../src/lib/useDoubleDummy.ts', () => ({
  canAnalyse: (board: BoardState) => board.phase === 'finished',
  useDoubleDummy: () => ({ status: 'loading' }),
  solvePosition: (request: DdPositionRequest) => ({ result: mocks.solve(request) as Promise<DdPositionRaw>, cancel: () => {} }),
}))
vi.mock('../../src/lib/api.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/api.ts')>()),
  api: mocks.api,
}))

const robot = (seat: string) => ({ id: `robot:gib:${seat}`, username: `TKB ${seat}`, robot: true })
const amy = { id: 'amy', username: 'amy' }

/** Each seat one suit: N ♠, E ♥, S ♦, W ♣ */
const hands: Hands = {
  N: fullDeck().filter((c) => c[0] === 'S'),
  E: fullDeck().filter((c) => c[0] === 'H'),
  S: fullDeck().filter((c) => c[0] === 'D'),
  W: fullDeck().filter((c) => c[0] === 'C'),
}

/** South plays 7♦ (N P, E P, S 7♦), every card played; West leads */
function record(id = 'b1'): BoardRecord {
  let board: BoardState = newBoard(1, hands)
  for (const call of ['P', 'P', '7D', 'P', 'P', 'P']) board = makeCall(board, turnOf(board)!, call)
  for (let i = 0; i < 52; i++) {
    const seat = turnOf(board)!
    board = playCard(board, seat, legalCards(board, seat)[0])
  }
  return { id, tableNumber: 0, finishedAt: 0, mode: 'casual', players: { N: robot('N'), E: robot('E'), S: amy, W: robot('W') }, board }
}

/** West to lead: ♣A keeps declarer to 12 tricks (the defence's best), any other club lets him make */
const LEAD: DdPositionRaw = { suit: [3, 3], rank: [14, 13], equals: [0, 0x3ffc & ~(1 << 13) & ~(1 << 14)], score: [1, 0] }
/** After a club: North (spades only) can only discard, every card gives 13 */
const DISCARD: DdPositionRaw = { suit: [0], rank: [14], equals: [0x3ffc & ~(1 << 14)], score: [13] }

/** The record page's replay: diagram, controls with the switch, and the line under them */
function Replay({ rec, style }: { rec: BoardRecord; style: CardStyle }) {
  const replay = useTrickReplay(rec.board.play.length, 0)
  const [on, setOn] = useState(false)
  const dd = useDoubleDummyReplay(rec.board, replay.step, on, replay.playing)
  return (
    <>
      <RecordDiagram record={rec} step={replay.step} width={40} trickWidth={30} styleFor={() => style} dd={dd} />
      <ReplayControls replay={replay} total={rec.board.play.length} dd={{ on, onChange: setOn }} />
      <DdReplayBar dd={dd} />
    </>
  )
}

const show = (style: CardStyle = 'text') =>
  render(
    <PreferencesProvider>
      <Replay rec={record()} style={style} />
    </PreferencesProvider>,
  )

beforeEach(() => {
  mocks.solve.mockReset()
  mocks.solve.mockImplementation(async (request: DdPositionRequest) => (request.currentTrickRank[0] ? DISCARD : LEAD))
})

describe('double-dummy mode in a replay', () => {
  it('is off until switched on, then marks each card West may lead', async () => {
    show()
    const toggle = screen.getByRole('switch', { name: '雙夢家模式' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(mocks.solve).not.toHaveBeenCalled()

    await userEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    // ♣A: declarer 12 tricks, one down, the defence's best; the rest let 7♦ make
    expect(await screen.findByRole('button', { name: /莊家 12 墩（倒 1 墩） · 最佳/ })).toBeEnabled()
    expect(screen.getAllByRole('button', { name: /莊家 13 墩（剛好做成）/ })).toHaveLength(12)
    // The colour says over or down: the number goes on the card without a sign, the words in the label and tooltip
    const marks = [...document.querySelectorAll('[data-dd-mark]')].map((m) => m.textContent)
    expect(marks.filter((m) => m === '1')).toHaveLength(1)
    expect(marks.filter((m) => m === '=')).toHaveLength(12)
    expect(marks.some((m) => /[+−-]/.test(m ?? ''))).toBe(false)
    expect(screen.getByRole('button', { name: /莊家 12 墩/ })).toHaveAttribute('title', expect.stringContaining('莊家 12 墩（倒 1 墩）'))
    expect(screen.getByText(/綠底的數字是超幾墩、紅底是倒幾墩，= 剛好做成/)).toBeInTheDocument()
    expect(mocks.solve).toHaveBeenCalledWith(expect.objectContaining({ trump: 2, first: 3, currentTrickRank: [0, 0, 0] }))

    await userEvent.click(toggle)
    expect(document.querySelectorAll('[data-dd-mark]')).toHaveLength(0)
    expect(screen.queryByText(/剛好做成，/)).toBeNull()
  })

  it('tries a card out and goes back to the actual play', async () => {
    show()
    await userEvent.click(screen.getByRole('switch', { name: '雙夢家模式' }))
    await userEvent.click(await screen.findByRole('button', { name: /莊家 12 墩/ }))
    // ♣A is on the table; North is to play and the solver is asked about the new point
    expect(await screen.findByText('假設打法')).toBeInTheDocument()
    expect(mocks.solve).toHaveBeenLastCalledWith(expect.objectContaining({ first: 3, currentTrickSuit: [3, 0, 0], currentTrickRank: [14, 0, 0] }))
    await waitFor(() => expect(screen.getAllByRole('button', { name: /莊家 13 墩/ })).toHaveLength(13))
    const north = screen.getByRole('group', { name: /^N / })
    expect(within(north).getAllByRole('button', { name: /莊家 13 墩/ })).toHaveLength(13)

    await userEvent.click(screen.getByRole('button', { name: '回到實際打法' }))
    expect(screen.queryByText('假設打法')).toBeNull()
    expect(await screen.findByRole('button', { name: /莊家 12 墩/ })).toBeInTheDocument()
  })

  it('steps one card at a time, and the hand to play next shows every card it may play', async () => {
    show()
    expect(screen.getByRole('button', { name: '下一墩' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('switch', { name: '雙夢家模式' }))
    await screen.findByRole('button', { name: /莊家 12 墩/ })
    await userEvent.click(screen.getByRole('button', { name: '下一張' }))
    // West's lead is on the table, and North (to play next) is solved: all 13 spades marked
    expect(mocks.solve).toHaveBeenLastCalledWith(expect.objectContaining({ first: 3, currentTrickSuit: [3, 0, 0] }))
    const north = screen.getByRole('group', { name: /^N / })
    await waitFor(() => expect(within(north).getAllByRole('button', { name: /莊家 13 墩/ })).toHaveLength(13))
    expect(screen.queryByText('假設打法')).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: '上一張' }))
    expect(await screen.findByRole('button', { name: /莊家 12 墩/ })).toBeInTheDocument()
  })

  it('moving the replay leaves a tried-out line and solves the new point', async () => {
    show()
    await userEvent.click(screen.getByRole('switch', { name: '雙夢家模式' }))
    await userEvent.click(await screen.findByRole('button', { name: /莊家 12 墩/ }))
    expect(await screen.findByText('假設打法')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '結尾' }))
    expect(screen.queryByText('假設打法')).toBeNull()
    // Every card has been played: nothing left to solve
    expect(await screen.findByText('牌已經出完了。')).toBeInTheDocument()
  })

  it('marks card faces too', async () => {
    show('cards')
    await userEvent.click(screen.getByRole('switch', { name: '雙夢家模式' }))
    expect(await screen.findByRole('button', { name: /莊家 12 墩（倒 1 墩） · 最佳/ })).toBeEnabled()
    expect(document.querySelectorAll('[data-dd-mark]')).toHaveLength(13)
  })

  it('says when DDS fails', async () => {
    mocks.solve.mockImplementation(async () => {
      throw new Error('boom')
    })
    show()
    await userEvent.click(screen.getByRole('switch', { name: '雙夢家模式' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('無法計算雙夢家分析')
  })
})

describe('double-dummy mode side by side', () => {
  it('has one switch for both results', async () => {
    mocks.api.record.mockImplementation(async (id: string) => ({ record: record(id) }))
    render(
      <PreferencesProvider>
        <MemoryRouter initialEntries={['/history/a/vs/b']}>
          <Routes>
            <Route path="/history/:recordId/vs/:otherId" element={<ComparePage />} />
          </Routes>
        </MemoryRouter>
      </PreferencesProvider>,
    )
    const toggle = await screen.findByRole('switch', { name: '雙夢家模式' })
    await userEvent.click(toggle)
    await waitFor(() => expect(screen.getAllByRole('button', { name: /莊家 12 墩/ })).toHaveLength(2))
  })
})
